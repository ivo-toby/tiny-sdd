// run_checks for OpenCode 2.1.4 workers: a local plugin in OpenCode's Promise
// shape (a default `{ id, setup }` object), loaded from the absolute directory
// the generated config names. Like the Pi extension (run-checks-extension.mjs)
// it only writes requests to and reads responses from the TinySDD check channel;
// the host runs the declared checks. It imports nothing outside node:.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WRITE_TOOLS = new Set(['write', 'edit', 'patch']);
const INPUT = { type: 'object', properties: { checkId: { type: 'string' } }, additionalProperties: false };

// OpenCode starts the tool calls of one model step concurrently (session/runner/
// step.ts forks each call as it streams in). A check therefore waits until no
// write call of its own message is in flight, so a batch of a write and a check
// sees the write. Hook order is not stream order, so every write of the message
// counts, also one that starts after the check; writes never wait for checks.
// Only write tools are tracked: their execute.after hook always runs once they
// start. A write's fiber may not have reached its execute.before hook yet when
// the check looks, so the check first gives it SETTLE_MS to get there. That
// narrows the race; it does not close it. The wait is capped at
// MAX_WRITE_WAIT_MS: a write whose after hook never comes must not hold every
// later check until the deadline. The check's candidate digests record which
// bytes it saw either way.
const SETTLE_MS = 100;
const MAX_WRITE_WAIT_MS = 3000;
const writes = new Map();
let queue = Promise.resolve();

function track(event) {
  if (WRITE_TOOLS.has(event.tool)) writes.set(String(event.id), event.messageID);
}

async function waitForWrites(context, deadline, signal) {
  await delay(SETTLE_MS, undefined, { signal });
  const pending = () => [...writes.values()].some((messageID) => messageID === context.messageID);
  const until = Math.min(deadline, Date.now() + MAX_WRITE_WAIT_MS);
  while (pending() && Date.now() < until) await delay(25, undefined, { signal });
  if (Date.now() >= deadline) throw new Error('worker check deadline expired');
}

async function runChecks(input, context) {
  const root = process.env.TINYSDD_CHECK_CHANNEL;
  const deadline = Number(process.env.TINYSDD_CHECK_DEADLINE);
  if (!root || !Number.isFinite(deadline)) throw new Error('check channel is unavailable');
  // The request file is named after the call id: without one, two checks would
  // share a name and the second would be handed the first one's response.
  const callId = context?.id;
  if ((typeof callId !== 'string' && typeof callId !== 'number') || String(callId) === '') throw new Error('run_checks call has no id');
  const signal = context.signal;
  signal?.throwIfAborted();
  await waitForWrites(context, deadline, signal);
  const name = `${createHash('sha256').update(String(callId)).digest('hex')}.json`;
  const temporary = join(root, 'requests', `${name}.tmp`);
  const request = input?.checkId === undefined ? {} : { checkId: input.checkId };
  await writeFile(temporary, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(root, 'requests', name));
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = JSON.parse(await readFile(join(root, 'responses', name), 'utf8'));
      if (response.error) throw new Error(JSON.stringify(response));
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50, undefined, { signal });
  }
  throw new Error('worker check deadline expired');
}

export default {
  id: 'tinysdd-run-checks',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', track);
    await ctx.tool.hook('execute.after', (event) => { writes.delete(String(event.id)); });
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'run_checks',
        description: 'Run one declared check by checkId, or all declared checks when omitted. Results are worker feedback, not acceptance evidence.',
        input: INPUT,
        // A codemode tool is only reachable through OpenCode's execute tool, which the worker denies.
        options: { codemode: false },
        // One check request at a time, as Pi's sequential execution mode gives.
        execute: (input, context) => {
          const run = queue.then(() => runChecks(input, context));
          queue = run.catch(() => {});
          return run;
        },
      });
    });
  },
};
