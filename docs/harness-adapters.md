# TinySDD foreign harness adapters

Issue #31 adds a host-managed capture boundary for two operator-selected
consumers of an approved slice bundle:

- Claude Code can prepare a slice with the frontier skill and implement it with
  the explicit small-model subagent template.
- Interactive Pi can consume the same packet in a begin-owned candidate with an
  operator-selected local provider and model.

The capture module does not run either harness. It begins with the current
ready task approval, copies the source using the native worker's bounded
git-aware rules, retains the exact packet and bundle bytes, and returns a new
candidate outside the source project. Finalization reads only that candidate,
checks the source, bundle, baseline, session, and alias identities, and writes
the normal `result.json` evidence under `.tinysdd/runs/worker-*`.

## Prepare and begin

Use a canonical directory outside the source project for the bundle and
candidate parent. The paths below are literal placeholders; replace them with
the paths selected by the operator. The command does not execute a harness:

```text
node /absolute/tiny-sdd/scripts/export-slice.mjs \
  --project /absolute/project \
  --change changes/feature/change.json \
  --slice feature-s1 \
  --out /absolute/canonical/adapter-runs/feature-s1-bundle \
  --json

node /absolute/tiny-sdd/scripts/harness-adapter.mjs begin \
  --project /absolute/project \
  --bundle /absolute/canonical/adapter-runs/feature-s1-bundle \
  --harness claude-code \
  --model haiku \
  --candidate-parent /absolute/canonical/adapter-runs \
  --json
```

Record the returned `runId`, `candidatePath`, and `artifactDir`. The model
value is caller-declared. A requested Claude model can be overridden by a
session or provider policy; this capture implementation leaves `observedId` as
`UNKNOWN`, so a live operator must confirm the resolved model and stop on a
mismatch. There is no model or provider fallback.

The begin operation retains the exact packet at `artifactDir/packet.json` and
the complete bundle under `artifactDir/bundle/`. It does not rewrite
`.tinysdd/runs/controller.json`, approvals, task inputs, or the source project.
The candidate is disposable and owned by this run. Do not move it, replace it,
or place credentials in it.

## Claude Code

The project-local templates are in
`skills/tinysdd/assets/harness/claude/`. The `tinysdd-frontier` skill describes
how a frontier session prepares and approves a normal TinySDD packet. The
`tinysdd-slice-worker.md` file is a Claude subagent definition with `Read`,
`Write`, and `Edit` in its `tools` field and an explicit `haiku` model value.
Use a fresh, run-owned adapter parent outside both the source project and
returned candidate. After inspecting the template and choosing the exact
small-model value, create
`<adapter-parent>/.claude/agents/tinysdd-slice-worker.md` exclusively, then
start Claude from the returned candidate below that parent. An explicit
per-session agent definition option with the template bytes is also safe. Never
create the definition inside the captured candidate, overwrite an existing
`.claude`/`.pi` file, or change global Claude configuration as part of a run.

Claude's `tools` field restricts the subagent's available tools. A skill's
`allowed-tools` field only preapproves tools; it is not an isolation boundary.
The template therefore keeps the implementation subagent free of command,
shell, network, and package-manager tools. It reports unrun checks and does not
claim verification or acceptance. Use the parent conversation to ask for
missing facts. Do not route this Claude subagent through the configured Pi
worker.

For a per-session definition, pass the template body through `--agents` and
ask the frontier session to delegate to the named worker. `--agent` selects the
main session agent, so it is intentionally omitted here. This keeps the
definition out of the candidate and does not overwrite Claude configuration.
The argument array below reads the reviewed template, removes only its
frontmatter, and passes the resulting definition and exact retained inputs
without shell interpolation:

```js
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const templatePath = '/absolute/tiny-sdd/skills/tinysdd/assets/harness/claude/tinysdd-slice-worker.md';
const template = await readFile(templatePath, 'utf8');
const prompt = template.replace(/^---\n[\s\S]*?\n---\n/u, '');
const artifactDir = '/absolute/project/.tinysdd/runs/worker-harness-id';
const candidatePath = '/absolute/canonical/adapter-runs/worker-candidate';
const agents = JSON.stringify({
  'tinysdd-slice-worker': {
    description: 'Implements one approved TinySDD slice using only file tools.',
    prompt,
    tools: ['Read', 'Write', 'Edit'],
    model: 'haiku',
  },
});
spawn('claude', [
  '--agents', agents,
  '--model', 'operator-selected-frontier-model',
  '--tools', 'Read,Write,Edit,Agent',
  [
    `Read the exact approved packet at ${artifactDir}/packet.json.`,
    `Read ${artifactDir}/bundle/brief.md, ${artifactDir}/bundle/compiled-context.md when present, and ${artifactDir}/bundle/checks.json.`,
    `Use the Agent tool to delegate implementation to tinysdd-slice-worker in ${candidatePath}.`,
    'Do not edit packet, context, checks, preparation, protected, or controller files; report unrun checks.',
  ].join('\n'),
], { cwd: candidatePath, stdio: 'inherit' });
```

Replace the literal paths and parent model with the values selected by the
operator. The frontier model is the main session choice; the delegated worker
model remains the explicit `haiku` value in the definition. Start Claude in the
returned candidate directory, inspect the retained inputs, and invoke the named
subagent after the operator has approved the paths. Keep the requested worker
model and the observed model identity separate in the host capture; this
implementation records the latter as `UNKNOWN`, so the operator must confirm it
outside this result. `allowedPaths` are
expected planning paths; ordinary create/modify extras remain eligible and are
reported for host and reviewer inspection. Deletions, filesystem type changes,
protected paths, preparation inputs, and task inputs remain blocked.

## Interactive Pi

The Pi consumer skill is
`skills/tinysdd/assets/harness/pi/tinysdd-interactive-slice/SKILL.md`. Pi's
explicit CLI flags make the local model and tool surface visible. The following
JavaScript uses an argument array, so model names, paths, and packet content are
never interpolated into a shell command:

```js
import { spawn } from 'node:child_process';

const args = [
  '--no-skills',
  '--skill', '/absolute/tiny-sdd/skills/tinysdd/assets/harness/pi/tinysdd-interactive-slice/SKILL.md',
  '--no-extensions',
  '--tools', 'read,write,edit',
  '--provider', 'local-provider',
  '--model', 'local-provider/model-id',
  '--session', '/absolute/canonical/adapter-runs/worker-session.jsonl',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/packet.json',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/compiled-context.md',
  '@/absolute/project/.tinysdd/runs/worker-harness-id/bundle/checks.json',
];

spawn('pi', args, { cwd: '/absolute/canonical/adapter-runs/worker-candidate', stdio: 'inherit' });
```

Use the retained filenames listed by `bundle.json`; the paths above are the
exporter's standard `packet.json`, `compiled-context.md`, and `checks.json`
names. If a valid bundle has no compiled context, omit that `@...` argument.
Do not pass source preparation or controller files from the candidate. Pi's
`allowedPaths` are expected planning paths; ordinary create/modify extras remain
eligible and are reported for host and reviewer inspection. Deletions,
filesystem type changes, protected paths, preparation inputs, and task inputs
remain blocked.

Replace every example path and identity with the values returned by `begin`.
Use an explicit `--provider` and matching `--model`; Pi requires the provider
flag to be paired with a model. `--no-skills` still permits the explicit skill
passed with `--skill`, and `--no-extensions` disables discovered, configured,
and built-in extensions. The skill's prompt restrictions do not promise OS
isolation, credential protection, check execution, or observed model identity.

## Finalize, apply, and review

After the operator declares the session complete or interrupted, finalize with
an explicit boolean. A completion declaration is caller metadata, not evidence:

```text
node /absolute/tiny-sdd/scripts/harness-adapter.mjs finalize \
  --project /absolute/project \
  --run worker-harness-id \
  --completed true \
  --claim 'Unverified foreign-harness completion claim.' \
  --json
```

Use `--completed false` for an interrupted or failed session. Such a result is
retained for inspection and cannot be applied. Finalization never runs checks,
arbitrary commands, a model, or a service; existing fixed `git ls-files`
inventory may run during the bounded source copy. Usage, sandbox behavior,
process termination, and observed model identity remain `UNKNOWN` in this
implementation; foreign output is never verification evidence. `runtime.json`
records the begin-time session as open; finalization records the caller's
completion declaration separately and does not infer process termination.

Route a completed, scope-clean result through the ordinary controller path:

```text
node /absolute/tiny-sdd/bin/tinysdd.mjs --project /absolute/project \
  task apply --id feature-s1 --run worker-harness-id --by operator
node /absolute/tiny-sdd/bin/tinysdd.mjs --project /absolute/project \
  task review --id feature-s1 --verdict accepted \
  --by reviewer --evidence .tinysdd/reviews/feature-s1.md
```

Reapproval, source drift, changed bundle bytes, changed baseline or alias
behavior, candidate relocation, symlinks, deletions, type changes, protected or
input edits, and dependency mounts remain visible blockers. The adapter never
adds an approval override, verification shortcut, acceptance event, or
qualification claim.

The offline fixtures cover one synthetic Talon-style packet for each adapter,
an ordinary edit plus ordinary extra, normal apply, and explicit fixture
review. Real Claude Code/Pi model execution, Talon implementation, OS
isolation, and operator acceptance remain unverified. `Refs #31`.

Primary references checked for the templates and recipes:

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Pi CLI](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/cli.md)
- [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
