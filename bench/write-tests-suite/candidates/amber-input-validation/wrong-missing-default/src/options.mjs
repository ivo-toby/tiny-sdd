export function normalizeOptions(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('options must be an object');
  const timeoutMs = input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('invalid timeoutMs');
  const headers = input.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new TypeError('headers must be an object');
  const normalizedHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new TypeError('header values must be strings');
    normalizedHeaders[name.toLowerCase()] = value;
  }
  return { timeoutMs, headers: normalizedHeaders };
}
