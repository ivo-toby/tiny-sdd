import assert from 'node:assert/strict';
import { appendUnique } from '../../../src/playlist.mjs';

assert.deepEqual(appendUnique([{ id: 'a' }], [{ id: 'b' }]), [{ id: 'a' }, { id: 'b' }]);
