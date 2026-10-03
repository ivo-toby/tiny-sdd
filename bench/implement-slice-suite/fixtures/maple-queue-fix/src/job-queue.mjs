export function dequeueReady(queue) {
  const first = queue[0];
  if (first === undefined) return null;
  queue.shift();
  return first;
}
