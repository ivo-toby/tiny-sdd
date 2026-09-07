# TinySDD controller and worker direction

Date: 2026-09-05. Status: user-agreed product direction. The bounded v0 CLI is
implemented; interfaces beyond that v0 boundary remain proposals, and the
configuration schema may evolve. See [the quickstart](quickstart.md) for current
usage.

## One CLI, two uses

TinySDD remains a spec-driven workflow usable through skills inside an ordinary
coding harness. A human can operate that flow with the current coding agent.
It also provides a callable worker for an orchestrating agent that delegates
bounded implementation to a smaller, potentially self-hosted model.

Use one CLI with separate controller and worker command families, backed by
shared artifact contracts. The controller owns workflow state and progression;
an executing worker returns changes, evidence and questions. There is one
authoritative controller per run. Delegating implementation does not delegate
permission to redefine requirements, enlarge budgets or accept the feature.

The current harness may implement a task itself, or the controller may dispatch
a TinySDD worker. Human and agent operation use the same task/result contracts.
An orchestrating agent can make decisions within authority delegated by its
user; it cannot manufacture approval for new product meaning or external effects.

The caller-facing interface should be harness-agnostic. Pi is the first worker
runtime adapter; this does not require a new coding tool loop or several runtime
implementations. Runtime/provider dependencies should stay separable from the
controller. WDD remains a conceptual comparison only: no WDD workflow, command,
skill, state or dependency is introduced.

## Project configuration and named workers

Initial v0 layout:

```text
.tinysdd/
  config.json        # versioned project defaults
  config.local.json  # optional gitignored machine overrides
  runs/              # gitignored execution state/evidence
```

The configuration has a schema version, a default worker name and a map of named
workers. Each worker selects a runtime adapter, exact provider/model, model
profile, skills, instruction resources and execution limits. Different named
workers may use the same runtime with different models or use future adapters.
Selecting an unsupported adapter or model fails clearly; no implicit fallback.

The project selects a reusable model profile, not a private copy of a complete
model database. Relative project paths should remain portable. Authentication
stays in the runtime credential store/environment, never in either config file.

The v0 resolver applies project defaults, then local overrides, then explicit
invocation options. Named workers are replaced whole by local overrides; arrays
replace, and null or unknown fields are errors. Future schema changes should
keep these conflict rules explicit. Retain validated effective values and their
sources for each run, with secrets redacted.

The v0 `tinysdd init` supports non-interactive arguments with structured output
for an agent. It preserves existing files, adds appropriate ignore rules, and
never implicitly installs packages, downloads profiles, calls models or modifies
global configuration. Configuration inspection explains resolved values and
provenance. Interactive creation remains a possible future convenience.

Worker model selection does not change the model already running in the outer
harness. Controller-only usage works with that harness's current model/tools.

## Worker context and output

Keep model connection/settings, TinySDD worker instructions, applicable repository
instructions, selected skills and model-profile guidance distinct. The approved
specification/task packet defines the work. Select relevant skills explicitly;
do not silently inherit the host's entire global skill/extension catalog.
Respect applicable repository instructions rather than replacing AGENTS.md with
a model profile. Detect consequential conflicts before execution or escalate.

Retain Pi's basic tool-use instructions by default and add a concise worker
contract. Extra steering must not expand permissions or weaken verification.
For a task that needs precise repository facts, use TinySDD's explicit
[context compiler](context-compiler.md): a reviewable manifest binds concise
facts and exact source/test line ranges to approval, then produces a bounded,
digested reference packet. It must fail on missing, stale or oversized context;
it does not guess relevant files or use a hidden model summary.
Record supplied instruction/skill versions and actual loading where observable.
Instructions are not a sandbox or hard enforcement of write scope.

The runtime should produce a validated result envelope containing execution
outcome, change artifact, observed checks/evidence, and separately labeled model
claims/questions. A model completion, a process exit, passing checks and operator
acceptance are different events. Do not convert a claimed success into observed
verification. Preserve human-readable progress alongside machine-readable output.

MCP integration and arbitrary runtime extensions are deferred. A selected skill
requiring unavailable capabilities must report that mismatch; it does not
authorize installing or enabling them.

## Evidence-backed model profiles

A profile distinguishes guidance for the orchestrator, concise worker instructions
and runtime settings. Scope observations to exact model/version/quantization,
runtime/tool settings and tested task classes. Retain supporting runs, confidence,
limitations and profile version. Unknown is preferable to an invented model trait.

An observed failure is not proof that an extra instruction helps. Compare a
candidate profile change with the unchanged workflow, then test held-out tasks.
General acceptance examples belong in task preparation if they help multiple
models; do not automatically label them model-specific quirks. Benchmark profile
development and profile evaluation on separate tasks.

Separate fixed-artifact worker evaluation from full preparation-to-acceptance
workflow evaluation. Record strong-model preparation/review and failed attempts
in total effort/cost. Normalized interfaces and better consistency are goals;
prompts cannot guarantee interchangeable model capability or correct code.

## Immediate sequencing

The operator-approved podcast async-generation checkpoint was prepared and
executed using the existing experimental Pi path before the v0 CLI was
available. The CLI, config schema and profile registry were intentionally not
prerequisites for that run. Existing experiments and their frozen protocols
retain their historical meaning; the v0 implementation is available for later
controlled runs.
