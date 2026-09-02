# `@staffel/workflow`

The deterministic core and repository transaction layer of Staffel. The package
currently exposes configuration validation, workflow policy, packet/ledger
codecs, retry-safe dispatch/begin/handoff services, and Node filesystem/Git
adapters behind portable application ports.

The future `@staffel/cli` package will provide the `staffel` command. Tracker and
Codex integrations remain outside this extraction slice.
