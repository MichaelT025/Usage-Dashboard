import type {
  IProviderAdapter,
  ProviderError,
  QuotaWindow,
  UsageData,
} from '../core/types.js';
import { getCommandCodeToken } from '../core/credentials.js';
import { redactSecrets, safeErrorMessage } from '../core/redact.js';

export const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai';
export const COMMAND_CODE_ENDPOINTS = {
  whoami: `${COMMAND_CODE_API_BASE}/alpha/whoami`,
  credits: `${COMMAND_CODE_API_BASE}/alpha/billing/credits`,
  subscriptions: `${COMMAND_CODE_API_BASE}/alpha/billing/subscriptions`,
  usage: `${COMMAND_CODE_API_BASE}/alpha/usage/summary`,
} as const;

const WINDOW_SECONDS: Record<string, number> = {
  '5h': 18_000,
  Weekly: 604_800,
  Monthly: 2_592_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Normalize a timestamp to ISO 8601. Accepts ISO strings and epoch
 * seconds/milliseconds. Returns null instead of fabricating a value.
 */
export function parseCommandCodeTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    try {
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
    if (ms === null || !Number.isFinite(ms)) return null;
    try {
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

const PLAN_LABELS: Record<string, string> = {
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  provider: 'Provider',
  free: 'Free',
  plus: 'Plus',
  business: 'Business',
  enterprise: 'Enterprise',
};

/**
 * Known planId prefixes mapped to readable labels, longest first.
 * Actual subscriptions/credits payloads use ids like `individual-go`,
 * `individual-goat`, `individual-pro`, `individual-max`,
 * `individual-provider`, and `teams-pro` (optionally with a billing-cadence
 * suffix such as `-monthly`). Longest-prefix matching ensures
 * `individual-goat*` wins over `individual-go*`.
 */
const PLAN_ID_PREFIX_LABELS: Array<[prefix: string, label: string]> = [
  ['individual-provider', 'Provider'],
  ['individual-goat', 'GOAT'],
  ['individual-max', 'Max'],
  ['individual-pro', 'Pro'],
  ['individual-go', 'Go'],
  ['teams-pro', 'Pro'],
  ['team-pro', 'Pro'],
];

const PLAN_NAMESPACE_PREFIXES = [
  'individual-',
  'teams-',
  'team-',
  'organization-',
  'org-',
];

/** Normalize a raw plan slug/name/id into a readable label. */
export function normalizeCommandCodePlan(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  const lower = trimmed.toLowerCase();
  const dashed = lower.replace(/[_\s]+/g, '-');
  for (const [prefix, label] of PLAN_ID_PREFIX_LABELS) {
    if (dashed === prefix || dashed.startsWith(`${prefix}-`)) {
      return label;
    }
  }
  const mapped = PLAN_LABELS[lower];
  if (mapped) return mapped;
  for (const ns of PLAN_NAMESPACE_PREFIXES) {
    if (dashed.startsWith(ns)) {
      const remainder = trimmed.slice(ns.length).trim();
      if (remainder.length === 0) break;
      const remainderLower = remainder.toLowerCase();
      const remainderMapped = PLAN_LABELS[remainderLower];
      if (remainderMapped) return remainderMapped;
      return toTitleCase(remainder);
    }
  }
  return toTitleCase(trimmed);
}

function toTitleCase(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      word.toUpperCase() === 'GOAT'
        ? 'GOAT'
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

function planStringFromRecord(record: Record<string, unknown>): string | null {
  const candidates = [
    record['plan'],
    record['planName'],
    record['plan_name'],
    record['planId'],
    record['plan_id'],
    record['planSlug'],
    record['plan_slug'],
    record['tier'],
    record['slug'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return normalizeCommandCodePlan(candidate);
    }
    if (isRecord(candidate)) {
      const nested =
        candidate['name'] ?? candidate['slug'] ?? candidate['tier'];
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return normalizeCommandCodePlan(nested);
      }
    }
  }
  return null;
}

function firstArrayIn(value: unknown): Array<unknown> | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of ['subscriptions', 'data', 'items', 'plans']) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
  }
  return null;
}

/**
 * Derive a plan label from whoami, subscriptions, and credits payloads.
 * Supports the discovered `{ data: { planId, status, ... } | null }`
 * subscriptions shape (single object under `data`, not just arrays) as well
 * as `planId` inside `credits.credits`. Returns undefined when no plan can
 * be determined (never fabricates).
 */
export function parseCommandCodePlan(
  whoami: unknown,
  subscriptions: unknown,
  creditsJson?: unknown,
): string | undefined {
  const sources: unknown[] = [];
  if (isRecord(whoami)) {
    sources.push(
      whoami,
      whoami['user'],
      whoami['account'],
      whoami['subscription'],
      whoami['plan'],
    );
  }
  const subs = firstArrayIn(subscriptions);
  if (subs) {
    const active =
      subs.find(
        (entry) =>
          isRecord(entry) &&
          typeof entry['status'] === 'string' &&
          ['active', 'trialing', 'past_due'].includes(
            (entry['status'] as string).toLowerCase(),
          ),
      ) ?? subs[0];
    sources.push(active);
    if (isRecord(subscriptions)) sources.push(subscriptions);
  } else if (isRecord(subscriptions)) {
    const data = subscriptions['data'];
    if (isRecord(data)) sources.push(data);
    sources.push(
      subscriptions,
      subscriptions['subscription'],
      subscriptions['current'],
    );
  }
  if (isRecord(creditsJson)) {
    sources.push(creditsJson, creditsJson['credits']);
  }

  for (const source of sources) {
    if (typeof source === 'string' && source.trim().length > 0) {
      return normalizeCommandCodePlan(source);
    }
    if (isRecord(source)) {
      const label = planStringFromRecord(source);
      if (label) return label;
    }
  }
  return undefined;
}

function percentFromParts(
  used: number | null,
  limit: number | null,
  remaining: number | null,
): number | null {
  if (used !== null && limit !== null && limit > 0 && used >= 0) {
    return Math.min(100, round2((used / limit) * 100));
  }
  if (
    remaining !== null &&
    limit !== null &&
    limit > 0 &&
    remaining >= 0 &&
    remaining <= limit
  ) {
    return Math.min(100, round2(((limit - remaining) / limit) * 100));
  }
  return null;
}

/** Parse one quota window; returns null instead of fabricating values. */
export function parseCommandCodeWindow(
  value: unknown,
  label: string,
  windowSeconds: number,
): QuotaWindow | null {
  if (!isRecord(value)) return null;

  let percent: number | null = null;
  const directKeys = [
    'percent',
    'usedPercent',
    'used_percent',
    'usagePercent',
    'usage_percent',
    'percentage',
  ];
  for (const key of directKeys) {
    const num = toFiniteNumber(value[key]);
    if (num !== null && num >= 0 && num <= 100) {
      percent = round2(num);
      break;
    }
  }
  if (percent === null) {
    const utilization = toFiniteNumber(
      value['utilization'] ?? value['usedRatio'] ?? value['used_ratio'],
    );
    if (utilization !== null && utilization >= 0 && utilization <= 1) {
      percent = round2(utilization * 100);
    }
  }
  if (percent === null) {
    percent = percentFromParts(
      toFiniteNumber(
        value['used'] ?? value['usedCredits'] ?? value['used_credits'],
      ),
      toFiniteNumber(
        value['limit'] ??
          value['cap'] ??
          value['total'] ??
          value['quota'] ??
          value['max'],
      ),
      toFiniteNumber(
        value['remaining'] ??
          value['remainingCredits'] ??
          value['remaining_credits'],
      ),
    );
  }
  if (percent === null || percent < 0 || percent > 100) return null;

  const resetsAt = parseCommandCodeTimestamp(
    value['resetsAt'] ??
      value['resets_at'] ??
      value['reset_at'] ??
      value['resetAt'] ??
      value['expires_at'] ??
      value['expiresAt'] ??
      value['reset'] ??
      value['resets'],
  );
  if (!resetsAt) {
    // Live API uses zero for rolling windows that have not started.
    // Accept only an explicit zero reset with explicit zero consumption.
    if (value['resetAt'] === 0 && value['used'] === 0 && percent === 0) {
      return { label, windowSeconds, usedPercent: 0, resetsAt: null };
    }
    return null;
  }

  return { label, windowSeconds, usedPercent: percent, resetsAt };
}

const WINDOW_KEY_MAP: Array<{
  keys: string[];
  label: string;
}> = [
  {
    keys: ['five_hour', 'fiveHour', 'five-hour', 'rolling', '5h', 'session'],
    label: '5h',
  },
  {
    keys: [
      'seven_day',
      'sevenDay',
      'seven-day',
      'weekly',
      'week',
      'trailing7d',
    ],
    label: 'Weekly',
  },
  {
    keys: [
      'thirty_day',
      'thirtyDay',
      'monthly',
      'month',
      'calendar_month',
      'calendarMonth',
    ],
    label: 'Monthly',
  },
];

function containerCandidates(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (!isRecord(value)) return out;
  out.push(value);
  for (const key of [
    'usage',
    'quotas',
    'windows',
    'data',
    'summary',
    'windowLimits',
    'window_limits',
    'windowlimits',
    'limits',
    'credits',
  ]) {
    const nested = value[key];
    if (isRecord(nested)) out.push(nested);
  }
  // Tolerate nested `credits.windowLimits` (actual credits response nests
  // credit pools under `credits` while window limits sit alongside it).
  if (isRecord(value['credits'])) {
    const inner = value['credits'] as Record<string, unknown>;
    for (const key of ['windowLimits', 'window_limits', 'limits']) {
      const nested = inner[key];
      if (isRecord(nested)) out.push(nested);
    }
  }
  return out;
}

/**
 * Normalize 5h/weekly (/monthly) windows from an alpha usage/summary payload.
 * Returns null when no window can be validated; never fabricates zero values.
 */
export function parseCommandCodeWindows(value: unknown): QuotaWindow[] | null {
  if (Array.isArray(value)) {
    const windows: QuotaWindow[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const rawLabel = entry['label'] ?? entry['name'] ?? entry['window'];
      const seconds =
        toFiniteNumber(entry['windowSeconds'] ?? entry['window_seconds']) ??
        (typeof rawLabel === 'string' && WINDOW_SECONDS[rawLabel] != null
          ? WINDOW_SECONDS[rawLabel]
          : undefined);
      if (typeof rawLabel !== 'string' || seconds == null) continue;
      const parsed = parseCommandCodeWindow(entry, rawLabel, seconds);
      if (parsed) windows.push(parsed);
    }
    return windows.length > 0 ? windows : null;
  }

  const containers = containerCandidates(value);
  if (containers.length === 0) return null;
  const windows: QuotaWindow[] = [];
  for (const { keys, label } of WINDOW_KEY_MAP) {
    for (const container of containers) {
      let found = false;
      for (const key of keys) {
        if (key in container) {
          const parsed = parseCommandCodeWindow(
            container[key],
            label,
            WINDOW_SECONDS[label]!,
          );
          if (parsed) {
            windows.push(parsed);
            found = true;
          }
          break;
        }
      }
      if (found) break;
    }
  }
  return windows.length > 0 ? windows : null;
}

export function parseCommandCodeMonthly(
  credits: unknown,
  subscriptions: unknown,
  usage: unknown,
): QuotaWindow | null {
  if (!isRecord(credits) || !isRecord(credits['credits']) ||
      !isRecord(subscriptions) || !isRecord(subscriptions['data']) ||
      !isRecord(usage) || usage['periodBasis'] !== 'billing-period') return null;
  const remaining = toFiniteNumber(credits['credits']['monthlyCredits']);
  const used = toFiniteNumber(usage['totalMonthlyCredits']);
  const end = parseCommandCodeTimestamp(subscriptions['data']['currentPeriodEnd']);
  const start = parseCommandCodeTimestamp(subscriptions['data']['currentPeriodStart']);
  if (remaining === null || used === null || remaining < 0 || used < 0 ||
      remaining + used <= 0 || !end || !start || Date.parse(end) <= Date.parse(start)) return null;
  // Included credits consumed + remaining form the current period pool.
  // Purchased/free credits and model dollar cost are not monthly quota usage.
  return {
    label: 'Monthly',
    windowSeconds: (Date.parse(end) - Date.parse(start)) / 1000,
    usedPercent: Math.min(100, round2(used / (used + remaining) * 100)),
    resetsAt: end,
  };
}

function creditNumberFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const num = toFiniteNumber(record[key]);
    if (num !== null) return num;
  }
  for (const nestedKey of ['credits', 'balance', 'usage', 'totals']) {
    const nested = record[nestedKey];
    if (isRecord(nested)) {
      for (const key of keys) {
        const num = toFiniteNumber(nested[key]);
        if (num !== null) return num;
      }
    }
  }
  return null;
}

/**
 * Normalize credit/balance info from the discovered alpha shapes:
 * credits response `{ credits: { monthlyCredits, purchasedCredits,
 * freeCredits, planId? }, windowLimits: {...} }` and usage summary
 * `{ totalCost, totalCount, totalTokens? }`.
 *
 * `CreditsInfo` cannot distinguish credit pools, so the adapter reports a
 * reasonable aggregate: `balanceUsd` = sum of the finite monthly /
 * purchased / free credit pools (undefined when no pool is numeric, never
 * a fabricated zero), and `valueUsd` = summary `totalCost` when present.
 * Legacy `balanceUsd`/`balance`/`remaining*` and `valueUsd`/`used*` fields
 * remain supported for tolerance. Returns undefined when nothing numeric
 * is present.
 */
export function parseCommandCodeCredits(
  creditsJson: unknown,
  subscriptionsJson: unknown,
  usageJson?: unknown,
): UsageData['credits'] {
  const POOL_KEYS = [
    'monthlyCredits',
    'monthly_credits',
    'purchasedCredits',
    'purchased_credits',
    'freeCredits',
    'free_credits',
  ];
  const poolSources: Array<Record<string, unknown>> = [];
  if (isRecord(creditsJson)) {
    const root = creditsJson;
    const nested = isRecord(root['credits'])
      ? (root['credits'] as Record<string, unknown>)
      : null;
    const nestedHasPools =
      nested !== null && POOL_KEYS.some((key) => key in nested);
    poolSources.push(nestedHasPools && nested ? nested : root);
  }

  let pooledBalance: number | undefined;
  for (const source of poolSources) {
    let sum: number | undefined;
    let found = false;
    for (const key of POOL_KEYS) {
      const num = poolNumber(source[key]);
      if (num !== null) {
        found = true;
        sum = (sum ?? 0) + num;
      }
    }
    if (found && sum !== undefined) {
      pooledBalance = (pooledBalance ?? 0) + sum;
    }
  }

  const sources: Array<Record<string, unknown>> = [];
  for (const payload of [creditsJson, subscriptionsJson]) {
    if (isRecord(payload)) sources.push(payload);
    if (isRecord(payload) && isRecord(payload['credits'])) {
      sources.push(payload['credits'] as Record<string, unknown>);
    }
    if (isRecord(payload) && isRecord(payload['balance'])) {
      sources.push(payload['balance'] as Record<string, unknown>);
    }
  }
  const balanceKeys = [
    'balanceUsd',
    'balance_usd',
    'balance',
    'remaining',
    'remainingCredits',
    'remaining_credits',
    'creditBalance',
    'credit_balance',
  ];
  const valueKeys = [
    'valueUsd',
    'value_usd',
    'totalCost',
    'total_cost',
    'used',
    'usedCredits',
    'used_credits',
    'spent',
    'consumed',
  ];
  let balanceUsd: number | undefined = pooledBalance;
  let valueUsd: number | undefined;
  for (const source of sources) {
    balanceUsd ??= creditNumberFromRecord(source, balanceKeys) ?? undefined;
    valueUsd ??= creditNumberFromRecord(source, valueKeys) ?? undefined;
    if (balanceUsd !== undefined && valueUsd !== undefined) break;
  }
  if (isRecord(usageJson)) {
    const usageSources: Array<Record<string, unknown>> = [usageJson];
    for (const key of ['summary', 'usage', 'data', 'totals']) {
      const nested = usageJson[key];
      if (isRecord(nested)) usageSources.push(nested);
    }
    for (const source of usageSources) {
      valueUsd ??= creditNumberFromRecord(source, valueKeys) ?? undefined;
      if (valueUsd !== undefined) break;
    }
  }
  if (balanceUsd === undefined && valueUsd === undefined) return undefined;
  return { label: 'Balance', balanceUsd, valueUsd };
}

function poolNumber(value: unknown): number | null {
  const direct = toFiniteNumber(value);
  if (direct !== null) return direct;
  if (isRecord(value)) {
    for (const key of [
      'balance',
      'balanceUsd',
      'balance_usd',
      'remaining',
      'remainingCredits',
      'remaining_credits',
      'total',
      'credits',
      'amount',
      'value',
    ]) {
      const num = toFiniteNumber(value[key]);
      if (num !== null) return num;
    }
  }
  return null;
}

type EndpointResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'auth' }
  | { kind: 'rate' }
  | { kind: 'entitled' }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'parse' };

function isEntitlementPayload(payload: unknown): boolean {
  const text = JSON.stringify(payload ?? '').toLowerCase();
  return (
    text.includes('entitle') ||
    text.includes('upgrade_required') ||
    text.includes('subscription_required') ||
    text.includes('plan_required') ||
    text.includes('payment_required')
  );
}

async function readJsonBody(res: Response, signal?: AbortSignal): Promise<unknown> {
  if (!signal) return res.json();
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  return await Promise.race([
    res.json(),
    new Promise<never>((_, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(signal?.reason ?? new Error('aborted')),
        { once: true },
      );
    }),
  ]);
}

async function fetchEndpoint(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<EndpointResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'llm-usage',
      },
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    void redactSecrets(err);
    void safeErrorMessage(err);
    return { kind: 'network' };
  }

  if (res.status === 401) return { kind: 'auth' };
  if (res.status === 429) return { kind: 'rate' };
  if (res.status === 402 || res.status === 403) {
    let payload: unknown = null;
    try {
      payload = await readJsonBody(res, signal);
    } catch (err) {
      void redactSecrets(err);
      void safeErrorMessage(err);
      // A body read that fails (abort/parse) on an error status carries
      // no usable entitlement evidence. Bare 403 still means the key is
      // not accepted; bare 402 surfaces as an unexpected HTTP status.
      return res.status === 403
        ? { kind: 'auth' }
        : { kind: 'http', status: res.status };
    }
    if (payload !== null && isEntitlementPayload(payload)) {
      return { kind: 'entitled' };
    }
    // Bare 403 (no explicit entitlement payload) is treated as an
    // authentication failure so stale/rejected keys prompt a refresh.
    if (res.status === 403) return { kind: 'auth' };
    return { kind: 'http', status: res.status };
  }
  if (!res.ok) return { kind: 'http', status: res.status };

  try {
    return { kind: 'ok', data: await readJsonBody(res, signal) };
  } catch (err) {
    void redactSecrets(err);
    void safeErrorMessage(err);
    // Malformed JSON is a schema failure; aborted/body transport reads
    // remain network failures.
    return { kind: !signal?.aborted && err instanceof SyntaxError ? 'parse' : 'network' };
  }
}

function commandCodeQueryUrl(
  endpoint: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function commandCodeOrgId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const org = value['org'];
  if (!isRecord(org)) return undefined;
  const id = org['id'];
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

function commandCodePeriodStart(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const data = value['data'];
  if (!isRecord(data)) return undefined;
  const start = data['currentPeriodStart'];
  if (typeof start === 'string' && start.trim().length > 0) return start;
  if (typeof start === 'number' && Number.isFinite(start)) {
    return String(start);
  }
  return undefined;
}

function errorUsage(
  error: ProviderError,
  fetchedAt: string,
  state: UsageData['state'] = 'unavailable',
): UsageData {
  return {
    providerId: 'command-code',
    displayName: 'Command Code',
    state,
    windows: [],
    error,
    fetchedAt,
  };
}

export class CommandCodeAdapter implements IProviderAdapter {
  readonly id = 'command-code' as const;
  readonly displayName = 'Command Code';

  async fetch(): Promise<UsageData> {
    const fetchedAt = new Date().toISOString();
    // One overall deadline shared by all four endpoint requests so a hung
    // server poll cannot hang the dashboard refresh. The same signal also
    // bounds JSON body reads via readJsonBody.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      const signal = controller.signal;
      const token = await getCommandCodeToken();
      if (!token) {
        return errorUsage(
          {
            code: 'NOT_CONFIGURED',
            message: 'Command Code API key not found',
            hint: 'Set COMMAND_CODE_API_KEY or sign in so ~/.commandcode/auth.json contains an apiKey',
          },
          fetchedAt,
          'unconfigured',
        );
      }

      const whoami = await fetchEndpoint(
        COMMAND_CODE_ENDPOINTS.whoami,
        token,
        signal,
      );
      if (whoami.kind === 'auth') {
        return errorUsage(
          {
            code: 'AUTH_EXPIRED',
            message: 'Command Code API key was rejected',
            hint: 'Refresh the key (COMMAND_CODE_API_KEY or ~/.commandcode/auth.json) and retry',
          },
          fetchedAt,
        );
      }
      const whoamiData = whoami.kind === 'ok' ? whoami.data : null;
      const orgId = commandCodeOrgId(whoamiData);
      const credits = await fetchEndpoint(
        commandCodeQueryUrl(COMMAND_CODE_ENDPOINTS.credits, { orgId }),
        token,
        signal,
      );
      const subscriptions = await fetchEndpoint(
        commandCodeQueryUrl(COMMAND_CODE_ENDPOINTS.subscriptions, { orgId }),
        token,
        signal,
      );
      const subscriptionsData =
        subscriptions.kind === 'ok' ? subscriptions.data : null;
      const usage = await fetchEndpoint(
        commandCodeQueryUrl(COMMAND_CODE_ENDPOINTS.usage, {
          orgId,
          since: commandCodePeriodStart(subscriptionsData),
        }),
        token,
        signal,
      );

      const results = [whoami, credits, subscriptions, usage];
      // Authentication failures win over every other status so stale keys
      // always prompt a refresh instead of a misleading backoff message.
      if (results.some((result) => result.kind === 'auth')) {
        return errorUsage(
          {
            code: 'AUTH_EXPIRED',
            message: 'Command Code API key was rejected',
            hint: 'Refresh the key (COMMAND_CODE_API_KEY or ~/.commandcode/auth.json) and retry',
          },
          fetchedAt,
        );
      }
      // Rate limiting is preserved (not folded into NETWORK) so the
      // server poller can back off instead of retrying immediately.
      if (results.some((result) => result.kind === 'rate')) {
        return errorUsage(
          {
            code: 'RATE_LIMITED',
            message: 'Command Code usage API rate limited',
            hint: 'Wait before refreshing usage again',
          },
          fetchedAt,
        );
      }
      if (results.some((result) => result.kind === 'entitled')) {
        return errorUsage(
          {
            code: 'NOT_ENTITLED',
            message: 'Command Code subscription required',
            hint: 'The API key is valid, but the account has no active Command Code subscription',
          },
          fetchedAt,
        );
      }
      // Conservative snapshot: any failed endpoint fails the whole
      // snapshot. Partial data (e.g. a plan from whoami while another
      // endpoint errored) never renders as ok.
      if (results.some((result) => result.kind !== 'ok')) {
        const httpFailure = results.find((result) => result.kind === 'http');
        if (httpFailure?.kind === 'http') {
          return errorUsage(
            {
              code: 'NETWORK',
              message: `HTTP ${httpFailure.status} from Command Code usage API`,
              hint: 'The Command Code alpha API returned an unexpected response',
            },
            fetchedAt,
          );
        }
        if (results.some((result) => result.kind === 'network')) {
          return errorUsage(
            {
              code: 'NETWORK',
              message: 'Could not reach the Command Code usage API',
              hint: 'Check network connectivity and try again',
            },
            fetchedAt,
          );
        }
        return errorUsage(
          {
            code: 'PARSE',
            message: 'Could not parse Command Code usage response',
            hint: 'The Command Code alpha API format may have changed',
          },
          fetchedAt,
        );
      }

      const creditsData = credits.kind === 'ok' ? credits.data : null;
      const usageData = usage.kind === 'ok' ? usage.data : null;

      const plan = parseCommandCodePlan(
        whoamiData,
        subscriptionsData,
        creditsData,
      );
      const parsedCredits = parseCommandCodeCredits(
        creditsData,
        subscriptionsData,
        usageData,
      );
      const windows =
        parseCommandCodeWindows(creditsData) ??
        parseCommandCodeWindows(usageData) ??
        parseCommandCodeWindows(subscriptionsData) ??
        [];

      const monthly = parseCommandCodeMonthly(creditsData, subscriptionsData, usageData);
      if (monthly && plan !== 'Provider' && !windows.some((window) => window.label === 'Monthly')) {
        windows.push(monthly);
      }

      // A plan label alone is not usable usage: ok requires real
      // windows or credit data from the successful responses.
      if (parsedCredits !== undefined || windows.length > 0) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'ok',
          ...(plan !== undefined ? { plan } : {}),
          windows,
          ...(parsedCredits !== undefined ? { credits: parsedCredits } : {}),
          fetchedAt,
        };
      }
      return errorUsage(
        {
          code: 'PARSE',
          message: 'Could not parse Command Code usage response',
          hint: 'The Command Code alpha API format may have changed',
        },
        fetchedAt,
      );
    } catch (err) {
      void redactSecrets(err);
      void safeErrorMessage(err);
      return errorUsage(
        {
          code: 'UNKNOWN',
          message: 'Unexpected Command Code error',
          hint: 'An unexpected Command Code error occurred — try again later',
        },
        fetchedAt,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
