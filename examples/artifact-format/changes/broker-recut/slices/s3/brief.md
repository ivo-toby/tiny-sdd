# Broker S3 backend

Implement an isolated in-memory backend. This synthetic reconstruction has no
historical approval or run evidence; those records are UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s3-backend","requirementIds":["broker-s3-backend"],"question":"Does the writable test establish backend isolation at the cited caller boundary?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s3-backend.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s3-backend","text":"S3 keeps the in-memory backend isolated per broker."}]
```
