# Reference fixture

`staffel.config.mjs` is a product-neutral example of a complete Staffel
configuration. Tests use it to exercise the versioned schema and state machine.

The reference repository uses `.staffel/` for workflow artifacts and has no
external tracker. Its executable graph ends at `cleanup-pending`; transition to
`closed` remains host-owned.
