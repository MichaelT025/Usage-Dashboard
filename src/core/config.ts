import fs from 'node:fs';
import path from 'node:path';
import { configDir, configPath, configExamplePath } from './paths.js';
import { redactSecrets } from './redact.js';

export interface AppConfig {
  refreshIntervalSec: number;
  port: number;
  opencodeWorkspaceId?: string;
  opencodeAuthCookie?: string;
  claudeCredentialsPathOverride?: string;
  codexAuthPathOverride?: string;
}

const DEFAULTS: AppConfig = {
  refreshIntervalSec: 180,
  port: 7878,
};

const MIN_REFRESH_SEC = 30;

/** Load config from ~/.llm-usage/config.json. Missing file → safe defaults (not an error). */
export function loadConfig(): AppConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const merged = { ...DEFAULTS, ...parsed };
    // Clamp refresh interval to minimum
    merged.refreshIntervalSec = Math.max(merged.refreshIntervalSec, MIN_REFRESH_SEC);
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Validate config fields. Throws a TypeError with a NON-secret message on invalid values.
 * Never echo cookie/token values in the error message.
 */
export function validateConfig(config: Partial<AppConfig>): void {
  if (config.opencodeWorkspaceId !== undefined) {
    if (typeof config.opencodeWorkspaceId !== 'string' || config.opencodeWorkspaceId.trim() === '') {
      throw new TypeError('opencodeWorkspaceId must be a non-empty string');
    }
  }
  if (config.opencodeAuthCookie !== undefined) {
    if (typeof config.opencodeAuthCookie !== 'string' || config.opencodeAuthCookie.trim() === '') {
      throw new TypeError('opencodeAuthCookie must be a non-empty string [value redacted]');
    }
  }
  if (config.refreshIntervalSec !== undefined) {
    if (typeof config.refreshIntervalSec !== 'number' || config.refreshIntervalSec < MIN_REFRESH_SEC) {
      throw new TypeError(`refreshIntervalSec must be a number >= ${MIN_REFRESH_SEC}`);
    }
  }
  if (config.port !== undefined) {
    if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
      throw new TypeError('port must be a number between 1 and 65535');
    }
  }
}

/**
 * Deep-merge partial config over existing on-disk config and atomically write.
 * Creates ~/.llm-usage/ dir if missing.
 * Attempts chmod 0600 on POSIX (best-effort on Windows).
 * NEVER logs values.
 */
export function saveConfig(partial: Partial<AppConfig>): void {
  validateConfig(partial);
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = loadConfig();
  const merged: AppConfig = { ...existing, ...partial };
  // Clamp after merge
  merged.refreshIntervalSec = Math.max(merged.refreshIntervalSec, MIN_REFRESH_SEC);

  const tmpPath = configPath() + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf8');

  // Best-effort restrictive permissions (POSIX only)
  try { fs.chmodSync(tmpPath, 0o600); } catch { /* Windows — no-op */ }

  fs.renameSync(tmpPath, configPath());
}

/** Write an example config with placeholder values to ~/.llm-usage/config.example.json. */
export function writeExampleConfig(): void {
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const example = {
    refreshIntervalSec: 180,
    port: 7878,
    opencodeWorkspaceId: 'wrk_YOUR_WORKSPACE_ID_HERE',
    opencodeAuthCookie: 'PASTE_YOUR_AUTH_COOKIE_HERE',
  };
  fs.writeFileSync(configExamplePath(), JSON.stringify(example, null, 2) + '\n', 'utf8');
}
