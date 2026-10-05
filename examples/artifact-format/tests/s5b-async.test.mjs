import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsyncLifecycle } from '../src/s5b-async.mjs';

test('S5b preserves the asynchronous lifecycle result', async () => assert.deepEqual(await runAsyncLifecycle('lease', 'held'), { key: 'lease', value: 'held' }));
