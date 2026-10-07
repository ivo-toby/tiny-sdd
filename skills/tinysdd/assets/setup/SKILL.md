---
name: tinysdd-setup
description: Guide TinySDD CLI onboarding, global skill loading, Pi worker preflight and a bounded readiness smoke.
---

# TinySDD setup

Use this skill before the TinySDD specification or worker workflow when the
CLI, global harness skills, target project, Pi runtime, provider/model route,
or authentication boundary is not already established. `tinysdd setup` is the
global onboarding command; this skill explains the checks and the later project
configuration. It is not a second controller, configuration format, provider
selector, or model qualification process.

In a fresh clone, the repository registers this setup skill and the product
skill as relative directory links in both native harness locations. Start the
session from this checkout and invoke `/tinysdd-setup` in Claude or
`$tinysdd-setup` in Codex; after setup, invoke `/tinysdd` or `$tinysdd`. If a
registration is unavailable, start a new session or restart the harness. These
links are scoped to this checkout and do not install skills into the target
project or a user/global skill directory. The product link preserves its
relative `assets/` and `references/`; use the setup/product skill links to load
the frontier router and selected phase. Codex may list nested skills reached
through the product link; use an explicit path when another harness does not
list one.

Keep setup facts in three separate groups:

- **Discovered:** executable paths, versions, platform capability, project
  configuration and the exact configured provider/model route.
- **Observed:** results from a user-authorized readiness smoke, including the
  selected sandbox, Pi version, worker outcome, candidate edit and declared
  `run_checks` result.
- **Unknown:** model quality, feature correctness, production suitability,
  operator acceptance and any server identity the provider does not attest.

Read [the setup workflow reference](references/setup-workflow.md) for the
commands and decision points. It is written for any harness. The TinySDD
product skill is [here](../../SKILL.md); the full preparation router is
[here](../harness/claude/tinysdd-frontier/SKILL.md), and the optional
[constitution skill](../constitution/SKILL.md). Load those files through
the harness's explicit skill mechanism when their workflows are needed.

## Setup boundaries

- Use a reviewed published package with `npm install --global tinysdd` and
  `tinysdd setup`, or an operator-authorized source checkout with
  `node bin/tinysdd.mjs setup`. The repository currently has no npm publication
  or version tag; setup reports that missing release instead of using an
  unpinned branch.
- Run global setup from any directory and do not pass `--project`; it does not
  inspect or change the current project. Use `init` separately for project
  configuration.
- Setup validates the matching versioned archive and installs the complete
  `skills/` plus sibling `docs/` resource tree under `~/.agents/tinysdd`, with
  relative Codex and Claude skill links. It preserves unrelated agent config
  and refuses conflicting managed paths.
- Load the exact setup, product, router and selected phase paths. Use the
  setup/product links to preserve each router's `references/` and `templates/`
  siblings, and use an explicit path when the harness does not list a nested
  phase entry.
- Inspect `specs/constitution.md` and `specs/constitution.approval.json` when
  preparing a project. Load the harness-independent constitution skill when
  the operator adopts those files; their presence alone does not change
  existing change or task authority.
- Reuse `init`, `config show`, `config validate` and the worker's existing Pi
  preflight. Preserve existing project and global configuration; do not invent
  a setup state file or silently replace a named worker.
- Keep the worker's provider and model exact. A Pi provider key, route alias,
  operator-reported backend and runtime-observed identity are different facts;
  do not substitute one when another is missing.
- Keep credentials out of chat, arguments, project files, source copies, logs
  and retained artifacts. Use only an operator-authorized environment
  reference. Do not read a keychain, Pi auth store or other credential store
  as part of this skill.
- Do not install prerequisites, read credential stores, start a service, or run
  live inference from setup. A readiness smoke is evidence about one configured
  path, not acceptance of a feature or a model.

## Procedure

1. Verify the CLI with `tinysdd --version`, or use
   `node .../bin/tinysdd.mjs --version` from a source checkout, then run
   `tinysdd setup` from any directory when global links are absent.
2. Load this skill explicitly. If preparing a feature, inspect the recommended
   constitution files and, when adopted by the operator, load the constitution
   skill before the product skill, frontier router and selected phase skill.
   Preserve each router's `references/` and `templates/` siblings.
3. Discover Node, the Pi executable in the same installation's `bin` directory,
   the required Linux or macOS sandbox, the Pi version target, and the
   non-secret project configuration. If Pi is absent, use the reference's
   operator-authorized repair for the pinned package in that exact Node root;
   never fall back to another executable, provider or model.
4. Run `init` only when the project needs `.tinysdd/`; then run `config validate`
   and `config show`. `init` preserves an existing config. Add an optional
   `featureIntegration` command only when the operator has chosen a real
   application entrypoint and protected test.
5. Confirm the exact Pi provider/model route and its credential environment
   reference without exposing the value. Let `worker start` perform its
   fail-before-detach preflight; it checks the configured Pi model and referenced
   environment values but cannot prove that a server will authenticate.
6. Run the offline fixture and preflight part of the bounded synthetic
   readiness smoke in a disposable project. With separate authorization for
   live inference, continue to the live stage, inspect the retained
   `runtime.json` and `result.json`, and report discovery and observations
   separately. Do not apply or accept the smoke candidate as part of setup.

If a required step is unavailable, leave the project unchanged and report the
exact observed failure, platform, route and next operator action. Do not retry
with a different provider/model or claim readiness from `pi --version` alone.
