# Broker S1 errors

Implement the error constructor for invalid leases. This is a reconstruction
fixture and its historical approval/run evidence is UNKNOWN.

## Slice test review contract

```json
{"schemaVersion":1,"workflow":"slice-tests","criteria":[{"id":"s1-errors","requirementIds":["broker-s1-errors"],"question":"Does the writable test establish the invalid lease error contract at the cited caller boundary?","interfaces":["examples/artifact-format/src/entrypoint.mjs"],"testPaths":["examples/artifact-format/tests/s1-errors.test.mjs"]}]}
```

## Approved slice requirements

```json
[{"spec":"examples/artifact-format/specs/broker.md","baseSha256":"991675b6ffaafd1d5bba8929512f899217cc222da7973d3b5934862a625e9a23","operation":"modify","id":"broker-s1-errors","text":"S1 reports invalid leases deterministically."}]
```
