/**
 * Phase-2 stub: OpenCode Zen provider.
 *
 * Future data source: HTML scrape of opencode.ai/workspace/{id}/go (same as Go panel)
 * OR per-response `cost` field accumulation.
 * Credits API endpoint: none (server-side only, no public REST API).
 *
 * NOT in the active Phase-1 aggregator list.
 */
import type { IProviderAdapter, UsageData } from '../core/types.js';

export class ZenAdapter implements IProviderAdapter {
  readonly id = 'zen' as const;
  readonly displayName = 'OpenCode Zen';

  async fetch(): Promise<UsageData> {
    return {
      providerId: this.id,
      displayName: this.displayName,
      state: 'not_implemented',
      windows: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}
