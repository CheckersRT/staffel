import assert from "node:assert/strict";
import test from "node:test";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import {
  classifyTransition,
  getBeginDestination,
  getExpectedPacketStages,
  getStage,
  isRoleActiveStage,
  normalizeTaskId,
  parseStaffelConfig,
  validateTransition,
} from "../dist/index.js";

const config = parseStaffelConfig(referenceFixture);

test("the reference executable stage graph is configuration-owned", () => {
  assert.equal(config.workflow.enabledStages.length, 20);
  assert.deepEqual(config.workflow.enabledStages, Object.keys(config.workflow.stages));
});

test("workflow contract maps role starts and rework results", () => {
  assert.equal(getBeginDestination(config, "ready-for-prototyping"), "prototyping");
  assert.equal(getBeginDestination(config, "ready-for-code-review"), "code-review");
  assert.equal(getBeginDestination(config, "changes-requested"), "implementing");
  assert.deepEqual(getExpectedPacketStages(config, "implementing"), [
    "ready-for-implementation",
    "changes-requested",
    "fixes-needed",
  ]);
});

test("lifecycle roles begin in their existing stage", () => {
  for (const stage of [
    "ready-for-merge",
    "deployment-pending",
    "release-pending",
    "cleanup-pending",
  ]) {
    assert.equal(isRoleActiveStage(config, stage), true);
  }
  assert.equal(isRoleActiveStage(config, "ready-for-code-review"), false);
});

test("workflow contract classifies normal and exceptional transitions", () => {
  assert.equal(classifyTransition(config, "prototyping", "ready-for-grilling"), "normal");
  assert.equal(classifyTransition(config, "code-review", "changes-requested"), "normal");
  assert.equal(classifyTransition(config, "grilling", "ready-for-implementation"), "exceptional");
  assert.equal(getStage(config, "fixes-needed").trackerList, "Ready for Implementation");
  assert.equal(getStage(config, "ready-for-prototyping").nextRole, "prototype");
});

test("exceptional transitions require a one-line reason", () => {
  assert.deepEqual(
    validateTransition(config, "grilling", "ready-for-implementation", "User approved skipping review"),
    {
      from: "grilling",
      to: "ready-for-implementation",
      classification: "exceptional",
      reason: "User approved skipping review",
    }
  );
  assert.throws(
    () => validateTransition(config, "grilling", "ready-for-implementation"),
    /requires --reason/
  );
  assert.throws(
    () => validateTransition(config, "grilling", "ready-for-implementation", "line one\nline two"),
    /must be one line/
  );
});

test("closure remains outside the version 1 executable contract", () => {
  assert.throws(
    () => classifyTransition(config, "cleanup-pending", "closed"),
    /closure and archival are owned by the workflow host/
  );
});

test("task ids preserve optional alphabetic suffixes", () => {
  assert.deepEqual(["18", "0018a", "#18B", "18c"].map(normalizeTaskId), [
    "18",
    "18A",
    "18B",
    "18C",
  ]);
  assert.notEqual(normalizeTaskId("18"), normalizeTaskId("18A"));
  assert.throws(() => normalizeTaskId("18-AA"), /Invalid task id/);
});
