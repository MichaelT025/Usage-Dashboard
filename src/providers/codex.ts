import type { IProviderAdapter, UsageData, QuotaWindow } from '../core/types.js';
import { getCodexToken } from '../core/credentials.js';
import { safeErrorMessage } from '../core/redact.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface WindowSnapshot {
  used_percent: number;
  reset_at: number;
  limit_window_seconds: number;
}

interface AdditionalRateLimit {
  limit_name: string;
  metered_feature?: string;
  rate_limit: {
    primary_window?: WindowSnapshot;
    secondary_window?: WindowSnapshot;
  };
}

interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: WindowSnapshot;
    secondary_window?: WindowSnapshot;
  };
  additional_rate_limits?: AdditionalRateLimit[];
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number;
  };
}

function unixToISO(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function labelWindow(windowSeconds: number): string {
  if (windowSeconds <= 21600) return '5h';
  if (windowSeconds <= 691200) return 'Weekly';
  return `${Math.round(windowSeconds / 86400)}d`;
}

export function parseCodexUsage(json: WhamUsageResponse): Pick<UsageData, 'windows' | 'credits' | 'plan'> {
  const windows: QuotaWindow[] = [];

  const snapshots: WindowSnapshot[] = [];
  if (json.rate_limit?.primary_window) snapshots.push(json.rate_limit.primary_window);
  if (json.rate_limit?.secondary_window) snapshots.push(json.rate_limit.secondary_window);

  snapshots.sort((a, b) => a.limit_window_seconds - b.limit_window_seconds);

  for (const snap of snapshots) {
    windows.push({
      label: labelWindow(snap.limit_window_seconds),
      windowSeconds: snap.limit_window_seconds,
      usedPercent: snap.used_percent,
      resetsAt: unixToISO(snap.reset_at),
    });
  }

  for (const extra of json.additional_rate_limits ?? []) {
    const primary = extra.rate_limit.primary_window;
    if (primary) {
      windows.push({
        label: extra.limit_name,
        windowSeconds: primary.limit_window_seconds,
        usedPercent: primary.used_percent,
        resetsAt: unixToISO(primary.reset_at),
      });
    }
  }

  const credits = json.credits?.has_credits && json.credits.balance != null
    ? { label: 'Credits', balanceUsd: json.credits.balance }
    : undefined;

  return {
    windows,
    credits,
    plan: json.plan_type,
  };
}

export class CodexAdapter implements IProviderAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';

  async fetch(): Promise<UsageData> {
    const fetchedAt = new Date().toISOString();

    const tokenResult = await getCodexToken();
    if (!tokenResult) {
      return {
        providerId: this.id,
        displayName: this.displayName,
        state: 'unconfigured',
        windows: [],
        error: {
          code: 'NOT_CONFIGURED',
          message: 'Codex token not found',
          hint: 'Log into the Codex CLI (run `codex login`)',
        },
        fetchedAt,
      };
    }

    const { accessToken, accountId } = tokenResult;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'llm-usage',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;

    try {
      const res = await fetch(USAGE_URL, { headers });

      if (res.status === 401) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'AUTH_EXPIRED',
            message: 'Codex auth token expired',
            hint: 'Re-run `codex login` to refresh your credentials',
          },
          fetchedAt,
        };
      }

      if (res.status === 429) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'RATE_LIMITED',
            message: 'Codex usage API rate limited',
            hint: 'Too many requests to the usage API — wait before refreshing',
          },
          fetchedAt,
        };
      }

      if (!res.ok) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'NETWORK',
            message: `HTTP ${res.status} from Codex usage API`,
            hint: 'Codex usage API returned an unexpected error — try again later',
          },
          fetchedAt,
        };
      }

      const json = await res.json() as WhamUsageResponse;
      const { windows, credits, plan } = parseCodexUsage(json);

      return {
        providerId: this.id,
        displayName: this.displayName,
        state: 'ok',
        plan,
        windows,
        credits,
        fetchedAt,
      };
    } catch (err) {
      const msg = safeErrorMessage(err);
      return {
        providerId: this.id,
        displayName: this.displayName,
        state: 'unavailable',
        windows: [],
        error: {
          code: 'NETWORK',
          message: msg,
          hint: 'Could not reach the Codex usage API — check network connectivity',
        },
        fetchedAt,
      };
    }
  }
}
