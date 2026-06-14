/**
 * Pure ANSI terminal formatter functions for llm-usage.
 *
 * This is the rendering layer that converts a StatusResponse from the data
 * pipeline into a printable terminal frame. Used by both the one-shot CLI
 * path AND the live TUI.
 *
 * Pure functions only: callers pass `cols` and `color`. This module never
 * reads `process.*`, never emits cursor/alt-screen escapes (those belong in
 * tui.ts), and imports no npm packages.
 */

import type { QuotaWindow, UsageData, StatusResponse } from './core/types.js';

export interface RenderOpts {
  cols: number;
  color: boolean;
}

// --- ANSI helpers (local, not exported) ---

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

function paint(s: string, code: string, color: boolean): string {
  return color ? code + s + RESET : s;
}

/** Fixed bar width — never stretches to full terminal width. */
const BAR_MAX = 50;

/**
 * Render a usage bar of the given width.
 * pct >= 100 → RED (critical), pct >= 80 → YELLOW (warning), else GREEN.
 * Mirrors app.js renderWindow color logic.
 */
export function bar(usedPercent: number, width: number, color: boolean): string {
  const pct = Math.min(100, Math.max(0, usedPercent));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const raw = '█'.repeat(filled) + '░'.repeat(empty);
  const code = pct >= 100 ? RED : pct >= 80 ? YELLOW : GREEN;
  return paint(raw, code, color);
}

/** Minutes / hours only, no seconds. ms <= 0 → "now". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const totalMin = Math.floor(s / 60);
  const totalH = Math.floor(s / 3600);
  const totalD = Math.floor(s / 86400);
  const remH = totalH % 24;
  const remM = totalMin % 60;
  if (totalD >= 1) return `${totalD}d ${remH}h`;
  if (totalH >= 1) return `${totalH}h ${remM}m`;
  if (totalMin >= 1) return `${totalMin}m`;
  return '0m';
}

/** Returns "just now" for < 60 s, then "1m", "2m", "1h", "2h" etc. */
export function formatUpdatedAgo(generatedAtISO: string): string {
  const diffMs = Date.now() - new Date(generatedAtISO).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  return `${diffH}h`;
}

/**
 * Render a single quota window block (multi-line, compact bar).
 * Label on its own line, bar + percentage on next, reset timestamp below.
 * Bar is capped at BAR_MAX so it never stretches to full terminal width.
 */
export function renderWindowRow(win: QuotaWindow, opts: RenderOpts): string {
  const pct = Math.min(100, Math.max(0, win.usedPercent));
  const pctStr = `${pct}% used`.padStart(8); // e.g. "  42% used"

  const delta = new Date(win.resetsAt).getTime() - Date.now();
  const countdown = delta <= 0 ? 'resetting now' : `Resets in ${formatDuration(delta)}`;

  const colorCode = pct >= 100 ? RED : pct >= 80 ? YELLOW : GREEN;
  const coloredBar = bar(pct, BAR_MAX, opts.color);
  const coloredPct = paint(pctStr, colorCode, opts.color);

  return [
    `  ${paint(win.label, BOLD, opts.color)}`,
    `  ${coloredBar}  ${coloredPct}`,
    `  ${paint(countdown, DIM, opts.color)}`,
  ].join('\n');
}

/** Render one provider block. Mirrors app.js renderCard (lines 57-89). */
export function renderProviderBlock(p: UsageData, opts: RenderOpts): string {
  const lines: string[] = [];

  // Header: displayName [plan] ●
  const dot =
    p.state === 'ok'
      ? paint('●', GREEN, opts.color)
      : p.state === 'unconfigured'
        ? paint('●', YELLOW, opts.color)
        : paint('●', RED, opts.color);
  const name = paint(p.displayName, BOLD, opts.color);
  const planStr = p.plan ? `  ${paint(p.plan, DIM, opts.color)}` : '';
  lines.push(`${name}${planStr}  ${dot}`);

  if (p.state === 'ok') {
    // Windows
    for (let i = 0; i < p.windows.length; i++) {
      lines.push(renderWindowRow(p.windows[i], opts));
      if (i < p.windows.length - 1) lines.push(''); // blank line between windows
    }
    // Credits (mirrors app.js renderCredits, lines 107-112)
    if (p.credits) {
      const parts: string[] = [];
      if (p.credits.balanceUsd != null) parts.push(`Balance: $${p.credits.balanceUsd.toFixed(2)}`);
      if (p.credits.valueUsd != null) parts.push(`Used: $${p.credits.valueUsd.toFixed(2)}`);
      if (parts.length) lines.push(`  ${p.credits.label}: ${parts.join(' · ')}`);
    }
  } else {
    // Error / unconfigured state
    const stateLabel = p.state === 'unconfigured' ? 'Not Configured' : 'Unavailable';
    lines.push(`  ${paint(stateLabel, BOLD, opts.color)}`);
    if (p.error?.code) lines.push(`  ${paint(p.error.code, DIM, opts.color)}`);
    if (p.error?.hint) lines.push(`  ${p.error.hint}`);
  }

  return lines.join('\n');
}

/**
 * Render the full terminal frame: title, blank line, each provider block
 * separated by blank lines, then a footer with the "updated X ago" label.
 * Filters not_implemented providers (matches app.js line 51).
 */
export function renderFrame(status: StatusResponse, opts: RenderOpts): string {
  const active = status.providers.filter((p) => p.state !== 'not_implemented');

  const title = paint('llm-usage', BOLD, opts.color);
  const blocks = active.map((p) => renderProviderBlock(p, opts));
  const footer = formatUpdatedAgo(status.generatedAt);

  return [title, '', ...blocks.flatMap((b) => [b, '']), footer].join('\n');
}
