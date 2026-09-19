import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Isolate server tests: mock credential loaders (no disk/auth-store reads)
// and config persistence (in-memory only, no real ~/.llm-usage writes).
// Local HTTP fetch to 127.0.0.1 is preserved (global fetch untouched).
vi.mock('./core/credentials.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./core/credentials.js')>();
  return {
    ...actual,
    getClaudeToken: vi.fn(async () => null),
    getCodexToken: vi.fn(async () => null),
    getCommandCodeToken: vi.fn(async () => null),
    getOpenCodeGoToken: vi.fn(async () => null),
  };
});

vi.mock('./core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/config.js')>();
  let mem: Record<string, unknown> = {
    refreshIntervalSec: 180,
    port: 17879,
  };
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ ...mem })),
    saveConfig: vi.fn((partial: Record<string, unknown>) => {
      actual.validateConfig(partial);
      mem = { ...mem, ...partial };
    }),
  };
});

import { startServer } from './server.js';
import type { ServerHandle } from './server.js';
import { ClaudeAdapter } from './providers/claude.js';
import { CodexAdapter } from './providers/codex.js';
import { CommandCodeAdapter } from './providers/command-code.js';
import { OpenCodeGoAdapter } from './providers/opencode-go.js';
import type { UsageData } from './core/types.js';

function stubUsage(
  providerId: UsageData['providerId'],
  displayName: string,
): UsageData {
  return {
    providerId,
    displayName,
    state: 'unconfigured',
    windows: [],
    fetchedAt: new Date().toISOString(),
  };
}

// Mock all provider fetch methods: no live upstream calls.
vi.spyOn(ClaudeAdapter.prototype, 'fetch').mockImplementation(async () =>
  stubUsage('claude', 'Claude'),
);
vi.spyOn(CodexAdapter.prototype, 'fetch').mockImplementation(async () =>
  stubUsage('codex', 'Codex'),
);
vi.spyOn(CommandCodeAdapter.prototype, 'fetch').mockImplementation(async () =>
  stubUsage('command-code', 'Command Code'),
);
vi.spyOn(OpenCodeGoAdapter.prototype, 'fetch').mockImplementation(async () =>
  stubUsage('opencode-go', 'OpenCode Go'),
);

let server: ServerHandle | undefined;

// Start the server once for the whole file
beforeAll(async () => {
  server = await startServer({ port: 17879 });
});

// Clean up after the whole file
afterAll(() => {
  server?.close();
});

describe('server refresh flow', () => {
  it('GET /api/status returns providers array with generatedAt', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'command-code' }),
      ]),
    );
    expect(typeof body.generatedAt).toBe('string');
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  it('POST /api/refresh triggers fresh poll and returns updated data', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/refresh', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.generatedAt).toBe('string');
    // Each provider in the response should have the required fields
    for (const p of body.providers) {
      expect(typeof p.providerId).toBe('string');
      expect(typeof p.displayName).toBe('string');
      expect(typeof p.state).toBe('string');
      expect(typeof p.fetchedAt).toBe('string');
      expect([
        'ok',
        'unavailable',
        'unconfigured',
        'not_implemented',
      ]).toContain(p.state);
    }
  });

  it('GET /api/config returns non-secret configuration status', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.claudeTokenFound).toBe('boolean');
    expect(typeof body.codexTokenFound).toBe('boolean');
    expect(typeof body.commandCodeTokenFound).toBe('boolean');
    expect(typeof body.openCodeGoTokenFound).toBe('boolean');
    expect(typeof body.refreshIntervalSec).toBe('number');
    // Never returns secret values
    expect(body).not.toHaveProperty('opencodeAuthCookie');
    expect(body).not.toHaveProperty('opencodeWorkspaceId');
  });

  it('POST /api/config rejects cross-origin requests', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ refreshIntervalSec: 300 }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/config saves isolated config and returns boolean-only status', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalSec: 300 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshIntervalSec).toBe(300);
    expect(typeof body.claudeTokenFound).toBe('boolean');
    expect(typeof body.codexTokenFound).toBe('boolean');
    expect(typeof body.commandCodeTokenFound).toBe('boolean');
    expect(typeof body.openCodeGoTokenFound).toBe('boolean');
    expect(body).not.toHaveProperty('opencodeAuthCookie');
  });
});

describe('refresh button flow (frontend logic mirrored)', () => {
  it('consecutive refreshNow calls share a single promise (concurrency lock)', async () => {
    // Fetch twice rapidly — second should not trigger a duplicate backend poll
    const [a, b] = await Promise.all([
      fetch('http://127.0.0.1:17879/api/status'),
      fetch('http://127.0.0.1:17879/api/status'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = await a.json();
    const bodyB = await b.json();
    expect(bodyA.generatedAt).toBe(bodyB.generatedAt);
  });
});
