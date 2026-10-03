const DEFAULT_TIMEOUT_MS = 5000;

export function normalizeOptions(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('options must be an object');
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (typeof timeoutMs !== 'number' || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('invalid timeoutMs');
  const headers = input.headers === undefined ? {} : input.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new TypeError('headers must be an object');
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (typeof value !== 'string') throw new TypeError('header values must be strings');
    return [name.toLowerCase(), value];
  }));
  return { timeoutMs, headers: normalizedHeaders };
}
