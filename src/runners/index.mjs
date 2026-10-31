import { piRunner } from "./pi.mjs";
import { openCodeRunner } from "./opencode.mjs";
import { WORKER_TYPES } from "./types.mjs";

const RUNNERS = Object.freeze({ pi: piRunner, opencode: openCodeRunner });

export { WORKER_TYPES };

/** The runner for a configured `worker.type`, or null when none is registered. */
export function workerRunner(type) {
  return typeof type === "string" && Object.hasOwn(RUNNERS, type) ? RUNNERS[type] : null;
}

export function registeredRunners() {
  return Object.values(RUNNERS);
}
