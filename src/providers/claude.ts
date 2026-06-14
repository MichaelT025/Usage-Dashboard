import type { IProviderAdapter, ProviderError, QuotaWindow, UsageData } from '../core/types.js';
import { getClaudeToken } from '../core/credentials.js';
import { redactSecrets, safeErrorMessage } from '../core/redact.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
// Mimic Claude Code's User-Agent — the usage endpoint rate-limits aggressively without it
const CLAUDE_UA = 'claude-code/2.1.0';
// In-memory cache: serve stale data within TTL, enforce 15-min cooldown after 429
const SUCCESS_TTL_MS = 180_000;       // 3 min — matches default poll interval
const RATE_LIMIT_BACKOFF_MS = 900_000; // 15 min
let cachedSuccess: UsageData | null = null;
let cachedSuccessAtMs = 0;
let nextAllowedAtMs = 0;

/** Reset in-memory cache — for testing only. */
export function _resetClaudeCache(): void {
  cachedSuccess = null;
  cachedSuccessAtMs = 0;
  nextAllowedAtMs = 0;
}

interface ClaudeUsageWindow {
  utilization: number;
  resets_at: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_sonnet?: ClaudeUsageWindow | null;
  seven_day_opus?: ClaudeUsageWindow | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function quotaWindow(label: string, source: ClaudeUsageWindow): QuotaWindow {
  return {
    label,
    windowSeconds: label === '5h' ? 18000 : 604800,
    usedPercent: roundPercent(source.utilization),
    resetsAt: source.resets_at,
  };
}

export function parseClaudeUsage(json: ClaudeUsageResponse): Pick<UsageData, 'windows' | 'credits'> {
  const windows: QuotaWindow[] = [];

  if (json.five_hour) {
    windows.push(quotaWindow('5h', json.five_hour));
  }

  if (json.seven_day) {
    windows.push(quotaWindow('Weekly', json.seven_day));
  }

  if (json.seven_day_sonnet) {
    windows.push(quotaWindow('Weekly (Sonnet)', json.seven_day_sonnet));
  }

  if (json.seven_day_opus) {
    windows.push(quotaWindow('Weekly (Opus)', json.seven_day_opus));
  }

  const credits = json.extra_usage?.is_enabled && json.extra_usage.monthly_limit != null
    ? {
        label: 'Extra usage',
        valueUsd: json.extra_usage.used_credits,
        balanceUsd: undefined,
      }
    : undefined;

  return { windows, credits };
}

function errorUsage(
  providerId: 'claude',
  displayName: string,
  error: ProviderError,
  fetchedAt: string,
  state: UsageData['state'] = 'unavailable',
): UsageData {
  return {
    providerId,
    displayName,
    state,
    windows: [],
    error,
    fetchedAt,
  };
}

export class ClaudeAdapter implements IProviderAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude';

  async fetch(): Promise<UsageData> {
    const fetchedAt = new Date().toISOString();

    const token = await getClaudeToken();
    if (!token) {
      return errorUsage(this.id, this.displayName, {
        code: 'NOT_CONFIGURED',
        message: 'Claude token not found',
        hint: 'Log into Claude Code (run `claude`) so credentials exist at ~/.claude/.credentials.json',
      }, fetchedAt, 'unconfigured');
    }

    const now = Date.now();

    // Serve cached success if still fresh
    if (cachedSuccess && now - cachedSuccessAtMs < SUCCESS_TTL_MS) {
      return cachedSuccess;
    }

    // Respect 429 cooldown — serve stale data if available, else surface error
    if (now < nextAllowedAtMs) {
      if (cachedSuccess) return cachedSuccess;
      return errorUsage(this.id, this.displayName, {
        code: 'RATE_LIMITED',
        message: 'Claude usage API is cooling down after a 429',
        hint: 'Too many requests — the dashboard will retry automatically in a few minutes',
      }, fetchedAt);
    }

    let res: Response;
    try {
      res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': BETA_HEADER,
          Accept: 'application/json',
          'User-Agent': CLAUDE_UA,
        },
      });
    } catch (err) {
      void redactSecrets(err);
      const msg = safeErrorMessage(err);
      return errorUsage(this.id, this.displayName, {
        code: 'NETWORK',
        message: msg,
        hint: 'Could not reach the Claude usage API — check network connectivity',
      }, fetchedAt);
    }

    if (res.status === 401) {
      return errorUsage(this.id, this.displayName, {
        code: 'AUTH_EXPIRED',
        message: 'Claude auth token expired',
        hint: 'Re-authenticate Claude Code (run `claude` or re-login at claude.ai)',
      }, fetchedAt);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RATE_LIMIT_BACKOFF_MS;
      nextAllowedAtMs = Date.now() + backoffMs;
      if (cachedSuccess) return cachedSuccess; // serve stale rather than error card
      return errorUsage(this.id, this.displayName, {
        code: 'RATE_LIMITED',
        message: 'Claude usage API rate limited',
        hint: 'Too many requests — the dashboard will retry automatically in a few minutes',
      }, fetchedAt);
    }

    if (!res.ok) {
      return errorUsage(this.id, this.displayName, {
        code: 'NETWORK',
        message: `HTTP ${res.status} from Claude usage API`,
        hint: 'Claude usage API returned an unexpected error — try again later',
      }, fetchedAt);
    }

    let parsed: Pick<UsageData, 'windows' | 'credits'>;
    try {
      const json = await res.json() as ClaudeUsageResponse;
      parsed = parseClaudeUsage(json);
    } catch (err) {
      void redactSecrets(err);
      const msg = safeErrorMessage(err);
      return errorUsage(this.id, this.displayName, {
        code: 'PARSE',
        message: msg,
        hint: 'Claude usage API returned an unexpected response — try again later',
      }, fetchedAt);
    }

    const result: UsageData = {
      providerId: this.id,
      displayName: this.displayName,
      state: 'ok',
      windows: parsed.windows,
      credits: parsed.credits,
      fetchedAt,
    };
    cachedSuccess = result;
    cachedSuccessAtMs = Date.now();
    nextAllowedAtMs = cachedSuccessAtMs + SUCCESS_TTL_MS;
    return result;
  }
}
