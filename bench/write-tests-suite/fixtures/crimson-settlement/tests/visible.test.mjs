import test from 'node:test';
import assert from 'node:assert/strict';
import { settleTasks } from '../src/settle.mjs';

test('settles a fulfilled task', async () => {
  assert.deepEqual(await settleTasks([() => 7]), [{ status: 'fulfilled', value: 7 }]);
});
