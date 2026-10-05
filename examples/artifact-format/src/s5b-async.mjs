export async function runAsyncLifecycle(key, value) {
  await Promise.resolve();
  return { key, value };
}
