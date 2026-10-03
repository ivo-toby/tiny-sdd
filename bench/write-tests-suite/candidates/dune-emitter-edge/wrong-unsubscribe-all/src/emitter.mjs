export function createEmitter() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.clear();
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}
