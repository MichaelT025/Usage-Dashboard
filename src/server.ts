import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Poller } from './core/poller.js';
import { ClaudeAdapter } from './providers/claude.js';
import { CodexAdapter } from './providers/codex.js';
import { OpenCodeGoAdapter } from './providers/opencode-go.js';
import { loadConfig, validateConfig, saveConfig } from './core/config.js';
import { getClaudeToken, getCodexToken } from './core/credentials.js';
import { redactSecrets } from './core/redact.js';
import type { StatusResponse } from './core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  const safe = redactSecrets(data);
  const body = JSON.stringify(safe);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

function emptyStatus(): StatusResponse {
  return { providers: [], generatedAt: new Date().toISOString() };
}

export interface ServerHandle {
  url: string;
  close(): void;
}

/**
 * Start the llm-usage HTTP server.
 * Binds to 127.0.0.1 only (never 0.0.0.0).
 * Creates a Poller with the active Phase-1 adapters and starts polling.
 */
export function startServer(opts: { port: number }): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const adapters = [new ClaudeAdapter(), new CodexAdapter(), new OpenCodeGoAdapter()];
    const poller = new Poller({ adapters, intervalSec: config.refreshIntervalSec });
    poller.start();

    // In production (dist/server.js): __dirname = dist/, public is at dist/public/
    // In dev (tsx src/server.ts): __dirname = src/, public is at ../public/ (project root)
    const publicDir = fs.existsSync(path.resolve(__dirname, 'public'))
      ? path.resolve(__dirname, 'public')
      : path.resolve(__dirname, '..', 'public');

    const server = http.createServer(async (req, res) => {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;

      if (method === 'GET' && pathname === '/api/status') {
        const latest = poller.getLatest();
        if (!latest) {
          poller.refreshNow()
            .then(result => jsonResponse(res, result))
            .catch(() => jsonResponse(res, emptyStatus(), 503));
          return;
        }

        jsonResponse(res, latest);
        return;
      }

      if (method === 'POST' && pathname === '/api/refresh') {
        poller.refreshNow()
          .then(result => jsonResponse(res, result))
          .catch(() => jsonResponse(res, emptyStatus(), 503));
        return;
      }

      // GET /api/config — non-secret status only, never returns stored credentials
      if (method === 'GET' && pathname === '/api/config') {
        const cfg = loadConfig();
        const claudeToken = await getClaudeToken();
        const codexToken = await getCodexToken();
        jsonResponse(res, {
          opencodeWorkspaceIdSet: !!cfg.opencodeWorkspaceId,
          opencodeAuthCookieSet: !!cfg.opencodeAuthCookie,
          refreshIntervalSec: cfg.refreshIntervalSec,
          claudeTokenFound: !!claudeToken,
          codexTokenFound: !!codexToken,
        });
        return;
      }

      // POST /api/config — same-origin only, validates, saves, triggers refresh
      if (method === 'POST' && pathname === '/api/config') {
        // Same-origin guard: reject requests with a non-localhost Origin header
        const origin = req.headers['origin'] ?? '';
        if (origin !== '' && !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: cross-origin request');
          return;
        }

        // Read body (max 8KB)
        let rawBody = '';
        for await (const chunk of req) {
          rawBody += chunk.toString();
          if (rawBody.length > 8192) {
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload Too Large');
            return;
          }
        }

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(rawBody) as Record<string, unknown>; }
        catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Invalid JSON'); return; }

        // Only accept the whitelisted config fields
        const update: Parameters<typeof saveConfig>[0] = {};
        if (typeof parsed['opencodeWorkspaceId'] === 'string' && parsed['opencodeWorkspaceId'].trim())
          update.opencodeWorkspaceId = parsed['opencodeWorkspaceId'] as string;
        if (typeof parsed['opencodeAuthCookie'] === 'string' && parsed['opencodeAuthCookie'].trim())
          update.opencodeAuthCookie = parsed['opencodeAuthCookie'] as string;
        if (typeof parsed['refreshIntervalSec'] === 'number')
          update.refreshIntervalSec = parsed['refreshIntervalSec'] as number;

        try {
          validateConfig(update);
          saveConfig(update);
        } catch (err) {
          jsonResponse(res, { error: err instanceof Error ? err.message : 'Validation failed' }, 400);
          return;
        }

        // Trigger a fresh poll (non-blocking)
        poller.refreshNow().catch(() => undefined);

        // Return updated non-secret status
        const cfg = loadConfig();
        const claudeToken = await getClaudeToken();
        const codexToken = await getCodexToken();
        jsonResponse(res, {
          opencodeWorkspaceIdSet: !!cfg.opencodeWorkspaceId,
          opencodeAuthCookieSet: !!cfg.opencodeAuthCookie,
          refreshIntervalSec: cfg.refreshIntervalSec,
          claudeTokenFound: !!claudeToken,
          codexTokenFound: !!codexToken,
        });
        return;
      }

      if (method === 'GET') {
        let filePath: string;
        try {
          filePath = pathname === '/'
            ? path.join(publicDir, 'index.html')
            : path.join(publicDir, decodeURIComponent(pathname.replace(/^\/+/, '')));
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
          return;
        }

        const resolved = path.resolve(filePath);
        if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        serveStatic(res, resolved);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.on('error', err => {
      poller.stop();
      reject(err);
    });

    server.listen(opts.port, '127.0.0.1', () => {
      const url = `http://localhost:${opts.port}`;
      resolve({
        url,
        close: () => {
          poller.stop();
          server.close();
        },
      });
    });
  });
}
