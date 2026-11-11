import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  claudeCredentialsPath,
  codexAuthPath,
  commandCodeAuthPath,
  opencodeAuthPath,
  opencodeDbPath,
} from './paths.js';
import { redactSecrets, safeErrorMessage } from './redact.js';

/**
 * Resolve the Claude Code OAuth access token.
 * Re-reads from disk on every call — never caches in module scope.
 *
 * Priority:
 *   1. ~/.claude/.credentials.json → claudeAiOauth.accessToken
 *   2. Windows only: Windows Credential Manager entry "Claude Code-credentials"
 *      (spawns PowerShell Get-StoredCredential — best-effort)
 *   3. Returns null if nothing found (adapter maps null → unconfigured)
 */
export async function getClaudeToken(): Promise<string | null> {
  try {
    const filePath = claudeCredentialsPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const oauth = json['claudeAiOauth'] as
        Record<string, unknown> | undefined;
      const token = oauth?.['accessToken'];
      if (typeof token === 'string' && token.length > 0) {
        return token;
      }
    }
  } catch (err) {
    void safeErrorMessage(err);
    void redactSecrets(err);
  }

  if (process.platform === 'win32') {
    try {
      const ps = `(Get-StoredCredential -Target 'Claude Code-credentials' -AsCredential).GetNetworkCredential().Password`;
      const result = execSync(
        `powershell -NoProfile -NonInteractive -Command "${ps}"`,
        {
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim();
      if (
        result &&
        result.length > 0 &&
        !result.startsWith('Get-StoredCredential')
      ) {
        return result;
      }
    } catch (err) {
      void safeErrorMessage(err);
      void redactSecrets(err);
    }
  }

  return null;
}

/**
 * Resolve the Codex CLI OAuth access token and optional account ID.
 * Re-reads from disk on every call.
 *
 * Reads: ~/.codex/auth.json → tokens.access_token
 * Optionally decodes id_token JWT payload for chatgpt_account_id.
 */
export async function getCodexToken(): Promise<{
  accessToken: string;
  accountId?: string;
} | null> {
  try {
    const filePath = codexAuthPath();
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const tokens = json['tokens'] as Record<string, unknown> | undefined;
    if (!tokens) return null;

    const accessToken = tokens['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0)
      return null;

    let accountId: string | undefined;
    try {
      const idToken = tokens['id_token'];
      if (typeof idToken === 'string') {
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1]!, 'base64url').toString('utf8'),
          ) as Record<string, unknown>;
          const id =
            payload['chatgpt_account_id'] ??
            payload['account_id'] ??
            payload['sub'];
          if (typeof id === 'string') accountId = id;
        }
      }
    } catch (err) {
      void safeErrorMessage(err);
      void redactSecrets(err);
    }

    return { accessToken, accountId };
  } catch (err) {
    void safeErrorMessage(err);
    void redactSecrets(err);
    return null;
  }
}

const ACTIVE_OPENCODE_CREDENTIAL_SQL = `
  SELECT value FROM credential
  WHERE integration_id IN ('opencode-go', 'opencode') AND active = 1
  ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END,
           time_updated DESC
  LIMIT 1
`;

type SqliteModule = typeof import('node:sqlite');

function loadSqlite(): SqliteModule {
  // Lazy native loading keeps legacy-only use free of SQLite startup warnings.
  // createRequire also supports test/build tools predating the node:sqlite builtin.
  return createRequire(import.meta.url)('node:sqlite') as SqliteModule;
}

function queryActiveCredential(
  location: string,
  options: { readOnly: boolean },
): Record<string, unknown> | undefined {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(location, options);
  try {
    db.exec('PRAGMA busy_timeout=1000');
    return db.prepare(ACTIVE_OPENCODE_CREDENTIAL_SQL).get() as
      Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

/**
 * Read the active OpenCode v2 credential row.
 *
 * OpenCode's DB is in WAL mode. SQLite deletes the -wal/-shm files when the
 * last OpenCode process exits, and a read-only connection cannot recreate the
 * -shm — which is exactly the situation inside the Docker container, where the
 * data dir is mounted :ro. A plain read-only open then fails with "unable to
 * open database file" until OpenCode is started again, so fall back:
 *   1. normal read-only open (sees live WAL content while OpenCode runs)
 *   2. immutable open — exact when no WAL exists, needs no -shm
 *   3. private snapshot of db(+wal/shm) in a temp dir, opened there
 */
function readActiveOpenCodeCredentialRow(
  dbPath: string,
): Record<string, unknown> | undefined {
  let firstError: unknown;
  try {
    return queryActiveCredential(dbPath, { readOnly: true });
  } catch (err) {
    firstError = err;
  }

  const walPath = `${dbPath}-wal`;
  let walHasData = false;
  try {
    walHasData = fs.statSync(walPath).size > 0;
  } catch {
    walHasData = false;
  }

  if (!walHasData) {
    try {
      return queryActiveCredential(
        `${pathToFileURL(dbPath).href}?immutable=1`,
        { readOnly: true },
      );
    } catch {
      // fall through to the snapshot strategy
    }
  }

  let tempDir: string | undefined;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-opencode-'));
    const copyPath = path.join(tempDir, 'opencode.db');
    fs.copyFileSync(dbPath, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.copyFileSync(`${dbPath}${suffix}`, `${copyPath}${suffix}`);
      } catch {
        // sidecar absent: the main file alone is then complete
      }
    }
    return queryActiveCredential(copyPath, { readOnly: false });
  } catch {
    throw firstError;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Resolve an API key for the OpenCode Go usage endpoint.
 * Priority: explicit API key, explicit legacy auth path, v2 active account, v1 JSON.
 * Once a v2 database exists it is authoritative: never resurrect legacy keys after logout.
 */
export async function getOpenCodeGoToken(): Promise<string | null> {
  const environmentKey = process.env['OPENCODE_API_KEY']?.trim();
  if (environmentKey) return environmentKey;
  try {
    const dbPath = opencodeDbPath();
    if (!process.env['OPENCODE_AUTH_PATH'] && fs.existsSync(dbPath)) {
      const row = readActiveOpenCodeCredentialRow(dbPath);
      if (!row || typeof row['value'] !== 'string') return null;
      const value: unknown = JSON.parse(row['value']);
      if (!value || typeof value !== 'object') return null;
      const entry = value as Record<string, unknown>;
      const key = entry['key'];
      // V2 uses type "key", unlike the legacy JSON store's type "api".
      return entry['type'] === 'key' && typeof key === 'string' && key.trim()
        ? key.trim()
        : null;
    }

    const filePath = opencodeAuthPath();
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;

    for (const providerId of ['opencode-go', 'opencode']) {
      const entry = json[providerId] as Record<string, unknown> | undefined;
      const key = entry?.['key'];
      if (
        entry?.['type'] === 'api' &&
        typeof key === 'string' &&
        key.length > 0
      ) {
        return key;
      }
    }
  } catch (err) {
    void safeErrorMessage(err);
    void redactSecrets(err);
  }
  return null;
}

/** Command Code API key: COMMAND_CODE_API_KEY env first, then ~/.commandcode/auth.json apiKey. */
export async function getCommandCodeToken(): Promise<string | null> {
  const environmentKey = process.env['COMMAND_CODE_API_KEY']?.trim();
  if (environmentKey) return environmentKey;
  try {
    const filePath = commandCodeAuthPath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    const key = json['apiKey'] ?? json['api_key'];
    if (typeof key === 'string' && key.trim().length > 0) return key.trim();
  } catch (err) {
    void safeErrorMessage(err);
    void redactSecrets(err);
  }
  return null;
}
