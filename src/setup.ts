import fs from 'node:fs';
import readline from 'node:readline';
import {
  loadConfig,
  saveConfig,
  validateConfig,
  type AppConfig,
} from './core/config.js';
import {
  getClaudeToken,
  getCodexToken,
  getCommandCodeToken,
  getOpenCodeGoToken,
} from './core/credentials.js';
import { configPath } from './core/paths.js';

/** Provider ids supported by `llm-usage add`. */
export type AddProviderId = 'claude' | 'codex' | 'command-code' | 'opencode-go';

/** Status map for the four guided-setup providers. */
export type ProviderStatusMap = Record<AddProviderId, boolean>;

/** Injectable credential checkers (defaults read the real CLI auth stores). */
export interface StatusCheckers {
  claude?: () => Promise<unknown | null>;
  codex?: () => Promise<unknown | null>;
  'command-code'?: () => Promise<unknown | null>;
  'opencode-go'?: () => Promise<unknown | null>;
}

export interface AddProviderInfo {
  id: AddProviderId;
  displayName: string;
  /** Exact credential source shown to the user (never a secret value). */
  credentialSource: string;
  /** Official login steps (never spawns commands, never asks for secrets). */
  loginSteps: string[];
  optional: boolean;
}

/**
 * Guided-setup catalog. Menu order is Claude, Codex, Command Code, OpenCode Go.
 * Status display order (printProviderStatus) stays Claude, Codex, OpenCode Go,
 * Command Code for backwards compatibility.
 */
export const ADD_PROVIDERS: readonly AddProviderInfo[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    credentialSource: '~/.claude/.credentials.json (claudeAiOauth.accessToken)',
    loginSteps: [
      'Run `claude`, then choose `/login` and complete the browser login.',
    ],
    optional: false,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    credentialSource: '~/.codex/auth.json (tokens.access_token, OAuth)',
    loginSteps: [
      'Run `codex login` and complete the OAuth browser login.',
      'Use the OAuth flow — do not paste an API key.',
    ],
    optional: false,
  },
  {
    id: 'command-code',
    displayName: 'Command Code',
    credentialSource:
      'COMMAND_CODE_API_KEY or ~/.commandcode/auth.json (top-level apiKey)',
    loginSteps: [
      'Run `command-code login` and complete the browser login (portable across macOS, Linux, and Windows).',
      '`cmdc` is the native Windows alias; `cmd` is POSIX-only (on Windows `cmd` is the system shell).',
    ],
    optional: true,
  },
  {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    credentialSource:
      'OPENCODE_API_KEY or ~/.local/share/opencode/auth.json (opencode-go entry, opencode entry as fallback)',
    loginSteps: [
      'Launch `opencode`.',
      'Run `/connect`, choose OpenCode Go, and paste the key from the OpenCode console.',
    ],
    optional: false,
  },
];

const ADD_PROVIDER_BY_ID: Record<AddProviderId, AddProviderInfo> = {
  claude: ADD_PROVIDERS[0]!,
  codex: ADD_PROVIDERS[1]!,
  'command-code': ADD_PROVIDERS[2]!,
  'opencode-go': ADD_PROVIDERS[3]!,
};

export function getAddProvider(id: AddProviderId): AddProviderInfo {
  return ADD_PROVIDER_BY_ID[id];
}

/**
 * Normalize a user-supplied provider selection to a provider id.
 * Accepts provider ids (case-insensitive), common aliases, and the
 * 1-based menu numbers used by the interactive menu.
 * Returns null when the input does not identify a provider.
 */
export function normalizeProviderSelection(
  input: string | undefined | null,
): AddProviderId | null {
  if (input === undefined || input === null) return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  switch (raw) {
    case '1':
    case 'claude':
      return 'claude';
    case '2':
    case 'codex':
      return 'codex';
    case '3':
    case 'command-code':
    case 'commandcode':
    case 'command_code':
    case 'cmd':
    case 'cmdc':
      return 'command-code';
    case '4':
    case 'opencode-go':
    case 'opencodego':
    case 'opencode_go':
    case 'opencode':
    case 'opencode go':
      return 'opencode-go';
    default:
      return null;
  }
}

/** Valid provider ids for help/error output. */
export function validProviderIds(): string {
  return 'claude, codex, command-code, opencode-go';
}

async function credentialFound<T>(
  loader: () => Promise<T | null>,
): Promise<boolean> {
  try {
    return (await loader()) !== null;
  } catch {
    return false;
  }
}

const DEFAULT_CHECKERS = {
  claude: getClaudeToken,
  codex: getCodexToken,
  'command-code': getCommandCodeToken,
  'opencode-go': getOpenCodeGoToken,
} as const;

/** Pure/testable provider status probe. Injected checkers never touch disk. */
export async function getProviderStatuses(
  checkers: StatusCheckers = {},
): Promise<ProviderStatusMap> {
  const claude = checkers.claude ?? DEFAULT_CHECKERS.claude;
  const codex = checkers.codex ?? DEFAULT_CHECKERS.codex;
  const commandCode =
    checkers['command-code'] ?? DEFAULT_CHECKERS['command-code'];
  const openCodeGo = checkers['opencode-go'] ?? DEFAULT_CHECKERS['opencode-go'];
  const [c, x, cc, oc] = await Promise.all([
    credentialFound(claude as () => Promise<unknown | null>),
    credentialFound(codex as () => Promise<unknown | null>),
    credentialFound(commandCode as () => Promise<unknown | null>),
    credentialFound(openCodeGo as () => Promise<unknown | null>),
  ]);
  return { claude: c, codex: x, 'command-code': cc, 'opencode-go': oc };
}

/**
 * `setup --check` / dashboard-required predicate.
 * Claude + Codex + OpenCode Go are required; Command Code is optional.
 */
export function isRequiredConfigured(status: ProviderStatusMap): boolean {
  return status.claude && status.codex && status['opencode-go'];
}

/** Lines describing the current config file, port, and refresh interval. */
export function buildConfigSummary(config: AppConfig): string[] {
  return [
    `Config file: ${configPath()}`,
    `Port: ${config.port} (default 7878)`,
    `Refresh interval: ${config.refreshIntervalSec}s (minimum 30s)`,
  ];
}

/** Status lines in the long-standing setup label/order (Command Code last). */
export function buildStatusLines(status: ProviderStatusMap): string[] {
  return [
    `  Claude         ${status.claude ? '✓ configured' : '✗ not found — run \`claude\` to login'}`,
    `  Codex          ${status.codex ? '✓ configured' : '✗ not found — run \`codex login\`'}`,
    `  OpenCode Go    ${status['opencode-go'] ? '✓ API key found' : '✗ not found — use \`/connect\` in OpenCode'}`,
    `  Command Code   ${status['command-code'] ? '✓ configured' : '✗ not found — optional, set COMMAND_CODE_API_KEY or log into Command Code'}`,
  ];
}

/** Add-specific help text (also used for `llm-usage add --help`). */
export function buildAddHelp(): string {
  return `
llm-usage add — guided provider setup (never prints or stores secrets)

USAGE
  llm-usage add                 Interactive numbered menu (requires a TTY)
  llm-usage add <provider-id>   Guided setup for one provider
  llm-usage add --list          Show providers and configured status
  llm-usage add --help          Show this help

PROVIDERS
  1  claude         Claude
  2  codex          Codex
  3  command-code   Command Code (optional)
  4  opencode-go    OpenCode Go (aliases: opencode, opencode_go)

ALIASES
  command-code: commandcode, command_code, cmd, cmdc
  opencode-go: opencode, opencode_go

BEHAVIOR
  If the provider is already configured, setup reports that and changes
  nothing. Otherwise it prints the official login command and the exact
  credential source llm-usage reads. This command never asks for, stores,
  or prints secret values and never spawns external login commands.

ARGUMENTS (strict)
  At most one provider id or flag per invocation. Extras are rejected.
  \`--list\` cannot be combined with a provider id or another flag.
  Unknown flags are rejected. Run \`llm-usage add --help\` for usage.

EXIT CODES
  0  Help or list shown, or the provider is already configured (no changes).
  1  Guidance printed for a missing provider, or invalid arguments.
`.trim();
}

/** Provider list with configured status (used for `llm-usage add --list`). */
export function buildAddList(status: ProviderStatusMap): string {
  const rows: string[] = ['Providers:'];
  for (const p of ADD_PROVIDERS) {
    const found = status[p.id];
    rows.push(
      `  ${p.id.padEnd(13)} ${p.displayName.padEnd(13)} ${found ? '✓ configured' : '✗ not configured'}${p.optional ? ' (optional)' : ''}`,
    );
  }
  return rows.join('\n');
}

/** Login guidance for one provider (no secrets, no external commands). */
export function buildAddGuidance(provider: AddProviderInfo): string[] {
  return [
    `${provider.displayName} is not configured.`,
    `Credential source: ${provider.credentialSource}`,
    ...provider.loginSteps.map((s) => `  - ${s}`),
    'Re-run `llm-usage add --list` after logging in to verify.',
  ];
}

export interface SetupDeps {
  isTTY?: boolean;
  pipedLines?: string[] | null;
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
  err?: (message: string) => void;
  exit?: (code: number) => never;
  checkers?: StatusCheckers;
  config?: AppConfig;
}

export interface AddDeps {
  isTTY?: boolean;
  ask?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
  err?: (message: string) => void;
  checkers?: StatusCheckers;
}

function defaultQuestion(): {
  question: (prompt: string) => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    question: (prompt: string) =>
      new Promise((resolve) => rl.question(prompt, resolve)),
    close: () => rl.close(),
  };
}

export async function runSetupWizard(
  opts: { check?: boolean } = {},
  deps: SetupDeps = {},
): Promise<void> {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const checkers = deps.checkers ?? {};

  if (opts.check) {
    const status = await getProviderStatuses(checkers);
    log('Current status:');
    for (const line of buildStatusLines(status)) log(line);
    exit(isRequiredConfigured(status) ? 0 : 1);
    return;
  }

  const isTTY = deps.isTTY ?? process.stdin.isTTY;
  const pipedAnswers =
    isTTY || deps.question
      ? null
      : (deps.pipedLines ?? fs.readFileSync(0, 'utf8').split(/\r?\n/));
  let pipedAnswerIndex = 0;
  const interactive = pipedAnswers
    ? null
    : deps.question
      ? null
      : defaultQuestion();
  const question =
    deps.question ??
    (pipedAnswers
      ? async (prompt: string): Promise<string> => {
          process.stdout.write(prompt);
          return pipedAnswers[pipedAnswerIndex++] ?? '';
        }
      : async (prompt: string): Promise<string> =>
          interactive!.question(prompt));

  log('\n🔧  llm-usage setup\n');
  log(
    'Provider credentials are read automatically from their local CLI auth stores.\n',
  );
  for (const line of buildConfigSummary(config)) log(line);
  log('');
  const status = await getProviderStatuses(checkers);
  log('Current status:');
  for (const line of buildStatusLines(status)) log(line);
  log('');

  try {
    const intervalInput = await question(
      `Auto-refresh interval in seconds [${config.refreshIntervalSec}]: `,
    );
    const intervalSec =
      parseInt(intervalInput.trim(), 10) || config.refreshIntervalSec;

    validateConfig({ refreshIntervalSec: intervalSec });
    saveConfig({ refreshIntervalSec: intervalSec });

    log('\n✓  Configuration saved to ~/.llm-usage/config.json');
    log('  Run `llm-usage` to start the dashboard.');
  } catch (e) {
    if (e instanceof TypeError) {
      err(`\nValidation error: ${e.message}`);
      exit(1);
      return;
    }
    throw e;
  } finally {
    interactive?.close();
  }
}

/**
 * Guided `llm-usage add` flow. Returns a process exit code and never calls
 * process.exit itself, so it is safe to unit test. Never reads secrets from
 * stdin and never spawns external login commands.
 */
export async function runAddCommand(
  rawArgs: string[],
  deps: AddDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const checkers = deps.checkers ?? {};
  const isTTY = deps.isTTY ?? process.stdin.isTTY;

  const HELP_FLAGS = new Set(['--help', '-h']);
  const helpRequested = rawArgs.some((a) => HELP_FLAGS.has(a));
  const listRequested = rawArgs.includes('--list');
  const unknownFlag = rawArgs.find(
    (a) => a.startsWith('-') && !HELP_FLAGS.has(a) && a !== '--list',
  );
  if (unknownFlag) {
    err(`Unknown option '${unknownFlag}'. Run \`llm-usage add --help\`.`);
    return 1;
  }

  const positionals = rawArgs.filter((a) => !a.startsWith('-'));

  if (helpRequested && (listRequested || positionals.length > 0)) {
    err('Conflicting arguments. Run `llm-usage add --help` for usage.');
    return 1;
  }
  if (helpRequested) {
    log(buildAddHelp());
    return 0;
  }

  if (listRequested) {
    if (positionals.length > 0) {
      err(
        'Conflicting arguments: `--list` cannot be combined with a provider id. ' +
          'Run `llm-usage add --help`.',
      );
      return 1;
    }
    if (rawArgs.length > 1) {
      err('Too many arguments. Run `llm-usage add --help` for usage.');
      return 1;
    }
    const status = await getProviderStatuses(checkers);
    log(buildAddList(status));
    return 0;
  }

  if (positionals.length > 1) {
    err('Too many arguments. Run `llm-usage add --help` for usage.');
    return 1;
  }

  const selectionArg = positionals[0];
  let providerId: AddProviderId | null =
    selectionArg !== undefined
      ? normalizeProviderSelection(selectionArg)
      : null;

  if (selectionArg !== undefined && providerId === null) {
    err(
      `Unknown provider '${selectionArg}'. Valid providers: ${validProviderIds()}.`,
    );
    return 1;
  }

  if (providerId === null) {
    if (!isTTY) {
      err(
        'Not an interactive terminal. Run `llm-usage add <provider-id>` with one of: ' +
          `${validProviderIds()}. See \`llm-usage add --help\`.`,
      );
      return 1;
    }
    log('Add a provider:');
    ADD_PROVIDERS.forEach((p, i) => {
      log(
        `  ${i + 1}) ${p.displayName} (${p.id})${p.optional ? ' [optional]' : ''}`,
      );
    });
    let answer: string;
    if (deps.ask) {
      answer = await deps.ask('Select a provider [1-4]: ');
    } else {
      const io = defaultQuestion();
      try {
        answer = await io.question('Select a provider [1-4]: ');
      } finally {
        io.close();
      }
    }
    providerId = normalizeProviderSelection(answer);
    if (providerId === null) {
      err(
        `Invalid selection '${answer.trim()}'. Valid providers: ${validProviderIds()}.`,
      );
      return 1;
    }
  }

  const provider = getAddProvider(providerId);
  const status = await getProviderStatuses(checkers);
  if (status[provider.id]) {
    log(
      `✓ ${provider.displayName} is already configured (${provider.credentialSource}). No changes made.`,
    );
    return 0;
  }

  for (const line of buildAddGuidance(provider)) log(line);
  return 1;
}

/** Backwards-compatible status printer used by the setup wizard. */
export async function printProviderStatus(
  checkers: StatusCheckers = {},
): Promise<boolean> {
  const status = await getProviderStatuses(checkers);
  console.log('Current status:');
  for (const line of buildStatusLines(status)) console.log(line);
  // Command Code is optional and never affects the success/failure result.
  return isRequiredConfigured(status);
}
