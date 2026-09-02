import type {
  IProviderAdapter,
  ProviderError,
  QuotaWindow,
  UsageData,
} from '../core/types.js';
import { getOpenCodeGoToken } from '../core/credentials.js';
import { safeErrorMessage } from '../core/redact.js';

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

interface GoUsageWindow {
  status: 'ok' | 'rate-limited';
  percent: number;
  resetsAt: string;
}

const WINDOW_DEFINITIONS = [
  ['rolling', '5h', 18_000],
  ['weekly', 'Weekly', 604_800],
  ['monthly', 'Monthly', 2_592_000],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWindow(value: unknown): GoUsageWindow | null {
  if (!isRecord(value)) return null;

  const status = value['status'];
  const percent = value['percent'];
  const resetsAt = value['resetsAt'];

  if (status !== 'ok' && status !== 'rate-limited') return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  if (percent < 0 || percent > 100) return null;
  if (typeof resetsAt !== 'string' || Number.isNaN(Date.parse(resetsAt)))
    return null;

  return { status, percent, resetsAt };
}

export function parseGoUsage(
  value: unknown,
): Pick<UsageData, 'windows'> | null {
  if (!isRecord(value) || !isRecord(value['usage'])) return null;

  const usage = value['usage'];
  const windows: QuotaWindow[] = [];

  for (const [key, label, windowSeconds] of WINDOW_DEFINITIONS) {
    const source = parseWindow(usage[key]);
    if (!source) return null;

    windows.push({
      label,
      windowSeconds,
      usedPercent: source.percent,
      resetsAt: source.resetsAt,
    });
  }

  return { windows };
}

function errorUsage(
  error: ProviderError,
  fetchedAt: string,
  state: UsageData['state'] = 'unavailable',
): UsageData {
  return {
    providerId: 'opencode-go',
    displayName: 'OpenCode Go',
    state,
    windows: [],
    error,
    fetchedAt,
  };
}

export class OpenCodeGoAdapter implements IProviderAdapter {
  readonly id = 'opencode-go' as const;
  readonly displayName = 'OpenCode Go';

  async fetch(): Promise<UsageData> {
    const fetchedAt = new Date().toISOString();
    const token = await getOpenCodeGoToken();

    if (!token) {
      return errorUsage(
        {
          code: 'NOT_CONFIGURED',
          message: 'OpenCode API key not found',
          hint: 'Connect OpenCode Go using `/connect` or set OPENCODE_API_KEY',
        },
        fetchedAt,
        'unconfigured',
      );
    }

    let res: Response;

    try {
      res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'llm-usage',
        },
        redirect: 'error',
      });
    } catch (error) {
      return errorUsage(
        {
          code: 'NETWORK',
          message: safeErrorMessage(error),
          hint: 'Could not reach the OpenCode Go usage API',
        },
        fetchedAt,
      );
    }

    if (res.status === 401) {
      return errorUsage(
        {
          code: 'AUTH_EXPIRED',
          message: 'OpenCode API key was rejected',
          hint: 'Reconnect OpenCode Go using `/connect` in OpenCode',
        },
        fetchedAt,
      );
    }

    if (res.status === 403) {
      let errorType: unknown;
      try {
        const body = (await res.json()) as {
          error?: { type?: unknown };
        };
        errorType = body.error?.type;
      } catch {
        errorType = undefined;
      }

      if (errorType === 'EntitlementError') {
        return errorUsage(
          {
            code: 'NOT_ENTITLED',
            message: 'OpenCode Go subscription required',
            hint: 'The API key is valid, but its workspace does not have an active Go subscription',
          },
          fetchedAt,
        );
      }

      return errorUsage(
        {
          code: 'UNKNOWN',
          message: 'OpenCode Go rejected the usage request',
          hint: 'Check the OpenCode workspace and subscription status',
        },
        fetchedAt,
      );
    }

    if (res.status === 429) {
      return errorUsage(
        {
          code: 'RATE_LIMITED',
          message: 'OpenCode Go usage API rate limited',
          hint: 'Wait before refreshing usage again',
        },
        fetchedAt,
      );
    }
    if (!res.ok) {
      return errorUsage(
        {
          code: 'NETWORK',
          message: `HTTP ${res.status} from OpenCode Go usage API`,
          hint: 'The usage API returned an unexpected response',
        },
        fetchedAt,
      );
    }

    let parsed: ReturnType<typeof parseGoUsage>;

    try {
      parsed = parseGoUsage(await res.json());
    } catch {
      parsed = null;
    }

    if (!parsed) {
      return errorUsage(
        {
          code: 'PARSE',
          message: 'Could not parse OpenCode Go usage response',
          hint: 'The OpenCode Go usage API format may have changed',
        },
        fetchedAt,
      );
    }

    return {
      providerId: this.id,
      displayName: this.displayName,
      state: 'ok',
      windows: parsed.windows,
      fetchedAt,
    };
  }
}
