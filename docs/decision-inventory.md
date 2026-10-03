# Frontier decision inventory

This inventory covers the five decision points listed in the design doc. The
costs below are estimates from the talon evidence in `worker-runtime-next.md`
sections 2.5–2.6, not token-metered measurements. The runs record model time,
tool calls and review rounds, but not a separate frontier-token total for each
decision.

## Failure triage after checks

This happens after a worker check or controller check fails, before deciding
whether to retry the worker, report an environment problem, or request missing
context. Today the frontier reviewer pays: S2, S3 and S5a each needed a full
review round even though the TDZ, `require-await` and TypeScript `.val` defects
were visible in the raw logs. The question shape is a choice: fixable from the
log, environment, missing context, or unknown.

The deterministic baseline is ordered error-pattern matching over the check
log: environment errors first, then missing-module context errors, then TDZ,
TypeScript, ESLint and assertion diagnostics. It returns the matched rule and
up to three bounded evidence lines. Estimated frontier cost: three review
rounds across S2, S3 and S5a, one per log-explainable defect. The exact token
cost is not recorded; this estimate is an upper-level talon count, not a model
pricing measurement.

## Research relevance of candidate files and symbols

This happens while preparing the packet, when deciding which repository files
and symbols the implementation model needs. The frontier preparation model
pays today through repository exploration. The question shape is a score per
candidate chunk. The deterministic baseline is grep plus a symbol graph: retain
direct matches and their relevant imports, exports and callers, then rank by
structural proximity.

The talon runs do not isolate this decision from ordinary worker reads. They
show 5–9 reads before the first write for the failed single-task attempts and
zero reads for S1, whose packet supplied four cited ranges. Estimated frontier
cost: not separately measurable from these runs; those read counts are context
signals, not a token estimate for research relevance.

## Review triage

This happens after the worker result, controller checks and patch are available,
before paying for a frontier review. The frontier reviewer pays today because
every delivered slice is reviewed. The question shape is noul: does this
candidate need frontier review? The deterministic baseline skips review only
when the worker completed, scope is clean, at least one controller check passed,
and the patch adds or removes no line whose content begins with `export `.
The controller checks must be non-empty and all passing.

The talon table shows five delivered slices through S5a, each with a review
decision, plus the failed initial S5 attempt that caused a behavior split.
Estimated frontier cost: at least five slice-level review decisions for the
delivered candidates, with one additional failed candidate in the routing path;
the token cost per review is not recorded.

## Spec coverage

This happens during strong-model preparation and frontier review, when checking
that each requirement has a criterion and each criterion has a check. The
frontier preparation or review model pays today. The question shape is noul per
requirement. The deterministic baseline is ID traceability: every requirement
ID must appear in a criterion, and every criterion ID must map to a check.

The talon evidence does not provide a separate coverage decision or token
counter. It does show the preparation scale that coverage must inspect: the
single task used 12 facts and about 650 cited test lines, while S1 used four
facts and four cited ranges. Estimated frontier cost: not separately measured;
these are the available context-size proxies, not a token-metered coverage
cost.

## Slice routing

This happens when deciding whether a packet should be split by behavior or sent
to a stronger model after a timeout or systematic defect. The frontier planner
pays today through re-cutting and respecifying the task. The question shape is
a choice: keep the slice, split it, or escalate the model. The deterministic
baseline is sizing and test-characteristic lint, including allowed-file count,
cited context size, test count, async/concurrency markers and other indicators
of a behavior-dense slice.

The talon evidence records two routing decisions: the failed single task was
re-cut into S1–S5, and the behavior-dense S5 timeout was split into sequential
S5a and async S5b. Estimated frontier cost: two re-cut decisions, with no
separate token total recorded. This is an estimate of observed routing events,
not a claim about the cost of every preparation pass.
