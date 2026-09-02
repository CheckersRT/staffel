# Staffel

Staffel is a reusable, versioned agent-workflow engine. This repository will
publish the `@staffel/workflow` package (including the `staffel` command) and
the matching skills-only `@staffel/codex-plugin` Codex plugin.

The current extraction includes the deterministic core, repository transaction
layer, structured CLI, and tracker adapters:

- versioned `staffel.config.mjs` JSON Schema and runtime validation;
- stage lookup, begin-stage policy, transition classification, and transition
  validation;
- task-ID normalization;
- package-owned blank registry, task-packet, and live-ledger templates;
- a product-neutral reference configuration covering the complete version 1
  workflow graph.
- packet, task-registry, and live-ledger parsing/rendering;
- retry-safe dispatch, begin-stage, and handoff services;
- filesystem, process, clock, hashing, lock, Git, and stage-sync boundaries;
- Node filesystem/process/Git adapters exercised against temporary repositories.
- the non-interactive `staffel` CLI (also installed as `agent-workflow`) with
  stable JSON envelopes and categorized exit codes;
- explicit, retry-safe `init`, validation-only `migrate --from embedded-v1`,
  `status`, and installation-focused `doctor` commands;
- published command/input/output/error JSON Schemas and
  `capabilities --json` discovery;
- configuration-driven no-tracker and Trello adapters, tested with recorded
  HTTP contracts rather than a live board.

Nothing under `packages/workflow/src/core` imports Node.js or project-specific
infrastructure.

## CLI

All commands are non-interactive and write one JSON document to stdout. The
`--json` flag is accepted explicitly for compatibility with callers that
negotiate output formats. Unstructured diagnostics are reserved for stderr.
Stable exit categories are `0` success, `2` usage, `3` configuration, `4`
workflow state, `5` tracker, and `10` unexpected internal failure.

```sh
staffel capabilities --json
staffel init --repository /path/to/repository --json
staffel dispatch --task 42 --name "Example" --type Work \
  --stage ready --goal "Exercise the workflow" --json
staffel stage --task 42 --json
staffel handoff --task 42 --to cleanup-pending --json
staffel status --json
staffel doctor --json
staffel migrate --from embedded-v1 --json
```

`init` requires an existing Git repository, creates and commits the initial
configuration and registry, creates the configured shared ledger, and ignores
the ledger and lock when they live inside the repository. Re-running it is a
no-op only when the initialized state is exact and committed; it never
overwrites an existing non-blank registry or ledger.

Historical command spellings remain accepted: `agent:dispatch`, `agent:stage`,
`agent:handoff`, and `trello:agent`.

## Development

Requires Node.js 20.19 or newer.

```sh
npm ci
npm run check
```

`npm run check` lints and type-checks the repository, builds the package, runs
the pure-core tests, and verifies the npm tarball contents.

## Repository layout

```text
packages/workflow/    @staffel/workflow source and tests
fixtures/reference/   Product-neutral version 1 reference configuration
.changeset/           versioning metadata
.github/workflows/    CI and non-publishing release-candidate packaging
```

The full extraction sequence is preserved in
[`docs/plans/agent-workflow-package-plugin-extraction-plan.md`](docs/plans/agent-workflow-package-plugin-extraction-plan.md).
It retains the original pre-Staffel names as a historical source plan.

Publishing remains disabled until the skills-only `@staffel/codex-plugin` is
present. The workflow package and plugin will be released from the same commit.
