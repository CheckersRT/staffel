# `@staffel/workflow`

The deterministic workflow engine and non-interactive CLI for Staffel. The
package exposes configuration validation, workflow policy, packet/ledger
codecs, retry-safe dispatch/begin/handoff services, Node filesystem/Git
adapters, and configuration-driven tracker adapters behind portable
application ports.

The package installs both `staffel` and the temporary `agent-workflow` binary
alias. Every command emits a stable JSON envelope to stdout; command, input,
output, and error schemas are exported from `@staffel/workflow/schemas/*`.
Exit codes distinguish usage (`2`), configuration (`3`), workflow state (`4`),
tracker (`5`), and unexpected internal (`10`) failures.

```sh
staffel capabilities --json
staffel init --repository . --json
staffel dispatch --task 1 --name "First task" --type Work \
  --stage ready --goal "Start the workflow" --json
```

The full command surface is `init`, `dispatch`, `stage`, `handoff`, `tracker`,
`status`, `doctor`, `capabilities`, and the deliberately narrow
`migrate --from embedded-v1` validator. All mutating workflow commands support
`--dry-run`.

Trello configuration keeps credentials indirect and repository-owned:

```js
tracker: {
  provider: "trello",
  boardIdEnvironmentVariable: "STAFFEL_TRELLO_BOARD_ID",
  apiKeyEnvironmentVariable: "STAFFEL_TRELLO_API_KEY",
  tokenEnvironmentVariable: "STAFFEL_TRELLO_TOKEN",
  listIds: { Ready: "trello-list-id", Active: "another-list-id" },
  taskTypeLabelIds: { Work: "trello-label-id" },
}
```

Use `{ provider: "none" }` for fully local operation. Codex integration remains
outside this extraction slice.
