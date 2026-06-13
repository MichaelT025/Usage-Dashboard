import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Poller } from './poller.js';
import type { IProviderAdapter, ProviderId, UsageData } from './types.js';

function usage(providerId: ProviderId, displayName: string, state: UsageData['state'] = 'ok'): UsageData {
  return {
    providerId,
    displayName,
    state,
    windows: [],
    fetchedAt: new Date().toISOString(),
  };
}

function rateLimitedUsage(providerId: ProviderId, displayName: string): UsageData {
  return {
    providerId,
    displayName,
    state: 'unavailable',
    windows: [],
    error: {
      code: 'RATE_LIMITED',
      message: 'rate limited',
      hint: 'wait',
    },
    fetchedAt: new Date().toISOString(),
  };
}

async function writeEvidence(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function appendEvidence(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `\n${content}`, 'utf8');
}

describe('Poller', () => {
  it('uses a refresh concurrency lock so same-tick refreshes do not double-poll', async () => {
    let resolveFetch: (value: UsageData) => void = () => {
      throw new Error('fetch resolver was not initialized');
    };
    const fetch = vi.fn(() => new Promise<UsageData>(resolve => { resolveFetch = resolve; }));
    const adapter: IProviderAdapter = { id: 'claude', displayName: 'Claude', fetch };
    const poller = new Poller({ adapters: [adapter], intervalSec: 180 });

    const first = poller.refreshNow();
    const second = poller.refreshNow();

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch(usage('claude', 'Claude'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(firstResult.providers).toHaveLength(1);
    expect(poller.getLatest()).toBe(firstResult);

    await writeEvidence(
      '.omo/evidence/task-10-lock.txt',
      [
        'Task T10 concurrency lock evidence',
        `fetchCalls=${fetch.mock.calls.length}`,
        `sameResult=${firstResult === secondResult}`,
        `latestCached=${poller.getLatest() === firstResult}`,
      ].join('\n'),
    );
  });

  it('backs off RATE_LIMITED providers for two cycles before retrying', async () => {
    const fetch = vi.fn(async () => rateLimitedUsage('codex', 'Codex'));
    const adapter: IProviderAdapter = { id: 'codex', displayName: 'Codex', fetch };
    const poller = new Poller({ adapters: [adapter], intervalSec: 180 });

    const cycle1 = await poller.refreshNow();
    const cycle2 = await poller.refreshNow();
    const cycle3 = await poller.refreshNow();
    const cycle4 = await poller.refreshNow();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cycle1.providers[0]?.error?.code).toBe('RATE_LIMITED');
    expect(cycle2.providers[0]).toBe(cycle1.providers[0]);
    expect(cycle3.providers[0]).toBe(cycle1.providers[0]);
    expect(cycle4.providers[0]?.error?.code).toBe('RATE_LIMITED');

    await appendEvidence(
      '.omo/evidence/task-10-lock.txt',
      [
        'Task T10 429 back-off evidence',
        'cycles=4',
        `fetchCalls=${fetch.mock.calls.length}`,
        'cycle1=fetch,cycle2=skip,cycle3=skip,cycle4=fetch',
      ].join('\n'),
    );
  });
});
