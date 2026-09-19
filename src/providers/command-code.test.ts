import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWindowRow } from '../render.js';
import { getCommandCodeToken } from '../core/credentials.js';
import {
  COMMAND_CODE_ENDPOINTS,
  CommandCodeAdapter,
  normalizeCommandCodePlan,
  parseCommandCodeCredits,
  parseCommandCodeMonthly,
  parseCommandCodePlan,
  parseCommandCodeTimestamp,
  parseCommandCodeWindow,
  parseCommandCodeWindows,
} from './command-code.js';
import happy from './fixtures/command-code-happy.json' with { type: 'json' };
import malformed from './fixtures/command-code-malformed.json' with { type: 'json' };

vi.mock('../core/credentials.js', () => ({
  getCommandCodeToken: vi.fn(),
}));

const TOKEN = 'cc-TEST-TOKEN';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubSequence(
  responses: Array<Response | Error>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubHappy(): ReturnType<typeof vi.fn> {
  return stubSequence([
    jsonResponse((happy as Record<string, unknown>)['whoami']),
    jsonResponse((happy as Record<string, unknown>)['credits']),
    jsonResponse((happy as Record<string, unknown>)['subscriptions']),
    jsonResponse((happy as Record<string, unknown>)['usage']),
  ]);
}

describe('normalizeCommandCodePlan', () => {
  it('normalizes known coding plans', () => {
    expect(normalizeCommandCodePlan('go')).toBe('Go');
    expect(normalizeCommandCodePlan('GOAT')).toBe('GOAT');
    expect(normalizeCommandCodePlan('pro')).toBe('Pro');
    expect(normalizeCommandCodePlan('max')).toBe('Max');
    expect(normalizeCommandCodePlan('team')).toBe('Team');
    expect(normalizeCommandCodePlan('provider')).toBe('Provider');
  });

  it('strips individual-/teams- planId prefixes', () => {
    expect(normalizeCommandCodePlan('individual-go')).toBe('Go');
    expect(normalizeCommandCodePlan('individual-goat')).toBe('GOAT');
    expect(normalizeCommandCodePlan('individual-pro')).toBe('Pro');
    expect(normalizeCommandCodePlan('individual-max')).toBe('Max');
    expect(normalizeCommandCodePlan('individual-provider')).toBe('Provider');
    expect(normalizeCommandCodePlan('teams-pro')).toBe('Pro');
  });

  it('uses longest-prefix matching for overlapping planIds', () => {
    // individual-goat must win over the individual-go prefix.
    expect(normalizeCommandCodePlan('individual-goat-monthly')).toBe('GOAT');
    expect(normalizeCommandCodePlan('individual-go-monthly')).toBe('Go');
    expect(normalizeCommandCodePlan('individual-provider-monthly')).toBe(
      'Provider',
    );
  });
});

describe('parseCommandCodePlan', () => {
  it('reads plan from whoami shapes', () => {
    expect(parseCommandCodePlan({ plan: 'go' }, null)).toBe('Go');
    expect(parseCommandCodePlan({ user: { plan: 'pro' } }, null)).toBe('Pro');
    expect(parseCommandCodePlan({ plan: { slug: 'max' } }, null)).toBe('Max');
    expect(parseCommandCodePlan({ tier: 'team' }, null)).toBe('Team');
  });

  it('reads planId from subscriptions.data and credits pools', () => {
    expect(
      parseCommandCodePlan(null, {
        data: { planId: 'individual-goat', status: 'active' },
      }),
    ).toBe('GOAT');
    expect(
      parseCommandCodePlan(
        { user: { name: 'Michael' } },
        { data: { planId: 'individual-pro', status: 'active' } },
      ),
    ).toBe('Pro');
    expect(
      parseCommandCodePlan(
        null,
        { data: null },
        { credits: { planId: 'teams-pro' } },
      ),
    ).toBe('Pro');
    expect(
      parseCommandCodePlan(null, { data: { planId: 'individual-max' } }),
    ).toBe('Max');
  });

  it('prefers the active subscription entry', () => {
    expect(
      parseCommandCodePlan(null, {
        subscriptions: [
          { plan: 'free', status: 'canceled' },
          { plan: 'goat', status: 'active' },
        ],
      }),
    ).toBe('GOAT');
  });

  it('returns undefined when no plan is present', () => {
    expect(parseCommandCodePlan({}, {})).toBeUndefined();
    expect(
      parseCommandCodePlan(
        (malformed as Record<string, unknown>)['whoami'],
        (malformed as Record<string, unknown>)['subscriptions'],
      ),
    ).toBeUndefined();
  });
});

describe('parseCommandCodeTimestamp', () => {
  it('accepts ISO strings and epoch values', () => {
    expect(parseCommandCodeTimestamp('2026-09-02T12:00:00.000Z')).toBe(
      '2026-09-02T12:00:00.000Z',
    );
    expect(parseCommandCodeTimestamp(1_757_845_200_000)).toBe(
      new Date(1_757_845_200_000).toISOString(),
    );
    expect(parseCommandCodeTimestamp(1_757_845_200)).toBe(
      new Date(1_757_845_200_000).toISOString(),
    );
  });

  it('rejects invalid timestamps instead of fabricating', () => {
    expect(parseCommandCodeTimestamp('not-a-date')).toBeNull();
    expect(parseCommandCodeTimestamp(null)).toBeNull();
    expect(parseCommandCodeTimestamp(-5)).toBeNull();
  });

  it('returns null for overflowing numeric timestamps', () => {
    expect(parseCommandCodeTimestamp(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(parseCommandCodeTimestamp(1e21)).toBeNull();
  });
});

describe('parseCommandCodeWindows', () => {
  it('maps 5h and weekly windows from the happy credits fixture', () => {
    const windows = parseCommandCodeWindows(
      (happy as Record<string, unknown>)['credits'],
    );
    expect(windows).toEqual([
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
    ]);
  });

  it('tolerates nested credits.windowLimits', () => {
    const windows = parseCommandCodeWindows({
      credits: {
        windowLimits: {
          fiveHour: {
            used: 50,
            cap: 200,
            resetAt: '2026-09-02T12:00:00.000Z',
          },
        },
      },
    });
    expect(windows).toMatchObject([{ label: '5h', usedPercent: 25 }]);
  });

  it('supports used/cap pairs with epoch reset timestamps', () => {
    const seconds = 1_757_845_200;
    const windows = parseCommandCodeWindows({
      windowLimits: {
        fiveHour: { used: 1, cap: 4, resetAt: seconds },
        weekly: {
          used: 1,
          cap: 4,
          resetAt: seconds * 1000,
        },
      },
    });
    expect(windows).toHaveLength(2);
    expect(windows?.[0]).toMatchObject({ label: '5h', usedPercent: 25 });
    expect(windows?.[0]?.resetsAt).toBe(new Date(seconds * 1000).toISOString());
  });

  it('supports utilization fractions and used/limit pairs', () => {
    expect(
      parseCommandCodeWindow(
        { utilization: 0.25, resetsAt: '2026-09-02T12:00:00.000Z' },
        '5h',
        18_000,
      ),
    ).toMatchObject({ usedPercent: 25 });
    expect(
      parseCommandCodeWindow(
        { used: 25, limit: 100, resets_at: '2026-09-02T12:00:00.000Z' },
        'Weekly',
        604_800,
      ),
    ).toMatchObject({ usedPercent: 25 });
    expect(
      parseCommandCodeWindow(
        { used: 250, cap: 100, resetAt: '2026-09-02T12:00:00.000Z' },
        '5h',
        18_000,
      ),
    ).toMatchObject({ usedPercent: 100 });
  });

  it('never fabricates windows from malformed input', () => {
    expect(
      parseCommandCodeWindows(
        (malformed as Record<string, unknown>)['credits'],
      ),
    ).toBeNull();
    expect(parseCommandCodeWindows({})).toBeNull();
    expect(parseCommandCodeWindows({ usage: {} })).toBeNull();
    expect(
      parseCommandCodeWindow(
        { percent: 101, resetsAt: '2026-09-02T12:00:00.000Z' },
        '5h',
        18_000,
      ),
    ).toBeNull();
    expect(
      parseCommandCodeWindow({ percent: 10, resetsAt: 'never' }, '5h', 18_000),
    ).toBeNull();
  });
});

describe('live inactive GOAT quota response', () => {
  const credits = { credits: { monthlyCredits: 70 }, windowLimits: {
    fiveHour: { used: 0, cap: 14, resetAt: 0 },
    weekly: { used: 0, cap: 35, resetAt: 0 },
  } };
  const subscriptions = { data: { currentPeriodStart: '2026-09-19T22:58:48.000Z', currentPeriodEnd: '2026-10-19T22:58:48.000Z' } };
  it('keeps inactive rolling windows without invented reset dates', () => {
    expect(parseCommandCodeWindows(credits)).toEqual([
      { label: '5h', windowSeconds: 18000, usedPercent: 0, resetsAt: null },
      { label: 'Weekly', windowSeconds: 604800, usedPercent: 0, resetsAt: null },
    ]);
    expect(parseCommandCodeWindow({ used: 2, cap: 14, resetAt: 0 }, '5h', 18000)).toBeNull();
  });
  it('uses included credits consumed, not total cost or purchased credits', () => {
    expect(parseCommandCodeMonthly(credits, subscriptions, { totalMonthlyCredits: 0, periodBasis: 'billing-period' })).toMatchObject({ label: 'Monthly', usedPercent: 0, resetsAt: '2026-10-19T22:58:48.000Z' });
    expect(parseCommandCodeMonthly({ credits: { monthlyCredits: 56, purchasedCredits: 100 } }, subscriptions, { totalMonthlyCredits: 14, totalCost: 99, periodBasis: 'billing-period' })).toMatchObject({ usedPercent: 20 });
    expect(parseCommandCodeMonthly(credits, subscriptions, { totalCost: 0 })).toBeNull();
    expect(parseCommandCodeMonthly(credits, subscriptions, { totalMonthlyCredits: 0, periodBasis: 'all-time' })).toBeNull();
  });
});

describe('parseCommandCodeCredits', () => {
  it('aggregates credit pools and maps summary totalCost', () => {
    // CreditsInfo cannot distinguish pools, so monthly + purchased + free
    // are reported as one aggregate balance (100 + 25 + 12.5).
    expect(
      parseCommandCodeCredits(
        (happy as Record<string, unknown>)['credits'],
        (happy as Record<string, unknown>)['subscriptions'],
        (happy as Record<string, unknown>)['usage'],
      ),
    ).toMatchObject({ label: 'Balance', balanceUsd: 137.5, valueUsd: 3.25 });
    expect(
      parseCommandCodeCredits(
        (happy as Record<string, unknown>)['credits'],
        null,
      ),
    ).toMatchObject({ balanceUsd: 137.5 });
    expect(
      parseCommandCodeCredits(
        {
          monthlyCredits: 100,
          credits: { monthlyCredits: 100 },
        },
        null,
      ),
    ).toMatchObject({ balanceUsd: 100 });
    expect(parseCommandCodeCredits({}, {})).toBeUndefined();
    expect(
      parseCommandCodeCredits('not-an-object', { subscriptions: [] }),
    ).toBeUndefined();
  });

  it('never fabricates zeros from malformed credit shapes', () => {
    expect(
      parseCommandCodeCredits(
        (malformed as Record<string, unknown>)['credits'],
        (malformed as Record<string, unknown>)['subscriptions'],
        (malformed as Record<string, unknown>)['usage'],
      ),
    ).toBeUndefined();
  });
});

describe('CommandCodeAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches the alpha endpoints and normalizes usage', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    const fetchMock = stubHappy();

    const result = await new CommandCodeAdapter().fetch();

    expect(result.providerId).toBe('command-code');
    expect(result.state).toBe('ok');
    expect(result.plan).toBe('Go');
    expect(result.windows).toHaveLength(2);
    expect(result.credits).toMatchObject({ balanceUsd: 137.5, valueUsd: 3.25 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      COMMAND_CODE_ENDPOINTS.whoami,
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          'User-Agent': 'llm-usage',
        },
        redirect: 'error',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `${COMMAND_CODE_ENDPOINTS.usage}?since=2026-09-01T00%3A00%3A00.000Z`,
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          'User-Agent': 'llm-usage',
        },
        redirect: 'error',
      }),
    );
    // A single shared AbortSignal bounds the whole poll so it cannot hang.
    const signals = fetchMock.mock.calls.map((call) => (call[1] as { signal?: unknown })?.signal);
    expect(signals).toHaveLength(4);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(signals).size).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('adds org and billing-period query parameters when available', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    const fetchMock = stubSequence([
      jsonResponse({ org: { id: 'org_fixture' } }),
      jsonResponse((happy as Record<string, unknown>)['credits']),
      jsonResponse((happy as Record<string, unknown>)['subscriptions']),
      jsonResponse((happy as Record<string, unknown>)['usage']),
    ]);

    await new CommandCodeAdapter().fetch();

    const creditsUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    const subscriptionsUrl = new URL(fetchMock.mock.calls[2]?.[0] as string);
    const usageUrl = new URL(fetchMock.mock.calls[3]?.[0] as string);
    expect(creditsUrl.searchParams.get('orgId')).toBe('org_fixture');
    expect(subscriptionsUrl.searchParams.get('orgId')).toBe('org_fixture');
    expect(usageUrl.searchParams.get('orgId')).toBe('org_fixture');
    expect(usageUrl.searchParams.get('since')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('represents credits-only Provider plans without fake windows', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'provider' }),
      jsonResponse({ balanceUsd: 20 }),
      jsonResponse({ subscriptions: [{ plan: 'provider', status: 'active' }] }),
      jsonResponse({ usage: {} }),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('ok');
    expect(result.plan).toBe('Provider');
    expect(result.windows).toEqual([]);
    expect(result.credits).toMatchObject({ balanceUsd: 20 });
  });

  it('renders all three windows for the live inactive GOAT shape', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({}),
      jsonResponse({ credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { fiveHour: { used: 0, cap: 14, resetAt: 0 }, weekly: { used: 0, cap: 35, resetAt: 0 } } }),
      jsonResponse({ data: { planId: 'individual-goat', currentPeriodStart: '2026-09-19T22:58:48.000Z', currentPeriodEnd: '2026-10-19T22:58:48.000Z' } }),
      jsonResponse({ totalMonthlyCredits: 0, totalCost: 0, periodBasis: 'billing-period' }),
    ]);
    const result = await new CommandCodeAdapter().fetch();
    expect(result.state).toBe('ok');
    expect(result.windows.map(w => w.label)).toEqual(['5h', 'Weekly', 'Monthly']);
    const output = renderWindowRow(result.windows[0]!, { cols: 80, color: false });
    expect(output).toContain('Starts on first use');
    expect(output).not.toContain('NaN');
  });

  it('reports malformed successful JSON as PARSE', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({}),
      new Response('{invalid json', { status: 200 }),
      jsonResponse({ data: { planId: 'individual-pro' } }),
      jsonResponse({ totalCost: 1 }),
    ]);
    const result = await new CommandCodeAdapter().fetch();
    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('PARSE');
  });

  it('returns unconfigured when no API key is found', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unconfigured');
    expect(result.error?.code).toBe('NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 to AUTH_EXPIRED without leaking the key', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ error: 'unauthorized' }, 401),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('AUTH_EXPIRED');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('maps upgrade-required 403 to NOT_ENTITLED', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'free' }),
      jsonResponse({}),
      jsonResponse(
        { error: { type: 'EntitlementError', message: 'upgrade required' } },
        403,
      ),
      jsonResponse({ usage: {} }),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    // Conservative snapshot: the failed subscriptions endpoint fails the
    // whole snapshot even though whoami returned a plan label.
    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('NOT_ENTITLED');
  });

  it('maps bare 403 to AUTH_EXPIRED', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'pro' }),
      jsonResponse({ error: 'forbidden' }, 403),
      jsonResponse((happy as Record<string, unknown>)['subscriptions']),
      jsonResponse((happy as Record<string, unknown>)['usage']),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('AUTH_EXPIRED');
  });

  it('prioritizes authentication errors over rate limiting', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ error: 'unauthorized' }, 401),
      jsonResponse({}, 429),
      jsonResponse((happy as Record<string, unknown>)['subscriptions']),
      jsonResponse((happy as Record<string, unknown>)['usage']),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.error?.code).toBe('AUTH_EXPIRED');
  });

  it('fails the whole snapshot when any endpoint fails, even with a plan', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'pro' }),
      jsonResponse((happy as Record<string, unknown>)['credits']),
      jsonResponse({ error: 'boom' }, 500),
      jsonResponse((happy as Record<string, unknown>)['usage']),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('NETWORK');
    expect(JSON.stringify(result)).toContain('HTTP 500');
  });

  it('treats plan-only success as PARSE without usable usage or credits', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'pro' }),
      jsonResponse({}),
      jsonResponse({ data: null }),
      jsonResponse({}),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('PARSE');
  });

  it('keeps RATE_LIMITED when usable credits accompany a 429', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({ plan: 'pro' }),
      jsonResponse((happy as Record<string, unknown>)['credits']),
      jsonResponse((happy as Record<string, unknown>)['subscriptions']),
      jsonResponse({}, 429),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    // Rate limiting wins over partial data so the poller can back off.
    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('maps aborted requests to NETWORK and shares one timeout signal', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const pending = new CommandCodeAdapter().fetch();
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await pending;

      expect(result.state).toBe('unavailable');
      expect(result.error?.code).toBe('NETWORK');
      expect(fetchMock).toHaveBeenCalled();
      const signal = (fetchMock.mock.calls[0]?.[1] as { signal?: unknown })?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns NOT_ENTITLED when nothing usable remains', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({ error: { type: 'EntitlementError' } }, 403),
      jsonResponse({ usage: {} }),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.error?.code).toBe('NOT_ENTITLED');
  });

  it('maps 429 to RATE_LIMITED and network throws to NETWORK', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}, 429),
    ]);
    const rateLimited = await new CommandCodeAdapter().fetch();
    expect(rateLimited.error?.code).toBe('RATE_LIMITED');

    stubSequence([
      new Error('socket hang up'),
      new Error('socket hang up'),
      new Error('socket hang up'),
      new Error('socket hang up'),
    ]);
    const offline = await new CommandCodeAdapter().fetch();
    expect(offline.error?.code).toBe('NETWORK');
    expect(JSON.stringify(offline)).not.toContain(TOKEN);
  });

  it('returns PARSE for malformed alpha responses, never zero windows', async () => {
    vi.mocked(getCommandCodeToken).mockResolvedValue(TOKEN);
    stubSequence([
      jsonResponse((malformed as Record<string, unknown>)['whoami']),
      jsonResponse((malformed as Record<string, unknown>)['credits']),
      jsonResponse((malformed as Record<string, unknown>)['subscriptions']),
      jsonResponse((malformed as Record<string, unknown>)['usage']),
    ]);

    const result = await new CommandCodeAdapter().fetch();

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('PARSE');
    expect(result.windows).toEqual([]);
  });

  it('never rejects on unexpected failures', async () => {
    vi.mocked(getCommandCodeToken).mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));

    const result = await new CommandCodeAdapter().fetch();

    expect(result.providerId).toBe('command-code');
    expect(result.state).toBe('unavailable');
    expect(result.error).toBeDefined();
  });
});
