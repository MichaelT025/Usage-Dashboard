/**
 * Core data contract for llm-usage.
 * This file has ZERO imports from any framework or library.
 * All types are purely semantic — no presentation fields (no colorClass, barWidth, etc.).
 */

/** Supported provider IDs */
export type ProviderId =
  | 'claude'
  | 'codex'
  | 'opencode-go'
  | 'zen'
  | 'openrouter';

/**
 * Provider lifecycle states:
 * - ok: data fetched successfully
 * - unavailable: configured but fetch failed (auth expired, rate-limited, network error, parse error)
 * - unconfigured: credentials/config not set up yet
 * - not_implemented: Phase-2 stub; no real implementation yet
 */
export type ProviderState = 'ok' | 'unavailable' | 'unconfigured' | 'not_implemented';

/** Typed error codes for per-provider error cards */
export type ProviderErrorCode =
  | 'AUTH_EXPIRED'     // OAuth/access token expired → re-login hint
  | 'COOKIE_EXPIRED'   // Session cookie expired (OpenCode Go) → refresh hint
  | 'RATE_LIMITED'     // 429 from usage endpoint → back-off hint
  | 'NETWORK'          // DNS/timeout/connection refused
  | 'PARSE'            // Unexpected response shape
  | 'NOT_CONFIGURED'   // Missing required credential in config
  | 'UNKNOWN';         // Catch-all

/** Structured error attached to unavailable/unconfigured UsageData */
export interface ProviderError {
  code: ProviderErrorCode;
  /** Human-readable, NEVER contains credential values */
  message: string;
  /** Actionable remediation hint shown in the UI card */
  hint: string;
}

/**
 * A single rate-limit window (e.g. 5-hour session, weekly, monthly).
 * usedPercent is 0–100. resetsAt is ISO 8601.
 * windowSeconds is informational (18000=5h, 604800=7d, 2592000=30d).
 */
export interface QuotaWindow {
  label: string;         // e.g. "5h", "Weekly", "Monthly"
  windowSeconds: number; // duration of this window
  usedPercent: number;   // 0–100
  resetsAt: string;      // ISO 8601
}

/**
 * Credits/balance info (primarily for Phase-2 pay-as-you-go providers).
 * Optional on subscription providers.
 */
export interface CreditsInfo {
  label: string;          // e.g. "Extra usage", "Balance"
  valueUsd?: number;      // amount consumed (if known)
  balanceUsd?: number;    // remaining balance (if known)
}

/**
 * Normalised usage snapshot for ONE provider.
 * Produced by every IProviderAdapter and consumed by the aggregator, server, and frontend.
 * MUST NOT contain presentation fields (colors, widths, CSS classes).
 */
export interface UsageData {
  providerId: ProviderId;
  displayName: string;       // e.g. "Claude", "Codex", "OpenCode Go"
  state: ProviderState;
  plan?: string;             // e.g. "Max 5x", "Plus" — optional, when derivable
  /** Rate-limit windows. Empty when state is not 'ok'. */
  windows: QuotaWindow[];
  /** Credits/balance — optional, mainly Phase-2 */
  credits?: CreditsInfo;
  /** Present when state is 'unavailable' or 'unconfigured' */
  error?: ProviderError;
  /** ISO 8601 timestamp of when this snapshot was fetched */
  fetchedAt: string;
}

/**
 * Adapter interface every provider must implement.
 * fetch() MUST be stateless — re-read credentials on every call.
 * fetch() MUST resolve (never reject) — errors become UsageData with state 'unavailable'.
 */
export interface IProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  fetch(): Promise<UsageData>;
}

/**
 * Shape returned by GET /api/status.
 * providers array contains one entry per active adapter.
 */
export interface StatusResponse {
  providers: UsageData[];
  /** ISO 8601 timestamp when this response was generated */
  generatedAt: string;
}
