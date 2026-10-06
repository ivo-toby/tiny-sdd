# Project constitution — issue #94 proposal

Status: approved by Ivo on 2026-10-06, including the regression tests.

## Artifact and approval

Use `specs/constitution.md` for concise project principles and amendment governance.
Use `specs/constitution.approval.json` for the operator-approved identity:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "ratifiedAt": "2026-10-06T00:00:00.000Z",
  "amendedAt": "2026-10-06T00:00:00.000Z",
  "approvedAt": "2026-10-06T00:00:00.000Z",
  "by": "operator",
  "reason": "Approved project principles",
  "contentSha256": "<SHA-256 of the exact Markdown bytes>"
}
```

The constitution skill prepares a draft, explains changes and conflicts, obtains
explicit operator approval, and only then records attribution and the exact byte
identity. These fields record operator decisions; they do not authenticate a
person or constitute a cryptographic signature. Workers cannot approve or amend
these artifacts. Preserve amendment history in version control.

Default paths are recommended; a portable change may explicitly reference other
project-relative ordinary paths. Do not silently overwrite AGENTS.md or copy the
historical write-set restrictions from the older prototype constitution.

## Adoption and compatibility

Add an optional `constitution` object to the existing change descriptor:

```json
"constitution": {
  "path": "specs/constitution.md",
  "approval": "specs/constitution.approval.json"
}
```

Without that field, current descriptors, tasks, approvals and projects retain their
existing behavior. Setup and preparation skills discover the recommended files,
explain drafts or mismatches, and ask the operator whether to adopt them. Mere
creation of a constitution does not silently change existing task authority.

When referenced, require bounded ordinary files, a valid approval record and an
exact matching content digest. Fail preparation on missing, malformed or changed
records. Use existing error and path-validation patterns, without dependencies.

## Propagation and freshness

Include both files in the change's existing preparation set and protected paths.
Require constitution excerpts in every slice's existing context manifest, with
exact source ranges covering the approved compact document; keep context budgets
honest. Use the existing context compiler and export pipeline rather than adding
a second worker prompt or controller approval type.

Any edit to either referenced file invalidates the existing preparation identity.
The operator approves an amendment, preparation is regenerated, affected tasks
are updated, and existing task approval/review rules require fresh approval.
Unrelated tasks and changes without a constitution reference keep their behavior.
No automatic plan acceptance, feature acceptance, or silent waiver is introduced.

## Skills and conflicts

Add a harness-independent constitution skill/template. Link it from setup and the
frontier router, and integrate approved principles with specify, research, plan
and slice. AGENTS.md continues to govern agent operation; the constitution records
project design and engineering principles. Surface conflicts with requirements,
AGENTS.md or existing contracts for the operator. Semantic consistency remains a
strong-model/operator review obligation; deterministic validation does not prove
that prose is correct or complete.

## Validation and scope

Offline regressions cover record validation and digest mismatches, optional-field
compatibility, context propagation, protected/preparation paths, amendment
freshness, and export/archive retention using existing fixtures. Test meaningful
behavior rather than matching skill wording. No live inference, services, secrets,
package installation, new top-level dependencies or unrelated controller refactor.

Expected code: a small constitution validator module and `src/change-format.mjs`;
controller state and packet schemas stay unchanged. Documentation: artifact format,
quickstart, CLI workflow, the issue #94 runtime tracking row, skill/router/phase
assets and templates. The operator explicitly approved these regression tests.
