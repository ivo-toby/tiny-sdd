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
    applyBatch(operations) {
      const bad = () => ({ ok: false, error: 'invalid_batch' });
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) return bad();
      const seen = new Set();
      for (const op of operations) {
        if (!op || typeof op !== 'object' || Array.isArray(op)
          || !['key', 'expectedVersion', 'value'].every(key => Object.hasOwn(op, key))
          || Object.keys(op).some(key => !['key', 'expectedVersion', 'value'].includes(key))
          || typeof op.key !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(op.key)
          || !Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 0
          || seen.has(op.key)) return bad();
        seen.add(op.key);
      }
      for (const op of operations) {
        const actualVersion = entries.get(op.key)?.version ?? 0;
        if (actualVersion !== op.expectedVersion) return {
          ok: false, error: 'version_conflict', key: op.key,
          expectedVersion: op.expectedVersion, actualVersion,
        };
      }
      const result = operations.map(op => {
        const entry = { value: structuredClone(op.value), version: op.expectedVersion + 1 };
        entries.set(op.key, entry);
        return { key: op.key, ...structuredClone(entry) };
      });
      return { ok: true, entries: result };
    },
  };
}
