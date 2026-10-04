import {
  compactDeterministically,
  createApprovedPacketAnchor,
} from './deterministic-compaction.mjs';

function previousCompaction(branchEntries) {
  if (!Array.isArray(branchEntries)) return undefined;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry && entry.type === 'compaction') return { id: entry.id, details: entry.details };
  }
  return undefined;
}

function refusal(reason, message) {
  return {
    cancel: true,
    details: {
      schemaVersion: 1,
      code: reason,
      message,
    },
  };
}

/**
 * Register the model-free deterministic compaction hook with a Pi extension
 * API. The anchor is captured once when the host creates the extension and is
 * never taken from event messages or tool output.
 */
export function registerCompactionExtension(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') throw new TypeError('Pi extension API with on() is required');
  let anchor;
  let anchorError;
  try {
    anchor = createApprovedPacketAnchor(options.approvedPacketAnchor ?? options.packetAnchor, { limits: options.limits });
  } catch (error) {
    anchorError = error;
  }
  return pi.on('session_before_compact', (event) => {
    if (anchorError) return refusal(anchorError.code ?? 'PACKET_ANCHOR_INVALID', anchorError.message);
    const preparation = event?.preparation;
    const outcome = compactDeterministically(preparation, {
      ...options,
      approvedPacketAnchor: anchor,
      previousCompaction: previousCompaction(event?.branchEntries),
      signal: event?.signal,
    });
    if (outcome.cancel) return { cancel: true, details: outcome.details };
    return { compaction: outcome.compaction };
  });
}

export default function compactionExtension(pi, options = {}) {
  return registerCompactionExtension(pi, options);
}
