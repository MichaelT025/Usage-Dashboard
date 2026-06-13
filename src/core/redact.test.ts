import { describe, expect, it } from 'vitest';
import { redactSecrets, safeErrorMessage } from './redact.js';

describe('redactSecrets', () => {
  it('redacts secret patterns in nested objects', () => {
    const input = {
      headers: { Authorization: 'Bearer sk-ant-oat01-XYZ' },
      nested: { cookie: 'auth=Fe26.2**abc' },
      note: 'sk-leak-123',
    };

    const result = redactSecrets(input) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain('sk-ant-oat01-XYZ');
    expect(JSON.stringify(result)).not.toContain('Fe26.2**abc');
    expect(JSON.stringify(result)).not.toContain('sk-leak-123');
  });

  it('preserves structure and redacts only sensitive keys', () => {
    const result = redactSecrets({
      keep: 'visible',
      nested: { token: 'abc123', other: 7 },
    }) as Record<string, unknown>;

    expect(result.keep).toBe('visible');
    expect(result.nested).toEqual({ token: '[REDACTED]', other: 7 });
  });

  it('walks arrays and removes secrets', () => {
    const result = redactSecrets([{ token: 'secret' }, 'sk-ant-test']) as Array<unknown>;

    expect(result[0]).toEqual({ token: '[REDACTED]' });
    expect(result[1]).toBe('[REDACTED]');
  });

  it('leaves primitives unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });
});

describe('safeErrorMessage', () => {
  it('redacts secrets from error messages', () => {
    const message = safeErrorMessage(new Error('failed with Bearer sk-ant-fake-token'));

    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('sk-ant-fake-token');
  });
});
