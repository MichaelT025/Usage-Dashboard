import { describe, expect, it } from 'vitest';
import { ZenAdapter } from './zen.js';
import { OpenRouterAdapter } from './openrouter.js';

describe('Phase-2 stubs', () => {
  it('ZenAdapter resolves as not_implemented with empty windows', async () => {
    const adapter = new ZenAdapter();
    const result = await adapter.fetch();
    expect(result.state).toBe('not_implemented');
    expect(result.windows).toEqual([]);
    expect(result.providerId).toBe('zen');
    expect(result.fetchedAt).toBeTruthy();
  });

  it('OpenRouterAdapter resolves as not_implemented with empty windows', async () => {
    const adapter = new OpenRouterAdapter();
    const result = await adapter.fetch();
    expect(result.state).toBe('not_implemented');
    expect(result.windows).toEqual([]);
    expect(result.providerId).toBe('openrouter');
  });

  it('stubs never resolve state ok or populate windows/credits', async () => {
    const zen = new ZenAdapter();
    const or = new OpenRouterAdapter();
    for (const adapter of [zen, or]) {
      const r1 = await adapter.fetch();
      const r2 = await adapter.fetch();
      expect(r1.state).not.toBe('ok');
      expect(r1.windows.length).toBe(0);
      expect(r1.credits).toBeUndefined();
      expect(r2.state).not.toBe('ok');
    }
  });

  it('stubs fetch() never throws', async () => {
    await expect(new ZenAdapter().fetch()).resolves.toBeDefined();
    await expect(new OpenRouterAdapter().fetch()).resolves.toBeDefined();
  });
});

// Active provider list coverage is owned by T10; these Phase-2 seams are intentionally not registered here.
