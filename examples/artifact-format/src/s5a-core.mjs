import { createBackend } from './s3-backend.mjs';

export function runLifecycle(key, value) {
  const backend = createBackend();
  backend.set(key, value);
  return backend.get(key);
}
