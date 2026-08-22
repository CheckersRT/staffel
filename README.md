# Staffel

Staffel is a reusable, versioned agent-workflow engine. This repository will
publish the `@staffel/workflow` package, the `@staffel/cli` package (providing
the `staffel` command), and the matching skills-only `@staffel/codex-plugin`
Codex plugin.

The current extraction slice contains the deterministic core only:

- versioned `staffel.config.mjs` JSON Schema and runtime validation;
- stage lookup, begin-stage policy, transition classification, and transition
  validation;
- task-ID normalization;
- package-owned blank registry, task-packet, and live-ledger templates;
- a product-neutral reference configuration covering the complete version 1
  workflow graph.

Filesystem, Git, tracker, CLI, and host integrations belong in later adapter
and application layers. Nothing under `packages/workflow/src/core` imports
Node.js or project-specific infrastructure.

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

Publishing remains disabled until `@staffel/cli` and
`@staffel/codex-plugin` are present. All three packages will start at the same
exact prerelease and be built from the same commit.
