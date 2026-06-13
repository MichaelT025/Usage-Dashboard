import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClaudeToken } from '../core/credentials.js';
import { ClaudeAdapter } from './claude.js';

vi.mock('../core/credentials.js', () => ({
  getClaudeToken: vi.fn(),
}));

const mockedGetClaudeToken = vi.mocked(getClaudeToken);
const TOKEN = 'sk-ant-oat01-FAKE';

async function writeEvidence(filename: string, result: unknown): Promise<void> {
  const dir = path.join(process.cwd(), '.omo', 'evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

describe('ClaudeAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses live-shape usage from the OAuth usage API', async () => {
    mockedGetClaudeToken.mockResolvedValue(TOKEN);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 35, resets_at: '2026-02-06T22:00:00+00:00' },
        seven_day: { utilization: 14, resets_at: '2026-02-12T20:00:00+00:00' },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 5 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new ClaudeAdapter();
    const result = await adapter.fetch();

    expect(result.state).toBe('ok');
    expect(result.windows[0]?.label).toBe('5h');
    expect(result.windows[0]?.usedPercent).toBe(35);
    expect(result.windows[1]?.label).toBe('Weekly');
    expect(result.windows[1]?.usedPercent).toBe(14);
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
    });

    await writeEvidence('task-7-claude-happy.txt', result);
  });

  it('maps 401 to AUTH_EXPIRED without leaking the token', async () => {
    mockedGetClaudeToken.mockResolvedValue(TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const adapter = new ClaudeAdapter();
    const result = await adapter.fetch();
    const serialized = JSON.stringify(result);

    expect(result.error?.code).toBe('AUTH_EXPIRED');
    expect(serialized.includes(TOKEN)).toBe(false);

    await writeEvidence('task-7-claude-401.txt', result);
  });

  it('maps 429 to RATE_LIMITED', async () => {
    mockedGetClaudeToken.mockResolvedValue(TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));

    const adapter = new ClaudeAdapter();
    const result = await adapter.fetch();

    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('maps network errors to NETWORK without leaking the token', async () => {
    mockedGetClaudeToken.mockResolvedValue(TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const adapter = new ClaudeAdapter();
    const result = await adapter.fetch();
    const serialized = JSON.stringify(result);

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('NETWORK');
    expect(serialized.includes(TOKEN)).toBe(false);
  });

  it('returns unconfigured when the Claude token is missing', async () => {
    mockedGetClaudeToken.mockResolvedValue(null);

    const adapter = new ClaudeAdapter();
    const result = await adapter.fetch();

    expect(result.state).toBe('unconfigured');
    expect(result.error?.code).toBe('NOT_CONFIGURED');
  });
});
