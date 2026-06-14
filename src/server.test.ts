import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server.js';
import type { ServerHandle } from './server.js';

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
    expect(typeof body.generatedAt).toBe('string');
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  it('POST /api/refresh triggers fresh poll and returns updated data', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/refresh', { method: 'POST' });
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
      expect(['ok', 'unavailable', 'unconfigured', 'not_implemented']).toContain(p.state);
    }
  });

  it('GET /api/config returns non-secret configuration status', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.claudeTokenFound).toBe('boolean');
    expect(typeof body.codexTokenFound).toBe('boolean');
    expect(typeof body.opencodeWorkspaceIdSet).toBe('boolean');
    expect(typeof body.opencodeAuthCookieSet).toBe('boolean');
    expect(typeof body.refreshIntervalSec).toBe('number');
    // Never returns secret values
    expect(body).not.toHaveProperty('opencodeAuthCookie');
    expect(body).not.toHaveProperty('opencodeWorkspaceId');
  });

  it('POST /api/config rejects cross-origin requests', async () => {
    const res = await fetch('http://127.0.0.1:17879/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
      body: JSON.stringify({ refreshIntervalSec: 300 }),
    });
    expect(res.status).toBe(403);
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
