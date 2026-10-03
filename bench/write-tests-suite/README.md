# TinySDD write-tests challenge suite

This phase-2 suite measures whether a worker can write deterministic contract
tests from a specification and an explicit module interface. It contains five
independent challenges covering input validation, collection ordering, state
transitions, async settlement, and a subscription API edge.

Each challenge contains a correct protected source fixture and a protected
visible smoke test. The packet allows exactly one worker-written file,
`tests/contract.test.mjs`. The reference test candidate is retained under
`candidates/<challenge>/reference/`; the declared wrong sources are under
`candidates/<challenge>/wrong-*`. The audit declares 20 wrong sources in total;
these candidates are audit material, not packet resources and are never copied
into a worker workspace.

`challenge-audit.json` maps every acceptance witness to the reference test and
to the mutant that must break it. A candidate passes the audit only when its
tests pass against the reference source and each wrong source produces a
substantive assertion failure in its named witness. Syntax errors, zero tests,
skips, timeouts, process failures, and unavailable checks do not count as
kills. The later runner adapter will report killed mutants over declared
mutants; this phase does not introduce qualification or acceptance thresholds.

The visible verifier runs the submitted test bytes against the reference source.
Each held-out check overlays one declared mutant and runs those same unchanged
test bytes in a separate evaluator copy. The canonical verifier requires TAP
with at least one test, no skips, todos, cancellations, setup/import failures or
timeouts, and a substantive failure of the mapped named witness; extra tests and
additional failed witnesses are allowed. A `passed` held-out verifier record
therefore means that the check confirmed a killed mutant. The measurement is
`referencePass` plus `killedMutants / declaredMutants`, derived from stable check
IDs and statuses; it is not a qualification or acceptance decision.

Production evaluation invokes these verifier commands through the existing
check-runner sandbox. The focused runner test uses only the explicit
`runtime.test` verifier injection and a real bounded Node evaluator callback;
live Pi, model, bubblewrap, and production check-runner behavior remain
unverified.
