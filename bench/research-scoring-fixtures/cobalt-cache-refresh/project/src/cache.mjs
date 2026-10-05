export function createCache() {
  const values = new Map();
  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      const existed = values.has(key);
      values.set(key, value);
      return { existed };
    },
  };
}
