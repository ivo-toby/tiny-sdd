import test from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../src/retry.mjs';

test('returns a successful operation result', async () => {
  assert.equal(await retry(() => 'ok', 2), 'ok');
});

test('retries a synchronous failure', async () => {
  let calls = 0;
  assert.equal(await retry(() => {
    calls += 1;
    if (calls < 2) throw new Error('try again');
    return 'ok';
  }, 2), 'ok');
  assert.equal(calls, 2);
});
