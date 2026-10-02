Fix: worker project copy must not include gitignored files

## Problem

`copyProjectTree` in src/worker.mjs (~line 140) recursively copies the entire
project working tree into the worker's disposable workspace. Its only exclusions
come from `excludedName` (~line 134): `.git`, `.tinysdd`, `node_modules`, and the
PROJECT_SECRET_DIR / PROJECT_SECRET_NAME patterns. It ignores `.gitignore`.

Observed failure (talon repo, 2026-10-02): `tinysdd worker start` failed at once with
INTERNAL_ERROR "Source contains a symlink; refusing to copy
data/threads/<id>/data/providers/codex-cli/threads/<id>/home/.codex/tmp/arg0/.../apply_patch"
`data/` is gitignored runtime state (246 MB: provider homes, thread state, Codex
home directories). The symlink check stopped the copy, which was lucky. Without that
symlink the worker sandbox would have received credential-bearing runtime data
that the secret-name heuristics don't detect. Gitignored content is a much
better signal of "not source" than name patterns.

## Required change

1. In a git repository, build the copy set from
   `git ls-files -z --cached --others --exclude-standard` (run with cwd = projectRoot,
   no shell, parse the NUL-separated output). That gives tracked files plus untracked
   files that aren't ignored, so new uncommitted source and tests are still included.
   - Keep the existing `excludedName` filtering on every path segment (.git,
     .tinysdd, node_modules, secret patterns) on top of the git list.
   - Keep the existing per-entry lstat checks: reject symlinks and non-regular
     files, and enforce the MAX_COPY_FILES / MAX_COPY_BYTES counters.
   - Skip paths that git lists but that no longer exist on disk (deleted but not
     yet staged), rather than failing on them.
   - Validate every listed path: relative, no `..` segments, stays inside projectRoot
     after resolution.
2. Outside a git repository (or if git is unavailable), keep the current recursive
   walk unchanged, and record which mode was used.
3. Record the copy mode ("git-ls-files" | "walk") in the run's metadata or result
   envelope, so the operator can see what was copied.
4. Make sure everything that later relies on the copied workspace (allowed-path
   overlay for --base-run, baseline diffing, patch generation, the context
   compiler's resource reads) still works when ignored files are absent. In
   particular, an allowed file that is new and untracked must still be copied, and
   a context resource must not point at a gitignored file (fail clearly if it does).

## Tests

- A fixture git repo with a gitignored dir that contains a symlink and a fake secret
  file: the copy succeeds, the ignored dir is absent from the workspace, and
  tracked plus untracked-but-not-ignored files are present.
- A tracked symlink still fails with the existing error.
- A non-git directory falls back to the walk, with today's behavior.
- The file/byte limits are still enforced in git mode.

## Second, smaller issue (same session if cheap)

`tinysdd worker status --json` returns the top-level `data.status` (e.g. "finished"),
but `data.request.status` keeps the launch-time value "running" forever. A naive
`grep '"status":"running"'` poller therefore never ends. Either update
request.status on completion, or rename the nested field to something like
`launchStatus`, so the request snapshot can't be mistaken for current state.
Document in the CLI workflow reference that pollers must read `data.status`.

Don't change worker sandboxing, approval binding, or the context-manifest schema.
