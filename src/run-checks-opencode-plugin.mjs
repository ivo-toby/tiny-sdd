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
// step.ts forks each call as it streams in). A check therefore waits until the
// write calls of its own message that started before it have finished, so a
// batch of a write and a check sees the write. Only write tools are tracked:
// their execute.after hook always runs once they start.
const started = new Map();
let order = 0;
let queue = Promise.resolve();

function track(event) {
  if (WRITE_TOOLS.has(event.tool) || event.tool === 'run_checks') {
    started.set(String(event.id), { messageID: event.messageID, order: ++order, write: WRITE_TOOLS.has(event.tool) });
  }
}

async function waitForEarlierWrites(context, deadline, signal) {
  const limit = started.get(String(context.id))?.order ?? order + 1;
  const pending = () => [...started.values()].some((entry) => entry.write && entry.messageID === context.messageID && entry.order < limit);
  while (pending()) {
    if (Date.now() >= deadline) throw new Error('worker check deadline expired');
    await delay(25, undefined, { signal });
  }
}

async function runChecks(input, context) {
  const root = process.env.TINYSDD_CHECK_CHANNEL;
  const deadline = Number(process.env.TINYSDD_CHECK_DEADLINE);
  if (!root || !Number.isFinite(deadline)) throw new Error('check channel is unavailable');
  const signal = context.signal;
  signal?.throwIfAborted();
  await waitForEarlierWrites(context, deadline, signal);
  const name = `${createHash('sha256').update(String(context.id)).digest('hex')}.json`;
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
    await ctx.tool.hook('execute.after', (event) => { started.delete(String(event.id)); });
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
