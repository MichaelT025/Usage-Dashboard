import os from 'node:os';
import path from 'node:path';

/**
 * All credential and config paths resolved via os.homedir().
 * NEVER use process.env.HOME or '~' string expansion.
 */

/** Directory where llm-usage config lives: ~/.llm-usage/ */
export function configDir(): string {
  return path.join(os.homedir(), '.llm-usage');
}

/** Path to the main config file: ~/.llm-usage/config.json */
export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** Path to the example config: ~/.llm-usage/config.example.json */
export function configExamplePath(): string {
  return path.join(configDir(), 'config.example.json');
}

/**
 * Path to Claude Code credentials file.
 * Respects CLAUDE_CONFIG_DIR env override (used by Claude Code).
 */
export function claudeCredentialsPath(): string {
  const base = process.env['CLAUDE_CONFIG_DIR']
    ? path.resolve(process.env['CLAUDE_CONFIG_DIR'])
    : path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

/**
 * Path to Codex CLI auth file.
 * Respects CODEX_HOME env override.
 */
export function codexAuthPath(): string {
  const base = process.env['CODEX_HOME']
    ? path.resolve(process.env['CODEX_HOME'])
    : path.join(os.homedir(), '.codex');
  return path.join(base, 'auth.json');
}
