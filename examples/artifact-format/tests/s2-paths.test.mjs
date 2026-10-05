import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrokerPath } from '../src/s2-paths.mjs';

test('S2 accepts a safe path', () => assert.equal(validateBrokerPath('lease'), 'lease'));
