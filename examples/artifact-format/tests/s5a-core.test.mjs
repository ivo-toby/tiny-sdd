import test from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle } from '../src/s5a-core.mjs';

test('S5a runs the sequential lifecycle', () => assert.equal(runLifecycle('lease', 'held'), 'held'));
