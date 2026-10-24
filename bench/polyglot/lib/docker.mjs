import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, prepareWorkspace, readReferenceFiles } from './dataset.mjs';

export const IMAGE = 'tinysdd-polyglot:1';
const DOCKER_DIR = fileURLToPath(new URL('../docker', import.meta.url));
const TAIL_CHARS = 12000;

export class HarnessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}

function execDocker(args) {
  return new Promise((resolvePromise, reject) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function buildImage() {
  const started = Date.now();
  await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['build', '-t', IMAGE, DOCKER_DIR], {
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('error', (error) => {
      reject(new HarnessError('DOCKER_UNAVAILABLE', `cannot run docker: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new HarnessError('IMAGE_BUILD_FAILED', `docker build exited with ${code}`));
    });
  });
  return { image: IMAGE, durationMs: Date.now() - started };
}

export async function assertImage() {
  try {
    await execDocker(['image', 'inspect', IMAGE]);
  } catch (error) {
    throw new HarnessError(
      'IMAGE_MISSING',
      `docker image ${IMAGE} is not available; run buildImage() first`,
      { stderr: String(error.stderr ?? error.message).slice(0, 2000) },
    );
  }
}

function userFlag() {
  if (typeof process.getuid !== 'function') return [];
  return ['--user', `${process.getuid()}:${process.getgid()}`];
}

// Runs the exercise's tests in a fresh container. `--network none` means nothing
// can be downloaded at test time; the image carries every dependency.
export async function runTests({ workDir, language, timeoutMs = 180000 }) {
  if (!LANGUAGES.includes(language)) throw new Error(`unknown language ${language}`);
  const name = `tinysdd-poly-${randomBytes(6).toString('hex')}`;
  const args = [
    'run', '--rm', '--name', name,
    '--network', 'none',
    '--memory', '4g',
    '--cpus', '4',
    ...userFlag(),
    '-e', 'HOME=/tmp',
    '--tmpfs', '/tmp:rw,exec,size=1g',
    '-v', `${resolve(workDir)}:/work`,
    '-w', '/work',
    IMAGE,
    'run-tests.sh', language,
  ];
  const started = Date.now();
  return await new Promise((resolvePromise, reject) => {
    let output = '';
    let timedOut = false;
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 1_000_000) output = output.slice(-TAIL_CHARS * 4);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      execFile('docker', ['kill', name], () => {});
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new HarnessError('DOCKER_UNAVAILABLE', `cannot run docker: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      // 125 is docker's own failure (daemon down, image missing), not a test result.
      if (exitCode === 125 && !timedOut) {
        reject(new HarnessError('DOCKER_RUN_FAILED', 'docker run failed', {
          outputTail: output.slice(-TAIL_CHARS),
        }));
        return;
      }
      resolvePromise({
        passed: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: output.slice(-TAIL_CHARS),
      });
    });
  });
}

function firstErrorLine(outputTail) {
  const lines = outputTail.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|fail|panic|exception|undefined/i.test(l));
  return (hit ?? lines.at(-1) ?? '(no output)').slice(0, 240);
}

function describeReferenceFailure(run) {
  if (run.timedOut) return 'reference timed out';
  return `reference fails (exit ${run.exitCode}): ${firstErrorLine(run.outputTail)}`;
}

// Stub must fail (otherwise the tests are not testing anything), reference
// must pass (otherwise the exercise is broken or unsolvable with its files).
export async function oracleCheck({
  checkoutDir,
  manifest,
  concurrency = 4,
  timeoutMs = 180000,
  workRoot = tmpdir(),
  outFile,
  onProgress = () => {},
}) {
  await assertImage();
  const started = Date.now();
  const runRoot = join(workRoot, `oracle-${randomBytes(4).toString('hex')}`);
  await mkdir(runRoot, { recursive: true });
  const exercises = manifest.exercises;
  const results = new Array(exercises.length);
  let next = 0;
  let done = 0;

  async function checkOne(exercise, index) {
    const base = join(runRoot, exercise.id.replaceAll('/', '__'));
    const { overlay, mapping } = await readReferenceFiles(checkoutDir, exercise);
    const stubDir = join(base, 'stub');
    const refDir = join(base, 'reference');
    await prepareWorkspace({ checkoutDir, exercise, destDir: stubDir });
    await prepareWorkspace({ checkoutDir, exercise, destDir: refDir, overlay });
    const stub = await runTests({ workDir: stubDir, language: exercise.language, timeoutMs });
    const reference = await runTests({ workDir: refDir, language: exercise.language, timeoutMs });
    await rm(base, { recursive: true, force: true });

    const notes = [...mapping.notes];
    if (mapping.unusedExamples.length) notes.push(`unused examples: ${mapping.unusedExamples.join(', ')}`);
    const kept = mapping.unmappedSolution;
    const ok = !stub.passed && reference.passed;
    let reason = null;
    if (stub.passed) reason = 'stub passes the tests (tests too weak or not run)';
    else if (!reference.passed) reason = describeReferenceFailure(reference);
    const result = {
      id: exercise.id,
      language: exercise.language,
      split: exercise.split,
      ok,
      stubPassed: stub.passed,
      stubExitCode: stub.exitCode,
      stubTimedOut: stub.timedOut,
      referencePassed: reference.passed,
      referenceExitCode: reference.exitCode,
      referenceTimedOut: reference.timedOut,
      durationMs: stub.durationMs + reference.durationMs,
      mapping: { pairs: mapping.pairs, keptStub: kept, notes },
      reason,
    };
    if (!ok) result.outputTail = reference.outputTail.slice(-2000);
    results[index] = result;
    done += 1;
    onProgress(`[${done}/${exercises.length}] ${exercise.id} ${ok ? 'ok' : 'FAIL'}`);
  }

  let aborted = false;
  async function worker() {
    while (!aborted && next < exercises.length) {
      const index = next++;
      try {
        await checkOne(exercises[index], index);
      } catch (error) {
        aborted = true;
        throw error;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, exercises.length) }, worker));
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }

  const byLanguage = {};
  for (const r of results) {
    byLanguage[r.language] ??= { total: 0, ok: 0 };
    byLanguage[r.language].total += 1;
    if (r.ok) byLanguage[r.language].ok += 1;
  }
  const document = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    image: IMAGE,
    source: manifest.source,
    durationMs: Date.now() - started,
    summary: {
      total: results.length,
      stubFailsAsExpected: results.filter((r) => !r.stubPassed).length,
      referencePasses: results.filter((r) => r.referencePassed).length,
      ok: results.filter((r) => r.ok).length,
      byLanguage,
      excluded: results.filter((r) => !r.ok).map((r) => r.id),
      ambiguousMappings: results.filter((r) => r.mapping.notes.length > 0).map((r) => r.id),
    },
    results,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}
