import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildServiceConfig } from '../src/service.mjs';

test('keeps the existing service config shape', () => {
  assert.deepEqual(buildServiceConfig({ sourceEndpoint: 'configured', timeoutMs: 250 }), {
    sourceEndpoint: 'configured',
    timeoutMs: 250,
  });
});

test('uses the documented bounded request format', async () => {
  const report = JSON.parse(await readFile(new URL('../questions/report.json', import.meta.url), 'utf8'));
  assert.deepEqual(report.missingInputs, ['sourceEndpoint', 'timeoutMs']);
  assert.equal(report.question, 'Please provide sourceEndpoint and timeoutMs.');
});
