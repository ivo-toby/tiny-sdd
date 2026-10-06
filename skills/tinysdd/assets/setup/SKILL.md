---
name: tinysdd-setup
description: Guide setup of TinySDD in an existing project, from a source checkout and explicit skill loading through Pi worker preflight and a bounded readiness smoke.
---

# TinySDD setup

Use this skill before the TinySDD specification or worker workflow when the
target project, CLI checkout, harness skills, Pi runtime, provider/model route,
or authentication boundary is not already established. It is a setup guide,
not a second controller, configuration format, provider selector, or model
qualification process.

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
[here](../harness/claude/tinysdd-frontier/SKILL.md). Load those files through
the harness's explicit skill mechanism when their workflows are needed.

## Setup boundaries

- Use an existing TinySDD checkout or an operator-authorized source checkout.
  The package is private and has no supported registry or `npx` installation
  route. Run the dependency-free CLI with Node from `bin/tinysdd.mjs`.
- Load the exact setup, product, router and selected phase paths. A nested
  `SKILL.md` is an ordinary file; copying or registering its parent does not
  make every nested phase available automatically.
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
- Do not install packages, start a service, or run live inference until the
  operator authorizes that action. A readiness smoke is evidence about one
  configured path, not acceptance of a feature or a model.

## Procedure

1. Establish `TINYSDD_CHECKOUT` and `TARGET_PROJECT`, then verify the source
   CLI with `node .../bin/tinysdd.mjs --version`.
2. Load this skill explicitly. If preparing a feature, load the product skill,
   then the frontier router, then only the selected phase skill. Preserve the
   router's `references/` and `templates/` siblings.
3. Discover Node, the Pi executable in the same installation's `bin` directory,
   the required Linux or macOS sandbox, the Pi version target, and the
   non-secret project configuration. Stop with the precise missing prerequisite
   and the supported repair; never fall back to another executable, provider or
   model.
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
