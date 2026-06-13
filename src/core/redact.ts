/**
 * Secret redaction utilities.
 * These run on any object/error before it is logged or serialized.
 * NEVER call console.log/error with raw tokens, cookies, or auth headers.
 */

const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'token', 'access_token', 'accesstoken',
  'apikey', 'api_key', 'key', 'password', 'credentials', 'secret',
  'refreshtoken', 'refresh_token', 'idtoken', 'id_token',
]);

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9\-_]+/g,
  /sk-[A-Za-z0-9\-_]+/g,
  /Fe26\.2\*\*[^\s"']*/g,
  /Bearer [^\s"']+/g,
];

function redactString(s: string): string {
  let result = s;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/** Deep-clone an object/array/primitive, replacing sensitive keys and secret-pattern strings. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactSecrets(v);
      }
    }
    return result;
  }
  return value;
}

/** Produce a safe, redacted error message string — never exposes tokens or cookies. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return redactString(err.message);
  }
  if (typeof err === 'string') {
    return redactString(err);
  }
  return 'Unknown error';
}
