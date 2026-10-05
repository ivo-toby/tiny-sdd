# Proposal: <change name>

Status: draft

## Outcome

State the observable behavior this change should add or change. Include the
successful result, rejection behavior, preserved state and the explicit
out-of-scope boundary.

## Clarifications

- Q1: <question whose answer changes behavior>
  - Answer: <operator answer, or UNKNOWN>
  - Decision: <resolved choice, or pending>

## Source facts

- <path:line or symbol>: <directly observed fact>.
- <path:line or symbol>: <existing check or caller that constrains the change>.

## Proposed decisions

- D1: <decision made for this change and why it is needed>.

## Unknowns and stop conditions

- UNKNOWN: <missing fact or external behavior>.
- Stop if <contradiction, missing authority or changed product meaning>.

## Requirements

Use stable slug IDs because delta and integration descriptors reference them.

- R-<id>: <observable requirement with success and rejection behavior>.
- R-<id>: <preserved state or compatibility requirement>.

## Acceptance criteria

- C1: Given <state>, when <action>, then <observable result>; <preserved state>.
- C2: <negative or integration criterion that must be checked independently>.

## Approval and evidence

Approval: pending operator review.

Evidence: <source paths and commands actually observed; otherwise UNKNOWN>.
