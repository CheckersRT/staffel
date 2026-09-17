import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import { runCli } from "../dist/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const referenceConfig = path.resolve(packageRoot, "../../fixtures/reference/staffel.config.mjs");

test("capabilities publish stable command, input, output, and error schemas", async () => {
  const response = await invoke(["capabilities", "--json"]);
  assert.equal(response.exitCode, 0);
  assert.equal(response.stderr, "");
  assert.equal(response.output.ok, true);
  assert.equal(response.output.result.interactive, false);
  assert.equal(response.output.result.commands.find((item) => item.name === "dispatch").supportsDryRun, true);
  for (const name of ["command", "input", "output", "error"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(packageRoot, `dist/schemas/staffel-${name}-v1.json`), "utf8"));
    assert.equal(schema.$id, response.output.result.schemas[name]);
  }
});

test("CLI errors use JSON stdout, leave diagnostics on stderr, and return stable exit codes", async () => {
  const response = await invoke(["agent:dispatch", "--json"]);
  assert.equal(response.exitCode, 2);
  assert.equal(response.stderr, "");
  assert.equal(response.output.ok, false);
  assert.equal(response.output.command, "dispatch");
  assert.equal(response.output.error.code, "cli.usage");

  const config = await invoke(["status", "--json"]);
  assert.equal(config.exitCode, 3);
  assert.equal(config.output.error.code, "config.invalid");

  const doctor = await invoke(["doctor", "--json"]);
  assert.equal(doctor.exitCode, 0);
  assert.equal(doctor.output.result.healthy, false);
  assert.equal(doctor.output.result.diagnostics[0].code, "installation.config");

  const usage = await invoke(["unknown-command"]);
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.output.error.code, "cli.usage");
});

test("blank repository init is dry-runnable, idempotent, and enables first dispatch", async (t) => {
  const root = createRepository(t, false);
  const dryRun = await invoke(["init", "--repository", root, "--dry-run", "--json"]);
  assert.equal(dryRun.output.result.dryRun, true);
  assert.equal(fs.existsSync(path.join(root, "staffel.config.mjs")), false);

  const initialized = await invoke(["init", "--repository", root, "--json"]);
  assert.equal(initialized.exitCode, 0);
  assert.equal(initialized.output.result.alreadyComplete, false);
  assert.match(git(root, ["log", "-1", "--format=%s"]), /initialize Staffel workflow/);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".staffel/workstreams.md\n.staffel/workstreams.md.lock\n");

  const repeated = await invoke(["initialize", "--repository", root, "--json"]);
  assert.equal(repeated.output.result.alreadyComplete, true);
  const dispatch = await invoke([
    "agent:dispatch",
    "--repository", root,
    "--task", "1",
    "--name", "First task",
    "--type", "Work",
    "--stage", "ready",
    "--goal", "Prove onboarding.",
    "--json",
  ]);
  assert.equal(dispatch.exitCode, 0);
  assert.equal(dispatch.output.result.branch, "work/0001-first-task");
  assert.equal(dispatch.output.result.verified, true);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("CLI completes dispatch, begin, dry-run handoff, handoff, status, doctor, and embedded-v1 validation", async (t) => {
  const root = createRepository(t);
  fs.copyFileSync(referenceConfig, path.join(root, "staffel.config.mjs"));
  assert.equal((await invoke(["init", "--repository", root])).exitCode, 0);

  const dispatch = await invoke([
    "dispatch", "--repository", root,
    "--task", "42", "--name", "CLI fixture", "--type", "Maintenance",
    "--stage", "ready-for-implementation", "--goal", "Exercise every command.",
  ]);
  assert.equal(dispatch.exitCode, 0);
  const branch = dispatch.output.result.branch;
  assert.equal(git(root, ["branch", "--show-current"]), branch);

  const begun = await invoke(["agent:stage", "--repository", root, "--task", "42"]);
  assert.equal(begun.output.result.to, "implementing");
  const packetPath = path.join(root, dispatch.output.result.packetPath);
  fs.writeFileSync(
    packetPath,
    fs.readFileSync(packetPath, "utf8").replace(
      "- Goal: Exercise every command.",
      "- Goal: Exercise every command.\n- Result: ready for code review."
    )
  );
  const beforeDryRun = snapshot(root, packetPath);
  const planned = await invoke([
    "agent:handoff", "--repository", root, "--task", "42", "--to", "ready-for-code-review", "--dry-run",
  ]);
  assert.equal(planned.output.result.dryRun, true);
  assert.deepEqual(snapshot(root, packetPath), beforeDryRun);

  const handedOff = await invoke([
    "handoff", "--repository", root, "--task", "42", "--to", "ready-for-code-review",
  ]);
  assert.equal(handedOff.exitCode, 0);
  assert.equal(handedOff.output.result.verified, true);
  assert.equal(git(root, ["status", "--porcelain"]), "");

  const status = await invoke(["status", "--repository", root]);
  assert.deepEqual(status.output.result.tasks.map((item) => [item.task, item.stage]), [["42", "ready-for-code-review"]]);
  const health = await invoke(["doctor", "--repository", root]);
  assert.equal(health.output.result.healthy, true);
  const tracker = await invoke(["trello:agent", "--repository", root, "--task", "42"]);
  assert.equal(tracker.output.result.provider, "none");

  const beforeMigration = artifactHashes(root);
  const migration = await invoke(["migrate", "--repository", root, "--from", "embedded-v1"]);
  assert.equal(migration.exitCode, 0);
  assert.equal(migration.output.result.rewritten, false);
  assert.deepEqual(artifactHashes(root), beforeMigration);
});

test("embedded-v1 validation preserves historical Liaura packet formats", async (t) => {
  const root = createRepository(t);
  const config = structuredClone(referenceFixture);
  config.repository.paths = {
    registry: "docs/task-registry.md",
    taskPackets: "docs/tasks",
    liveLedger: "scratch/agent-coordination/workstreams.md",
    rolePlaybooks: "docs/agents/roles",
  };
  fs.writeFileSync(path.join(root, "staffel.config.mjs"), `export default ${JSON.stringify(config)};\n`);
  fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, "scratch/agent-coordination"), { recursive: true });
  const artifacts = {
    "docs/task-registry.md": `# Project Task Registry\n\n- [x] #18C Historical task.\n      Type: Maintenance\n      Task packet: [docs/tasks/0018c-historical-task.md](tasks/0018c-historical-task.md)\n\n- [ ] #42 Current task.\n      Type: Feature\n      Task packet: [docs/tasks/0042-current-task.md](tasks/0042-current-task.md)\n`,
    "docs/tasks/0018c-historical-task.md": `# #18C Historical task\n\n## Current Stage\n\n- Stage: closed\n- Next role: none\n- Role playbook: docs/agents/roles/release.md\n\n## Historical Start Prompt\n\nCompleted before Staffel.\n`,
    "docs/tasks/0042-current-task.md": `#42 Current task\n\n## Stable Brief\n\n- Type: Feature\n\n## Current Stage\n\n- Stage: ready-for-implementation\n- Next role: implementation\n- Role playbook: docs/agents/roles/implementation.md\n\n## Stage Brief\n\n- Goal: Continue the task.\n`,
    "scratch/agent-coordination/workstreams.md": `# Agent Workstreams\n\n## Active Workstreams\n\n### 0042 Current task\n\nStatus: in-progress\nStage: ready-for-implementation\nTask packet: docs/tasks/0042-current-task.md\n\n## Recently Closed\n`,
  };
  for (const [name, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  const before = Object.fromEntries(Object.keys(artifacts).map((name) => [
    name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex"),
  ]));

  const migration = await invoke(["migrate", "--repository", root, "--from", "embedded-v1"]);
  assert.equal(migration.exitCode, 0, JSON.stringify(migration.output));
  assert.deepEqual(migration.output.result.counts, { registry: 2, packets: 2, ledger: 1 });
  assert.equal(migration.output.result.rewritten, false);
  const after = Object.fromEntries(Object.keys(artifacts).map((name) => [
    name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex"),
  ]));
  assert.deepEqual(after, before);

  fs.writeFileSync(
    path.join(root, "scratch/agent-coordination/workstreams.md"),
    artifacts["scratch/agent-coordination/workstreams.md"].replace(
      "## Recently Closed",
      "### 0018C Historical task\n\nStatus: in-progress\nStage: ready-for-implementation\nTask packet: docs/tasks/0018c-historical-task.md\n\n## Recently Closed"
    )
  );
  const activeLegacy = await invoke(["migrate", "--repository", root, "--from", "embedded-v1"]);
  assert.equal(activeLegacy.exitCode, 4);
});

test("CLI traverses the reference lifecycle through cleanup-pending", async (t) => {
  const root = createRepository(t);
  fs.copyFileSync(referenceConfig, path.join(root, "staffel.config.mjs"));
  assert.equal((await invoke(["init", "--repository", root])).exitCode, 0);
  const dispatched = await invoke([
    "dispatch", "--repository", root,
    "--task", "77", "--name", "Lifecycle fixture", "--type", "Feature",
    "--stage", "ready-for-prototyping", "--goal", "Reach cleanup without a tracker.",
  ]);
  assert.equal(dispatched.exitCode, 0);
  const packetPath = path.join(root, dispatched.output.result.packetPath);
  const destinations = [
    "ready-for-grilling",
    "ready-for-plan-review",
    "ready-for-implementation",
    "ready-for-code-review",
    "ready-for-e2e",
    "ready-for-pr",
    "ready-for-merge",
    "release-pending",
    "cleanup-pending",
  ];

  for (const [index, destination] of destinations.entries()) {
    const begun = await invoke(["stage", "--repository", root, "--task", "77"]);
    assert.equal(begun.exitCode, 0, JSON.stringify(begun.output));
    authorPacket(packetPath, `Lifecycle evidence ${index + 1}.`);
    const handoff = await invoke([
      "handoff", "--repository", root, "--task", "77", "--to", destination,
    ]);
    assert.equal(handoff.exitCode, 0, JSON.stringify(handoff.output));
    assert.equal(handoff.output.result.to, destination);
  }

  const finalStage = await invoke(["stage", "--repository", root, "--task", "77"]);
  assert.equal(finalStage.output.result.alreadyComplete, true);
  assert.equal(finalStage.output.result.to, "cleanup-pending");
  const status = await invoke(["status", "--repository", root]);
  assert.equal(status.output.result.tasks[0].stage, "cleanup-pending");
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("init refuses to overwrite existing workflow state", async (t) => {
  const root = createRepository(t);
  fs.mkdirSync(path.join(root, ".staffel"), { recursive: true });
  fs.writeFileSync(path.join(root, ".staffel/task-registry.md"), "# Existing workflow\n");
  const response = await invoke(["init", "--repository", root]);
  assert.equal(response.exitCode, 4);
  assert.equal(response.output.error.code, "state.invalid");
  assert.equal(fs.readFileSync(path.join(root, ".staffel/task-registry.md"), "utf8"), "# Existing workflow\n");
});

test("init does not commit pre-existing edits to tracked files", async (t) => {
  const root = createRepository(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "existing-ignore\n");
  git(root, ["add", ".gitignore"]);
  git(root, ["commit", "-m", "add gitignore"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "existing-ignore\nuser-edit\n");
  const headBefore = git(root, ["rev-parse", "HEAD"]);

  const response = await invoke(["init", "--repository", root]);
  assert.equal(response.exitCode, 4);
  assert.match(response.output.error.message, /pre-existing tracked changes/);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "existing-ignore\nuser-edit\n");
  assert.equal(fs.existsSync(path.join(root, "staffel.config.mjs")), false);
  assert.equal(fs.existsSync(path.join(root, ".staffel/task-registry.md")), false);
});

test("tracker credential failures use the stable tracker exit code without an HTTP request", async (t) => {
  const root = createRepository(t);
  const config = structuredClone(referenceFixture);
  const trackerLists = [...new Set(Object.values(config.workflow.stages).map((stage) => stage.trackerList))];
  config.tracker = {
    provider: "trello",
    boardIdEnvironmentVariable: "MISSING_BOARD",
    apiKeyEnvironmentVariable: "MISSING_KEY",
    tokenEnvironmentVariable: "MISSING_TOKEN",
    listIds: Object.fromEntries(trackerLists.map((name, index) => [name, `list-${index}`])),
    taskTypeLabelIds: { Feature: "feature-label", Maintenance: "maintenance-label" },
  };
  fs.writeFileSync(path.join(root, "staffel.config.mjs"), `export default ${JSON.stringify(config, null, 2)};\n`);
  assert.equal((await invoke(["init", "--repository", root])).exitCode, 0);
  const response = await invoke([
    "dispatch", "--repository", root,
    "--task", "9", "--name", "Offline tracker", "--type", "Maintenance",
    "--stage", "ready-for-implementation", "--goal", "Fail before transport.",
  ]);
  assert.equal(response.exitCode, 5);
  assert.equal(response.output.error.code, "tracker.credentials_missing");
  assert.equal(git(root, ["branch", "--show-current"]), "main");
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runCli(argv, {
    writeStdout: (value) => { stdout += value; },
    writeStderr: (value) => { stderr += value; },
  }, {});
  return { ...result, stdout, stderr, output: JSON.parse(stdout) };
}

function createRepository(t, withInitialCommit = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staffel-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Staffel Test"]);
  git(root, ["config", "user.email", "staffel@test.invalid"]);
  if (withInitialCommit) {
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "fixture"]);
  }
  return root;
}

function snapshot(root, packetPath) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    packet: fs.readFileSync(packetPath, "utf8"),
    ledger: fs.readFileSync(path.join(root, ".staffel/workstreams.md"), "utf8"),
  };
}

function artifactHashes(root) {
  return [
    ".staffel/task-registry.md",
    ".staffel/workstreams.md",
    ...fs.readdirSync(path.join(root, ".staffel/tasks")).map((name) => `.staffel/tasks/${name}`),
  ].map((name) => [name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]);
}

function authorPacket(packetPath, line) {
  const content = fs.readFileSync(packetPath, "utf8");
  fs.writeFileSync(packetPath, content.replace("\n## Task Registry Entry\n", `\n- ${line}\n\n## Task Registry Entry\n`));
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
