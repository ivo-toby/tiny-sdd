# Targeted packet revision: caller-owned state

Status: applied after completing both v1 attempts; one v2 Qwen run and one Gemma
transfer completed. This document retains the pre-call hypothesis; outcomes and
qualifications are in the [results report](results-2026-09-05.md).

## Observation

Both Qwen service submissions retained the caller's command lines in the
successful binding. Both passed their own suites and failed the independently
prepared defensive-copy check. Attempt 1's test expected the wrong result after
mutation. Attempt 2 checked that reserve did not mutate its argument, but did
not check that later caller mutation could not corrupt future replay.

The feature and task already require defensive copies. The missing distinction
is not another architectural decision: "do not mutate inputs" and "own a stable
copy of retained inputs" are different properties. The first planned review
resolved this distinction without supplying implementation code.

## Hypothesis and only participant-visible change

Add one concrete acceptance witness to task 02. Leave the feature contract,
interfaces, other task packets, skills, seed, independent checks, model settings
and review budgets unchanged. The witness specifies an input mutation followed
by two different requests and expected outcomes, not an implementation recipe.

Proposed addition:

> Caller-ownership acceptance witness: start a fresh service with {pen:5}.
> Pass a normalized command r1 with [pen:2] directly to reserve; expect creation
> and stock {pen:3}. Afterwards change the caller's line quantity to 1. Submitting
> that changed command must conflict; submitting a fresh r1 with the original
> [pen:2] must replay the original success, with current stock still {pen:3}.
> Repeat from a fresh service after mutating the caller's lines array instead of
> a line object. This is separate from checking that reserve itself does not
> mutate its input.

The primary applied/versioned this only after the second v1 attempt finished.
Old inputs and outcomes remain preserved in their run snapshots. Record the
protocol version and exact hash changes before making a new participant call.

## Bounded next test

One fresh Qwen feature attempt with this packet addition, following the same
three tasks, review policy and finite acceptance checks. The discriminating
observation is whether the initial service submission now preserves request
identity after caller mutation and whether its own test checks that behavior.
Final reviewed feature success remains the product outcome.

This is an exploratory, outcome-informed candidate, not a causal estimate from
randomized matched arms. One successful corrected-packet attempt cannot prove
reliability or transfer. If the defect recurs, retain it and diagnose rather
than resampling. If useful and time permits, a separately labeled Gemma transfer
attempt can test this candidate; no Nemotron/proxy work is added.
