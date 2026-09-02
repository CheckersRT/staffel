import assert from "node:assert/strict";
import test from "node:test";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import {
  appendTaskRegistryEntry,
  executeHandoffTransaction,
  finalizeLiveLedgerTransition,
  findLiveLedgerEntry,
  formatTimestamp,
  insertLiveLedgerEntry,
  parseLiveLedger,
  parseStaffelConfig,
  parseTaskPacket,
  parseTaskRegistry,
  pendingTransition,
  recordLiveLedgerPacketCommit,
  renderLiveLedgerEntry,
  renderTaskPacket,
  renderTaskRegistryEntry,
  reserveLiveLedgerTransition,
  transitionTaskPacket,
} from "../dist/index.js";

const config = parseStaffelConfig(referenceFixture);
const task = {
  taskId: "42",
  name: "Contract fixture",
  taskType: "Maintenance",
  branch: "work/0042-contract-fixture",
  packetPath: ".staffel/tasks/0042-contract-fixture.md",
  goal: "Freeze repository transaction output.",
};

test("task registry and packet codecs preserve stable identity and authored briefs", () => {
  const registryEntry = renderTaskRegistryEntry({
    ...task,
    registryPath: ".staffel/task-registry.md",
  });
  assert.equal(
    registryEntry,
    "- [ ] #42 Contract fixture.\n" +
      "      Type: Maintenance\n" +
      "      Task packet: [.staffel/tasks/0042-contract-fixture.md](tasks/0042-contract-fixture.md)"
  );
  const registry = appendTaskRegistryEntry("# Task Registry\n", registryEntry);
  assert.deepEqual(parseTaskRegistry(registry).map((entry) => ({
    taskId: entry.taskId,
    name: entry.name,
    taskType: entry.taskType,
    packetPath: entry.packetPath,
  })), [
    {
      taskId: "42",
      name: "Contract fixture",
      taskType: "Maintenance",
      packetPath: ".staffel/tasks/0042-contract-fixture.md",
    },
  ]);

  const packet = renderTaskPacket(config, {
    ...task,
    stage: "ready-for-implementation",
    registryEntry,
  });
  const parsed = parseTaskPacket(packet);
  assert.deepEqual(
    {
      taskId: parsed.taskId,
      name: parsed.name,
      taskType: parsed.taskType,
      stage: parsed.stage,
      nextRole: parsed.nextRole,
      rolePlaybook: parsed.rolePlaybook,
      stageBrief: parsed.stageBrief,
    },
    {
      taskId: "42",
      name: "Contract fixture",
      taskType: "Maintenance",
      stage: "ready-for-implementation",
      nextRole: "implementation",
      rolePlaybook: ".staffel/roles/implementation.md",
      stageBrief: "- Goal: Freeze repository transaction output.",
    }
  );

  const authored = packet.replace(
    "- Goal: Freeze repository transaction output.",
    "- Goal: Freeze repository transaction output.\n- Verified: authored detail survives."
  );
  const handedOff = transitionTaskPacket(config, {
    content: authored,
    taskId: task.taskId,
    name: task.name,
    branch: task.branch,
    packetPath: task.packetPath,
    from: "implementing",
    to: "ready-for-code-review",
    reason: null,
  });
  const transitioned = parseTaskPacket(handedOff);
  assert.equal(transitioned.stage, "ready-for-code-review");
  assert.equal(transitioned.nextRole, "code-review");
  assert.match(transitioned.stageBrief, /authored detail survives/);
  assert.doesNotMatch(transitioned.stageBrief, /Current Stage/);
});

test("live-ledger reservation, commit recording, and finalization are compare-before-replace", () => {
  const timestamp = "2026-08-30 12:34 Europe/Berlin";
  const entry = renderLiveLedgerEntry({
    ...task,
    status: "in-progress",
    stage: "implementing",
    nextRole: "implementation",
    worktree: "/tmp/staffel-contract",
    timestamp,
  });
  const initial = insertLiveLedgerEntry(
    "# Agent Workstreams\n\n## Active Workstreams\n\n## Recently Closed\n",
    entry
  );
  assert.equal(parseLiveLedger(initial).length, 1);

  const reservation = {
    operation: "handoff",
    from: "implementing",
    to: "ready-for-code-review",
    reason: null,
    baseCommit: "base",
    expectedPacketHash: "hash",
    packetCommit: null,
  };
  const reserved = reserveLiveLedgerTransition(initial, "42", reservation, timestamp);
  assert.equal(reserved.changed, true);
  assert.deepEqual(pendingTransition(reserved.entry), reservation);
  assert.equal(
    reserveLiveLedgerTransition(reserved.content, "42", reservation, timestamp).changed,
    false
  );
  assert.throws(
    () => reserveLiveLedgerTransition(reserved.content, "42", { ...reservation, to: "ready-for-e2e" }, timestamp),
    /mismatch/
  );

  const recorded = recordLiveLedgerPacketCommit(
    reserved.content,
    "42",
    "packet-commit",
    reservation
  );
  const exact = pendingTransition(recorded.entry);
  assert.equal(exact.packetCommit, "packet-commit");
  const finalized = finalizeLiveLedgerTransition(
    config,
    recorded.content,
    "42",
    "ready-for-code-review",
    null,
    exact,
    timestamp
  );
  const finalEntry = findLiveLedgerEntry(finalized.content, "42");
  assert.equal(finalEntry.fields.Stage, "ready-for-code-review");
  assert.equal(finalEntry.fields.Status, "in-progress");
  assert.equal(finalEntry.fields["Next role"], "code-review");
  assert.equal(finalEntry.fields["Pending transition"], undefined);
});

test("handoff executor resumes at the first incomplete side effect", async () => {
  const calls = [];
  await assert.rejects(
    executeHandoffTransaction({
      fresh: true,
      existingCommit: null,
      commitRecorded: false,
      stageAtDestination: false,
      reserve: () => calls.push("reserve"),
      commit: () => (calls.push("commit"), "abc"),
      recordCommit: () => calls.push("record"),
      syncStage: () => {
        calls.push("sync");
        throw new Error("stage service unavailable");
      },
      finalize: () => calls.push("finalize"),
      verify: () => calls.push("verify"),
    }),
    /stage service unavailable/
  );
  assert.deepEqual(calls, ["reserve", "commit", "record", "sync"]);

  calls.length = 0;
  const commit = await executeHandoffTransaction({
    fresh: false,
    existingCommit: "abc",
    commitRecorded: true,
    stageAtDestination: true,
    reserve: () => calls.push("reserve"),
    commit: () => (calls.push("commit"), "duplicate"),
    recordCommit: () => calls.push("record"),
    syncStage: () => calls.push("sync"),
    finalize: () => calls.push("finalize"),
    verify: () => calls.push("verify"),
  });
  assert.equal(commit, "abc");
  assert.deepEqual(calls, ["finalize", "verify"]);
});

test("timestamps use the configured timezone rather than a fixed project timezone", () => {
  assert.equal(
    formatTimestamp(new Date("2026-08-30T10:34:00Z"), "Europe/Berlin"),
    "2026-08-30 12:34 Europe/Berlin"
  );
  assert.equal(
    formatTimestamp(new Date("2026-08-30T10:34:00Z"), "UTC"),
    "2026-08-30 10:34 UTC"
  );
});
