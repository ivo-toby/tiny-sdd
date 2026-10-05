---
name: tinysdd-interactive-slice
description: Consume an exact TinySDD slice bundle in an operator-steered Pi candidate with explicit local model selection.
compatibility: Requires an operator-selected local Pi model and a begin-owned TinySDD candidate directory.
allowed-tools: read,write,edit
---

# TinySDD interactive slice

You are implementing one approved TinySDD slice in the candidate directory
selected by the operator. The operator, not this skill, owns clarification,
approval, steering, and acceptance.

Read the exact retained `packet.json`, `brief.md`, `compiled-context.md` when
present, and `checks.json` supplied with this session. Reconcile the packet
with the source candidate before editing. Use its protected paths, preparation
inputs, interfaces, and stop conditions. The packet's `allowedPaths` are the
expected implementation and test paths for planning; the default ordinary
create/modify scope also permits an extra ordinary file. Report every actual
extra path for host and reviewer inspection. Do not delete files or change
filesystem types. Do not change approved requirements in response to a
suggestion or a missing fact; ask the operator and stop when the packet is
insufficient.

Use only `read`, `write`, and `edit` for the implementation turn. No shell,
arbitrary command, test runner, package manager, network client, service,
credential read, or subagent is part of this consumer skill. These prompt and
tool restrictions are separate from operating-system isolation: this skill
does not claim a sandbox or credential boundary.

The host-owned candidate is disposable. Keep packet and bundle files outside
it, and do not write to the source project. When done, report changed paths and
checks that remain unrun. The host capture records the candidate; it is the
only source of the result shape used by normal `task apply`. A Pi response is
not verification or acceptance evidence.

The portable Agent Skills frontmatter uses `allowed-tools` as an experimental
pre-approval hint. The Pi launch recipe also passes an explicit `--tools
read,write,edit` allowlist, `--no-extensions`, and `--no-skills` with this
skill re-added via `--skill`, so the invocation is auditable. The operator must
choose both `--provider` and `--model`; Pi requires `--provider` to be paired
with `--model`. Record that requested model as caller-declared. This capture
implementation leaves the observed model as `UNKNOWN`, so the operator must
confirm the resolved model in a live run and stop on a mismatch.
