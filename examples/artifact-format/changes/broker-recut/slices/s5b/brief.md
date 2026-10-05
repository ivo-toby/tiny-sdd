# Broker S5b asynchronous lifecycle

Implement the asynchronous lifecycle edge after S5a. This synthetic
reconstruction has no historical approval or run evidence; those records are
UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s5b-async","requirementIds":["broker-s5b-async"],"question":"Does the writable test establish the asynchronous lifecycle edge at the cited caller boundary?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s5b-async.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s5b-async","text":"S5b covers the asynchronous lifecycle edge."}]
```
