# Feature review lessons from the first TinySDD pilot

Date: 2026-09-05. Status: candidate review practice, not a validated new skill.

These checks come from [experiment 003](../experiments/003-idempotent-reservations/results-2026-09-05.md).
They support the agreed operator-led workflow. They do not require a controller,
extra agent fleet, or reduced human involvement.

## Review the meaning of the tests

For each important acceptance condition, inspect the actual operation and expected
value. A green test can endorse a bug. In both v1 Qwen service submissions, the
implementation retained caller-owned state; one suite explicitly expected the
incorrect replay after caller mutation.

For stateful properties, spell out a short before/action/after witness when the
verbal requirement leaves room for a plausible misreading. Distinguish "the
operation does not mutate its input" from "later caller mutation cannot alter
retained service state." The v2 packet added such a witness without prescribing
an implementation. Its effect is exploratory, not established causal benefit.

Check that the test actually reaches the object or state it purports to mutate.
Mutating raw input before a validator's defensive copy is not the same test as
mutating the normalized command retained by a service. Replaying in a new service
instance does not verify the original instance's binding.

Concurrency tests must start operations before awaiting their combined results.
Unless the contract requires an ordering, accept either assignment of creation
and replay outcomes, and verify the final state. Sequential awaits do not test
overlap, even when the test name says they do.

## Separate acceptance signals

- Behavior: independently check the contract through the production path, including
  a complete feature sequence across task boundaries.
- Preservation: compare original tests and prior-task files, not only test counts.
- Verification: inspect raw observed command results. A successful capture-process
  exit can contain a model API error; a timeout can leave passing code without a
  completed handoff. Report each dimension accurately.
- Process: distinguish meaningful pre-implementation failures from setup errors,
  manual probes, and retrospective claims. Do not manufacture red evidence later.
- Evidence: inspect the diff and assertions before accepting "all covered" or
  "no findings." Keep the report short enough to finish within the task budget.

Runtime execution of TypeScript is not a type-check. Use the repository's normal
compiler check when available; otherwise disclose its absence and review types
explicitly. A test green light cannot establish compile-time correctness.

## Keep the workflow small

Continue with one feature contract, a few bounded task packets, ordinary coding
tools, and visible review decisions. The separate new-test-file convention
preserved earlier tests in the observed feature attempts, but was not isolated
as a causal treatment. Keep it a candidate procedure, not an enforcement claim.

Do not respond to every observed mistake by extending a universal instruction
file. First decide whether the missing information belongs in the feature,
the particular task, a concrete acceptance example, or the review itself. Changes
to experimental instructions need another recorded test; they are not promoted
merely because they sound sensible.

## Next useful evidence

The next feature should be held out from this inventory example and come from a
real repository selected with the operator. Have a strong model prepare artifacts
from the actual request and existing code, then have the operator review the
decisions before smaller-model implementation. Retain preparation revisions and
review effort as well as participant calls. This tests a missing part of the
product: whether preparation produces sufficient artifacts, not only whether
models can consume an already carefully prepared packet.

Use the same bounded review policy and independent acceptance/preservation
checks. Decide success criteria before execution. A matched alternative is
needed if the question becomes whether a particular skill improves outcomes;
another successful inventory run would not answer that question.
