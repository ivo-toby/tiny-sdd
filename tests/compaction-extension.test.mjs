import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApprovedPacketAnchor,
  extractApprovedPacket,
} from '../src/deterministic-compaction.mjs';
import registerCompactionExtension from '../src/compaction-extension.mjs';
import { COMPACTION_AUDIT_ENTRY } from '../src/compaction-runtime.mjs';

const anchor = createApprovedPacketAnchor({
  id: 'extension-packet',
  text: 'approved\n  packet\té\n',
});
function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
}

function auditableFakePi() {
  const pi = fakePi();
  pi.entries = [];
  pi.appendEntry = (customType, data) => pi.entries.push({ type: 'custom', customType, data });
  return pi;
}

function preparation() {
  return {
    firstKeptEntryId: 'kept-1',
    tokensBefore: 123,
    messagesToSummarize: [
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/a.mjs' } }] },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: 'old output' },
    ],
    turnPrefixMessages: [],
  };
}

test('extension adapts deterministic output to the Pi 1.0.0 hook shape without a model call', async () => {
  const pi = fakePi();
  let modelCalls = 0;
  registerCompactionExtension(pi, { approvedPacketAnchor: anchor, model: () => { modelCalls += 1; } });
  const handler = pi.handlers.get('session_before_compact');
  assert.equal(typeof handler, 'function');
  const response = await handler({
    preparation: preparation(),
    branchEntries: [{ type: 'message', id: 'old', parentId: null }],
    reason: 'threshold',
    willRetry: false,
    signal: new AbortController().signal,
  }, {});
  assert.equal(response.cancel, undefined);
  assert.deepEqual(Object.keys(response), ['compaction']);
  assert.equal(response.compaction.firstKeptEntryId, 'kept-1');
  assert.equal(response.compaction.tokensBefore, 123);
  assert.equal(extractApprovedPacket(response.compaction.summary).text, anchor.text);
  assert.equal(modelCalls, 0);
});

test('extension returns an explicit cancellation reason for abort and missing anchor', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const pi = fakePi();
  registerCompactionExtension(pi, { approvedPacketAnchor: anchor });
  const response = await pi.handlers.get('session_before_compact')({ preparation: preparation(), signal: aborted.signal }, {});
  assert.equal(response.cancel, true);
  assert.equal(response.details.code, 'COMPACTION_ABORTED');

  const missingPi = fakePi();
  registerCompactionExtension(missingPi);
  const missing = await missingPi.handlers.get('session_before_compact')({ preparation: preparation(), signal: new AbortController().signal }, {});
  assert.equal(missing.cancel, true);
  assert.equal(missing.details.code, 'PACKET_ANCHOR_MISSING');
});

test('extension records refusal details as a non-context Pi custom entry', async () => {
  const pi = auditableFakePi();
  registerCompactionExtension(pi, { approvedPacketAnchor: anchor });
  const response = await pi.handlers.get('session_before_compact')({
    preparation: { ...preparation(), messagesToSummarize: [] },
    reason: 'threshold',
    signal: new AbortController().signal,
  }, {});
  assert.equal(response.cancel, true);
  assert.equal(response.details.code, 'COMPACTION_EMPTY');
  assert.deepEqual(pi.entries, [{
    type: 'custom',
    customType: COMPACTION_AUDIT_ENTRY,
    data: {
      schemaVersion: 1,
      kind: 'deterministic-compaction-refusal',
      code: 'COMPACTION_EMPTY',
      message: response.details.message,
      reason: 'threshold',
      details: response.details,
    },
  }]);
});

test('extension carries previous compaction identity without copying its summary', async () => {
  const pi = fakePi();
  registerCompactionExtension(pi, { approvedPacketAnchor: anchor });
  const previous = { type: 'compaction', id: 'previous-compaction', details: { schemaVersion: 1, omissions: [{ contentSha256: 'a'.repeat(64) }] } };
  const response = await pi.handlers.get('session_before_compact')({
    preparation: { ...preparation(), previousSummary: 'old summary that must be referenced by digest' },
    branchEntries: [previous],
    signal: new AbortController().signal,
  }, {});
  assert.equal(response.cancel, undefined);
  assert.equal(response.compaction.details.previous.compactionId, 'previous-compaction');
  assert.equal(response.compaction.summary.includes('old summary that must be referenced by digest'), true);
  assert.match(response.compaction.summary, /previous-summary-sha256:[a-f0-9]{64}/u);
});
