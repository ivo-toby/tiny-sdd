---
name: tinysdd-constitution
description: Prepare, approve and propagate a small project constitution without changing TinySDD task authority.
---

# TinySDD project constitution

Use this harness-independent skill when a project wants concise engineering
principles to travel with a prepared change. Load it after [setup](../setup/SKILL.md)
and before the [frontier router](../harness/claude/tinysdd-frontier/SKILL.md).
The constitution is project design guidance; AGENTS.md still governs agent
operation and the controller still governs task approval, review and
acceptance.

Start from [templates/constitution.md](templates/constitution.md) and
[templates/constitution.approval.json](templates/constitution.approval.json).
Inspect the recommended paths `specs/constitution.md` and
`specs/constitution.approval.json` as bounded ordinary files. Explain a
missing, malformed or digest-mismatched pair to the operator. Creating these
files alone does not adopt them into existing changes.

When the operator adopts a constitution, add the optional change descriptor
field:

```json
"constitution": {
  "path": "specs/constitution.md",
  "approval": "specs/constitution.approval.json"
}
```

The validator records the exact Markdown bytes and requires the approval
record's `contentSha256` to match. `version`, timestamps, `by` and `reason`
record the operator decision; they are not a signature or an identity claim.
Keep the record's timestamps ordered and use an exact UTC timestamp. A
deterministic validator checks shape, bytes, paths, ranges and digests; the
operator and strong model review whether the prose is complete and consistent.

For initial ratification, draft the exact principles and explain conflicts or
UNKNOWNs, obtain the operator's approval of those exact Markdown bytes, then
write the approval record with its digest, attribution, reason and timestamps.
Creating the files or adding a change reference cannot mint an approval record.

For an amendment, prepare the proposed Markdown change, explain its effect and
surface conflicts with requirements, AGENTS.md or existing contracts. Obtain
explicit operator approval, write the new exact digest and record, then
revalidate the change. Regenerate affected preparation entries, update affected
tasks and obtain fresh task approval and review through the existing workflow.
Do not make the constitution or approval record a delta target in the same
change; an amendment is a constitution workflow followed by fresh preparation.

Every slice that references a constitution must cite exact context ranges that
cover every line of the approved compact Markdown within its existing context
budget. Include both constitution files in the existing preparation and
protected paths. Export and archive through the existing pipeline so the
retained bytes and their digests remain reviewable. Worker output never proves
constitution approval or semantic consistency.
