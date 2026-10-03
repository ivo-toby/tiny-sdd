export function tokenize(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const trimmed = input.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
}
