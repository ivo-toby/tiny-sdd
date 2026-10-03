Fix `dequeueReady(queue)` in `src/job-queue.mjs`.

Remove and return the first job whose state is exactly `ready`. If no such job
exists, return `null` and leave the queue unchanged. Keep queue order for all
remaining jobs and mutate only the queue as the existing API expects.
