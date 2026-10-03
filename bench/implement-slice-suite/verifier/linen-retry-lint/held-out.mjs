import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../../src/retry.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(source, /async\s+function\s+retry/u);
assert.match(source, /export\s+function\s+retry/u);
