import test from 'node:test';
import assert from 'node:assert/strict';
import { appendUnique, normalizeTracks } from '../src/playlist.mjs';

test('keeps existing normalization behavior', () => {
  assert.deepEqual(normalizeTracks([{ id: 4, title: '  Harbor  ' }]), [{ id: '4', title: 'Harbor' }]);
});

test('appends new tracks in order', () => {
  assert.deepEqual(appendUnique([{ id: 'a' }], [{ id: 'b' }]), [{ id: 'a' }, { id: 'b' }]);
});
