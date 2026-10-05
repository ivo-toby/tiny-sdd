# Broker S2 paths

Implement safe broker path validation. This synthetic reconstruction has no
historical approval or run evidence; those records are UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s2-paths","requirementIds":["broker-s2-paths"],"question":"Does the writable test establish safe path rejection at the cited caller boundary?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s2-paths.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s2-paths","text":"S2 rejects unsafe paths before backend access."}]
```
