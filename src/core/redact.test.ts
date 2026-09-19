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
    const result = redactSecrets([
      { token: 'secret' },
      'sk-ant-test',
    ]) as Array<unknown>;

    expect(result[0]).toEqual({ token: '[REDACTED]' });
    expect(result[1]).toBe('[REDACTED]');
  });

  it('leaves primitives unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });

  it('redacts Command Code apiKey fields and cc- tokens', () => {
    const result = redactSecrets({
      apiKey: 'cc-live-fixture',
      note: 'auth cc-abc123XYZ',
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain('cc-live-fixture');
    expect(JSON.stringify(result)).not.toContain('cc-abc123XYZ');
  });

  it('redacts user_/cc_/cmd_ key variants with bounded matching', () => {
    const secrets = {
      userKey: 'user_abcdefghijklmnop1234',
      ccUnderscore: 'cc_abc123XYZ456',
      cmdDash: 'cmd-abc123XYZ456',
      cmdUnderscore: 'cmd_xyz987654321',
    };
    const result = redactSecrets(secrets) as Record<string, unknown>;
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    // Bounded matching avoids redacting short fragments.
    expect(redactSecrets('cc-x')).toBe('cc-x');
    expect(redactSecrets('user_short')).toBe('user_short');
  });
});

describe('safeErrorMessage', () => {
  it('redacts secrets from error messages', () => {
    const message = safeErrorMessage(
      new Error('failed with Bearer sk-ant-fake-token'),
    );

    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('sk-ant-fake-token');
  });

  it('redacts real key prefixes from error messages', () => {
    const userKey = 'user_abcdefghijklmnop1234';
    const ccKey = 'cc_abc123XYZ45678';
    const cmdKey = 'cmd-abc123XYZ45678';
    for (const secret of [userKey, ccKey, cmdKey]) {
      const message = safeErrorMessage(new Error(`request failed: ${secret}`));
      expect(message).not.toContain(secret);
      expect(message).toContain('[REDACTED]');
    }
  });
});
