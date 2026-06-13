import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCodexToken } from '../core/credentials.js';
import { CodexAdapter, parseCodexUsage } from './codex.js';

vi.mock('../core/credentials.js', () => ({ getCodexToken: vi.fn() }));

const mockGetCodexToken = vi.mocked(getCodexToken);
const evidenceDir = path.join(process.cwd(), '.omo', 'evidence');

function writeEvidence(fileName: string, value: unknown): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, fileName), JSON.stringify(value, null, 2), 'utf8');
}

function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })));
}

describe('CodexAdapter', () => {
  beforeEach(() => {
    mockGetCodexToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses wham/usage windows with unix seconds reset timestamps', async () => {
    mockGetCodexToken.mockResolvedValue({ accessToken: 'FAKE-CODEX-TOKEN' });
    stubFetch(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 24, reset_at: 1738900000, limit_window_seconds: 604800 },
      },
    });

    const result = await new CodexAdapter().fetch();

    expect(result.state).toBe('ok');
    expect(result.plan).toBe('plus');
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({ label: '5h', windowSeconds: 18000, usedPercent: 6 });
    expect(result.windows[1]).toMatchObject({ label: 'Weekly', windowSeconds: 604800, usedPercent: 24 });
    for (const window of result.windows) {
      expect(window.resetsAt).toMatch(/T.*(Z|[+-]\d{2}:\d{2})$/);
    }
    writeEvidence('task-8-codex-happy.txt', result);
  });

  it('labels swapped window durations by duration instead of position', () => {
    const parsed = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 24, reset_at: 1738900000, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
      },
    });

    expect(parsed.windows[0]).toMatchObject({ label: '5h', windowSeconds: 18000, usedPercent: 6 });
    expect(parsed.windows[1]).toMatchObject({ label: 'Weekly', windowSeconds: 604800, usedPercent: 24 });
    writeEvidence('task-8-codex-swap.txt', parsed);
  });

  it('maps 401 to AUTH_EXPIRED without leaking the token', async () => {
    mockGetCodexToken.mockResolvedValue({ accessToken: 'FAKE-CODEX-TOKEN' });
    stubFetch(401);

    const result = await new CodexAdapter().fetch();
    const serialized = JSON.stringify(result);

    expect(result.error?.code).toBe('AUTH_EXPIRED');
    expect(serialized).not.toContain('FAKE-CODEX-TOKEN');
    writeEvidence('task-8-codex-401.txt', { result, leakedToken: serialized.includes('FAKE-CODEX-TOKEN') });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    mockGetCodexToken.mockResolvedValue({ accessToken: 'FAKE-CODEX-TOKEN' });
    stubFetch(429);

    const result = await new CodexAdapter().fetch();

    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('returns unconfigured when token is missing', async () => {
    mockGetCodexToken.mockResolvedValue(null);

    const result = await new CodexAdapter().fetch();

    expect(result.state).toBe('unconfigured');
    expect(result.error?.code).toBe('NOT_CONFIGURED');
  });
});
