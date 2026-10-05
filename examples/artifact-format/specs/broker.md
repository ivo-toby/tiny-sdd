# Broker lifecycle specification

S1 reports invalid leases deterministically.
S2 rejects unsafe paths before backend access.
S3 keeps the in-memory backend isolated per broker.
S4 applies the declared allowlist at the broker boundary.
S5a runs the sequential lifecycle through the real caller.
S5b covers the asynchronous lifecycle edge.
