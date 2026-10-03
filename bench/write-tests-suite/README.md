# TinySDD write-tests challenge suite

This phase-1 suite measures whether a worker can write deterministic contract
tests from a specification and an explicit module interface. It contains five
independent challenges covering input validation, collection ordering, state
transitions, async settlement, and a subscription API edge.

Each challenge contains a correct protected source fixture and a protected
visible smoke test. The packet allows exactly one worker-written file,
`tests/contract.test.mjs`. The reference test candidate is retained under
`candidates/<challenge>/reference/`; the three source mutants per challenge are
under `candidates/<challenge>/wrong-*`. These candidates are audit material,
not packet resources and are never copied into a worker workspace.

`challenge-audit.json` maps every acceptance witness to the reference test and
to the mutant that must break it. A candidate passes the audit only when its
tests pass against the reference source and each wrong source produces a
substantive assertion failure in its named witness. Syntax errors, zero tests,
skips, timeouts, process failures, and unavailable checks do not count as
kills. The later runner adapter will report killed mutants over declared
mutants; this phase does not introduce qualification or acceptance thresholds.

The verifier manifests intentionally run the submitted test file with
`node --test` in an evaluator copy. The held-out source candidates stay outside
the fixture and packet trees. Live Pi, model, and production sandbox behavior
are outside this deterministic fixture audit.
