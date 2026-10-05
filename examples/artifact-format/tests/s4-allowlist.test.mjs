import test from 'node:test';
import assert from 'node:assert/strict';
import { allowlisted } from '../src/s4-allowlist.mjs';

test('S4 checks the declared allowlist', () => assert.equal(allowlisted(['lease'], 'lease'), true));
