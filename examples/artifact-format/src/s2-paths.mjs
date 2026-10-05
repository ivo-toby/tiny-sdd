export function validateBrokerPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('..')) throw new Error('unsafe broker path');
  return value;
}
