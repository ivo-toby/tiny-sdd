import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidLease } from '../src/s1-errors.mjs';

test('S1 creates a typed invalid lease error', () => assert.equal(invalidLease().message, 'invalid lease'));
