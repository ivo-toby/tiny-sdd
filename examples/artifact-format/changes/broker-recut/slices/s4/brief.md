# Broker S4 allowlist

Implement allowlist enforcement at the broker boundary. This synthetic
reconstruction has no historical approval or run evidence; those records are
UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s4-allowlist","requirementIds":["broker-s4-allowlist"],"question":"Does the writable test establish allowlist enforcement at the cited caller boundary?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s4-allowlist.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s4-allowlist","text":"S4 applies the declared allowlist at the broker boundary."}]
```
