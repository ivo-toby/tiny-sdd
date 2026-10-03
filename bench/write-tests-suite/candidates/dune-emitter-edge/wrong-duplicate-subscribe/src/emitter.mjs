export function createEmitter() {
  const listeners = [];
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}
