# Polyglot benchmark — implementation spec (#148)

Deterministic harness that runs TinySDD Pi workers on the Aider polyglot
exercises, verifies with the exercises' own tests in Docker, and supports
failure-driven instruction profiles. **AI proposes, tests decide.** The only
AI steps are (a) the worker model under test and (b) an external proposer
(a separate Claude session) that writes candidate instructions from an export.
Jev is an optional failure-triage helper; it never affects scores.

Conventions: Node >= 22 ESM `.mjs`, no npm dependencies, single quotes,
`node:` imports. Every CLI subcommand prints one JSON object on stdout when
`--json` is given; progress goes to stderr. Tests go in `tests/polyglot-*.test.mjs`
and must not need network, Docker, Pi or a model.

## Paths

- Code: `bench/polyglot/` in this repo.
- Data root (outside repo): `--data DIR`, default env `TINYSDD_BENCH_DATA`,
  default `~/workspace/tinysdd-bench-data`.
- Dataset checkout: `<data>/polyglot-benchmark` (git clone of
  `https://github.com/Aider-AI/polyglot-benchmark`, pinned commit
  `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`).
- Generated: `<data>/manifest.json`, `<data>/oracle-check.json`,
  `<data>/runs/<runName>/...`.

## File ownership

| File | Owner |
| --- | --- |
| `lib/dataset.mjs`, `lib/docker.mjs`, `docker/*` | agent A |
| `lib/worker-run.mjs`, `lib/driver.mjs`, `lib/pi-agent-dir.mjs` | agent B |
| `lib/features.mjs`, `lib/stats.mjs`, `lib/report.mjs`, `lib/plans.mjs`, `lib/export.mjs`, `lib/triage.mjs` | agent C |
| `cli.mjs`, `models.json`, `RUNBOOK.md`, `profiles/` | integrator |

Each lib module exports plain async functions; the CLI wires them.

## 1. Manifest (`lib/dataset.mjs`)

`buildManifest({ checkoutDir })` → object, written to `<data>/manifest.json`:

```json
{
  "schemaVersion": 1,
  "source": { "repo": "https://github.com/Aider-AI/polyglot-benchmark", "commit": "<git HEAD>" },
  "exercises": [
    {
      "id": "python/affine-cipher",
      "language": "python",
      "dir": "python/exercises/practice/affine-cipher",
      "solutionFiles": ["affine_cipher.py"],
      "testFiles": ["affine_cipher_test.py"],
      "exampleFiles": [".meta/example.py"],
      "instructions": "<.docs/instructions.md + \n\n + .docs/instructions.append.md if present>",
      "split": "discovery"
    }
  ]
}
```

- Languages: `cpp go java javascript python rust`. 225 exercises total.
- `solutionFiles`/`testFiles`/`exampleFiles` come from `.meta/config.json`
  (`files.solution`, `files.test`, `files.example`). Paths relative to `dir`.
- Exercises sorted by `id`.
- **Split:** within each language, sort exercise ids by
  `sha256(id)` hex ascending; the first `ceil(n/2)` are `discovery`, the rest
  `holdout`. Pure function `assignSplit(ids)` exported for tests.

## 2. Workspace preparation (`lib/dataset.mjs`)

`prepareWorkspace({ checkoutDir, exercise, destDir, overlay })`:
copy the exercise directory into `destDir`, **excluding `.meta/` and `.docs/`**
(`.meta` holds the reference solution). `overlay` is an optional map
`{ relativePath: fileContents }` written over solution files only (used for
attempt 2 and verification). Reject overlay keys not in `solutionFiles`.

## 3. Test runner (`lib/docker.mjs`, `docker/`)

- One image `tinysdd-polyglot:1` built from `docker/Dockerfile` with all six
  toolchains and **all dependencies pre-fetched** (npm packages for the JS
  `package.json` devDependencies, gradle distribution + junit/assertj, cargo
  crates `anyhow`, `rand 0.8`, `time 0.3` and anything else Cargo.toml files
  list, pytest). Network is allowed only at build time.
- `docker/run-tests.sh <language>` runs inside `/work`:
  - python: `python3 -m pytest -q`
  - go: `go test ./...`
  - rust: `cargo test --offline -- --include-ignored`
  - javascript: use pre-installed `node_modules` (symlink/copy from image), `npx jest ./*`
  - java: gradle test offline (pre-warmed cache; wrapper or installed gradle)
  - cpp: `cmake -S . -B build -DEXERCISM_RUN_ALL_TESTS=1 && cmake --build build` (Exercism CMake runs tests in the build)
- `runTests({ workDir, language, timeoutMs = 180000 })` → 
  `{ passed, exitCode, timedOut, durationMs, outputTail }`:
  `docker run --rm --network none --memory 4g --cpus 4 -v <workDir>:/work tinysdd-polyglot:1 run-tests.sh <language>`;
  kill the container on timeout (use `--name` and `docker kill`);
  `outputTail` = last 12000 chars of combined stdout+stderr;
  `passed = exitCode === 0 && !timedOut`.
  Throws `HarnessError` (exported class, `code` field) when Docker itself fails
  (daemon down, image missing) so callers can tell infra failure from test failure.
- `buildImage()` runs `docker build -t tinysdd-polyglot:1 bench/polyglot/docker`.
- **Oracle check** `oracleCheck({ checkoutDir, manifest, concurrency })`:
  for every exercise, (1) stub workspace → tests must fail, (2) workspace with
  example files copied over the solution files (map example→solution by
  matching basename or order) → tests must pass. Writes `<data>/oracle-check.json`
  `{ results: [{ id, stubPassed, referencePassed, ... }], summary }`.
  Exercises that fail the oracle are listed and excluded by the driver.

## 4. Models (`models.json`, integrator)

```json
{ "models": [ { "key": "qwen38q3", "route": "titan/llamacpp/qwen3.8-q3-128k",
  "provider": "litellm", "contextWindow": 128000, "maxTokens": 16384,
  "thinking": "medium", "parallel": 1 } ] }
```

`parallel` > 1 only when the route is a `Nx` variant.

## 5. Profiles (`<run>/profiles/<profileId>.json`)

TinySDD worker profile objects: `{ "schemaVersion": 1, "id": "<profileId>",
"runtime": { "thinking": "<from model>", "reasoning": true }, "instructions": "<text or empty>" }`.
`baseline` has empty instructions. Candidate profiles differ only in `instructions`.

## 6. Worker attempt (`lib/worker-run.mjs`)

`runAttempt({ checkoutDir, exercise, model, profile, attempt, previous, caseDir, runtime })`:

1. `prepareWorkspace` into a fresh temp dir; for attempt 2 overlay the
   attempt-1 candidate solution files.
2. The brief is passed inline (not written into the project). Packet:
   `{ taskId: <exercise id with / → __>, briefText, allowedPaths: solutionFiles, protectedPaths: testFiles, context: null, checks: null }`
   (`taskId` must match `/^[a-z0-9_-]+$/`; see `normalizePacket` in `src/worker.mjs`).
   Brief text:
   ```
   # Task: <exercise id>
   Implement this <language> exercise. Edit only: <solutionFiles>.
   The tests (<testFiles>) define the required interface and behavior; read them, do not modify them.
   Use only the standard library unless the project files already declare a dependency.

   <instructions>
   ```
   Attempt 2 appends:
   ```
   ## Previous attempt
   Your previous implementation is in the files above. The tests failed with this output:
   ```<outputTail, last 6000 chars>```
   Fix the implementation so all tests pass.
   ```
3. Call `runWorker` from `src/worker.mjs` with
   `worker = { type: 'pi', provider: model.provider, model: model.route, limits: { timeoutMs: 600000, maxToolCalls: 100 } }`
   and the profile object. Set `process.env.PI_CODING_AGENT_DIR` to the agent
   dir from `lib/pi-agent-dir.mjs` (generated `models.json` with one `litellm`
   provider, `baseUrl https://ai-gateway.cloud.toby.nu/v1`,
   `api openai-completions`, `apiKey "$HOMELAB_AI_GATEWAY_API_KEY"`, and the
   model entry `{ id, contextWindow, maxTokens, input: ['text'], reasoning: true }`).
   Requires env `HOMELAB_AI_GATEWAY_API_KEY`; fail fast if missing.
4. Read the candidate solution files from `result.artifactPaths.candidate`.
   Verify: `prepareWorkspace` fresh + overlay candidate solution files (tests
   always come from the dataset, so test tampering is impossible) → `runTests`.
5. Save into `caseDir/attempt-<n>/`: `worker-result.json` (copy), `patch.diff`
   (if any), `prompt.txt`, `test.json`, `solution/<files>`.
6. Return the attempt record (section 7). A worker outcome other than
   `completed` still gets verified if any solution file changed.

`runtime` is passed through to `runWorker` (tests use the fake runtime from
`tests/worker.test.mjs`; real runs pass `undefined`).

## 7. Queue, results, driver (`lib/driver.mjs`)

Run dir `<data>/runs/<runName>/`: `queue.jsonl`, `results.jsonl`,
`cases/<entryId>/`, `profiles/`, `run.json` (`{ name, createdAt, models, notes }`).

Queue entry: `{ "id": "<model>__<profile>__<exercise id / → __>__r<repeat>", "model", "profile", "exercise", "repeat", "attempts": 2 }`.

Result line (append-only; one per finished entry):

```json
{ "id": "...", "model": "...", "profile": "...", "exercise": "python/x", "language": "python",
  "split": "discovery", "repeat": 1,
  "attempts": [ { "n": 1, "workerOutcome": "completed", "workerError": null,
    "elapsedMs": 0, "usage": { "input": 0, "output": 0 }, "toolCalls": 0,
    "changedFiles": ["x.py"], "scopeViolation": false,
    "test": { "passed": false, "exitCode": 1, "timedOut": false, "durationMs": 0, "outputTail": "..." } } ],
  "pass1": false, "pass2": true, "features": ["tests_failed"],
  "startedAt": "...", "finishedAt": "..." }
```

- Attempt 2 runs only when attempt 1 did not pass.
- `runQueue({ runDir, models, checkoutDir, manifest, excluded })`:
  skip entries already in `results.jsonl`; process entries grouped by model in
  queue order; at most `model.parallel` concurrent entries.
- **Harness errors** (Docker failure, gateway unreachable/5xx before the model
  produced anything, missing env): do **not** write a result; append to
  `harness-errors.jsonl` and retry the entry up to 3 times with 60 s backoff,
  then stop the whole run with a clear error (so a dead Titan does not burn
  the queue). Model failures (timeouts, tool limits, bad code) are results.
- `SIGINT`: finish in-flight entries' bookkeeping, stop cleanly. Re-running
  resumes.
- Progress line per entry on stderr: `[done/total] model profile exercise pass1/pass2 elapsed`.

## 8. Features (`lib/features.mjs`)

`featuresFor(result)` → sorted unique strings, deterministic, from the **last** attempt:
`worker_timeout`, `tool_limit`, `response_token_limit`, `raw_output_limit`,
`no_progress`, `worker_failed` (other non-completed outcomes), `no_edits`,
`scope_violation`, `test_timeout`, `compile_error` (language-specific regexes
on outputTail: e.g. `SyntaxError`, `error\[E\d+\]`, `cannot find symbol`,
`undefined:`, `error: ` from g++/clang, `IndentationError`), `tests_failed`
(ran but failed, none of the above), `passed`.

## 9. Stats and report (`lib/stats.mjs`, `lib/report.mjs`)

- `mcnemar(pairs)` with exact two-sided binomial p-value on discordant pairs
  (`b`, `c`); returns `{ b, c, n, p }`.
- `summarize(results, { groupBy })` → pass1/pass2 rates with counts.
- `report({ runDir })` writes `report.md` and `report.csv`:
  per model × profile: n, pass@1, pass@2, per language pass@2, feature counts;
  per candidate vs baseline (paired on exercise+repeat+split): Δpass@2, McNemar p.

## 10. Plans (`lib/plans.mjs`)

All sampling uses a seeded PRNG (`mulberry32(seed)`), seed recorded in output.

- `baselinePlan({ models, manifest, excluded, repeats: 2 })` → queue entries,
  profile `baseline`, all non-excluded exercises.
- `screenPlan({ results, model, candidates, passSample: 20, seed })` → for the
  model's **discovery** baseline results: every exercise that failed pass@2 in
  any repeat, plus `passSample` random discovery exercises that passed;
  entries for `baseline-rerun` (baseline instructions, new repeat ids) **and**
  each candidate profile. Repeat 1 only.
- `confirmPlan({ model, candidate, manifest, excluded, repeats: 2 })` →
  **holdout** exercises, entries for the candidate (baseline holdout results
  already exist from the baseline run).
- `decide({ results, model, candidate })` → `{ keep: boolean, deltaPass2,
  p, perLanguage }` with the pre-registered rule: keep iff holdout
  pass@2(candidate) − pass@2(baseline) > 0.05 and no language drops by more
  than 0.10.

## 11. Export for the proposer (`lib/export.mjs`)

`exportFailures({ runDir, model, profile: 'baseline', split: 'discovery', out })`
writes a markdown + JSON bundle of discovery failures only: exercise id,
language, features, the brief instructions (trimmed to 3000 chars), the final
solution diff vs the stub (trimmed 4000 chars), the test outputTail (trimmed
3000 chars), and Jev triage labels when present. **Never** include holdout
exercises or `.meta` reference solutions.

## 12. Jev triage (`lib/triage.mjs`)

`triage({ runDir, model, profile, split: 'discovery' })` for failed results:
one batched POST per failure to `https://api.typesafe.ai/v1/systemone`
(`Authorization: Bearer $JEV_API_KEY`), body
`{ model: 'jev-latest', state: { instructions, testOutput, solutionExcerpt }, questions }`
where questions is an object keyed by id, each
`{ type: 'noul', instruction, criteria: { true, false } }`:

- `signature`: "Does the test output show the implementation's function/class names or signatures do not match what the tests call?"
- `edge_case`: "Do the failing tests check an edge case or error condition that the instructions mention?"
- `incomplete`: "Does the solution leave parts unimplemented (stubs, TODO, placeholder returns)?"
- `misread`: "Does the failure show the implementation solves a different problem than the instructions describe?"
- `env`: "Does the failure come from build or tooling problems rather than the solution logic?"

Response: `{ answers: { id: { noul } } }`. Store
`<runDir>/triage/<entryId>.json` `{ answers, modelVersion }`; label = noul ≥ 0.7.
State must be small: truncate each field to 4000 chars. Missing key or HTTP
error → record `unavailable` and continue; never fail the run. fetch must be
injectable for tests.

## 12a. Registry cards (`lib/card.mjs`)

`card --run NAME --model K [--profile ID]` builds one benchmark card for the
registry (#123): settings from `models.json` plus the worker timeout, pass@1,
pass@2, mean minutes per entry and per-language rates. A baseline card covers
every split; a candidate card covers holdout only and needs a `decide` file,
whose keep/reject result it carries. `--into FILE` adds the card to a TinySDD
profile (replacing a card with the same suite, variant, split and run) and
refuses a card whose settings differ from the profile; with `--id` it creates
the profile when FILE does not exist. Cards hold aggregates only.

## 13. Tests (each owner)

Offline only. At minimum: split determinism and stratification; workspace
excludes `.meta`/`.docs` and rejects bad overlays; features table; McNemar
known values; plans determinism with a fixed seed; driver resume/skip and
harness-error retry using injected fakes for `runAttempt`; triage with a fake
fetch; export excludes holdout.
