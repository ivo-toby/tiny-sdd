import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/s3-backend.mjs';

test('S3 stores values in an isolated backend', () => {
  const backend = createBackend();
  backend.set('lease', 'held');
  assert.equal(backend.get('lease'), 'held');
});
