export function parseOptions(input = {}) {
  const mode = input.mode ?? 'safe';
  const verbose = input.verbose === true;
  return { mode, verbose };
}

export function isSafeMode(options) {
  return options.mode === 'safe';
}
