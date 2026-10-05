# Broker S5a sequential lifecycle

Implement the sequential lifecycle core. This synthetic reconstruction has no
historical approval or run evidence; those records are UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s5a-core","requirementIds":["broker-s5a-core"],"question":"Does the writable test establish the sequential lifecycle through the cited real caller?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s5a-core.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s5a-core","text":"S5a runs the sequential lifecycle through the real caller."}]
```
