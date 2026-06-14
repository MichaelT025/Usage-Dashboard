#!/usr/bin/env node
/**
 * llm-usage CLI entrypoint.
 *
 * Usage:
 *   llm-usage [options]           Print a usage snapshot to the terminal and exit
 *   llm-usage --watch             Live terminal UI (alias: --tui)
 *   llm-usage --json              Print JSON snapshot and exit
 *   llm-usage --dash [options]    Start dashboard at http://localhost:PORT
 *   llm-usage setup [--check] [--no-validate]  Interactive setup wizard
 *   llm-usage --help              Show usage
 */

import { existsSync } from 'node:fs';

import { aggregate } from './core/aggregator.js';
import { loadConfig, writeExampleConfig } from './core/config.js';
import { configPath } from './core/paths.js';
import { redactSecrets } from './core/redact.js';
import { renderFrame } from './render.js';
import { startServer } from './server.js';
import { startTui } from './tui.js';
import { ClaudeAdapter } from './providers/claude.js';
import { CodexAdapter } from './providers/codex.js';
import { OpenCodeGoAdapter } from './providers/opencode-go.js';
import type { IProviderAdapter, UsageData } from './core/types.js';

const args = process.argv.slice(2);
const subcommand = args[0];

// --- setup subcommand (delegated to setup.ts) ---
if (subcommand === 'setup') {
  const { runSetupWizard } = await import('./setup.js');
  const check = args.includes('--check');
  const noValidate = args.includes('--no-validate');
  await runSetupWizard({ check, noValidate });
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
llm-usage — Local LLM subscription usage monitor

USAGE
  llm-usage [options]           Print a usage snapshot to the terminal and exit (default)
  llm-usage --watch             Live auto-refreshing terminal UI (alias: --tui)
  llm-usage --json              Print a machine-readable JSON snapshot and exit
  llm-usage --dash [options]    Launch the local web dashboard
  llm-usage setup               Interactive setup wizard
  llm-usage setup --check       Check current provider configuration
  llm-usage setup --no-validate Skip live validation during setup

OPTIONS
  --watch, --tui   Live TUI — requires an interactive terminal (TTY)
  --json           Machine-readable JSON output — always exits 0
  --dash           Launch web dashboard (old default behavior)
  --port <n>       Server port (default: 7878) — only applies with --dash
  --no-open        Don't open browser automatically — only applies with --dash
  --help, -h       Show this help

  Note: --watch/--tui, --json, and --dash are mutually exclusive.
  Color is auto-disabled when output is piped or NO_COLOR is set.

CONFIG
  ~/.llm-usage/config.json      (run \`llm-usage setup\` to configure)
  `.trim());
  process.exit(0);
}

const watch = args.includes('--watch') || args.includes('--tui');
const json = args.includes('--json');
const dash = args.includes('--dash');

if ([watch, json, dash].filter(Boolean).length > 1) {
  console.error('Error: --watch/--tui, --json, and --dash are mutually exclusive');
  process.exit(1);
}

if ((args.includes('--port') || args.includes('--no-open')) && !dash) {
  console.error('Note: --port and --no-open only apply with --dash; ignoring.');
}

if (dash) {
  await dashMain();
} else if (watch) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('Error: --watch requires an interactive terminal (TTY).');
    process.exit(1);
  }
  const config = loadConfig();
  startTui(buildWrappedAdapters(), { intervalSec: config.refreshIntervalSec });
} else if (json) {
  const status = await aggregate(buildWrappedAdapters());
  process.stdout.write(JSON.stringify(redactSecrets(status), null, 2) + '\n');
  process.exit(0);
} else {
  loadConfig();

  // First-run example config — do NOT print to stdout in --json (handled above)
  if (!existsSync(configPath())) {
    try {
      writeExampleConfig();
      console.log('📋 Created example config at ~/.llm-usage/config.example.json');
      console.log('   Run `llm-usage setup` to configure OpenCode Go credentials.\n');
    } catch {
      void 0;
    }
  }

  const status = await aggregate(buildWrappedAdapters());
  const cols = process.stdout.columns ?? 80;
  const color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined;
  process.stdout.write(renderFrame(status, { cols, color }) + '\n');
  process.exit(0);
}

function withTimeout(
  p: Promise<UsageData>,
  ms: number,
  id: string,
  displayName: string,
): Promise<UsageData> {
  return Promise.race([
    p,
    new Promise<UsageData>(res =>
      setTimeout(() => res({
        providerId: id as import('./core/types.js').ProviderId,
        displayName,
        state: 'unavailable',
        windows: [],
        error: {
          code: 'NETWORK',
          message: 'Request timed out',
          hint: 'The provider did not respond in time — check network connectivity',
        },
        fetchedAt: new Date().toISOString(),
      }), ms)
    ),
  ]);
}

function buildWrappedAdapters(): IProviderAdapter[] {
  const base: IProviderAdapter[] = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new OpenCodeGoAdapter(),
  ];
  return base.map(a => ({
    id: a.id,
    displayName: a.displayName,
    fetch: () => withTimeout(a.fetch(), 15_000, a.id, a.displayName),
  }));
}

async function dashMain(): Promise<void> {
  // --- Parse flags ---
  const noOpen = args.includes('--no-open');
  const portFlagIdx = args.indexOf('--port');
  const portOverride = portFlagIdx !== -1 ? parseInt(args[portFlagIdx + 1] ?? '', 10) : NaN;

  // --- Load config ---
  const config = loadConfig();
  const port = (!isNaN(portOverride) && portOverride > 0) ? portOverride : config.port;

  // --- First-run: write example config if none exists ---
  if (!existsSync(configPath())) {
    try {
      writeExampleConfig();
      console.log(`📋 Created example config at ~/.llm-usage/config.example.json`);
      console.log(`   Run \`llm-usage setup\` to configure OpenCode Go credentials.\n`);
    } catch {
      void 0; // non-fatal — writeExampleConfig can fail silently on first run
    }
  }

  // --- Start server ---
  let server: { url: string; close(): void };

  try {
    server = await startServer({ port });
  } catch (err: unknown) {
    // EADDRINUSE: assume an existing instance is already running
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const existingUrl = `http://localhost:${port}`;
      console.log(`llm-usage is already running at ${existingUrl}`);
      if (!noOpen) {
        await openBrowser(existingUrl);
      }
      process.exit(0);
    }
    console.error('Failed to start server:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`\nllm-usage listening on ${server.url}\n`);

  if (!noOpen) {
    await openBrowser(server.url);
  }

  // Graceful shutdown
  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function openBrowser(url: string): Promise<void> {
  const { platform } = process;
  try {
    const { spawn } = await import('node:child_process');
    const cmd = platform === 'win32' ? 'cmd'
      : platform === 'darwin' ? 'open'
      : 'xdg-open';
    const cmdArgs = platform === 'win32' ? ['/c', 'start', url] : [url];
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // non-fatal — user can open manually
    console.log(`Open your browser to: ${url}`);
  }
}
