#!/usr/bin/env node
/**
 * llm-usage CLI entrypoint.
 * T13 adds: server launch, browser open, EADDRINUSE handling, --port flag.
 * This file currently handles: setup subcommand, --help, --tui guard.
 */

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === 'setup') {
  const { runSetupWizard } = await import('./setup.js');
  const check = args.includes('--check');
  const noValidate = args.includes('--no-validate');
  await runSetupWizard({ check, noValidate });
} else if (args.includes('--tui')) {
  console.error('TUI not yet implemented');
  process.exit(1);
} else if (args.includes('--help') || args.includes('-h')) {
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
  ~/.llm-usage/config.json      (run \`llm-usage setup\` to create)
  `);
  process.exit(0);
} else {
  // T13 will replace this with the server launch logic
  console.log('Dashboard server not yet implemented — run `llm-usage setup` to configure providers.');
  process.exit(0);
}
