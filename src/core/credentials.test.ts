import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClaudeToken,
  getCodexToken,
  getCommandCodeToken,
  getOpenCodeGoToken,
} from './credentials.js';

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
const originalCodexHome = process.env.CODEX_HOME;
const originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
const originalOpenCodeAuthPath = process.env.OPENCODE_AUTH_PATH;
const originalOpenCodeDb = process.env.OPENCODE_DB;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalCommandCodeApiKey = process.env.COMMAND_CODE_API_KEY;
const originalCommandCodeAuthPath = process.env.COMMAND_CODE_AUTH_PATH;
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
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'usage-dashboard-credentials-'),
  );
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_AUTH_PATH;
  process.env.OPENCODE_DB = path.join(tempRoot, 'opencode.db');
  delete process.env.XDG_DATA_HOME;
  delete process.env.COMMAND_CODE_API_KEY;
  delete process.env.COMMAND_CODE_AUTH_PATH;
  vi.restoreAllMocks();
  vi.spyOn(os, 'homedir').mockReturnValue(tempRoot);
});

afterEach(() => {
  if (originalClaudeConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;

  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;

  if (originalOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalOpenCodeApiKey;

  if (originalOpenCodeAuthPath === undefined)
    delete process.env.OPENCODE_AUTH_PATH;
  else process.env.OPENCODE_AUTH_PATH = originalOpenCodeAuthPath;

  if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = originalOpenCodeDb;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;

  if (originalCommandCodeApiKey === undefined)
    delete process.env.COMMAND_CODE_API_KEY;
  else process.env.COMMAND_CODE_API_KEY = originalCommandCodeApiKey;

  if (originalCommandCodeAuthPath === undefined)
    delete process.env.COMMAND_CODE_AUTH_PATH;
  else process.env.COMMAND_CODE_AUTH_PATH = originalCommandCodeAuthPath;

  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
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
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

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

describe('getOpenCodeGoToken', () => {
  function openDatabase(): SQLiteDatabase {
    const db = new DatabaseSync(process.env.OPENCODE_DB!);
    db.exec(`CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER,
      value TEXT NOT NULL, time_updated INTEGER NOT NULL
    )`);
    return db;
  }

  function insertKey(
    db: SQLiteDatabase,
    id: string,
    integration: string,
    active: number | null,
    key: string,
    updated = 1,
  ): void {
    db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)').run(
      id,
      integration,
      active,
      JSON.stringify({ type: 'key', key }),
      updated,
    );
  }

  it('reads the active v2 Go account instead of stale legacy credentials', async () => {
    process.env.XDG_DATA_HOME = tempRoot;
    writeJson(path.join(tempRoot, 'opencode', 'auth.json'), {
      'opencode-go': { type: 'api', key: 'STALE-LEGACY-KEY' },
    });
    const db = openDatabase();
    try {
      insertKey(db, 'inactive', 'opencode-go', null, 'OLD-KEY', 99);
      insertKey(db, 'active', 'opencode-go', 1, 'ACTIVE-GO-KEY');
      insertKey(db, 'shared', 'opencode', 1, 'SHARED-KEY', 100);
      await expect(getOpenCodeGoToken()).resolves.toBe('ACTIVE-GO-KEY');
    } finally {
      db.close();
    }
  });

  it('re-reads v2 rotations and account switches including uncheckpointed WAL', async () => {
    const db = openDatabase();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    try {
      insertKey(db, 'first', 'opencode-go', 1, 'FIRST-KEY');
      await expect(getOpenCodeGoToken()).resolves.toBe('FIRST-KEY');
      db.exec('UPDATE credential SET active = NULL');
      insertKey(db, 'second', 'opencode-go', 1, 'SECOND-KEY');
      await expect(getOpenCodeGoToken()).resolves.toBe('SECOND-KEY');
    } finally {
      db.close();
    }
  });

  it('falls back to the active v2 shared account, never an inactive Go key', async () => {
    const db = openDatabase();
    try {
      insertKey(db, 'inactive', 'opencode-go', null, 'INACTIVE-KEY');
      insertKey(db, 'shared', 'opencode', 1, 'ACTIVE-SHARED-KEY');
      await expect(getOpenCodeGoToken()).resolves.toBe('ACTIVE-SHARED-KEY');
    } finally {
      db.close();
    }
  });

  it('does not resurrect legacy auth after v2 logout', async () => {
    const db = openDatabase();
    db.close();
    process.env.XDG_DATA_HOME = tempRoot;
    writeJson(path.join(tempRoot, 'opencode', 'auth.json'), {
      'opencode-go': { type: 'api', key: 'STALE-LEGACY-KEY' },
    });
    await expect(getOpenCodeGoToken()).resolves.toBeNull();
  });

  it('supports default v2 discovery under XDG_DATA_HOME', async () => {
    process.env.XDG_DATA_HOME = tempRoot;
    fs.mkdirSync(path.join(tempRoot, 'opencode'));
    process.env.OPENCODE_DB = path.join(tempRoot, 'opencode', 'opencode.db');
    const db = openDatabase();
    try {
      insertKey(db, 'active', 'opencode-go', 1, 'XDG-KEY');
      delete process.env.OPENCODE_DB;
      await expect(getOpenCodeGoToken()).resolves.toBe('XDG-KEY');
    } finally {
      db.close();
    }
  });

  it('supports automatic v1 discovery when no v2 database exists', async () => {
    process.env.XDG_DATA_HOME = tempRoot;
    writeJson(path.join(tempRoot, 'opencode', 'auth.json'), {
      'opencode-go': { type: 'api', key: 'LEGACY-KEY' },
    });
    await expect(getOpenCodeGoToken()).resolves.toBe('LEGACY-KEY');
  });

  it('rejects non-key or empty v2 credentials without trying inactive accounts', async () => {
    const db = openDatabase();
    try {
      insertKey(db, 'active', 'opencode-go', 1, 'ORIGINAL');
      insertKey(db, 'inactive', 'opencode-go', null, 'INACTIVE');
      for (const value of [
        { type: 'oauth', key: 'NOT-AN-API-KEY' },
        { type: 'api', key: 'LEGACY-TYPE-NOT-V2' },
        { type: 'key', key: ' ' },
        { type: 'key', key: 123 },
        null,
        [],
      ]) {
        db.prepare('UPDATE credential SET value = ? WHERE id = ?').run(
          JSON.stringify(value),
          'active',
        );
        await expect(getOpenCodeGoToken()).resolves.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it('fails closed on unreadable or malformed v2 databases without logging secrets', async () => {
    const db = openDatabase();
    db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)').run(
      'broken',
      'opencode-go',
      1,
      '{"key":"DO-NOT-LEAK"',
      1,
    );
    db.close();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await expect(getOpenCodeGoToken()).resolves.toBeNull();
    fs.writeFileSync(process.env.OPENCODE_DB!, 'not a database DO-NOT-LEAK');
    await expect(getOpenCodeGoToken()).resolves.toBeNull();
    expect(
      JSON.stringify([...log.mock.calls, ...error.mock.calls]),
    ).not.toContain('DO-NOT-LEAK');
  });

  it('prefers explicit environment keys and legacy auth-path overrides to v2', async () => {
    const db = openDatabase();
    try {
      insertKey(db, 'active', 'opencode-go', 1, 'DATABASE-KEY');
      process.env.OPENCODE_API_KEY = 'ENV-KEY';
      await expect(getOpenCodeGoToken()).resolves.toBe('ENV-KEY');
      delete process.env.OPENCODE_API_KEY;
      process.env.OPENCODE_AUTH_PATH = path.join(tempRoot, 'explicit.json');
      writeJson(process.env.OPENCODE_AUTH_PATH, {
        'opencode-go': { type: 'api', key: 'EXPLICIT-LEGACY-KEY' },
      });
      await expect(getOpenCodeGoToken()).resolves.toBe('EXPLICIT-LEGACY-KEY');
    } finally {
      db.close();
    }
  });

  it('resolves the opencode-go API key from the CLI auth store', async () => {
    const authPath = path.join(tempRoot, 'opencode-auth.json');
    process.env.OPENCODE_AUTH_PATH = authPath;
    writeJson(authPath, {
      'opencode-go': { type: 'api', key: 'OPENCODE-GO-FIXTURE' },
    });

    await expect(getOpenCodeGoToken()).resolves.toBe('OPENCODE-GO-FIXTURE');
  });

  it('falls back to the shared opencode entry', async () => {
    const authPath = path.join(tempRoot, 'opencode-auth.json');
    process.env.OPENCODE_AUTH_PATH = authPath;
    writeJson(authPath, {
      opencode: { type: 'api', key: 'OPENCODE-SHARED-FIXTURE' },
    });

    await expect(getOpenCodeGoToken()).resolves.toBe('OPENCODE-SHARED-FIXTURE');
  });

  it('re-reads the Go key after an atomic auth-file replacement', async () => {
    const authPath = path.join(tempRoot, 'opencode-auth.json');
    process.env.OPENCODE_AUTH_PATH = authPath;
    writeJson(authPath, {
      'opencode-go': { type: 'api', key: 'OPENCODE-OLD-FIXTURE' },
    });
    await expect(getOpenCodeGoToken()).resolves.toBe('OPENCODE-OLD-FIXTURE');

    const replacement = `${authPath}.new`;
    writeJson(replacement, {
      'opencode-go': { type: 'api', key: 'OPENCODE-NEW-FIXTURE' },
    });
    fs.renameSync(replacement, authPath);

    await expect(getOpenCodeGoToken()).resolves.toBe('OPENCODE-NEW-FIXTURE');
  });

  it('prefers OPENCODE_API_KEY over the auth store', async () => {
    const authPath = path.join(tempRoot, 'opencode-auth.json');
    process.env.OPENCODE_AUTH_PATH = authPath;
    process.env.OPENCODE_API_KEY = 'OPENCODE-ENV-FIXTURE';
    writeJson(authPath, {
      'opencode-go': { type: 'api', key: 'OPENCODE-FILE-FIXTURE' },
    });

    await expect(getOpenCodeGoToken()).resolves.toBe('OPENCODE-ENV-FIXTURE');
  });

  it('returns null without exposing malformed credential contents', async () => {
    const authPath = path.join(tempRoot, 'opencode-auth.json');
    const fakeToken = 'sk-OPENCODE-DO-NOT-LEAK';
    process.env.OPENCODE_AUTH_PATH = authPath;
    fs.writeFileSync(
      authPath,
      `{ "opencode-go": { "type": "api", "key": "${fakeToken}" `,
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(getOpenCodeGoToken()).resolves.toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain(fakeToken);
    expect(JSON.stringify(error.mock.calls)).not.toContain(fakeToken);
  });
});

describe('getCommandCodeToken', () => {
  it('resolves the apiKey from the Command Code auth file', async () => {
    const authPath = path.join(tempRoot, 'commandcode-auth.json');
    process.env.COMMAND_CODE_AUTH_PATH = authPath;
    writeJson(authPath, { apiKey: 'COMMAND-CODE-FIXTURE' });

    await expect(getCommandCodeToken()).resolves.toBe('COMMAND-CODE-FIXTURE');
  });

  it('prefers COMMAND_CODE_API_KEY over the auth file', async () => {
    const authPath = path.join(tempRoot, 'commandcode-auth.json');
    process.env.COMMAND_CODE_AUTH_PATH = authPath;
    process.env.COMMAND_CODE_API_KEY = 'COMMAND-CODE-ENV-FIXTURE';
    writeJson(authPath, { apiKey: 'COMMAND-CODE-FILE-FIXTURE' });

    await expect(getCommandCodeToken()).resolves.toBe(
      'COMMAND-CODE-ENV-FIXTURE',
    );
  });

  it('returns null without exposing malformed credential contents', async () => {
    const authPath = path.join(tempRoot, 'commandcode-auth.json');
    const fakeToken = 'cc-DO-NOT-LEAK';
    process.env.COMMAND_CODE_AUTH_PATH = authPath;
    fs.writeFileSync(authPath, `{ "apiKey": "${fakeToken}" `, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(getCommandCodeToken()).resolves.toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain(fakeToken);
    expect(JSON.stringify(error.mock.calls)).not.toContain(fakeToken);
  });
});
