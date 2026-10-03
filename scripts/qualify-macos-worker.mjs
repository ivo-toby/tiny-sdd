import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runWorker } from "../src/worker.mjs";

const { values } = parseArgs({ options: { provider: { type: "string" }, model: { type: "string" } } });
if (process.platform !== "darwin" || !values.provider || !values.model) throw new Error("Use on macOS with --provider NAME --model EXACT_MODEL_ID");

// Keep the synthetic project and artifacts for independent inspection.
const projectRoot = await mkdtemp(join(await realpath(tmpdir()), "tinysdd-macos-model-qualification-"));
await mkdir(join(projectRoot, "src"));
await writeFile(join(projectRoot, "src", "answer.txt"), "before\n");
const result = await runWorker({
  projectRoot,
  packet: { schemaVersion: 1, taskId: "macos-qualification", allowedPaths: ["src/answer.txt"], briefText: 'Use the write tool to replace src/answer.txt with exactly "after\\n" (one line containing after, followed by a newline). No other edits. Do not run checks or commands. Report verification as unrun.' },
  worker: { type: "pi", provider: values.provider, model: values.model, limits: { timeoutMs: 120_000, maxToolCalls: 8 } },
});
const metadata = JSON.parse(await readFile(result.artifactPaths.runtime, "utf8"));
const sourceUnchanged = await readFile(join(projectRoot, "src", "answer.txt"), "utf8") === "before\n";
const candidateCorrect = await readFile(join(result.artifactPaths.workspaceAfter, "src", "answer.txt"), "utf8") === "after\n";
const observed = { projectRoot, runId: result.runId, outcome: result.outcome, sandbox: metadata.sandbox, piVersion: metadata.piVersion, sourceUnchanged, candidateCorrect, scopeViolations: result.scopeViolations.length, resultPath: result.artifactPaths.result };
console.log(JSON.stringify(observed));
assert.equal(result.outcome, "completed");
assert.equal(metadata.sandbox, "seatbelt");
assert.equal(sourceUnchanged, true);
assert.equal(candidateCorrect, true);
assert.equal(result.scopeViolations.length, 0);
