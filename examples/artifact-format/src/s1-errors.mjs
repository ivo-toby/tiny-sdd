export function invalidLease(message = 'invalid lease') {
  return new Error(message);
}
