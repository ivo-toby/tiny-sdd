import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceConfig } from '../src/service.mjs';

test('keeps the existing service config shape', () => {
  assert.deepEqual(buildServiceConfig({ sourceEndpoint: 'configured', timeoutMs: 250 }), {
    sourceEndpoint: 'configured',
    timeoutMs: 250,
  });
});
