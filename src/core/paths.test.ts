import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCredentialsPath, codexAuthPath, configPath } from './paths.js';

const originalClaude = process.env.CLAUDE_CONFIG_DIR;
const originalCodex = process.env.CODEX_HOME;
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaude;

  if (originalCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodex;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('paths', () => {
  it('configPath uses os.homedir()', () => {
    const result = configPath();
    expect(result.replace(/\\/g, '/').startsWith(os.homedir().replace(/\\/g, '/'))).toBe(true);
    expect(result.replace(/\\/g, '/').endsWith('.llm-usage/config.json')).toBe(true);
  });

  it('claudeCredentialsPath supports default and env override', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeCredentialsPath().replace(/\\/g, '/').endsWith('.claude/.credentials.json')).toBe(true);

    process.env.CLAUDE_CONFIG_DIR = '/tmp/test';
    expect(claudeCredentialsPath().replace(/\\/g, '/').endsWith('/tmp/test/.credentials.json')).toBe(true);
  });

  it('codexAuthPath supports default and env override', () => {
    delete process.env.CODEX_HOME;
    expect(codexAuthPath().replace(/\\/g, '/').endsWith('.codex/auth.json')).toBe(true);

    process.env.CODEX_HOME = '/tmp/codex';
    expect(codexAuthPath().replace(/\\/g, '/').endsWith('/tmp/codex/auth.json')).toBe(true);
  });

  it('does not rely on process.env.HOME', () => {
    delete process.env.HOME;
    expect(configPath()).not.toBe((process.env.HOME ?? '') + '/.llm-usage/config.json');
  });
});
