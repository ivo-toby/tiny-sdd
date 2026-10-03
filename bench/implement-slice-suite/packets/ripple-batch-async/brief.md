Implement `runBatch(tasks, options)` in `src/batch.mjs`.

Run task functions with at most `options.concurrency` tasks active. Each task
settles independently into `{ status: 'fulfilled', value }` or
`{ status: 'rejected', reason }`, and output order matches input order. A task
that does not settle within `options.timeoutMs` is rejected with reason
`timeout`; later tasks still run. Validate positive integer concurrency and
timeout values.
