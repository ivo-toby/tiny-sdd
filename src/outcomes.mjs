// Worker result outcomes. Only "completed" can feed a revision base; every
// other outcome is reported as a failed launch, with its evidence retained.
//
// raw_output_limit: TinySDD's cap on captured Pi event bytes was reached.
// response_token_limit: one model response stopped at its output-token cap
// (assistant stopReason "length"/"max_tokens").
// no_progress: no write/edit tool call before the configured firstWriteMs.
// stopped: the operator stopped the run (`worker stop`); evidence is finalized as usual.
export const WORKER_OUTCOMES = Object.freeze(['completed', 'failed', 'timeout', 'tool_limit', 'raw_output_limit', 'response_token_limit', 'no_progress', 'stopped']);
export const FAILED_WORKER_OUTCOMES = Object.freeze(WORKER_OUTCOMES.filter((outcome) => outcome !== 'completed'));

export function isFailedWorkerOutcome(outcome) {
  return FAILED_WORKER_OUTCOMES.includes(outcome);
}
