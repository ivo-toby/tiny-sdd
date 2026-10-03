export function tokenize(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  return input.trim().split(' ');
}
