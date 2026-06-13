import type { IProviderAdapter, StatusResponse, UsageData } from './types.js';
import { aggregate } from './aggregator.js';

interface PollerOptions {
  adapters: IProviderAdapter[];
  intervalSec: number;
}

/**
 * Standalone polling service — ZERO web-framework imports.
 * Can be used by both the HTTP server AND a future TUI without modification.
 *
 * Concurrency contract: if a poll is in flight, refreshNow() returns the same promise.
 * Back-off contract: after a provider returns RATE_LIMITED, skip it for 2 cycles.
 */
export class Poller {
  private readonly adapters: IProviderAdapter[];
  private readonly intervalSec: number;
  private latest: StatusResponse | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<StatusResponse> | null = null;
  private readonly backoff: Map<string, number> = new Map();

  constructor(opts: PollerOptions) {
    this.adapters = opts.adapters;
    this.intervalSec = opts.intervalSec;
  }

  /** Start polling: fires an immediate poll then schedules the interval. */
  start(): void {
    this.poll().catch(() => undefined);
    this.scheduleNext();
  }

  /** Stop the polling interval. Does not abort any in-flight poll. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Return the latest cached result, or null if no poll has completed yet. */
  getLatest(): StatusResponse | null {
    return this.latest;
  }

  /**
   * Trigger an out-of-cycle poll.
   * If a poll is already in flight, returns the same promise (no double-poll).
   */
  refreshNow(): Promise<StatusResponse> {
    if (this.inFlight) return this.inFlight;
    return this.poll();
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.poll().catch(() => undefined);
      this.scheduleNext();
    }, this.intervalSec * 1000);
  }

  private poll(): Promise<StatusResponse> {
    const activeAdapters = this.adapters.filter(adapter => {
      const remaining = this.backoff.get(adapter.id) ?? 0;
      if (remaining > 0) {
        this.backoff.set(adapter.id, remaining - 1);
        return false;
      }
      return true;
    });

    const activeIds = new Set(activeAdapters.map(adapter => adapter.id));
    const wrappedAdapters: IProviderAdapter[] = activeAdapters.map(adapter => ({
      id: adapter.id,
      displayName: adapter.displayName,
      fetch: async () => {
        const result = await adapter.fetch();
        if (result.error?.code === 'RATE_LIMITED') {
          this.backoff.set(adapter.id, 2);
        }
        return result;
      },
    }));

    const skippedResults: UsageData[] = this.adapters
      .filter(adapter => !activeIds.has(adapter.id))
      .map(adapter => this.cachedOrRateLimited(adapter));

    const pollPromise = (async () => {
      try {
        const freshResult = await aggregate(wrappedAdapters);
        const providers = [...freshResult.providers, ...skippedResults];
        providers.sort((left, right) => this.adapterIndex(left.providerId) - this.adapterIndex(right.providerId));

        const result: StatusResponse = {
          providers,
          generatedAt: freshResult.generatedAt,
        };
        this.latest = result;
        return result;
      } finally {
        this.inFlight = null;
      }
    })();

    this.inFlight = pollPromise;
    return pollPromise;
  }

  private cachedOrRateLimited(adapter: IProviderAdapter): UsageData {
    const cached = this.latest?.providers.find(provider => provider.providerId === adapter.id);
    if (cached) return cached;

    return {
      providerId: adapter.id,
      displayName: adapter.displayName,
      state: 'unavailable',
      windows: [],
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limited — waiting to retry',
        hint: 'Wait a few minutes before refreshing',
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  private adapterIndex(providerId: string): number {
    return this.adapters.findIndex(adapter => adapter.id === providerId);
  }
}
