import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClaudeToken, getCodexToken } from './credentials.js';

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

let tempRoot: string;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-credentials-'));
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;

  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;

  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('getClaudeToken', () => {
  it('resolves Claude token from file', async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'claude');
    writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'sk-ant-oat01-FIXTURE' },
    });

    await expect(getClaudeToken()).resolves.toBe('sk-ant-oat01-FIXTURE');
  });

  it('returns null when Claude file is missing on non-Windows', async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'missing-claude');
    mockPlatform('linux');

    await expect(getClaudeToken()).resolves.toBeNull();
  });

  it('does not log or throw token values on malformed Claude credentials', async () => {
    const fakeToken = 'sk-ant-oat01-DO-NOT-LEAK';
    process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'malformed-claude');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
      `{ "claudeAiOauth": { "accessToken": "${fakeToken}" `,
      'utf8',
    );
    mockPlatform('linux');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getClaudeToken()).resolves.toBeNull();

    expect(JSON.stringify(log.mock.calls)).not.toContain(fakeToken);
    expect(JSON.stringify(error.mock.calls)).not.toContain(fakeToken);
  });
});

describe('getCodexToken', () => {
  it('parses Codex auth.json with accountId from id_token', async () => {
    process.env.CODEX_HOME = path.join(tempRoot, 'codex');
    const idToken = [
      base64UrlJson({ alg: 'none', typ: 'JWT' }),
      base64UrlJson({ chatgpt_account_id: 'acct_123', sub: 'user_abc' }),
      'sig',
    ].join('.');

    writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), {
      tokens: {
        access_token: 'CODEX-ACCESS-TOKEN',
        id_token: idToken,
      },
    });

    await expect(getCodexToken()).resolves.toEqual({
      accessToken: 'CODEX-ACCESS-TOKEN',
      accountId: 'acct_123',
    });
  });
});
