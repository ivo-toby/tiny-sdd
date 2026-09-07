# Baseline inventory: asynchronous podcast generation checkpoint

Inventory target: `/home/ivo/workspace/mcp-podcast-generator`

Observed: `2026-09-05T20:12:16+02:00` (Europe/Amsterdam). This is a
read-only inventory. At inventory time no target tests, build, server, model,
or network calls were run. Later verification is recorded in
[baseline-results.md](baseline-results.md). `.env` files, authentication material, and private configuration
were not read or copied. No `AGENTS.md` was found in the target repository or
its parent search path.

## Repository identity and working-tree state

| Field | Observation |
| --- | --- |
| Git HEAD | `b93a947217fe469767378b532542de8cd278cc9f` |
| Branch | `feat/full-pipeline` |
| Git status | Three untracked async-design documents; no other status entries were reported |
| Untracked files | `docs/SPEC-async-generation-publishing.md`, `docs/implementation-plan-async-jobs.md`, `docs/research-async-mcp-jobs.md` |

The three untracked documents are retained user working inputs, not part of
the committed source baseline. They should be preserved when creating any
disposable execution copy.

## Local runtime and package versions

Versions were read from the installed executables/package manifests, not
installed or refreshed during this inventory.

| Component | Version / path |
| --- | --- |
| Node | `v24.15.0`; `/home/ivo/.local/share/mise/installs/node/24.15.0/bin/node` |
| npm | `11.12.1` |
| Pi | `0.84.4`; `/home/ivo/.local/share/mise/installs/node/24.15.0/bin/pi` |
| `@modelcontextprotocol/sdk` | `1.29.0` (declared `^1.12.0`) |
| `zod` | `3.25.76` (declared `^3.22.0`) |
| `vitest` | `4.1.2` (declared `^4.1.2`) |
| `typescript` | `5.9.3` (declared `^5.4.0`) |
| `tsx` | `4.21.0` (declared `^4.0.0`) |

The Dockerfile uses `node:20-alpine`; local verification therefore runs on
Node 24.15.0 while the container target is Node 20. The lockfile resolves the
SDK to 1.29.0, Zod to 3.25.76, Vitest to 4.1.2, and TypeScript to 5.9.3.

## Existing commands and async checkpoint

`package.json` currently defines:

```text
npm run build       -> tsc
npm start           -> node dist/index.js
npm run dev         -> tsx src/index.ts
npm test            -> vitest run
npm run test:watch  -> vitest
npm run test:coverage -> vitest run --coverage
```

The primary agent reports that `tsc --noEmit` passed before this inventory;
that check was not repeated here. The async design documents require the
eventual implementation to add a process-local job manager, a combined
`generate_and_publish` operation, `get_job_status`, stage/terminal state, and
opt-in separate tools. The current source has no `src/jobs/`, `tests/jobs/`,
or `tests/server/` tree. `src/index.ts` remains synchronous at this
checkpoint: it awaits `publishHandler` and `generatePodcast` inside handlers,
creates a fresh MCP server for each stateless HTTP request, and starts the
Express listener at module load.

## Relevant source inventory

The complete current source inventory is below. Files central to the async
checkpoint are marked `focus`; the remaining files are existing execution
cores or their external boundaries that the async wrapper must preserve.

| File | Lines | Role at baseline |
| --- | ---: | --- |
| `src/index.ts` | 342 | **focus** — environment validation, output/temp directory creation, MCP registration, request handlers, listener |
| `src/tools/generate-podcast.ts` | 186 | **focus** — generation schema and async Gemini/assembly core |
| `src/tools/publish-podcast.ts` | 511 | **focus** — publish schema/handler, file checks, ffprobe, S3/RSS stage result |
| `src/audio/assembler.ts` | 120 | Existing assembly pipeline and temp-file cleanup |
| `src/audio/ffmpeg.ts` | 157 | Existing child-process FFmpeg/FFprobe wrapper |
| `src/audio/normalizer.ts` | 42 | Existing normalization/temp-file operations |
| `src/feed/feed-types.ts` | 110 | Feed contracts and result types |
| `src/feed/index.ts` | 9 | Feed exports |
| `src/feed/rss-feed.ts` | 499 | RSS parsing/building and HTTP/S3 feed updates/retries |
| `src/storage/index.ts` | 8 | Storage exports |
| `src/storage/s3-storage.ts` | 107 | S3 client and upload/put operations |
| `src/storage/storage-types.ts` | 139 | S3 configuration and storage contracts |
| `src/tts/gemini-client.ts` | 333 | Gemini TTS calls, PCM/MP3 file writes, FFmpeg conversion |
| `src/utils/download.ts` | 62 | HTTPS/HTTP music download and destination writes |
| `src/utils/feed-utils.ts` | 36 | Feed URL/key helpers |
| `src/utils/logger.ts` | 18 | Logger construction |

Async-relevant source facts inspected directly:

- `src/index.ts:170-177` creates `OUTPUT_DIR` and `TEMP_DIR`; `:179-268`
  registers the existing synchronous tools; `:306-337` handles stateless MCP
  requests and starts the listener.
- `src/tools/generate-podcast.ts:77-186` creates directories, calls Gemini,
  assembles audio, writes output/temp files, and removes the temporary TTS
  file in `finally`.
- `src/tools/publish-podcast.ts:121-457` validates and probes a local output
  file, optionally uploads to S3 and updates RSS; `:459-510` spawns local
  `ffprobe` with a 30-second timer.
- No production module named a job store, queue, job status tool, or combined
  generation/publish executor exists in this baseline.

## Existing test inventory

There are 10 test files and 181 statically counted `it`/`test` cases. Counts
below are source counts, not an executed result.

| File | Lines | Cases | Async relevance / boundary |
| --- | ---: | ---: | --- |
| `tests/tools/generate-podcast.test.ts` | 290 | 23 | **focus** — generation schema and mocked Gemini/assembler/filesystem |
| `tests/tools/publish-podcast.test.ts` | 546 | 32 | **focus** — publish stages, validation, real `/tmp` fixtures, local `ffprobe` attempt |
| `tests/index.config.test.ts` | 197 | 17 | **focus** — S3/config helpers only; does not import `src/index.ts` or start a server |
| `tests/feed/rss-feed.test.ts` | 846 | 25 | RSS semantics; S3 is mocked and RSS-only `fetch` is replaced by a stub |
| `tests/storage/s3-storage.test.ts` | 342 | 14 | S3 semantics with mocked SDK; synthetic environment values and `/tmp` fixture |
| `tests/audio/assembler.test.ts` | 242 | 11 | Assembly ordering/cleanup with FFmpeg, download, and filesystem mocks |
| `tests/audio/ffmpeg.test.ts` | 324 | 19 | FFmpeg command construction with child process/filesystem mocks |
| `tests/audio/normalizer.test.ts` | 171 | 8 | Normalization path construction with filesystem mocks |
| `tests/tts/gemini-client.test.ts` | 336 | 25 | Formatting/chunking and mocked Google SDK/filesystem/FFmpeg |
| `tests/utils/download.test.ts` | 153 | 7 | Real loopback HTTP server, ephemeral port, and unique `/tmp` directory |

## Side effects and external-call audit

The existing unit suite does not import the listener entrypoint. Most external
boundaries are mocked:

- `tests/tools/generate-podcast.test.ts` mocks `@google/generative-ai`,
  `Assembler`, and `fs/promises`; it does not call Gemini or write target
  files.
- `tests/tts/gemini-client.test.ts` mocks the Google SDK, `fs/promises`, and
  child process; it does not call the Google API or real FFmpeg.
- `tests/audio/assembler.test.ts`, `tests/audio/ffmpeg.test.ts`, and
  `tests/audio/normalizer.test.ts` mock download, FFmpeg/child process, and
  filesystem boundaries. They use absolute `/tmp` strings as assertions but
  do not perform those operations.
- `tests/feed/rss-feed.test.ts` uses an in-memory S3 mock. Its RSS-only cases
  replace and restore `globalThis.fetch`; URLs are example values and no
  remote endpoint is contacted.
- `tests/storage/s3-storage.test.ts` mocks `@aws-sdk/client-s3`. It creates
  and removes a synthetic `/tmp/s3-test-<timestamp>.mp3` and temporarily sets
  fake S3 environment values, restoring the original environment after each
  test. No real S3 request occurs.
- `tests/tools/publish-podcast.test.ts` uses mocked storage/feed backends but
  writes/removes exact `/tmp/*.mp3` fixtures and creates/removes a symlink.
  Its production handler still spawns the local `ffprobe` binary against the
  synthetic file; this is a local child process, not a model or network call.
- `tests/utils/download.test.ts` is the one deliberate real network-shaped
  test: it binds a local `127.0.0.1` HTTP server on an ephemeral port and
  writes downloaded bytes beneath a unique `/tmp/download-test-*` directory,
  then closes the server and recursively removes only that directory.
- `tests/index.config.test.ts` mutates only `process.env` with synthetic S3
  values and restores the complete environment; it does not load `src/index.ts`.

The entrypoint itself is not safe as a baseline unit-test import: it reads
environment configuration, can exit when `GOOGLE_API_KEY`/RSS/S3 settings are
invalid, creates output/temp directories, and calls `app.listen`. Generation,
real publish, and server smoke paths would additionally contact Gemini, fetch
music/RSS URLs, upload to S3, or invoke FFmpeg.

## Safe baseline execution method (proposal; not executed)

Use a disposable copy or isolated worktree containing the tracked baseline and
the three user documents, explicitly excluding `.env`, credentials, and other
private configuration. Run the unit suite there with no provider variables:

```text
env -i PATH=/home/ivo/.local/share/mise/installs/node/24.15.0/bin:/usr/bin:/bin NODE_ENV=test \
  ./node_modules/.bin/vitest run
```

This exercises mocked model/storage/feed boundaries, local `ffprobe`, and the
loopback HTTP fixture only. It may create test/cache files and `/tmp` fixtures.
A disposable repository copy or changing `TMPDIR` alone does **not** isolate
the hard-coded absolute `/tmp` paths used by some existing tests; those paths
require a private `/tmp` mount/namespace or explicit test changes. The test
process itself temporarily sets synthetic environment values and restores them;
do not provide real credentials. Private filesystem and network namespaces were
both verified in direct primary-agent execution; the delegated agent's context
had narrower permissions. See [baseline-results.md](baseline-results.md) for
the final 181/181 pass and the earlier failed attempts.

For a no-output typecheck, use the already-installed compiler in the same
disposable copy:

```text
env -i PATH=/home/ivo/.local/share/mise/installs/node/24.15.0/bin:/usr/bin:/bin NODE_ENV=test \
  ./node_modules/.bin/tsc --noEmit
```

`npm run build` is the documented build gate but writes `dist/`, so run it only
in the disposable copy. Do not import or start `src/index.ts`, run the Docker
server, call `/mcp`, invoke Gemini, fetch remote media/RSS, or exercise S3 for
this baseline. These would be separate integration/model checks requiring
explicit authorization and isolated synthetic configuration.

## SHA-256 source/document snapshot

Hashes were computed with `sha256sum` over the exact regular files listed. They
are provenance records only; no source file was modified.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/SPEC-async-generation-publishing.md` | 11721 | `e2f1492065c6deb90130cc1e276df318fca801de5049b5396950afbe2db0f328` |
| `docs/implementation-plan-async-jobs.md` | 10291 | `8e99664639e96b640cc593291b894e81de91d55ed833bbe15f411ae3284b96c4` |
| `docs/research-async-mcp-jobs.md` | 8815 | `b20a85dd25c98412f5fbb2069546773cfb4f7c5ef5b44ebec5ccbf1163ec8898` |
| `src/index.ts` | 11788 | `b885ceb03f47a229da369e945327be4c1d2b42815b600a864458d2fc5ec47888` |
| `src/tools/generate-podcast.ts` | 5605 | `7267e621a4fc5c9e2fcfb125a7f852c6cdea49c2c9011e106919bf182ea00293` |
| `src/tools/publish-podcast.ts` | 17014 | `afd280278fef50f88d92f7f0cbf5c1953721e777fcb50b0e27e5fed09303e880` |
| `package.json` | 969 | `8a1c6ffa54fce9fd8fff3ecaab5a7c885de40cfac52c503e691763256c916d93` |
| `package-lock.json` | 160171 | `4966015d295d7de98a3b84fc3d346f38e87e6b0efc8e3072270ce4ca3ca88632` |
| `tsconfig.json` | 332 | `fb109ef2535d13ccf37551282293aca6decf02be3c57c67a4aed800a3452a7f5` |
| `vitest.config.ts` | 284 | `a043ea35ea81965507b422b1f5e3f193dffe1835c2cd5edde7ee4c8ca42817fb` |
