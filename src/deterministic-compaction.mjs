import { createHash } from 'node:crypto';

export const DETERMINISTIC_COMPACTION_VERSION = 1;

export const DEFAULT_COMPACTION_LIMITS = Object.freeze({
  maxMessages: 8192,
  maxInputBytes: 8 * 1024 * 1024,
  maxPacketBytes: 2 * 1024 * 1024,
  maxPreviousSummaryBytes: 2 * 1024 * 1024,
  maxPreviousDetailsBytes: 512 * 1024,
  maxSummaryBytes: 4 * 1024 * 1024,
  maxDetailsBytes: 512 * 1024,
  maxDepth: 40,
});

const SUMMARY_HEADER = 'TinySDD deterministic compaction v1';
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const MESSAGE_ROLES = new Set([
  'system',
  'user',
  'assistant',
  'toolResult',
  'custom',
  'bashExecution',
  'branchSummary',
  'compactionSummary',
]);
const ELIDABLE_TOOLS = new Set(['read', 'run_checks']);

export class DeterministicCompactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeterministicCompactionError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function canonicalValue(value, seen, depth, maxDepth) {
  if (depth > maxDepth) {
    throw new DeterministicCompactionError('COMPACTION_INPUT_TOO_DEEP', 'compaction input exceeds the nesting limit');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DeterministicCompactionError('COMPACTION_INPUT_INVALID', 'compaction input contains a non-finite number');
    return value;
  }
  if (typeof value === 'undefined') return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value !== 'object') throw new DeterministicCompactionError('COMPACTION_INPUT_INVALID', 'compaction input contains an unsupported value');
  if (seen.has(value)) throw new DeterministicCompactionError('COMPACTION_INPUT_INVALID', 'compaction input contains a cycle');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalValue(item, seen, depth + 1, maxDepth));
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(result, key, {
        value: canonicalValue(value[key], seen, depth + 1, maxDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

export function stableStringify(value, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_COMPACTION_LIMITS.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw invalid('COMPACTION_INPUT_INVALID', 'maxDepth must be a positive integer');
  return JSON.stringify(canonicalValue(value, new Set(), 0, maxDepth));
}

function stableBytes(value, maxDepth = DEFAULT_COMPACTION_LIMITS.maxDepth) {
  const serialized = typeof value === 'string' ? value : stableStringify(value, { maxDepth });
  return Buffer.from(serialized, 'utf8');
}

function invalid(code, message, details = {}) {
  return new DeterministicCompactionError(code, message, details);
}

function refusal(code, message, details = {}) {
  return {
    cancel: true,
    reason: code,
    details: {
      schemaVersion: DETERMINISTIC_COMPACTION_VERSION,
      code,
      message,
      ...details,
    },
  };
}

function abortRefusal(signal) {
  return signal?.aborted ? refusal('COMPACTION_ABORTED', 'deterministic compaction was cancelled by its abort signal') : null;
}

function checkSignal(signal) {
  return abortRefusal(signal);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw invalid('COMPACTION_INPUT_INVALID', `${label} must be a bounded identifier`);
  return value;
}

function normalizeLimits(options) {
  const limits = { ...DEFAULT_COMPACTION_LIMITS, ...(options?.limits ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw invalid('COMPACTION_INPUT_INVALID', `${name} must be a positive integer`);
  }
  return limits;
}

function normalizeAnchor(input, limits) {
  if (!isObject(input) || Array.isArray(input)) throw invalid('PACKET_ANCHOR_MISSING', 'an immutable approved packet anchor is required');
  let bytes;
  if (typeof input.text === 'string') bytes = Buffer.from(input.text, 'utf8');
  else if (input.bytes instanceof Uint8Array) bytes = Buffer.from(input.bytes);
  else throw invalid('PACKET_ANCHOR_INVALID', 'approved packet anchor must provide text or UTF-8 bytes');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw invalid('PACKET_ANCHOR_INVALID', 'approved packet anchor bytes must be valid UTF-8');
  if (bytes.length > limits.maxPacketBytes) throw invalid('PACKET_ANCHOR_OVERSIZE', 'approved packet anchor exceeds the byte limit', { bytes: bytes.length, limit: limits.maxPacketBytes });
  const digest = sha256(bytes);
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !DIGEST.test(input.sha256) || input.sha256 !== digest)) {
    throw invalid('PACKET_ANCHOR_DIGEST_MISMATCH', 'approved packet anchor digest does not match its bytes', { expected: digest });
  }
  const id = input.id === undefined ? 'approved-packet' : assertSafeId(input.id, 'approved packet anchor id');
  const anchor = {
    id,
    sha256: digest,
    bytes: bytes.length,
    text,
  };
  if (typeof input.path === 'string') anchor.path = input.path;
  return Object.freeze(anchor);
}

export function createApprovedPacketAnchor(input, options = {}) {
  return normalizeAnchor(input, { ...DEFAULT_COMPACTION_LIMITS, ...(options.limits ?? {}) });
}

function normalizeMessage(message, label, maxDepth) {
  if (!isObject(message) || Array.isArray(message) || typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) {
    throw invalid('COMPACTION_INPUT_INVALID', `${label} must be a supported Pi message`);
  }
  try {
    stableStringify(message, { maxDepth });
  } catch (error) {
    if (error instanceof DeterministicCompactionError) throw error;
    throw invalid('COMPACTION_INPUT_INVALID', `${label} is not serializable`);
  }
  return message;
}

function messageIdentity(message, section, index) {
  for (const key of ['entryId', 'sessionEntryId', 'id']) {
    if (typeof message[key] === 'string' && message[key].length > 0 && message[key].length <= 256) return message[key];
  }
  return `${section}:${index}`;
}

function toolCallBlocks(message) {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => isObject(block) && block.type === 'toolCall');
}

function callId(block) {
  for (const key of ['id', 'toolCallId', 'callId']) {
    if (typeof block[key] === 'string' && block[key].length > 0 && block[key].length <= 256) return block[key];
  }
  return null;
}

function callArguments(block) {
  if (isObject(block.arguments)) return block.arguments;
  if (isObject(block.params)) return block.params;
  if (isObject(block.input)) return block.input;
  return {};
}

function toolDescriptor(block) {
  if (!isObject(block) || typeof block.name !== 'string' || !ELIDABLE_TOOLS.has(block.name)) return null;
  const id = callId(block);
  if (!id) return null;
  const args = callArguments(block);
  if (block.name === 'read') {
    const path = args.path ?? args.filePath;
    if (typeof path !== 'string' || path.length === 0 || byteLength(path) > 4096) return null;
    return { id, tool: 'read', path };
  }
  const checkId = args.checkId === undefined ? 'all' : args.checkId;
  if (typeof checkId !== 'string' || checkId.length === 0 || byteLength(checkId) > 4096) return null;
  return { id, tool: 'run_checks', checkId };
}

function resultCallId(message) {
  for (const key of ['toolCallId', 'callId', 'id']) {
    if (typeof message[key] === 'string' && message[key].length > 0) return message[key];
  }
  return null;
}

function contentDigest(content, maxDepth) {
  const bytes = stableBytes(content, maxDepth);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function markerFor(descriptor, digest) {
  const identity = descriptor.tool === 'read'
    ? `path=${JSON.stringify(descriptor.path)}`
    : `checkId=${JSON.stringify(descriptor.checkId)}`;
  const replay = descriptor.tool === 'read' ? 're-read required' : 're-run required';
  return `[elided old ${descriptor.tool} output; sha256=${digest.sha256}; bytes=${digest.bytes}; ${identity}; ${replay}]`;
}

function replacementContent(message, marker) {
  if (typeof message.content === 'string') return marker;
  return [{ type: 'text', text: marker }];
}

function collectCalls(sections) {
  const calls = new Map();
  const ambiguous = new Set();
  const resultCounts = new Map();
  let ordinal = 0;
  for (const section of sections) {
    for (const message of section.messages) {
      for (const block of toolCallBlocks(message)) {
        const id = callId(block);
        if (!id || typeof block.name !== 'string' || block.name.length === 0) continue;
        const located = { id, name: block.name, descriptor: toolDescriptor(block), ordinal };
        if (calls.has(id)) ambiguous.add(id);
        else calls.set(id, located);
      }
      if (message.role === 'toolResult') {
        const id = resultCallId(message);
        if (id) resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
      }
      ordinal += 1;
    }
  }
  return { calls, ambiguous, resultAmbiguous: new Set([...resultCounts].filter(([, count]) => count !== 1).map(([id]) => id)) };
}

function compactMessage(message, descriptor, maxDepth) {
  if (!descriptor || message.role !== 'toolResult') return { message, omission: null };
  const digest = contentDigest(message.content, maxDepth);
  const detailsDigest = Object.hasOwn(message, 'details') ? contentDigest(message.details, maxDepth) : null;
  const marker = markerFor(descriptor, digest);
  const compacted = { ...message, content: replacementContent(message, marker) };
  // Tool result details are extension-owned and may contain a duplicate raw output.
  // Drop them from model context while binding every removed field in the audit record.
  if (Object.hasOwn(compacted, 'details')) delete compacted.details;
  return {
    message: compacted,
    omission: {
      entryId: null,
      tool: descriptor.tool,
      ...(descriptor.tool === 'read' ? { path: descriptor.path } : { checkId: descriptor.checkId }),
      contentSha256: digest.sha256,
      contentBytes: digest.bytes,
      ...(detailsDigest ? { detailsSha256: detailsDigest.sha256, detailsBytes: detailsDigest.bytes } : {}),
      replayMarker: descriptor.tool === 'read' ? 're-read required' : 're-run required',
    },
  };
}

function normalizePrevious(previousSummary, previousCompaction, limits) {
  if (previousSummary !== undefined && typeof previousSummary !== 'string') throw invalid('COMPACTION_INPUT_INVALID', 'previousSummary must be text');
  const summaryBytes = previousSummary === undefined ? 0 : byteLength(previousSummary);
  if (summaryBytes > limits.maxPreviousSummaryBytes) throw invalid('PREVIOUS_SUMMARY_OVERSIZE', 'previous compaction summary exceeds the byte limit', { bytes: summaryBytes, limit: limits.maxPreviousSummaryBytes });
  let previousDetails;
  if (previousCompaction?.details !== undefined) {
    const serialized = stableStringify(previousCompaction.details, { maxDepth: limits.maxDepth });
    const bytes = byteLength(serialized);
    if (bytes > limits.maxPreviousDetailsBytes) throw invalid('PREVIOUS_DETAILS_OVERSIZE', 'previous compaction details exceed the byte limit', { bytes, limit: limits.maxPreviousDetailsBytes });
    previousDetails = { sha256: sha256(serialized), bytes };
  }
  if (previousSummary === undefined && previousDetails === undefined && previousCompaction?.id === undefined) return null;
  if (previousCompaction?.id !== undefined) assertSafeId(previousCompaction.id, 'previous compaction id');
  return {
    summarySha256: previousSummary === undefined ? null : sha256(Buffer.from(previousSummary, 'utf8')),
    summaryBytes,
    compactionId: previousCompaction?.id ?? null,
    detailsSha256: previousDetails?.sha256 ?? null,
    detailsBytes: previousDetails?.bytes ?? 0,
  };
}

function parseSummaryFrame(summary) {
  const match = new RegExp(`^${SUMMARY_HEADER}\\nfirst-kept-entry-id:([^\\n]+)\\ntokens-before:([^\\n]+)\\npacket-id:([^\\n]+)\\npacket-sha256:([a-f0-9]{64})\\npacket-bytes:(\\d+)\\npacket-begin\\n`, 'u').exec(summary);
  if (!match) throw invalid('COMPACTION_SUMMARY_INVALID', 'summary does not contain a deterministic packet frame');
  const packetBytes = Number(match[5]);
  if (!Number.isSafeInteger(packetBytes) || packetBytes < 0) throw invalid('COMPACTION_SUMMARY_INVALID', 'summary packet length is invalid');
  const tokensBefore = Number(match[2]);
  if (!Number.isFinite(tokensBefore) || tokensBefore < 0) throw invalid('COMPACTION_SUMMARY_INVALID', 'summary token count is invalid');
  const encoded = Buffer.from(summary, 'utf8');
  const prefixBytes = byteLength(match[0]);
  const packet = encoded.subarray(prefixBytes, prefixBytes + packetBytes);
  if (packet.length !== packetBytes) throw invalid('COMPACTION_SUMMARY_INVALID', 'summary packet frame is truncated');
  const digest = sha256(packet);
  if (digest !== match[4]) throw invalid('COMPACTION_SUMMARY_INVALID', 'summary packet digest does not match its bytes');
  return { encoded, prefixBytes, packetBytes, packet, id: match[3], firstKeptEntryId: match[1], tokensBefore, sha256: digest };
}

function previousSummaryItems(previousSummary, maxDepth) {
  if (previousSummary === undefined) return [];
  if (!previousSummary.startsWith(`${SUMMARY_HEADER}\n`)) {
    const serialized = stableStringify({
      role: 'custom',
      customType: 'deterministic-compaction-previous-summary',
      content: previousSummary,
      display: false,
    }, { maxDepth });
    const bytes = Buffer.from(serialized, 'utf8');
    return [{ index: 0, serialized, sha256: sha256(bytes), bytes: bytes.length, elided: false }];
  }
  const frame = parseSummaryFrame(previousSummary);
  const suffix = frame.encoded.subarray(frame.prefixBytes + frame.packetBytes).toString('utf8');
  const beginMarker = '\nmessages-begin\n';
  const endMarker = '\nmessages-end\n';
  const begin = suffix.indexOf(beginMarker);
  const end = suffix.indexOf(endMarker, begin + beginMarker.length);
  if (begin < 0 || end < 0 || end < begin) throw invalid('PREVIOUS_SUMMARY_INVALID', 'previous deterministic summary has no complete message section');
  const lines = suffix.slice(begin + beginMarker.length, end).split('\n');
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('message:')) continue;
    let metadata;
    try { metadata = JSON.parse(lines[index].slice('message:'.length)); }
    catch { throw invalid('PREVIOUS_SUMMARY_INVALID', 'previous deterministic summary contains malformed message metadata'); }
    const serialized = lines[index + 1];
    if (!metadata || typeof metadata !== 'object' || typeof serialized !== 'string'
      || !Number.isInteger(metadata.bytes) || metadata.bytes < 0 || !DIGEST.test(metadata.sha256)
      || metadata.bytes !== byteLength(serialized) || sha256(Buffer.from(serialized, 'utf8')) !== metadata.sha256) {
      throw invalid('PREVIOUS_SUMMARY_INVALID', 'previous deterministic summary message digest is invalid');
    }
    items.push({ index: items.length, serialized, sha256: metadata.sha256, bytes: metadata.bytes, elided: metadata.elided === true });
    index += 1;
  }
  if (items.length === 0) throw invalid('PREVIOUS_SUMMARY_INVALID', 'previous deterministic summary contains no messages');
  return items;
}

function buildSummary({ anchor, firstKeptEntryId, tokensBefore, splitTurn, previous, sections, omissions, retained, maxDepth }) {
  const prefix = Buffer.from([
    SUMMARY_HEADER,
    `first-kept-entry-id:${firstKeptEntryId}`,
    `tokens-before:${String(tokensBefore)}`,
    `packet-id:${anchor.id}`,
    `packet-sha256:${anchor.sha256}`,
    `packet-bytes:${anchor.bytes}`,
    'packet-begin',
  ].join('\n') + '\n', 'utf8');
  const messageLines = ['messages-begin', `split-turn:${splitTurn ? 'true' : 'false'}`];
  for (const section of sections) {
    messageLines.push(`section:${section.name}`);
    for (const item of section.items) {
      messageLines.push(`message:${stableStringify({ index: item.index, sha256: item.sha256, bytes: item.bytes, elided: item.elided }, { maxDepth })}`);
      messageLines.push(item.serialized);
    }
  }
  messageLines.push('messages-end', 'audit-begin', `omissions-count:${omissions.length}`);
  for (const omission of omissions) messageLines.push(`omission:${stableStringify(omission, { maxDepth })}`);
  messageLines.push(`retained-count:${retained.length}`, 'audit-end');
  const suffix = Buffer.from([
    '',
    'packet-end',
    `previous-summary-sha256:${previous?.summarySha256 ?? 'none'}`,
    `previous-summary-bytes:${previous?.summaryBytes ?? 0}`,
    `previous-compaction-id:${previous?.compactionId ?? 'none'}`,
    `previous-details-sha256:${previous?.detailsSha256 ?? 'none'}`,
    `previous-details-bytes:${previous?.detailsBytes ?? 0}`,
    ...messageLines,
    '',
  ].join('\n'), 'utf8');
  return Buffer.concat([prefix, Buffer.from(anchor.text, 'utf8'), suffix]).toString('utf8');
}

function normalizeOptions(optionsOrAnchor, maybeOptions) {
  if (isObject(optionsOrAnchor) && (typeof optionsOrAnchor.text === 'string' || optionsOrAnchor.bytes instanceof Uint8Array)
    && !Object.hasOwn(optionsOrAnchor, 'approvedPacketAnchor') && !Object.hasOwn(optionsOrAnchor, 'packetAnchor')) {
    return { ...(maybeOptions ?? {}), approvedPacketAnchor: optionsOrAnchor };
  }
  return optionsOrAnchor ?? {};
}

/**
 * Build a model-free Pi compaction result from a prepared compaction span.
 * The approved packet anchor must be supplied by the trusted host, never read
 * from a conversation message or tool result.
 */
export function compactDeterministically(preparation, optionsOrAnchor = {}, maybeOptions) {
  const options = normalizeOptions(optionsOrAnchor, maybeOptions);
  const signal = options.signal;
  const aborted = checkSignal(signal);
  if (aborted) return aborted;
  try {
    if (!isObject(preparation) || Array.isArray(preparation)) throw invalid('COMPACTION_INPUT_INVALID', 'compaction preparation must be an object');
    const limits = normalizeLimits(options);
    const anchor = normalizeAnchor(options.approvedPacketAnchor ?? options.packetAnchor, limits);
    if (typeof preparation.firstKeptEntryId !== 'string' || preparation.firstKeptEntryId.length === 0) throw invalid('COMPACTION_INPUT_INVALID', 'firstKeptEntryId is required');
    assertSafeId(preparation.firstKeptEntryId, 'firstKeptEntryId');
    if (typeof preparation.tokensBefore !== 'number' || !Number.isFinite(preparation.tokensBefore) || preparation.tokensBefore < 0) throw invalid('COMPACTION_INPUT_INVALID', 'tokensBefore must be a finite non-negative number');
    if (!Array.isArray(preparation.messagesToSummarize) || !Array.isArray(preparation.turnPrefixMessages)) throw invalid('COMPACTION_INPUT_INVALID', 'compaction message spans must be arrays');
    const rawSections = [
      { name: 'history', messages: preparation.messagesToSummarize },
      { name: 'turn-prefix', messages: preparation.turnPrefixMessages },
    ];
    const totalMessages = rawSections.reduce((sum, section) => sum + section.messages.length, 0);
    if (totalMessages === 0) throw invalid('COMPACTION_EMPTY', 'there are no messages to compact');
    if (totalMessages > limits.maxMessages) throw invalid('COMPACTION_INPUT_OVERSIZE', 'compaction input exceeds the message limit', { messages: totalMessages, limit: limits.maxMessages });
    const sections = rawSections.map((section) => ({ ...section, messages: section.messages.map((message, index) => normalizeMessage(message, `${section.name}[${index}]`, limits.maxDepth)) }));
    const initialBytes = sections.reduce((sum, section) => sum + section.messages.reduce((sectionSum, message) => sectionSum + byteLength(stableStringify(message, { maxDepth: limits.maxDepth })), 0), 0);
    if (initialBytes > limits.maxInputBytes) throw invalid('COMPACTION_INPUT_OVERSIZE', 'compaction input exceeds the byte limit', { bytes: initialBytes, limit: limits.maxInputBytes });
    const previous = normalizePrevious(preparation.previousSummary, options.previousCompaction, limits);
    const priorItems = previousSummaryItems(preparation.previousSummary, limits.maxDepth);
    const { calls, ambiguous, resultAmbiguous } = collectCalls(sections);
    const omissions = [];
    const retained = [];
    let sectionOffset = 0;
    const renderedSections = [
      ...(priorItems.length > 0 ? [{ name: 'previous-history', items: priorItems }] : []),
      ...sections.map((section) => {
        const items = section.messages.map((message, index) => {
          const resultId = resultCallId(message);
          const call = message.role === 'toolResult' ? calls.get(resultId) : null;
          const resultToolName = typeof message.toolName === 'string' ? message.toolName : null;
          const descriptor = call?.descriptor;
          const paired = descriptor && resultToolName !== null && call.name === resultToolName
            && !ambiguous.has(resultId) && !resultAmbiguous.has(resultId) && call.ordinal < sectionOffset + index ? descriptor : null;
          const compacted = compactMessage(message, paired, limits.maxDepth);
          const identity = messageIdentity(message, section.name, index);
          const originalBytes = stableBytes(message, limits.maxDepth);
          const renderedBytes = stableBytes(compacted.message, limits.maxDepth);
          if (compacted.omission) {
            compacted.omission.entryId = identity;
            omissions.push(compacted.omission);
          } else {
            retained.push({ entryId: identity, section: section.name, index, contentSha256: sha256(originalBytes), contentBytes: originalBytes.length });
          }
          if (checkSignal(signal)) throw invalid('COMPACTION_ABORTED', 'deterministic compaction was cancelled by its abort signal');
          return { index, serialized: stableStringify(compacted.message, { maxDepth: limits.maxDepth }), sha256: sha256(renderedBytes), bytes: renderedBytes.length, elided: Boolean(compacted.omission) };
        });
        sectionOffset += section.messages.length;
        return { name: section.name, items };
      }),
    ];
    if (omissions.length === 0 && retained.length === 0) throw invalid('COMPACTION_EMPTY', 'there are no model-visible messages to compact');
    const summary = buildSummary({
      anchor,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      splitTurn: preparation.isSplitTurn === true || preparation.turnPrefixMessages.length > 0,
      previous,
      sections: renderedSections,
      omissions,
      retained,
      maxDepth: limits.maxDepth,
    });
    const summaryBytes = byteLength(summary);
    if (summaryBytes > limits.maxSummaryBytes) throw invalid('COMPACTION_SUMMARY_OVERSIZE', 'deterministic compaction summary exceeds the byte limit', { bytes: summaryBytes, limit: limits.maxSummaryBytes });
    const details = {
      schemaVersion: DETERMINISTIC_COMPACTION_VERSION,
      strategy: 'deterministic',
      packet: { id: anchor.id, ...(anchor.path ? { path: anchor.path } : {}), sha256: anchor.sha256, bytes: anchor.bytes },
      splitTurn: preparation.isSplitTurn === true || preparation.turnPrefixMessages.length > 0,
      input: { messages: totalMessages, bytes: initialBytes },
      output: { summaryBytes, retainedMessages: retained.length, omittedMessages: omissions.length },
      omissions,
      previous,
      summarySha256: sha256(Buffer.from(summary, 'utf8')),
    };
    const detailsBytes = byteLength(stableStringify(details, { maxDepth: limits.maxDepth }));
    if (detailsBytes > limits.maxDetailsBytes) throw invalid('COMPACTION_DETAILS_OVERSIZE', 'deterministic compaction details exceed the byte limit', { bytes: detailsBytes, limit: limits.maxDetailsBytes });
    const compaction = { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details };
    return { ...compaction, compaction, metrics: { inputBytes: initialBytes, summaryBytes, detailsBytes, omittedBytes: omissions.reduce((sum, item) => sum + item.contentBytes, 0) } };
  } catch (error) {
    if (error instanceof DeterministicCompactionError) return refusal(error.code, error.message, error.details);
    return refusal('COMPACTION_FAILED', 'deterministic compaction refused an unsupported input');
  }
}

/**
 * Parse the length-framed packet block from a deterministic summary. This is
 * also used by offline reconstruction tests to inspect the rebuilt Pi context.
 */
export function extractApprovedPacket(summary) {
  if (typeof summary !== 'string') throw invalid('COMPACTION_SUMMARY_INVALID', 'summary must be text');
  const frame = parseSummaryFrame(summary);
  return {
    id: frame.id,
    firstKeptEntryId: frame.firstKeptEntryId,
    tokensBefore: frame.tokensBefore,
    sha256: frame.sha256,
    bytes: frame.packetBytes,
    text: frame.packet.toString('utf8'),
  };
}

export const deterministicCompaction = compactDeterministically;
