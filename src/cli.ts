#!/usr/bin/env node
/**
 * llm-usage CLI entrypoint.
 *
 * Usage:
 *   llm-usage [--port <n>] [--no-open]   Start dashboard at http://localhost:PORT
 *   llm-usage setup [--check] [--no-validate]  Interactive setup wizard
 *   llm-usage --tui                        (not yet implemented)
 *   llm-usage --help                       Show usage
 */

import { existsSync } from 'node:fs';

import { loadConfig, writeExampleConfig } from './core/config.js';
import { configPath } from './core/paths.js';
import { startServer } from './server.js';

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

// --- Guard flags ---
if (args.includes('--tui')) {
  console.error('TUI not yet implemented');
  process.exit(1);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
llm-usage — Local LLM subscription usage dashboard

USAGE
  llm-usage [options]           Start the dashboard at http://localhost:7878
  llm-usage setup               Interactive setup wizard
  llm-usage setup --check       Check current provider configuration
  llm-usage setup --no-validate Skip live validation during setup

OPTIONS
  --port <n>     Server port (default: 7878)
  --no-open      Don't open browser automatically
  --tui          (not yet implemented)
  --help, -h     Show this help

CONFIG
  ~/.llm-usage/config.json      (run \`llm-usage setup\` to configure)
  `.trim());
  process.exit(0);
}

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
    // non-fatal
  }
}

// --- Start server ---
async function main(): Promise<void> {
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

await main();
