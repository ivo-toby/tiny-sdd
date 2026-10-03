export function dequeueReady(queue) {
  const index = queue.findIndex((job) => job.state === 'ready');
  if (index === -1) return null;
  return queue.splice(index, 1)[0];
}
