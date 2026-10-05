# Bounded research packet workflow

Issue #29 provides an offline handoff between repository preparation and a
caller-selected research model. The handoff is a packet directory outside the
target project. It contains the exact proposal bytes, an eligible repository
map with lexical line hints, retained source bytes, and a selection-only
prompt. Preparation invokes no provider, model, service, or source code.

## Prepare a packet

Run the script from any working directory and provide absolute project and
output paths. The output directory must be new, canonical, and outside the
project:

```sh
node /absolute/path/to/tiny-sdd/scripts/research.mjs prepare \
  --project /absolute/path/to/project \
  --proposal changes/example/proposal.md \
  --out /absolute/canonical/tmp/research-packet \
  --max-files 200 --max-source-bytes 524288 \
  --max-map-bytes 262144 --budget-bytes 24576 --json
```

The required limits are `max-files`, `max-source-bytes`, `max-map-bytes`, and
`budget-bytes`. Optional limits can further bound the proposal, each source
file, and the prompt. Git's eligible file listing is preferred; a bounded
filesystem walk is used only when Git cannot provide one. Internal state,
dependencies, secret names, symlinks and non-regular files are excluded. A
fallback warning is written to stderr.

The map and packet are deterministic for the same project bytes, proposal and
limits. Every retained input has a byte count and SHA-256 digest. Exceeded
limits, invalid paths, source races, output aliases and output collisions fail
explicitly before a successful handoff is reported.

## Return and validate a selection

The caller-selected model or harness may use `prompt.txt`, but its response is
only a selection hint. Return exactly this manifest shape:

```json
{
  "schemaVersion": 1,
  "facts": [],
  "resources": [
    {"path": "src/example.mjs", "startLine": 1, "endLine": 10, "purpose": "selection hint"}
  ]
}
```

Validate the response with a fresh output directory:

```sh
node /absolute/path/to/tiny-sdd/scripts/research.mjs validate \
  --project /absolute/path/to/project \
  --packet /absolute/canonical/tmp/research-packet \
  --selection /absolute/path/to/research.selection.json \
  --out /absolute/canonical/tmp/research-result \
  --budget-bytes 24576 --json
```

Validation rechecks the current proposal and every cited source against the
packet identities, verifies retained packet bytes and metadata, and compiles
the selected ranges through `compileContext()`. Excerpts in the result are
verbatim source excerpts; `purpose` is untrusted model-authored metadata.
Facts must be empty, and unknown, excluded, symlinked, changed or out-of-range
resources are refused. The result is a `draft_unapproved` report and does not
record a phase decision, approval, gate, task state or controller state.

An optional caller-supplied gold manifest can be scored with `--gold PATH` or
`--gold-text JSON`. Without gold, precision and recall are `UNKNOWN`. Supplied
gold is reported as caller-supplied; missing human-review and calibration
evidence remains `UNKNOWN`.

With `--json`, the CLI emits exactly one JSON object on stdout. Progress and
fallback or missing-gold warnings go to stderr. The commands never modify the
source project; retain failed packet or result directories when their contents
are needed for diagnosis.
