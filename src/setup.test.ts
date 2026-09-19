import { describe, expect, it, vi } from 'vitest';
import { saveConfig } from './core/config.js';
import {
  ADD_PROVIDERS,
  buildAddGuidance,
  buildAddHelp,
  buildAddList,
  buildConfigSummary,
  buildStatusLines,
  getAddProvider,
  getProviderStatuses,
  isRequiredConfigured,
  normalizeProviderSelection,
  runAddCommand,
  runSetupWizard,
  type ProviderStatusMap,
} from './setup.js';

vi.mock('./core/config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./core/config.js')>();
  return { ...actual, saveConfig: vi.fn() };
});

const ALL_ON: ProviderStatusMap = {
  claude: true,
  codex: true,
  'command-code': true,
  'opencode-go': true,
};

const REQUIRED_ONLY: ProviderStatusMap = {
  claude: true,
  codex: true,
  'command-code': false,
  'opencode-go': true,
};

function checkersFrom(status: ProviderStatusMap) {
  return {
    claude: async () => (status.claude ? 'tok' : null),
    codex: async () => (status.codex ? 'tok' : null),
    'command-code': async () => (status['command-code'] ? 'tok' : null),
    'opencode-go': async () => (status['opencode-go'] ? 'tok' : null),
  };
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (m: string) => void logs.push(m),
    err: (m: string) => void errors.push(m),
  };
}

describe('getProviderStatuses', () => {
  it('maps stub checkers to a status map', async () => {
    expect(await getProviderStatuses(checkersFrom(ALL_ON))).toEqual(ALL_ON);
  });

  it('treats throwing loaders as not configured', async () => {
    const status = await getProviderStatuses({
      claude: async () => {
        throw new Error('boom');
      },
      codex: async () => 'tok',
      'command-code': async () => null,
      'opencode-go': async () => 'tok',
    });
    expect(status).toEqual({
      claude: false,
      codex: true,
      'command-code': false,
      'opencode-go': true,
    });
  });
});

describe('isRequiredConfigured', () => {
  it('requires Claude + Codex + OpenCode Go', () => {
    expect(isRequiredConfigured(ALL_ON)).toBe(true);
    expect(
      isRequiredConfigured({ ...ALL_ON, 'opencode-go': false }),
    ).toBe(false);
    expect(isRequiredConfigured({ ...ALL_ON, claude: false })).toBe(false);
    expect(isRequiredConfigured({ ...ALL_ON, codex: false })).toBe(false);
  });

  it('treats Command Code as optional', () => {
    expect(isRequiredConfigured(REQUIRED_ONLY)).toBe(true);
  });
});

describe('buildConfigSummary', () => {
  it('mentions config file, port, and refresh interval', () => {
    const lines = buildConfigSummary({
      refreshIntervalSec: 180,
      port: 7878,
    }).join('\n');
    expect(lines).toMatch(/config\.json/);
    expect(lines).toMatch(/7878/);
    expect(lines).toMatch(/180/);
  });
});

describe('buildStatusLines', () => {
  it('keeps legacy labels and order (Command Code last)', () => {
    const lines = buildStatusLines(REQUIRED_ONLY);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/Claude/);
    expect(lines[1]).toMatch(/Codex/);
    expect(lines[2]).toMatch(/OpenCode Go/);
    expect(lines[3]).toMatch(/Command Code/);
    expect(lines[0]).toMatch(/✓ configured/);
    expect(lines[3]).toMatch(/optional/);
  });
});

describe('normalizeProviderSelection', () => {
  it('accepts ids case-insensitively', () => {
    expect(normalizeProviderSelection('claude')).toBe('claude');
    expect(normalizeProviderSelection('Codex')).toBe('codex');
    expect(normalizeProviderSelection('COMMAND-CODE')).toBe('command-code');
    expect(normalizeProviderSelection('opencode-go')).toBe('opencode-go');
  });

  it('accepts menu numbers and aliases', () => {
    expect(normalizeProviderSelection('1')).toBe('claude');
    expect(normalizeProviderSelection('2')).toBe('codex');
    expect(normalizeProviderSelection('3')).toBe('command-code');
    expect(normalizeProviderSelection('4')).toBe('opencode-go');
    expect(normalizeProviderSelection('opencode')).toBe('opencode-go');
    expect(normalizeProviderSelection('commandcode')).toBe('command-code');
  });

  it('rejects blank and unknown input', () => {
    expect(normalizeProviderSelection('')).toBeNull();
    expect(normalizeProviderSelection(undefined)).toBeNull();
    expect(normalizeProviderSelection('watson')).toBeNull();
  });
});

describe('runAddCommand help and list', () => {
  it('--help prints add-specific help and exits 0', async () => {
    const c = capture();
    const code = await runAddCommand(['--help'], {
      ...c,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/llm-usage add/);
    expect(c.logs.join('\n')).toMatch(/--list/);
  });

  it('--list prints providers and status', async () => {
    const c = capture();
    const code = await runAddCommand(['--list'], {
      ...c,
      checkers: checkersFrom(REQUIRED_ONLY),
    });
    expect(code).toBe(0);
    const out = c.logs.join('\n');
    for (const p of ADD_PROVIDERS) expect(out).toContain(p.id);
    expect(out).toMatch(/not configured/);
  });
});

describe('runAddCommand selection', () => {
  it('rejects unknown provider ids', async () => {
    const c = capture();
    const code = await runAddCommand(['watson'], {
      ...c,
      isTTY: true,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Unknown provider/);
  });

  it('fails clearly on non-TTY with no id without reading stdin', async () => {
    let asked = false;
    const c = capture();
    const code = await runAddCommand([], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
      ask: async () => {
        asked = true;
        return '1';
      },
    });
    expect(code).toBe(1);
    expect(asked).toBe(false);
    expect(c.errors.join('\n')).toMatch(/Not an interactive terminal/);
  });

  it('reports already-configured providers without changes', async () => {
    const c = capture();
    const code = await runAddCommand(['claude'], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/already configured/);
  });

  it('prints official login instructions for missing providers', async () => {
    const cases: Array<[string, RegExp, RegExp]> = [
      ['claude', /\/login/, /credentials\.json/],
      ['codex', /codex login/, /auth\.json/],
      ['command-code', /command-code login/, /COMMAND_CODE_API_KEY/],
      ['opencode-go', /\/connect/, /OPENCODE_API_KEY/],
    ];
    for (const [id, loginRe, sourceRe] of cases) {
      const c = capture();
      const code = await runAddCommand([id], {
        ...c,
        isTTY: false,
        checkers: checkersFrom({
          claude: false,
          codex: false,
          'command-code': false,
          'opencode-go': false,
        }),
      });
      expect(code).toBe(1);
      const out = c.logs.join('\n');
      expect(out).toMatch(loginRe);
      expect(out).toMatch(sourceRe);
    }
  });

  it('rejects extra positional arguments', async () => {
    const c = capture();
    const code = await runAddCommand(['claude', 'codex'], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Too many arguments/);
  });

  it('rejects --list combined with a provider id', async () => {
    const c = capture();
    const code = await runAddCommand(['--list', 'claude'], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Conflicting arguments/);
  });

  it('rejects unknown flags', async () => {
    const c = capture();
    const code = await runAddCommand(['--bogus'], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Unknown option/);
  });

  it('rejects --help combined with other arguments', async () => {
    const c = capture();
    const code = await runAddCommand(['--help', 'claude'], {
      ...c,
      isTTY: false,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Conflicting arguments/);
  });

  it('documents 0/1 exit semantics in help', async () => {
    const c = capture();
    const code = await runAddCommand(['--help'], {
      ...c,
      checkers: checkersFrom(ALL_ON),
    });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/EXIT CODES/);
    expect(c.logs.join('\n')).toMatch(/0.*already configured/s);
  });
  it('Command Code guidance distinguishes portable login from platform aliases', async () => {
    const guidance = buildAddGuidance(getAddProvider('command-code')).join(
      '\n',
    );
    expect(guidance).toMatch(/command-code login/);
    expect(guidance).toMatch(/cmdc.*Windows/);
    expect(guidance).toMatch(/POSIX-only/);
  });

  it('TTY menu selection resolves through ask without secrets', async () => {
    const c = capture();
    const code = await runAddCommand([], {
      ...c,
      isTTY: true,
      checkers: checkersFrom(REQUIRED_ONLY),
      ask: async () => '1',
    });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/already configured/);
  });

  it('TTY invalid menu selection fails clearly', async () => {
    const c = capture();
    const code = await runAddCommand([], {
      ...c,
      isTTY: true,
      checkers: checkersFrom(ALL_ON),
      ask: async () => '9',
    });
    expect(code).toBe(1);
    expect(c.errors.join('\n')).toMatch(/Invalid selection/);
  });
});

describe('setup regression', () => {
  it('--check exits 0 when required providers configured (Command Code optional)', async () => {
    const c = capture();
    let exitCode = -1;
    await runSetupWizard(
      { check: true },
      {
        ...c,
        checkers: checkersFrom(REQUIRED_ONLY),
        exit: ((code: number) => {
          exitCode = code;
          throw new Error('exit');
        }) as (code: number) => never,
      },
    ).catch((e: Error) => {
      expect(e.message).toBe('exit');
    });
    expect(exitCode).toBe(0);
    expect(c.logs.join('\n')).toMatch(/Current status/);
  });

  it('--check exits 1 when a required provider is missing', async () => {
    const c = capture();
    let exitCode = -1;
    await runSetupWizard(
      { check: true },
      {
        ...c,
        checkers: checkersFrom({ ...REQUIRED_ONLY, codex: false }),
        exit: ((code: number) => {
          exitCode = code;
          throw new Error('exit');
        }) as (code: number) => never,
      },
    ).catch((e: Error) => {
      expect(e.message).toBe('exit');
    });
    expect(exitCode).toBe(1);
  });

  it('add help mentions never handling secrets', () => {
    expect(buildAddHelp()).toMatch(/never.*secret/i);
  });

  it('wizard saves via injected question on non-TTY without touching stdin or disk', async () => {
    const c = capture();
    const mockedSave = vi.mocked(saveConfig);
    mockedSave.mockClear();
    let prompted = '';
    await runSetupWizard(
      {},
      {
        ...c,
        isTTY: false,
        config: { refreshIntervalSec: 180, port: 7878 },
        checkers: checkersFrom(REQUIRED_ONLY),
        question: async (prompt: string) => {
          prompted = prompt;
          return '';
        },
      },
    );
    expect(prompted).toMatch(/interval/i);
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith({ refreshIntervalSec: 180 });
    expect(c.logs.join('\n')).toMatch(/Configuration saved/);
  });
});
