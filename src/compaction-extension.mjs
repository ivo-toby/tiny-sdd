import {
  compactDeterministically,
  createApprovedPacketAnchor,
} from './deterministic-compaction.mjs';
import { COMPACTION_ANCHOR_ENV, COMPACTION_AUDIT_ENTRY, loadCompactionAnchorSync } from './compaction-runtime.mjs';

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

function appendRefusalAudit(pi, event, details) {
  if (typeof pi.appendEntry !== 'function') return;
  try {
    pi.appendEntry(COMPACTION_AUDIT_ENTRY, {
      schemaVersion: 1,
      kind: 'deterministic-compaction-refusal',
      code: details.code,
      message: details.message,
      reason: typeof event?.reason === 'string' ? event.reason : null,
      details,
    });
  } catch {
    // A refusal must remain a refusal even if a host cannot persist its audit.
  }
}

/**
 * Register the model-free deterministic compaction hook with a Pi extension
 * API. The anchor is captured once when the host creates the extension and is
 * never taken from event messages or tool output.
 */
export function registerCompactionExtension(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') throw new TypeError('Pi extension API with on() is required');
  let anchor;
  let anchorError = options.anchorError;
  if (!anchorError) {
    try {
      anchor = createApprovedPacketAnchor(options.approvedPacketAnchor ?? options.packetAnchor, { limits: options.limits });
    } catch (error) {
      anchorError = error;
    }
  }
  return pi.on('session_before_compact', (event) => {
    if (anchorError) {
      const result = refusal(anchorError.code ?? 'PACKET_ANCHOR_INVALID', anchorError.message);
      appendRefusalAudit(pi, event, result.details);
      return result;
    }
    const preparation = event?.preparation;
    const outcome = compactDeterministically(preparation, {
      ...options,
      approvedPacketAnchor: anchor,
      previousCompaction: previousCompaction(event?.branchEntries),
      signal: event?.signal,
    });
    if (outcome.cancel) {
      const result = { cancel: true, details: outcome.details };
      appendRefusalAudit(pi, event, result.details);
      return result;
    }
    return { compaction: outcome.compaction };
  });
}

export default function compactionExtension(pi, options = {}) {
  if (Object.hasOwn(options, 'approvedPacketAnchor') || Object.hasOwn(options, 'packetAnchor') || Object.hasOwn(options, 'anchorError')) {
    return registerCompactionExtension(pi, options);
  }
  const anchorPath = process.env[COMPACTION_ANCHOR_ENV];
  if (!anchorPath) return registerCompactionExtension(pi);
  try {
    return registerCompactionExtension(pi, { approvedPacketAnchor: loadCompactionAnchorSync(anchorPath) });
  } catch (error) {
    return registerCompactionExtension(pi, { anchorError: error });
  }
}
