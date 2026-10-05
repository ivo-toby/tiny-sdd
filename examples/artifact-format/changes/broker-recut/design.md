# Broker recut design

The real caller is `examples/artifact-format/src/entrypoint.mjs`. Each slice
owns one implementation module and one writable slice test. The feature test
remains protected and enters through that caller. S5b depends on S5a; this
distinct-file graph is a proposed runnable recut rather than historical
evidence.
