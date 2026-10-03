import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export default function runChecksExtension(pi) {
  pi.registerTool({
    name: 'run_checks',
    label: 'Run declared checks',
    description: 'Run one declared check by checkId, or all declared checks when omitted. Results are worker feedback, not acceptance evidence.',
    executionMode: 'sequential',
    parameters: Type.Object({ checkId: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const root = process.env.TINYSDD_CHECK_CHANNEL;
      const deadline = Number(process.env.TINYSDD_CHECK_DEADLINE);
      if (!root || !Number.isFinite(deadline)) throw new Error('check channel is unavailable');
      signal?.throwIfAborted();
      const name = `${createHash('sha256').update(toolCallId).digest('hex')}.json`;
      const temporary = join(root, 'requests', `${name}.tmp`);
      await writeFile(temporary, JSON.stringify(params), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(root, 'requests', name));
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
          const response = JSON.parse(await readFile(join(root, 'responses', name), 'utf8'));
          if (response.error) throw new Error(JSON.stringify(response));
          return { content: [{ type: 'text', text: JSON.stringify(response) }], details: response };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(50, undefined, { signal });
      }
      throw new Error('worker check deadline expired');
    },
  });
}
