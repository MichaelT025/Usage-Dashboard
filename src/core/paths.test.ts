import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeCredentialsPath,
  codexAuthPath,
  commandCodeAuthPath,
  configPath,
  opencodeAuthPath,
  opencodeDbPath,
} from './paths.js';

const originalClaude = process.env.CLAUDE_CONFIG_DIR;
const originalCodex = process.env.CODEX_HOME;
const originalCommandCodeAuth = process.env.COMMAND_CODE_AUTH_PATH;
const originalHome = process.env.HOME;
const originalOpenCodeDb = process.env.OPENCODE_DB;
const originalOpenCodeAuthPath = process.env.OPENCODE_AUTH_PATH;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
  for (const [key, value] of Object.entries({
    OPENCODE_DB: originalOpenCodeDb,
    OPENCODE_AUTH_PATH: originalOpenCodeAuthPath,
    XDG_DATA_HOME: originalXdgDataHome,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaude;

  if (originalCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodex;

  if (originalCommandCodeAuth === undefined)
    delete process.env.COMMAND_CODE_AUTH_PATH;
  else process.env.COMMAND_CODE_AUTH_PATH = originalCommandCodeAuth;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('paths', () => {
  it('resolves default OpenCode v1 and v2 paths', () => {
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_AUTH_PATH;
    delete process.env.XDG_DATA_HOME;
    expect(opencodeDbPath().replace(/\\/g, '/')).toBe(
      `${os.homedir().replace(/\\/g, '/')}/.local/share/opencode/opencode.db`,
    );
    expect(opencodeAuthPath().replace(/\\/g, '/')).toBe(
      `${os.homedir().replace(/\\/g, '/')}/.local/share/opencode/auth.json`,
    );
  });

  it('honors XDG_DATA_HOME for both OpenCode stores', () => {
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_AUTH_PATH;
    process.env.XDG_DATA_HOME = '/custom/data';
    expect(opencodeDbPath().replace(/\\/g, '/')).toMatch(
      /\/custom\/data\/opencode\/opencode.db$/,
    );
    expect(opencodeAuthPath().replace(/\\/g, '/')).toMatch(
      /\/custom\/data\/opencode\/auth.json$/,
    );
  });

  it('honors explicit OpenCode database and legacy-file overrides', () => {
    process.env.OPENCODE_DB = '/custom/channel.db';
    process.env.OPENCODE_AUTH_PATH = '/legacy/auth.json';
    expect(opencodeDbPath().replace(/\\/g, '/')).toMatch(
      /\/custom\/channel.db$/,
    );
    expect(opencodeAuthPath().replace(/\\/g, '/')).toMatch(
      /\/legacy\/auth.json$/,
    );
  });

  it('configPath uses os.homedir()', () => {
    const result = configPath();
    expect(
      result.replace(/\\/g, '/').startsWith(os.homedir().replace(/\\/g, '/')),
    ).toBe(true);
    expect(result.replace(/\\/g, '/').endsWith('.llm-usage/config.json')).toBe(
      true,
    );
  });

  it('claudeCredentialsPath supports default and env override', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(
      claudeCredentialsPath()
        .replace(/\\/g, '/')
        .endsWith('.claude/.credentials.json'),
    ).toBe(true);

    process.env.CLAUDE_CONFIG_DIR = '/tmp/test';
    expect(
      claudeCredentialsPath()
        .replace(/\\/g, '/')
        .endsWith('/tmp/test/.credentials.json'),
    ).toBe(true);
  });

  it('codexAuthPath supports default and env override', () => {
    delete process.env.CODEX_HOME;
    expect(
      codexAuthPath().replace(/\\/g, '/').endsWith('.codex/auth.json'),
    ).toBe(true);

    process.env.CODEX_HOME = '/tmp/codex';
    expect(
      codexAuthPath().replace(/\\/g, '/').endsWith('/tmp/codex/auth.json'),
    ).toBe(true);
  });

  it('commandCodeAuthPath supports default and env override', () => {
    delete process.env.COMMAND_CODE_AUTH_PATH;
    expect(
      commandCodeAuthPath()
        .replace(/\\/g, '/')
        .endsWith('.commandcode/auth.json'),
    ).toBe(true);

    process.env.COMMAND_CODE_AUTH_PATH = '/tmp/commandcode-auth.json';
    expect(
      commandCodeAuthPath()
        .replace(/\\/g, '/')
        .endsWith('/tmp/commandcode-auth.json'),
    ).toBe(true);
  });

  it('does not rely on process.env.HOME', () => {
    delete process.env.HOME;
    expect(configPath()).not.toBe(
      (process.env.HOME ?? '') + '/.llm-usage/config.json',
    );
  });
});
