export function createBackend() {
  const values = new Map();
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}
