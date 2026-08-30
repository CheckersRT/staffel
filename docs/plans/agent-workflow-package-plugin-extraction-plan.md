# Agent Workflow Package And Plugin Extraction Plan

Status: proposed
Created: 2026-08-20
Target branch: `v1.2.5`

## Reviewed Decisions

- Publish the workflow package and skills-only plugin as matching exact
  prereleases built from the same commit, beginning with `0.1.0-alpha.1`.
- Treat the structured CLI as the primary human, CI, and agent-facing machine
  interface.
- Keep the extraction plugin skills-only. It teaches Codex when and how to call
  the CLI but adds no MCP server or custom UI.
- Defer MCP until a later feature needs host-native tool discovery, per-tool
  approval, a no-shell client, or a one-click action interface.
- Make `init` the permanent onboarding path for new repositories. Handle
  Liaura's existing records with one narrowly scoped `embedded-v1` migration;
  do not build a generic importer for arbitrary task or ledger systems.

## Goal

Move Liaura's embedded agent workflow into a reusable, versioned package and
Codex plugin. Liaura should become the first consuming repository: it owns only
project configuration, project-specific instructions, credentials, and workflow
data; the external package and plugin own the reusable implementation and role
experience.

Complete the split without changing workflow behavior. Develop new workflow
features only after Liaura has cut over and the embedded implementation has been
removed.

## Outcome

The completed split should have this dependency shape:

```text
Liaura repository
|- workflow.config.mjs
|- package.json -> exact @liaura/agent-workflow prerelease
|- .agents/plugins/marketplace.json -> exact @liaura/agent-workflow-plugin prerelease
|- AGENTS.md -> Liaura-specific bootstrap and safety rules
|- docs/tasks, docs/handoffs, live ledger -> workflow data
`- docs/agents defaults/runbooks -> Liaura-specific domain guidance

agent-workflow repository
|- packages/workflow
|  |- core state machine
|  |- filesystem and Git adapters
|  |- tracker adapters
|  `- structured CLI
`- plugin
   |- .codex-plugin/plugin.json
   `- role skills
```

Use one external repository for the package and plugin initially. This keeps
their versions compatible and makes a single release the tested workflow unit.
Split them later only if their release cadences genuinely diverge.

## Ownership Boundaries

### Package owns

- Stage definitions, transition classification, and transition validation.
- Dispatch, begin-stage, handoff, reservation, retry, and reconciliation logic.
- Task-packet and ledger parsing/rendering.
- Filesystem, Git, tracker, and context-health adapter interfaces.
- CLI commands, machine-readable capability discovery, JSON schemas, stable
  structured output, and stable error codes.
- Config schema, blank registry/packet/ledger templates, explicit repository
  initialization, compatibility checks, and migrations between package-owned
  format versions.

### Plugin owns

- Reusable role skills and activation descriptions.
- Workflow-specific prompts and next-stage interaction guidance.
- Guidance for invoking and interpreting the package CLI.
- Host-specific behavior such as asking Codex to apply an emitted task title.

The plugin must not duplicate state-machine or mutation logic. Its skills call
the package CLI, which remains the single executable contract.

### Liaura owns

- Repository paths, timezone, branch prefix, task types, and enabled stages.
- Tracker selection, board identity, and credentials.
- Task packets, handoffs, registry entries, and live coordination state.
- Supabase, simulator, Figma, release, deployment, and application-specific
  runbooks.
- Project safety rules and direct CLI usage when the plugin is unavailable.

## Migration Principles

1. Parity before redesign.
2. One executable implementation after cutover.
3. Package and plugin releases are pinned exactly during migration.
4. The structured CLI is the primary machine interface and remains fully
   functional without Codex or the plugin.
5. All mutations remain idempotent and gate-checked.
6. Historical task packets remain readable without bulk rewrites.
7. Each PR is independently releasable or revertible.
8. No stage titles, action cards, context rotation, or new tracker adapters are
   implemented until the split acceptance gate passes.
9. Package installation never silently creates workflow state. `init` is an
   explicit repository mutation; Liaura's legacy migration is extraction-only.

## Initial External Repository Shape

```text
agent-workflow/
|- packages/
|  `- workflow/
|     |- src/core/
|     |- src/application/
|     |- src/adapters/
|     |- src/cli/
|     `- test/
|- plugin/
|  |- .codex-plugin/plugin.json
|  |- skills/
|  `- assets/
|- fixtures/
|  `- liaura/
|- package.json
`- README.md
```

Initial executable surface:

```text
agent-workflow init
agent-workflow dispatch
agent-workflow stage
agent-workflow handoff
agent-workflow tracker
agent-workflow status
agent-workflow doctor
agent-workflow capabilities
```

Temporary Liaura cutover surface:

```text
agent-workflow migrate --from embedded-v1
```

Preserve Liaura's existing npm command names as aliases during cutover:

```text
npm run agent:dispatch
npm run agent:stage
npm run agent:handoff
npm run trello:agent
```

## Version And Distribution Strategy

### Migration period

- Start the external package and plugin at the matching prerelease
  `0.1.0-alpha.1`.
- Publish both npm artifacts from the same tested commit.
- Pin Liaura's package dependency to the exact workflow prerelease.
- Point Liaura's repo marketplace at the exact matching npm plugin prerelease.
- Never use a moving branch or permissive version range during cutover.
- Record the expected package and plugin versions in `workflow.config.mjs` so
  `doctor` can report skew.

### After cutover

- Promote the package and plugin together to matching stable versions from the
  same release commit.
- Keep compatible exact versions initially.
- Add an automated compatibility matrix before allowing independent releases.
- Keep the repo marketplace as the Liaura installation surface even if the
  plugin later becomes workspace or publicly published.

OpenAI's plugin format permits a skills-only plugin; MCP servers, hooks, and UI
are optional. Repo marketplaces can reference npm plugin sources and pin an
exact version. Installed plugin skills become available in new Codex tasks; the
IDE extension does not currently support plugins, so the package CLI remains
the portable primary interface.

References:

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/concepts/mcp-server>
- <https://learn.chatgpt.com/docs/plugins>

## PR Sequence

The PRs below are ordered. A PR may begin before its predecessor merges only
when it is based on that predecessor and does not widen scope.

### PR 1 - Freeze The Existing Workflow Contract

Repository: Liaura

Purpose: establish a behavioral baseline before moving code.

Scope:

- Inventory public commands, flags, output fields, files changed, and external
  calls.
- Preserve the existing dispatch, transition, workflow, and Trello tests.
- Add golden fixtures for dispatch, begin-stage, handoff, retry, and recovery.
- Add tests for packet, registry, ledger, branch, and tracker output.
- Resolve and test the documented `cleanup-pending -> closed` lifecycle
  discrepancy.
- Capture the current expected behavior of dry runs and partial failures.

Exit gate:

- Existing tests pass.
- Golden fixtures describe the supported contract.
- The closed-state decision is explicit in code and docs.

### PR 2 - Bootstrap The External Repository And Extract The Pure Core

Repository: agent-workflow

Purpose: create the distributable project and move deterministic policy first.

Scope:

- Create package, lint, test, build, and release scaffolding.
- Extract stage definitions, transition classification, normalization, and
  validation.
- Define the versioned configuration schema.
- Define blank package-owned templates for the task registry, task packet, and
  live ledger.
- Add a Liaura fixture configuration.
- Port pure state-machine tests.
- Keep filesystem, Git, Trello, and Codex imports out of the core.

Exit gate:

- The package builds independently.
- Core tests pass without a Liaura checkout.
- Liaura's current stage graph is reproducible from configuration.

### PR 3 - Extract Transactions And Repository Adapters

Repository: agent-workflow

Purpose: move file and Git behavior while preserving transactional semantics.

Scope:

- Extract packet and ledger parsing/rendering.
- Extract dispatch, reservation, begin, handoff, retry, and finalize services.
- Add filesystem, clock, process, and Git adapter boundaries.
- Remove absolute checkout paths, `LIAURA_*` names, fixed timezone, fixed branch
  prefix, and fixed task/document paths from reusable code.
- Port transaction and failure-recovery tests.
- Emit stable structured results instead of presentation-only text.

Exit gate:

- Golden output matches the Liaura baseline.
- Retries remain idempotent.
- The package operates against a temporary fixture repository.

### PR 4 - Extract CLI And Tracker Adapters

Repository: agent-workflow

Purpose: make the package usable without Codex.

Scope:

- Add the `agent-workflow` CLI and compatibility command aliases.
- Add `capabilities --json` and publish JSON Schema for commands, inputs,
  outputs, and errors.
- Require non-interactive operation, stable exit codes, JSON output, explicit
  dry-run support, and clean separation of stdout from diagnostics.
- Add an idempotent `init` command that deliberately creates the package config,
  an empty task registry, the task-packet directory, and a configured shared
  local ledger. Refuse to overwrite existing state.
- Add the narrowly scoped `migrate --from embedded-v1` cutover command. It
  validates Liaura's current registry, packets, and ledger in place without
  rewriting historical records.
- Do not add a generic `adopt` command or attempt to infer arbitrary existing
  task-system formats.
- Move Trello behavior behind a tracker interface.
- Add Trello and no-tracker adapters.
- Move Trello task-type labels, list mapping, and credentials into config.
- Add `status` and a minimal `doctor` sufficient for installation diagnostics.
- Port tracker request and command integration tests.

Exit gate:

- The CLI completes the current lifecycle against fixtures.
- A blank fixture repository can initialize and dispatch its first task without
  manually creating workflow files.
- The Liaura fixture passes the `embedded-v1` migration validation without data
  loss or bulk rewrite.
- The no-tracker mode works.
- Trello contract tests pass without live board mutation.

### PR 5 - Build And Publish The Baseline Skills-Only Codex Plugin

Repository: agent-workflow

Purpose: move reusable role guidance, teach Codex to use the package CLI, and
produce the first compatible package/plugin release pair.

Scope:

- Add `.codex-plugin/plugin.json` and npm package metadata.
- Name the plugin artifact `@liaura/agent-workflow-plugin` and keep its version
  equal to `@liaura/agent-workflow`.
- Convert reusable role playbooks into bundled skills.
- Keep project-specific references injectable through repository config.
- Teach each skill to discover CLI capabilities, invoke the correct command,
  request JSON output, and interpret structured results.
- Add positive, negative, follow-up, and boundary activation tests.
- Pack and inspect both npm artifacts; ensure the plugin tarball is complete
  without install-time lifecycle scripts.
- Publish both `0.1.0-alpha.1` artifacts from the same tested commit.
- Do not add an MCP server, hooks, or custom UI during extraction.

Exit gate:

- Both exact prerelease artifacts resolve to the same source commit.
- The plugin installs from its packed artifact through a test marketplace.
- A new Codex task exposes the expected skills.
- Each role skill invokes the expected package CLI command and handles success,
  validation failure, and recovery output correctly.
- Plugin-disabled CLI operation still succeeds.

### PR 6 - Make Liaura Consume The Pinned Package

Repository: Liaura

Purpose: replace the active embedded implementation while retaining a temporary
comparison path.

Scope:

- Add `workflow.config.mjs` with all Liaura-specific policy.
- Add the exact `@liaura/agent-workflow@0.1.0-alpha.1` dependency.
- Run `migrate --from embedded-v1` against disposable copies of Liaura's
  existing registry, packets, and ledger, then configure their current paths.
- Change existing npm scripts to call the package CLI.
- Rename embedded commands to explicit `legacy:*` comparison commands.
- Run old and new commands against equivalent disposable fixtures.
- Compare packets, branches, ledger mutations, transition results, tracker
  requests, dry runs, and retries.
- Document the package installation and direct CLI path.

Exit gate:

- Normal Liaura workflow commands invoke the package.
- Old/new parity comparisons pass.
- No production workflow state or real tracker card was mutated during fixture
  comparison.

### PR 7 - Inject The Pinned Plugin Into Liaura

Repository: Liaura

Purpose: make Liaura obtain generic role behavior from the external plugin.

Scope:

- Add `.agents/plugins/marketplace.json`.
- Pin the marketplace entry to
  `@liaura/agent-workflow-plugin@0.1.0-alpha.1`.
- Ensure package and plugin compatibility is checked by `doctor`.
- Reduce `AGENTS.md` to activation, Liaura-specific rules, and fallback behavior.
- Keep existing generic role docs temporarily for comparison.
- Verify installation in Codex Desktop and Codex CLI using a new task/session.
- Document that unsupported plugin surfaces must use the package CLI.

Exit gate:

- Liaura exposes the plugin through its repo marketplace.
- A fresh task can discover and use each role skill.
- Plugin skills operate on Liaura configuration and state through the package
  CLI.
- Package/plugin version skew produces a clear diagnostic.

### PR 8 - Run Full Lifecycle Acceptance And Failure Recovery

Repositories: agent-workflow and Liaura

Purpose: prove the injected workflow before deleting the old one.

Scope:

- Run a disposable task through dispatch, grilling, plan review,
  implementation, code review, E2E, PR, release, cleanup, and closed.
- Exercise both continue-in-task and handoff-to-new-task paths manually without
  adding automatic context policy.
- Simulate stale state, repeated actions, tracker failure, Git failure, and
  interrupted transitions.
- Verify historical task packets remain readable.
- Record package version, plugin version, config version, and acceptance
  evidence.

Exit gate:

- The full lifecycle completes with plugin skills driving the package CLI.
- Recovery tests demonstrate no duplicate task, commit, transition, or tracker
  card.
- The direct CLI path without plugin guidance completes the same lifecycle.

### PR 9 - Remove Liaura's Embedded Workflow Implementation

Repository: Liaura

Purpose: complete the split and eliminate dual ownership.

Scope:

- Remove embedded dispatch, stage, handoff, Trello, workflow, and transition
  implementations.
- Remove `legacy:*` comparison commands.
- Remove generic role docs now supplied by plugin skills.
- Retain Liaura-specific defaults and application runbooks.
- Update docs to name the package, plugin, config, and marketplace as the
  supported architecture.
- Keep historical packet contents untouched.
- Preserve a simple rollback through the pre-cutover commit and dependency pin.

Exit gate:

- Liaura contains no reusable workflow implementation.
- `rg` confirms removed coupling is absent outside project configuration.
- Fresh checkout setup, CLI workflow, and plugin workflow pass.
- The pre-cutover revision remains a documented rollback point.

### PR 10 - Harden Release And Upgrade Mechanics

Repository: agent-workflow, with a small Liaura consumer update

Purpose: establish a safe development baseline after extraction.

Scope:

- Add package/plugin release automation from one commit.
- Add config-schema compatibility and migration commands.
- Add package/plugin/config compatibility tests.
- Add changelog and upgrade documentation.
- Add a consumer fixture that installs the published artifact, not workspace
  source.
- Prove an upgrade and rollback from Liaura's initially pinned release.
- Define the sunset for the `embedded-v1` migration after Liaura's exercised
  rollback window; it is not part of the permanent onboarding interface.

Exit gate:

- One release produces compatible package and plugin artifacts.
- Liaura can upgrade, diagnose version skew, and roll back predictably.
- The extraction program is complete and feature development can begin.

## Overall Split Acceptance Gate

Do not begin the feature roadmap until all conditions hold:

- Liaura's normal scripts invoke the external package.
- Liaura's repo marketplace installs the external plugin.
- Package, plugin, and configuration versions are compatible and pinned.
- One disposable task has completed the full lifecycle.
- CLI-only operation works without plugin installation.
- The embedded reusable implementation and generic role playbooks are removed.
- Historical task data remains readable.
- Retry and partial-failure tests demonstrate idempotency.
- A documented rollback has been exercised.

## Post-Split Feature Roadmap

Develop these after PR 10, each as independently gated work:

1. Rich `status`, `doctor`, and `reconcile` commands.
2. Stage-aware task titles such as `#72 GR`, `#72 IM`, and `#72 E2`.
3. Structured transition gates and evidence.
4. A thin MCP adapter only when required for host-native discovery, per-tool
   approval, no-shell clients, or an action interface.
5. One-click stage-action card over the thin MCP adapter, with CLI fallback.
6. Context-aware `CONTINUE`, `FRESH_RECOMMENDED`, and `FRESH_REQUIRED`
   recommendations.
7. GitHub Issues, Linear, Jira, and additional tracker adapters.
8. Append-only event history and optimistic concurrency.
9. Config profiles, template overrides, and automated migrations.

If introduced, the MCP adapter remains a thin wrapper over the same package
application services and schemas used by the CLI. The action card remains
presentation over that adapter; neither may store workflow state or bypass
package validation.

## Verification Strategy

### Package

- Unit tests for the state graph and validation.
- Golden tests for packets, ledger entries, prompts, and structured results.
- Adapter contract tests.
- Temporary-repository integration tests.
- Crash, retry, stale-revision, and duplicate-action tests.
- Package-install and plugin-install smoke tests from built artifacts.

### Liaura

- Existing agent workflow tests remain green until replaced by consumer
  integration tests.
- Package-backed npm commands pass in a fresh checkout.
- `git diff --check` passes in every PR.
- No live Trello mutation occurs in automated tests.
- One controlled acceptance task verifies the live integration before removal.

### Plugin

- Intended prompts activate the correct skill.
- Similar indirect requests behave consistently.
- Unsupported requests do not activate the workflow.
- Skills call the expected CLI commands with structured output.
- CLI results remain useful when plugin guidance is unavailable.
- New tasks receive updated plugin content after installation or upgrade.

## Risks And Controls

- **Behavior drift during extraction:** golden fixtures and old/new comparison
  before deletion.
- **Package/plugin version skew:** exact pins and `doctor` compatibility check.
- **Two sources of truth:** short comparison window followed by mandatory
  embedded-code removal.
- **Plugin unavailable on a Codex surface:** documented CLI fallback.
- **Tracker side effects during testing:** adapter fakes and explicit live-test
  approval.
- **Historical packets reference old playbook paths:** backward-compatible
  parsing; no bulk rewrite.
- **External repository blocks Liaura development:** pinned releases, fixture
  tests, and tested rollback.
- **Feature work contaminates migration:** post-split feature freeze until the
  overall acceptance gate passes.

## Explicit Non-Goals

- Add stage-title automation during extraction.
- Add one-click UI during extraction.
- Add an MCP server during extraction.
- Read undocumented Codex session logs during extraction.
- Generalize every Liaura-specific runbook.
- Support every tracker in the first package release.
- Import or infer arbitrary pre-existing task, packet, or ledger systems.
- Publish publicly before the private/repo-scoped consumer path is stable.
- Rewrite historical task packets solely to adopt the new terminology.

## First Action

Start PR 1 on `v1.2.5`: freeze the workflow contract and resolve the closed-state
decision. In parallel, create the empty external repository only after its name,
package scope, visibility, and release ownership are agreed; do not move
implementation code before the parity fixtures are merged.
