import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { claudeCredentialsPath, codexAuthPath } from './paths.js';
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
      const oauth = json['claudeAiOauth'] as Record<string, unknown> | undefined;
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
      const result = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (result && result.length > 0 && !result.startsWith('Get-StoredCredential')) {
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
export async function getCodexToken(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const filePath = codexAuthPath();
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const tokens = json['tokens'] as Record<string, unknown> | undefined;
    if (!tokens) return null;

    const accessToken = tokens['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

    let accountId: string | undefined;
    try {
      const idToken = tokens['id_token'];
      if (typeof idToken === 'string') {
        const parts = idToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
          const id = payload['chatgpt_account_id'] ?? payload['account_id'] ?? payload['sub'];
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
