export async function runBatch(tasks, options = {}) {
  const concurrency = options.concurrency ?? 1;
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be positive');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive');
  return Promise.all(tasks.map((task) => task()));
}
