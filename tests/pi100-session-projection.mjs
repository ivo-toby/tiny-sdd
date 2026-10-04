function createBranchSummaryMessage(summary, fromId, timestamp) {
  return { role: 'branchSummary', summary, fromId, timestamp: new Date(timestamp).getTime() };
}

function createCompactionSummaryMessage(summary, tokensBefore, timestamp) {
  return { role: 'compactionSummary', summary, tokensBefore, timestamp: new Date(timestamp).getTime() };
}

function createCustomMessage(customType, content, display, details, timestamp) {
  return { role: 'custom', customType, content, display, details, timestamp: new Date(timestamp).getTime() };
}

function buildEntryIndex(entries, byId) {
  if (byId) return byId;
  const index = new Map();
  for (const entry of entries) index.set(entry.id, entry);
  return index;
}

function buildSessionPath(entries, leafId, byId) {
  const index = buildEntryIndex(entries, byId);
  if (leafId === null) return [];
  let leaf = leafId ? index.get(leafId) : undefined;
  leaf ??= entries.at(-1);
  if (!leaf) return [];
  const path = [];
  for (let current = leaf; current; current = current.parentId ? index.get(current.parentId) : undefined) path.push(current);
  path.reverse();
  return path;
}

function sessionEntryToContextMessages(entry) {
  if (entry.type === 'message') {
    const message = entry.message;
    if (message.role === 'system' && message.content == null) return [{ ...message, content: '' }];
    if (['user', 'assistant', 'toolResult'].includes(message.role) && message.content == null) return [{ ...message, content: [] }];
    return [message];
  }
  if (entry.type === 'custom_message') return [createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp)];
  if (entry.type === 'branch_summary' && entry.summary) return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  if (entry.type === 'compaction') {
    const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
    return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
  }
  return [];
}

function buildContextEntries(entries, leafId, byId) {
  const path = buildSessionPath(entries, leafId, byId);
  let compaction;
  for (const entry of path) if (entry.type === 'compaction') compaction = entry;
  if (!compaction) return path;
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  if (compactionIndex < 0) return path;
  const contextEntries = [compaction];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && !(entry.type === 'message' && entry.message.role === 'system')) contextEntries.push(entry);
  }
  contextEntries.push(...path.slice(compactionIndex + 1));
  return contextEntries;
}

function projectContextEntry(entry, edit) {
  const messages = sessionEntryToContextMessages(entry);
  if (!edit) return messages;
  if (edit.replacement === null) return [];
  return messages.map((message) => {
    if (!['user', 'assistant', 'toolResult', 'custom'].includes(message.role)) return message;
    const content = (message.role === 'assistant' || message.role === 'toolResult') && typeof edit.replacement.content === 'string'
      ? [{ type: 'text', text: edit.replacement.content }]
      : edit.replacement.content;
    return { ...message, content };
  });
}

export function buildSessionContext(entries, leafId, byId) {
  const path = buildSessionPath(entries, leafId, byId);
  const contextEntries = buildContextEntries(entries, leafId, byId);
  const edits = new Map();
  for (const entry of contextEntries) if (entry.type === 'context_edit') edits.set(entry.targetId, entry);
  const projectedEntries = contextEntries.map((sourceEntry, index) => ({
    sourceEntry,
    messages: sourceEntry.type === 'compaction' && index > 0 ? [] : projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
  }));
  let thinkingLevel = 'off';
  let model = null;
  for (const entry of path) {
    if (entry.type === 'thinking_level_change') thinkingLevel = entry.thinkingLevel;
    else if (entry.type === 'model_change') model = { provider: entry.provider, modelId: entry.modelId };
    else if (entry.type === 'message' && entry.message.role === 'assistant') model = { provider: entry.message.provider, modelId: entry.message.model };
  }
  return { messages: projectedEntries.flatMap((entry) => entry.messages), thinkingLevel, model };
}
