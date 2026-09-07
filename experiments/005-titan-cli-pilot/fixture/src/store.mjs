export function createStore(seed = {}) {
  const entries = new Map(Object.entries(seed).map(([key, value]) => [key, { value: structuredClone(value), version: 1 }]));
  return {
    get(key) {
      const entry = entries.get(key);
      return entry ? structuredClone(entry) : null;
    },
    put(key, value) {
      const previous = entries.get(key);
      const entry = { value: structuredClone(value), version: (previous?.version ?? 0) + 1 };
      entries.set(key, entry);
      return structuredClone(entry);
    },
  };
}
