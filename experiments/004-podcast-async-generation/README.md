# Experiment 004: asynchronous podcast generation

Status: approved for controlled execution, 2026-09-05. Independent-check
preflight is being prepared; participant invocations are recorded per run.
Original baseline: typecheck and build passed; all 181 tests passed in one
direct primary-agent run with private filesystem/network namespaces. Earlier
delegated-context permission failures are retained in the evidence.

Question: can strong-model preparation and review enable Qwen to implement a
small, connected feature correctly in an existing repository using TinySDD?
This tests delivery quality, not reduced operator involvement or a model ranking.

The target is `/home/ivo/workspace/mcp-podcast-generator`. Its existing feature
specification covers generation **and** publishing. This first checkpoint covers
only asynchronous generation and polling, through the real MCP/HTTP stack with
fake execution dependencies. It is an intermediate, non-release patch, not
completion of the supplied specification.

## Review packet

- [Checkpoint contract](feature.md): behavior, interfaces, acceptance criteria,
  exclusions and proposed decisions.
- Tasks: [job manager](tasks/01-job-manager.md),
  [server extraction](tasks/02-server-factories.md),
  [async tools](tasks/03-async-tools.md),
  [HTTP integration](tasks/04-http-integration.md).
- [Verification and run protocol](protocol.md): independent checks, isolation,
  evidence, budgets and actual operator gates.
- [Baseline inventory](baseline-inventory.md): source identity and test hazards.
- [Baseline results](baseline-results.md): observed checks and isolation limits.
- [Preparation review](preparation-review.md): corrections and remaining gates.

The preparation and task skills from experiment 003 are reused unchanged,
explicitly supplied rather than globally installed. The agreed future
[controller/worker CLI](../../docs/controller-worker-design.md) is not a
prerequisite for this experiment.

## Approval and execution state

The user subsequently [delegated execution and judgement](approval.md) to the
primary agent. The primary approved this contract and task boundaries within that
delegation. No approval is simulated; subsequent primary review is not labeled
as personal human inspection. Preparation made no target implementation edits,
production invocations, deployments or patch applications to the user's repository.

Before dispatch: complete safe baseline verification, review this packet, build
and preflight the independent acceptance checks, freeze the exact inputs, and
record the delegation with task 01. Subsequent handoffs return to the primary
for review and a recorded decision under this explicit delegation.
