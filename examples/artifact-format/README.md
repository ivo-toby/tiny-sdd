# Artifact format reference fixture

This directory is a small, runnable reconstruction of the broker recut used in
the format proposal. `broker-s1` through `broker-s5b` are labeled preparation
descriptors, not historical packets: original approvals, source excerpts and
run evidence are `UNKNOWN`. The six slices use distinct expected outputs so the
fixture can be registered under the current accepted-output freshness rules;
that differs from the historical reconstruction where shared files were
reported.

From the repository root, validate the fixture with:

```text
node scripts/validate-change.mjs --change examples/artifact-format/changes/broker-recut/change.json --ready --json
```

The feature check is offline and uses the real `src/entrypoint.mjs` caller for
all six reconstructed slices:

```text
node examples/artifact-format/tests/feature-integration.test.mjs
```

`tests/feature-wiring.test.mjs` disconnects each declared slice from that
entrypoint and reruns the protected feature test; every mutation fails. Green
isolated slice tests would not establish integration. This is a synthetic
fixture demonstration, not a Talon, Pi, provider, foreign-harness, approval or
historical rerun.

The validator is read-only. To register a slice, materialize the exact
descriptor bytes at the fixed controller paths before `task add` and approval.
Use the complete `registrationPlan` entry printed by `--ready --json` as the
source for every `allow`, `protect`, `preparation` and `dependsOn` value; the
exporter compares the full preparation boundary, so a shortened hand-written
list is not equivalent to the plan:

```sh
mkdir -p .tinysdd/tasks
cp examples/artifact-format/changes/broker-recut/slices/s1/brief.md .tinysdd/tasks/broker-s1.md
cp examples/artifact-format/changes/broker-recut/slices/s1/context.json .tinysdd/tasks/broker-s1.context.json
cp examples/artifact-format/changes/broker-recut/slices/s1/checks.json .tinysdd/tasks/broker-s1.checks.json
PLAN_JSON=$(mktemp)
node scripts/validate-change.mjs \
  --change examples/artifact-format/changes/broker-recut/change.json \
  --ready --json > "$PLAN_JSON"
node --input-type=module - "$PLAN_JSON" <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const entry = plan.registrationPlan.find(({ id }) => id === 'broker-s1');
if (!entry) throw new Error('broker-s1 is missing from registrationPlan');
const args = [
  'task', 'add', '--id', entry.id, '--feature', entry.feature,
  '--brief', '.tinysdd/tasks/broker-s1.md',
  '--context', '.tinysdd/tasks/broker-s1.context.json',
  '--checks', '.tinysdd/tasks/broker-s1.checks.json',
  '--allow', entry.allow.join(','),
  '--protect', entry.protect.join(','),
  '--preparation', entry.preparation.map(({ path }) => path).join(','),
];
if (entry.dependsOn.length > 0) args.push('--depends-on', entry.dependsOn.join(','));
const result = spawnSync('tinysdd', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
NODE
```

Repeat the copy and registration in the topological order printed by the plan;
the explicit paths preserve byte identity. The example forwards the complete
preparation path list, including entries that are currently absent, and passes
dependencies with `--depends-on` when present.

The exporter requires the selected slice task and any accepted dependencies to
be currently registered and freshly approved. Unrelated draft or missing tasks
do not block a selected slice export. It writes a new bundle outside the
checkout and never runs the feature or slice checks.
