import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregator.js';
import type { IProviderAdapter, ProviderId, UsageData } from './types.js';

function okUsage(providerId: ProviderId, displayName: string): UsageData {
  return {
    providerId,
    displayName,
    state: 'ok',
    windows: [],
    fetchedAt: new Date().toISOString(),
  };
}

function adapter(
  id: ProviderId,
  displayName: string,
  fetch: () => Promise<UsageData>,
): IProviderAdapter {
  return { id, displayName, fetch };
}

async function writeEvidence(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('aggregate', () => {
  it('isolates provider failures so one thrown adapter does not affect others', async () => {
    const adapters: IProviderAdapter[] = [
      adapter('claude', 'Claude', async () => okUsage('claude', 'Claude')),
      adapter('codex', 'Codex', async () => { throw new Error('failed with Bearer sk-ant-explosion'); }),
      adapter('opencode-go', 'OpenCode Go', async () => okUsage('opencode-go', 'OpenCode Go')),
    ];

    const result = await aggregate(adapters);

    expect(result.providers).toHaveLength(3);
    expect(result.providers[0]?.state).toBe('ok');
    expect(result.providers[2]?.state).toBe('ok');
    expect(result.providers[1]?.state).toBe('unavailable');
    expect(result.providers[1]?.error?.message).toContain('[REDACTED]');
    expect(result.providers[1]?.error?.message).not.toContain('sk-ant-explosion');

    await writeEvidence(
      '.omo/evidence/task-10-isolation.txt',
      [
        'Task T10 isolation evidence',
        `providers=${result.providers.length}`,
        `states=${result.providers.map(provider => `${provider.providerId}:${provider.state}`).join(',')}`,
        `wrappedErrorCode=${result.providers[1]?.error?.code}`,
        `redacted=${!result.providers[1]?.error?.message.includes('sk-ant-explosion')}`,
      ].join('\n'),
    );
  });

  it('is directly importable and usable without an HTTP server seam', async () => {
    const result = await aggregate([
      adapter('claude', 'Claude', async () => okUsage('claude', 'Claude')),
      adapter('codex', 'Codex', async () => okUsage('codex', 'Codex')),
    ]);

    expect(result.providers).toHaveLength(2);
    expect(Date.parse(result.generatedAt)).not.toBeNaN();
  });
});
