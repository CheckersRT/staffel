import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import {
  BLANK_LIVE_LEDGER_TEMPLATE,
  BLANK_TASK_REGISTRY_TEMPLATE,
  FileWorkflowLockAdapter,
  GitCliAdapter,
  NodeWorkflowStorageAdapter,
  NoopWorkflowLock,
  Sha256ContentHasher,
  WorkflowService,
  findLiveLedgerEntry,
  parseStaffelConfig,
  parseTaskPacket,
  pendingTransition,
} from "../dist/index.js";

const config = parseStaffelConfig(referenceFixture);

test("repository adapters complete dispatch, begin, and handoff in a temporary Git repository", async (t) => {
  const fixture = createFixture(t);
  const stageSync = new MemoryStageSync();
  const service = createService(fixture, stageSync);

  const dispatched = await service.dispatch({
    taskId: "42",
    name: "Contract fixture",
    taskType: "Maintenance",
    stage: "ready-for-implementation",
    goal: "Exercise the repository transaction.",
  });
  assert.equal(dispatched.branch, "work/0042-contract-fixture");
  assert.equal(dispatched.alreadyComplete, false);
  assert.equal(dispatched.verified, true);
  assert.equal(stageSync.position, "Ready for Implementation");
  assert.match(git(fixture.root, ["log", "-1", "--format=%s"]), /dispatch task #42/);

  const begun = await service.begin({ taskId: "42" });
  assert.equal(begun.from, "ready-for-implementation");
  assert.equal(begun.to, "implementing");
  assert.equal(stageSync.position, "Implementing");

  const packetPath = path.join(fixture.root, ".staffel/tasks/0042-contract-fixture.md");
  fs.writeFileSync(
    packetPath,
    fs.readFileSync(packetPath, "utf8").replace(
      "- Goal: Exercise the repository transaction.",
      "- Goal: Exercise the repository transaction.\n- Result: ready for review."
    )
  );
  const authoredPacket = fs.readFileSync(packetPath, "utf8");
  const ledgerBeforeDryRun = fixture.storage.readLedger();
  const headBeforeDryRun = git(fixture.root, ["rev-parse", "HEAD"]);
  const dryRun = await service.handoff({
    taskId: "42",
    to: "ready-for-code-review",
    dryRun: true,
  });
  assert.deepEqual(dryRun.wouldCommit, [".staffel/tasks/0042-contract-fixture.md"]);
  assert.equal(fs.readFileSync(packetPath, "utf8"), authoredPacket);
  assert.equal(fixture.storage.readLedger(), ledgerBeforeDryRun);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), headBeforeDryRun);
  assert.equal(stageSync.position, "Implementing");

  const handedOff = await service.handoff({
    taskId: "42",
    to: "ready-for-code-review",
  });
  assert.equal(handedOff.classification, "normal");
  assert.equal(handedOff.packetCommit, git(fixture.root, ["rev-parse", "HEAD"]));
  assert.equal(stageSync.position, "Ready for Code Review");
  assert.equal(parseTaskPacket(fs.readFileSync(packetPath, "utf8")).stage, "ready-for-code-review");
  const finalEntry = findLiveLedgerEntry(fixture.storage.readLedger(), "42");
  assert.equal(finalEntry.fields.Stage, "ready-for-code-review");
  assert.equal(finalEntry.fields["Pending transition"], undefined);
  assert.deepEqual(new GitCliAdapter(fixture.root).changedPaths(), []);
});

test("dispatch dry-run validates identity without creating a branch or workflow state", async (t) => {
  const fixture = createFixture(t);
  const stageSync = new MemoryStageSync();
  const service = createService(fixture, stageSync);
  const registryBefore = fixture.storage.readRegistry();
  const ledgerBefore = fixture.storage.readLedger();
  const headBefore = git(fixture.root, ["rev-parse", "HEAD"]);

  const result = await service.dispatch({
    taskId: "41",
    name: "Dry run fixture",
    taskType: "Maintenance",
    stage: "ready-for-implementation",
    goal: "Read everything and write nothing.",
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(git(fixture.root, ["branch", "--show-current"]), "main");
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(fixture.storage.readRegistry(), registryBefore);
  assert.equal(fixture.storage.readLedger(), ledgerBefore);
  assert.equal(fixture.storage.packetExists(result.packetPath), false);
  assert.equal(stageSync.position, null);
});

test("filesystem workflow locks reject overlapping mutations and release afterward", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staffel-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "workflow.lock");
  const lock = new FileWorkflowLockAdapter(lockPath);

  await lock.withLock(async () => {
    assert.equal(fs.existsSync(lockPath), true);
    await assert.rejects(lock.withLock(async () => undefined), /already exists/);
  });
  assert.equal(fs.existsSync(lockPath), false);
  await lock.withLock(async () => undefined);
});

test("handoff retries after an external-stage failure without creating another packet commit", async (t) => {
  const fixture = createFixture(t);
  const stageSync = new MemoryStageSync();
  const service = createService(fixture, stageSync);
  await service.dispatch({
    taskId: "43",
    name: "Retry fixture",
    taskType: "Maintenance",
    stage: "ready-for-implementation",
    goal: "Prove retry safety.",
  });
  await service.begin({ taskId: "43" });
  const packetPath = path.join(fixture.root, ".staffel/tasks/0043-retry-fixture.md");
  fs.writeFileSync(
    packetPath,
    fs.readFileSync(packetPath, "utf8").replace(
      "- Goal: Prove retry safety.",
      "- Goal: Prove retry safety.\n- Result: authored once."
    )
  );

  stageSync.failNext = true;
  await assert.rejects(
    service.handoff({ taskId: "43", to: "ready-for-code-review" }),
    /stage synchronizer unavailable/
  );
  const commitAfterFailure = git(fixture.root, ["rev-parse", "HEAD"]);
  const pendingEntry = findLiveLedgerEntry(fixture.storage.readLedger(), "43");
  assert.equal(pendingTransition(pendingEntry).packetCommit, commitAfterFailure);
  assert.equal(pendingEntry.fields.Stage, "implementing");
  assert.deepEqual(new GitCliAdapter(fixture.root).changedPaths(), []);

  const resumed = await service.handoff({ taskId: "43", to: "ready-for-code-review" });
  assert.equal(resumed.packetCommit, commitAfterFailure);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), commitAfterFailure);
  assert.equal(stageSync.position, "Ready for Code Review");
  assert.equal(findLiveLedgerEntry(fixture.storage.readLedger(), "43").fields.Stage, "ready-for-code-review");
});

test("dispatch and begin resume their reserved state after external-stage failures", async (t) => {
  const fixture = createFixture(t);
  const stageSync = new MemoryStageSync();
  const service = createService(fixture, stageSync);

  stageSync.failNext = true;
  await assert.rejects(
    service.dispatch({
      taskId: "44",
      name: "Dispatch retry fixture",
      taskType: "Maintenance",
      stage: "ready-for-implementation",
      goal: "Resume dispatch safely.",
    }),
    /stage synchronizer unavailable/
  );
  const dispatchCommit = git(fixture.root, ["rev-parse", "HEAD"]);
  assert.equal(findLiveLedgerEntry(fixture.storage.readLedger(), "44").fields.Stage, "dispatching");

  const dispatched = await service.dispatch({
    taskId: "44",
    name: "Dispatch retry fixture",
    taskType: "Maintenance",
    stage: "ready-for-implementation",
    goal: "Resume dispatch safely.",
  });
  assert.equal(dispatched.artifactCommit, dispatchCommit);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), dispatchCommit);

  stageSync.failNext = true;
  await assert.rejects(service.begin({ taskId: "44" }), /stage synchronizer unavailable/);
  const pendingEntry = findLiveLedgerEntry(fixture.storage.readLedger(), "44");
  assert.equal(pendingTransition(pendingEntry).operation, "begin");
  assert.equal(pendingEntry.fields.Stage, "ready-for-implementation");

  const begun = await service.begin({ taskId: "44" });
  assert.equal(begun.to, "implementing");
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), dispatchCommit);
  assert.equal(findLiveLedgerEntry(fixture.storage.readLedger(), "44").fields.Stage, "implementing");
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staffel-transactions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".staffel/tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".staffel/workstreams.md\n");
  fs.writeFileSync(path.join(root, ".staffel/task-registry.md"), BLANK_TASK_REGISTRY_TEMPLATE);
  fs.writeFileSync(path.join(root, ".staffel/workstreams.md"), BLANK_LIVE_LEDGER_TEMPLATE);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Staffel Test"]);
  git(root, ["config", "user.email", "staffel@test.invalid"]);
  git(root, ["add", ".gitignore", ".staffel/task-registry.md", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  return {
    root,
    storage: new NodeWorkflowStorageAdapter(config, { repositoryRoot: root }),
  };
}

function createService(fixture, stageSync) {
  return new WorkflowService({
    config,
    storage: fixture.storage,
    git: new GitCliAdapter(fixture.root),
    clock: { now: () => new Date("2026-08-30T10:34:00Z") },
    hasher: new Sha256ContentHasher(),
    lock: new NoopWorkflowLock(),
    stageSync,
  });
}

class MemoryStageSync {
  position = null;
  reference = "memory://task";
  failNext = false;

  inspect() {
    return { position: this.position, reference: this.reference };
  }

  sync(_task, destination) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("stage synchronizer unavailable");
    }
    this.position = destination;
    return this.inspect();
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
