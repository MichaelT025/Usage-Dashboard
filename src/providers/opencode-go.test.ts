import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../core/config.js';
import { OpenCodeGoAdapter } from './opencode-go.js';

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const fixtureDir = path.join(__dirname, 'fixtures');
const evidenceDir = path.join(projectRoot, '.omo', 'evidence');

const happyHtml = readFixture('opencode-go-happy.html');
const loginHtml = readFixture('opencode-go-login.html');
const malformedHtml = readFixture('opencode-go-malformed.html');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), 'utf8');
}

function writeEvidence(name: string, value: unknown): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function configured(): ReturnType<typeof loadConfig> {
  return {
    opencodeWorkspaceId: 'wrk_test',
    opencodeAuthCookie: 'Fe26.2**TESTCOOKIE',
    refreshIntervalSec: 180,
    port: 7878,
  };
}

function stubFetchText(html: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(html, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('OpenCodeGoAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('parses Go hydration usage from the web console HTML', async () => {
    vi.mocked(loadConfig).mockReturnValue(configured());
    stubFetchText(happyHtml);

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('ok');
    expect(result.windows).toHaveLength(3);
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ['5h', 17],
      ['Weekly', 42],
      ['Monthly', 55],
    ]);
    expect(result.credits?.balanceUsd).toBeCloseTo(1.23456789, 8);
    writeEvidence('task-9-go-happy.txt', result);
  });

  it('detects an expired cookie without leaking the configured cookie', async () => {
    vi.mocked(loadConfig).mockReturnValue(configured());
    stubFetchText(loginHtml);

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('COOKIE_EXPIRED');
    expect(JSON.stringify(result)).not.toContain('Fe26.2**TESTCOOKIE');
    writeEvidence('task-9-go-expired.txt', result);
  });

  it('returns PARSE for malformed hydrated usage HTML', async () => {
    vi.mocked(loadConfig).mockReturnValue(configured());
    stubFetchText(malformedHtml);

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('PARSE');
  });

  it('returns unconfigured when workspace ID or auth cookie is missing', async () => {
    vi.mocked(loadConfig).mockReturnValue({ refreshIntervalSec: 180, port: 7878 });

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('unconfigured');
    expect(result.error?.code).toBe('NOT_CONFIGURED');
    expect(result.error?.hint).toContain('llm-usage setup');
    writeEvidence('task-9-go-unconfigured.txt', result);
  });

  it('re-fetches fresh HTML on each call and keeps no adapter state', async () => {
    vi.mocked(loadConfig).mockReturnValue(configured());
    const secondHtml = happyHtml.replace('usagePercent:17', 'usagePercent:88');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(happyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(secondHtml, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenCodeGoAdapter();
    const first = await adapter.fetch();
    const second = await adapter.fetch();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.windows.find((window) => window.label === '5h')?.usedPercent).toBe(17);
    expect(second.windows.find((window) => window.label === '5h')?.usedPercent).toBe(88);
  });
});
