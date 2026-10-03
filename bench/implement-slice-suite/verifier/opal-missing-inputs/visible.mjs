import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(new URL('../../../questions/report.json', import.meta.url), 'utf8'));
assert.deepEqual(Object.keys(report).sort(), ['missingInputs', 'question']);
assert.deepEqual(report.missingInputs, ['sourceEndpoint', 'timeoutMs']);
assert.equal(typeof report.question, 'string');
assert.ok(report.question.trim().length > 0);
