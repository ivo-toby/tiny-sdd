import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePi } from '../lib/capture-pi.mjs';
import { preparePiEnvironment } from '../lib/pi-environment.mjs';

const participant = process.argv[2];
const mode = process.argv[3] ?? 'read';
if (mode !== 'read' && mode !== 'tools') {
  throw new Error(`Unknown smoke mode: ${mode}`);
}
const prepared = await preparePiEnvironment(participant);
const runId = `smoke-${new Date().toISOString().replaceAll(':', '-')}-${participant}-${mode}-${randomUUID().slice(0, 8)}`;
const runsRoot = fileURLToPath(new URL('../runs/001-batch-reservation/', import.meta.url));
const runDir = join(runsRoot, runId);
await mkdir(runDir, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'tinysdd-smoke-'));
const marker = randomUUID();
const originalMarker = marker + '\n';
const initialSample = 'export const marker = "pending";\n';
const verifySource = [
  "import assert from 'node:assert/strict';",
  "import { readFile } from 'node:fs/promises';",
  "import { marker } from './sample.mjs';",
  '',
  "const original = await readFile('marker.txt', 'utf8');",
  "const copy = await readFile('copy.txt', 'utf8');",
  '',
  'assert.equal(marker, original.trim());',
  'assert.equal(copy, original);',
  "console.log('TOOL_CHECK_PASS');",
  '',
].join('\n');
await writeFile(join(workspace, 'marker.txt'), originalMarker);
const initialFiles = ['marker.txt'];
if (mode === 'tools') {
  await writeFile(join(workspace, 'sample.mjs'), initialSample);
  await writeFile(join(workspace, 'verify.mjs'), verifySource);
  initialFiles.push('sample.mjs', 'verify.mjs');
}
await mkdir(join(runDir, 'initial'), { recursive: true });
for (const file of initialFiles) {
  await copyFile(join(workspace, file), join(runDir, 'initial', file));
}
const prompt = mode === 'tools'
  ? 'This is an exploratory tool qualification, not an implementation experiment. Read marker.txt and sample.mjs using read. marker.txt contains a UUID followed by exactly one newline. Use write to create copy.txt with the UUID followed by exactly one newline, preserving all 37 bytes. Use edit to replace pending in sample.mjs with only the 36-character UUID, without putting a newline inside the JavaScript string. Preserve the module file\'s final newline. Run node verify.mjs > check-output.txt 2>&1 using bash, then read check-output.txt. Reply TOOL_CHECK_PASS only if the check succeeded; otherwise report the failure. You may inspect the five fixture files marker.txt, sample.mjs, verify.mjs, copy.txt, and check-output.txt, but no other paths or environment variables. Do not use network. Do not change marker.txt or verify.mjs.'
  : 'Read marker.txt with the read tool. Reply with its contents and nothing else. Do not inspect any other path or the environment. This is a tool-use connectivity check, not an implementation task.';
const args = [
  '--offline', '--print', '--mode', 'json', '--no-session',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve',
  '--tools', 'read,write,edit,bash',
  '--provider', prepared.provider, '--model', prepared.modelId, '--thinking', 'off', prompt,
];
const limits = mode === 'tools'
  ? { timeoutMs: 90000, maxToolCalls: 12, maxObservedTokens: 32000 }
  : { timeoutMs: 90000, maxToolCalls: 3, maxObservedTokens: 32000 };
const sourceDigests = {};
const sourceFiles = [
  ['./run-smoke.mjs', 'run-smoke.mjs'],
  ['../lib/pi-environment.mjs', 'pi-environment.mjs'],
  ['../lib/capture-pi.mjs', 'capture-pi.mjs'],
];
await mkdir(join(runDir, 'sources'), { recursive: true });
for (const [path, snapshotName] of sourceFiles) {
  const bytes = await readFile(new URL(path, import.meta.url));
  sourceDigests[path] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(runDir, 'sources', snapshotName), bytes);
}
await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
  kind: 'exploratory-tool-smoke', runId, mode, workspace, expectedMarker: marker,
  runtime: prepared.metadata, args, limits, nodeVersion: process.version, sourceDigests,
  note: 'Provider advertises no streaming usage; reported zero tokens do not establish zero usage.',
}, null, 2) + '\n');
await writeFile(join(runDir, 'prompt.txt'), prompt + '\n');
const captured = await capturePi({
  executable: 'pi', args, cwd: workspace, env: prepared.env,
  outputDir: join(runDir, 'pi'), ...limits,
});
const stdout = await readFile(join(runDir, 'pi', 'stdout.jsonl'), 'utf8');
const events = stdout.split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const reads = events.filter((event) => event.type === 'tool_execution_start' && event.toolName === 'read');
const finalMessages = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant');
const finalText = finalMessages.at(-1)?.message?.content
  ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
const assistantErrors = finalMessages.filter((event) => event.message.stopReason === 'error' || event.message.errorMessage)
  .map((event) => event.message.errorMessage ?? 'Unspecified assistant error');
const validCapture = captured.stopReason === 'completed'
  && captured.exitCode === 0 && captured.parseErrors.length === 0 && captured.output.stdoutBytes > 0
  && captured.output.stdoutTruncated === false && captured.output.stderrTruncated === false;
const resourceLimitStopReasons = new Set(['tool_limit', 'timeout', 'token_limit', 'output_limit']);
const eventRecords = events.map((event, index) => ({ event, index }));
const successfulToolEnds = eventRecords.filter(({ event }) => event.type === 'tool_execution_end'
  && event.isError === false);
const requiredTools = ['read', 'write', 'edit', 'bash'];
const successfulTools = Object.fromEntries(requiredTools.map((toolName) => [
  toolName,
  successfulToolEnds.some(({ event }) => event.toolName === toolName),
]));
const verifierCommand = 'node verify.mjs > check-output.txt 2>&1';
const verifierBashStarts = eventRecords.filter(({ event }) => event.type === 'tool_execution_start'
  && event.toolName === 'bash' && event.args?.command === verifierCommand);
const verifierBashEnd = successfulToolEnds.find(({ event, index }) => event.toolName === 'bash'
  && verifierBashStarts.some(({ event: start, index: startIndex }) =>
    start.toolCallId === event.toolCallId && startIndex < index));
const verifierBashSucceeded = verifierBashEnd !== undefined;
const checkOutputPath = resolve(workspace, 'check-output.txt');
const checkReadStarts = eventRecords.filter(({ event }) => event.type === 'tool_execution_start'
  && event.toolName === 'read' && typeof event.args?.path === 'string'
  && resolve(workspace, event.args.path) === checkOutputPath);
const checkOutputRead = verifierBashEnd !== undefined && checkReadStarts.some(({ event: start, index: startIndex }) =>
  startIndex > verifierBashEnd.index && eventRecords.some(({ event: end, index: endIndex }) =>
    endIndex > startIndex && end.type === 'tool_execution_end' && end.toolName === 'read'
      && end.isError === false && end.toolCallId === start.toolCallId
      && end.result?.content?.some((block) => block.type === 'text'
        && block.text.includes('TOOL_CHECK_PASS'))));
const finalFiles = mode === 'tools'
  ? ['marker.txt', 'sample.mjs', 'verify.mjs', 'copy.txt', 'check-output.txt']
  : ['marker.txt'];
await mkdir(join(runDir, 'final'), { recursive: true });
const finalFileStatus = {};
const finalFileBytes = {};
for (const file of finalFiles) {
  try {
    const stat = await lstat(join(workspace, file));
    if (!stat.isFile()) throw new Error(`Final path is not a regular file: ${file}`);
    await copyFile(join(workspace, file), join(runDir, 'final', file));
    finalFileBytes[file] = await readFile(join(runDir, 'final', file), 'utf8');
    finalFileStatus[file] = true;
  } catch {
    finalFileStatus[file] = false;
  }
}
const finalMarker = finalFileBytes['marker.txt'] ?? null;
const finalSample = mode === 'tools' ? finalFileBytes['sample.mjs'] ?? null : null;
const finalVerify = mode === 'tools' ? finalFileBytes['verify.mjs'] ?? null : null;
const finalCopy = mode === 'tools' ? finalFileBytes['copy.txt'] ?? null : null;
const expectedSample = `export const marker = "${marker}";\n`;
const filesCorrect = mode === 'tools'
  ? finalMarker === originalMarker && finalVerify === verifySource
    && finalSample === expectedSample && finalCopy === originalMarker
  : finalMarker === originalMarker;
const expectedReply = mode === 'tools' ? 'TOOL_CHECK_PASS' : marker;
const toolModeQualified = mode === 'tools'
  && validCapture && assistantErrors.length === 0
  && requiredTools.every((toolName) => successfulTools[toolName])
  && verifierBashSucceeded && checkOutputRead && filesCorrect
  && finalText.trim() === expectedReply;
const readModeQualified = mode === 'read'
  && validCapture && assistantErrors.length === 0
  && reads.length > 0 && finalText.trim() === expectedReply && filesCorrect;
const summary = {
  kind: 'exploratory-tool-smoke', participant, mode, runDir, capture: captured,
  assistantErrors,
  classification: resourceLimitStopReasons.has(captured.stopReason) ? 'resource-limit'
    : !validCapture ? 'capture-or-process-failure'
    : assistantErrors.length > 0 ? 'runtime-error'
      : mode === 'tools' && toolModeQualified ? 'tool-qualification-pass'
        : mode === 'read' && readModeQualified ? 'tool-smoke-pass' : 'tool-smoke-fail',
  tokenUsageStatus: prepared.metadata.compatibility?.supportsUsageInStreaming === false
    ? 'UNKNOWN: streaming usage disabled; reported zeros are not measured usage' : 'reported by runtime',
  readToolObserved: reads.length > 0,
  finalReply: finalText.trim(),
  finalMarkerMatches: finalText.trim() === expectedReply,
  successfulTools,
  verifierCommand,
  verifierBashSucceeded,
  checkOutputRead,
  filesCorrect,
  finalFileStatus,
  qualified: mode === 'tools' ? toolModeQualified : readModeQualified,
};
await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
process.exitCode = summary.qualified ? 0 : 1;
