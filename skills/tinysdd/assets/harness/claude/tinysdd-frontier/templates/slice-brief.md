# Slice brief: <slice ID>

Status: draft

## Outcome and boundaries

Implement <coherent behavior> for requirements <requirement IDs>. Preserve
<existing behavior>. The worker may create or modify ordinary project files
needed by the implementation; the listed paths are expected outputs for sizing,
not a hard writable ceiling. Deletions, filesystem type changes, protected
feature tests, preparation inputs and task inputs remain out of scope.

## Sources and interfaces

- <interface path:lines>: <contract supplied by the compiled context>.
- <requirement ID>: <approved behavior from the feature delta>.

## Acceptance and checks

| Situation | Expected result and preserved state | Requirement | Exact check |
| --- | --- | --- | --- |
| <success> | <observable result> | <requirement ID> | <slice check ID> |
| <rejection> | <error/result and no unintended mutation> | <requirement ID> | <slice check ID> |

## Stop conditions

- Stop and ask if a cited interface contradicts the approved requirement.
- Stop if a required fact is UNKNOWN or a change would alter protected tests,
  preparation inputs, task inputs or the feature contract.
- Report every actual ordinary extra path for review.

## Slice test review contract

The JSON block must exactly match slice.json.testReview.

```json
{
  "schemaVersion": 1,
  "workflow": "slice-tests",
  "criteria": [
    {
      "id": "slice-test-criterion",
      "requirementIds": ["<requirement-id>"],
      "question": "Does the writable slice test establish the requirement at the cited interface without encoding an unapproved implementation?",
      "interfaces": ["<interface path>"],
      "testPaths": ["<slice test path>"]
    }
  ]
}
```

## Approved slice requirements

The JSON array must exactly match the requirement records referenced by
slice.json.testReview. Copy the matching entries from the delta descriptor.

```json
[
  {
    "spec": "specs/<area>.md",
    "baseSha256": null,
    "operation": "add",
    "id": "<requirement-id>",
    "text": "<approved requirement text>"
  }
]
```

Approval: pending normal task approval.

Evidence: <commands actually run and observed results, or UNKNOWN>.
