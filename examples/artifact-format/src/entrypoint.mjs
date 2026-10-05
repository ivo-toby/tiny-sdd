import { invalidLease } from './s1-errors.mjs';
import { validateBrokerPath } from './s2-paths.mjs';
import { createBackend } from './s3-backend.mjs';
import { allowlisted } from './s4-allowlist.mjs';
import { runLifecycle } from './s5a-core.mjs';
import { runAsyncLifecycle } from './s5b-async.mjs';
export async function brokerEntry(key, value, declaredAllowlist = ['lease']) {
  const path = validateBrokerPath(key);
  const allowed = allowlisted(declaredAllowlist, path);
  if (!allowed) throw new Error('broker path is not allowlisted');
  const lease = invalidLease();
  const backend = createBackend();
  backend.set(path, value);
  const sequential = runLifecycle(path, value);
  const asynchronous = await runAsyncLifecycle(path, value);
  return { invalidLease: lease.message, path, allowed, backend: backend.get(path), sequential, asynchronous };
}
