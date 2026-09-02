import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOpenCodeGoToken } from '../core/credentials.js';
import { OpenCodeGoAdapter, parseGoUsage } from './opencode-go.js';

vi.mock('../core/credentials.js', () => ({
  getOpenCodeGoToken: vi.fn(),
}));

const TOKEN = 'sk-OPENCODE-TEST';
const happyResponse = {
  usage: {
    rolling: {
      status: 'ok',
      percent: 17,
      resetsAt: '2026-09-02T12:00:00.000Z',
    },
    weekly: {
      status: 'ok',
      percent: 42,
      resetsAt: '2026-09-07T00:00:00.000Z',
    },
    monthly: {
      status: 'ok',
      percent: 55,
      resetsAt: '2026-10-01T00:00:00.000Z',
    },
  },
};

function stubJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubText(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('parseGoUsage', () => {
  it('maps all official usage windows', () => {
    expect(parseGoUsage(happyResponse)?.windows).toEqual([
      {
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 17,
        resetsAt: '2026-09-02T12:00:00.000Z',
      },
      {
        label: 'Weekly',
        windowSeconds: 604_800,
        usedPercent: 42,
        resetsAt: '2026-09-07T00:00:00.000Z',
      },
      {
        label: 'Monthly',
        windowSeconds: 2_592_000,
        usedPercent: 55,
        resetsAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
  });

  it('rejects missing, invalid, and out-of-range window fields', () => {
    expect(parseGoUsage({})).toBeNull();
    expect(parseGoUsage({ usage: { rolling: {} } })).toBeNull();
    expect(
      parseGoUsage({
        ...happyResponse,
        usage: {
          ...happyResponse.usage,
          rolling: { ...happyResponse.usage.rolling, percent: 101 },
        },
      }),
    ).toBeNull();
    expect(
      parseGoUsage({
        ...happyResponse,
        usage: {
          ...happyResponse.usage,
          weekly: { ...happyResponse.usage.weekly, resetsAt: 'not-a-date' },
        },
      }),
    ).toBeNull();
  });
});

describe('OpenCodeGoAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches and maps the official Go usage API', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    const fetchMock = stubJson(happyResponse);

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('ok');
    expect(result.windows).toHaveLength(3);
    expect(result.windows.map((window) => window.usedPercent)).toEqual([
      17, 42, 55,
    ]);
    expect(result.credits).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/usage',
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          'User-Agent': 'llm-usage',
        },
        redirect: 'error',
      },
    );
  });

  it('returns unconfigured when no API key is found', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('unconfigured');
    expect(result.error?.code).toBe('NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 to AUTH_EXPIRED without leaking the API key', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    stubJson(
      { type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } },
      401,
    );

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.error?.code).toBe('AUTH_EXPIRED');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('maps a missing Go subscription to NOT_ENTITLED', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    stubJson(
      {
        type: 'error',
        error: {
          type: 'EntitlementError',
          message: 'OpenCode Go subscription required.',
        },
      },
      403,
    );

    const result = await new OpenCodeGoAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('NOT_ENTITLED');
  });

  it('maps rate limits and unexpected HTTP errors', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    stubJson({}, 429);
    const rateLimited = await new OpenCodeGoAdapter().fetch();

    stubJson({}, 500);
    const failed = await new OpenCodeGoAdapter().fetch();

    expect(rateLimited.error?.code).toBe('RATE_LIMITED');
    expect(failed.error?.code).toBe('NETWORK');
  });

  it('returns PARSE for invalid JSON or response structure', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    stubText('{');
    const invalidJson = await new OpenCodeGoAdapter().fetch();

    stubJson({ usage: {} });
    const invalidShape = await new OpenCodeGoAdapter().fetch();

    expect(invalidJson.error?.code).toBe('PARSE');
    expect(invalidShape.error?.code).toBe('PARSE');
  });

  it('re-fetches current usage on every call', async () => {
    vi.mocked(getOpenCodeGoToken).mockResolvedValue(TOKEN);
    const secondResponse = {
      ...happyResponse,
      usage: {
        ...happyResponse.usage,
        rolling: { ...happyResponse.usage.rolling, percent: 88 },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(happyResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondResponse)));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenCodeGoAdapter();
    const first = await adapter.fetch();
    const second = await adapter.fetch();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.windows[0]?.usedPercent).toBe(17);
    expect(second.windows[0]?.usedPercent).toBe(88);
  });
});
