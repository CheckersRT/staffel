import assert from "node:assert/strict";
import test from "node:test";

import {
  STAFFEL_TEMPLATES_V1,
  BLANK_LIVE_LEDGER_TEMPLATE,
  BLANK_TASK_PACKET_TEMPLATE,
  BLANK_TASK_REGISTRY_TEMPLATE,
} from "../dist/index.js";

test("versioned package templates define all blank workflow artifacts", () => {
  assert.equal(STAFFEL_TEMPLATES_V1.version, 1);
  assert.equal(STAFFEL_TEMPLATES_V1.taskRegistry, BLANK_TASK_REGISTRY_TEMPLATE);
  assert.equal(STAFFEL_TEMPLATES_V1.taskPacket, BLANK_TASK_PACKET_TEMPLATE);
  assert.equal(STAFFEL_TEMPLATES_V1.liveLedger, BLANK_LIVE_LEDGER_TEMPLATE);
  assert.equal(Object.isFrozen(STAFFEL_TEMPLATES_V1), true);
});

test("blank templates carry the stable packet and ledger structure", () => {
  for (const heading of ["Stable Brief", "References", "Current Stage", "Stage Brief", "Task Registry Entry", "Start Prompt"]) {
    assert.match(BLANK_TASK_PACKET_TEMPLATE, new RegExp(`^## ${heading}$`, "m"));
  }
  assert.match(BLANK_TASK_REGISTRY_TEMPLATE, /^# Task Registry$/m);
  assert.match(BLANK_LIVE_LEDGER_TEMPLATE, /^## Active Workstreams$/m);
  assert.match(BLANK_LIVE_LEDGER_TEMPLATE, /^## Recently Closed$/m);
});
