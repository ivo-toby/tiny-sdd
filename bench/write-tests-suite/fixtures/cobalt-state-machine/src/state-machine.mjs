const STATES = new Set(['idle', 'running', 'succeeded', 'failed']);
const EVENTS = new Set(['start', 'succeed', 'fail']);

export function transition(state, event) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state must be an object');
  }
  if (!STATES.has(state.status) || !Number.isInteger(state.attempts) || state.attempts < 0) {
    throw new TypeError('state has an invalid shape');
  }
  if (!EVENTS.has(event)) throw new RangeError(`unknown event: ${event}`);

  const next = { ...state };
  if (state.status === 'idle' && event === 'start') {
    next.status = 'running';
    next.attempts += 1;
  } else if (state.status === 'running' && event === 'succeed') {
    next.status = 'succeeded';
  } else if (state.status === 'running' && event === 'fail') {
    next.status = 'failed';
  } else {
    throw new RangeError(`event ${event} is invalid for ${state.status}`);
  }
  return next;
}
