import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Poller } from './core/poller.js';
import { ClaudeAdapter } from './providers/claude.js';
import { CodexAdapter } from './providers/codex.js';
import { OpenCodeGoAdapter } from './providers/opencode-go.js';
import { loadConfig } from './core/config.js';
import { redactSecrets } from './core/redact.js';
import type { StatusResponse } from './core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
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

    const publicDir = path.resolve(__dirname, 'public');

    const server = http.createServer((req, res) => {
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
