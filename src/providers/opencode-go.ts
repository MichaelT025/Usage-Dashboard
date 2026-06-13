import type { IProviderAdapter, QuotaWindow, UsageData } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { safeErrorMessage } from '../core/redact.js';

/**
 * OpenCode Go subscription usage adapter.
 *
 * Data source: HTML scrape of https://opencode.ai/workspace/{workspaceId}/go
 * The page is SERVER-RENDERED — the usage numbers are baked into the SolidJS hydration
 * payload on every request. Every poll issues a fresh GET, yielding always-current data.
 *
 * Auth: session cookie `auth=<Fe26.2**...>` — expires in hours/days, must be refreshed manually.
 * No official API exists (feature requests #29634, #31084 closed without action).
 *
 * Limits: ~$12/5h, ~$30/week, ~$60/month (tracked as dollar-percent, not token-percent).
 */

interface GoWindow {
  status: string;
  resetInSec: number;
  usagePercent: number;
}

function parseGoWindow(html: string, varName: string): GoWindow | null {
  const match = html.match(
    new RegExp(`${varName}:\\$R\\[\\d+\\]=\\{status:"([^"]*)",resetInSec:(\\d+),usagePercent:(\\d+)\\}`),
  );
  if (!match) return null;

  return {
    status: match[1]!,
    resetInSec: parseInt(match[2]!, 10),
    usagePercent: parseInt(match[3]!, 10),
  };
}

function parseBalance(html: string): number | null {
  const match = html.match(/balance:(\d+)(?:,|\})/);
  return match ? Number(match[1]) : null;
}

function isLoginPage(html: string): boolean {
  return !html.includes('rollingUsage') && !html.includes('weeklyUsage');
}

export function parseGoUsage(html: string): Pick<UsageData, 'windows' | 'credits'> | null {
  if (isLoginPage(html)) return null;

  const rolling = parseGoWindow(html, 'rollingUsage');
  const weekly = parseGoWindow(html, 'weeklyUsage');
  const monthly = parseGoWindow(html, 'monthlyUsage');

  if (!rolling && !weekly && !monthly) return null;

  const now = Date.now();
  const windows: QuotaWindow[] = [];

  if (rolling) {
    windows.push({
      label: '5h',
      windowSeconds: 18000,
      usedPercent: rolling.usagePercent,
      resetsAt: new Date(now + rolling.resetInSec * 1000).toISOString(),
    });
  }

  if (weekly) {
    windows.push({
      label: 'Weekly',
      windowSeconds: 604800,
      usedPercent: weekly.usagePercent,
      resetsAt: new Date(now + weekly.resetInSec * 1000).toISOString(),
    });
  }

  if (monthly) {
    windows.push({
      label: 'Monthly',
      windowSeconds: 2592000,
      usedPercent: monthly.usagePercent,
      resetsAt: new Date(now + monthly.resetInSec * 1000).toISOString(),
    });
  }

  const balanceMicroCents = parseBalance(html);
  const credits = balanceMicroCents != null
    ? { label: 'Balance', balanceUsd: balanceMicroCents / 1e8 }
    : undefined;

  return { windows, credits };
}

export class OpenCodeGoAdapter implements IProviderAdapter {
  readonly id = 'opencode-go' as const;
  readonly displayName = 'OpenCode Go';

  async fetch(): Promise<UsageData> {
    const fetchedAt = new Date().toISOString();
    const config = loadConfig();
    const { opencodeWorkspaceId, opencodeAuthCookie } = config;

    if (!opencodeWorkspaceId || !opencodeAuthCookie) {
      return {
        providerId: this.id,
        displayName: this.displayName,
        state: 'unconfigured',
        windows: [],
        error: {
          code: 'NOT_CONFIGURED',
          message: 'OpenCode Go workspace ID or auth cookie not configured',
          hint: 'Run `llm-usage setup` or add opencodeWorkspaceId and opencodeAuthCookie to ~/.llm-usage/config.json',
        },
        fetchedAt,
      };
    }

    const url = `https://opencode.ai/workspace/${opencodeWorkspaceId}/go`;

    try {
      const res = await fetch(url, {
        headers: {
          Cookie: `auth=${opencodeAuthCookie}`,
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'llm-usage',
        },
        redirect: 'follow',
      });

      if (!res.ok && res.status !== 200) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'NETWORK',
            message: `HTTP ${res.status} from OpenCode Go console`,
            hint: 'Could not load the OpenCode Go usage page — check your workspace ID',
          },
          fetchedAt,
        };
      }

      const html = await res.text();

      if (isLoginPage(html)) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'COOKIE_EXPIRED',
            message: 'OpenCode Go session cookie expired or invalid',
            hint: 'Re-copy the `auth` cookie from opencode.ai (Settings > Auth) and update opencodeAuthCookie in config',
          },
          fetchedAt,
        };
      }

      const parsed = parseGoUsage(html);

      if (!parsed) {
        return {
          providerId: this.id,
          displayName: this.displayName,
          state: 'unavailable',
          windows: [],
          error: {
            code: 'PARSE',
            message: 'Could not parse OpenCode Go usage from page HTML',
            hint: 'The OpenCode Go page format may have changed — check for updates to llm-usage',
          },
          fetchedAt,
        };
      }

      return {
        providerId: this.id,
        displayName: this.displayName,
        state: 'ok',
        windows: parsed.windows,
        credits: parsed.credits,
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
          hint: 'Could not reach opencode.ai — check network connectivity',
        },
        fetchedAt,
      };
    }
  }
}
