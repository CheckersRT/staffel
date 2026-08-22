import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import {
  STAFFEL_CONFIG_SCHEMA_V1,
  StaffelConfigValidationError,
  parseStaffelConfig,
  validateStaffelConfig,
} from "../dist/index.js";

test("the reference fixture satisfies Staffel configuration version 1", () => {
  assert.deepEqual(validateStaffelConfig(referenceFixture), []);
  const parsed = parseStaffelConfig(structuredClone(referenceFixture));
  assert.equal(parsed.configVersion, 1);
  assert.equal(parsed.compatibility.workflow, "0.1.0-alpha.1");
  assert.equal(parsed.compatibility.cli, "0.1.0-alpha.1");
  assert.equal(parsed.compatibility.plugin, "0.1.0-alpha.1");
  assert.equal(Object.isFrozen(parsed.workflow.stages), true);
});

test("schema is published as Draft 2020-12 with a stable versioned id", () => {
  assert.equal(STAFFEL_CONFIG_SCHEMA_V1.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(STAFFEL_CONFIG_SCHEMA_V1.$id, "urn:staffel:schema:config:v1");
  assert.deepEqual(STAFFEL_CONFIG_SCHEMA_V1.properties.configVersion, { const: 1 });
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const publishedSchema = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "dist/schemas/staffel-config-v1.json"), "utf8")
  );
  assert.deepEqual(publishedSchema, STAFFEL_CONFIG_SCHEMA_V1);
});

test("malformed nested configuration returns issues instead of throwing", () => {
  const invalid = structuredClone(referenceFixture);
  invalid.workflow.stages.grilling = null;
  invalid.workflow.normalTransitions.grilling = null;
  assert.doesNotThrow(() => validateStaffelConfig(invalid));
  const issues = validateStaffelConfig(invalid);
  assert.ok(issues.some((entry) => entry.path === "$.workflow.stages.grilling"));
  assert.ok(issues.some((entry) => entry.path === "$.workflow.normalTransitions.grilling"));
});

test("configuration validation rejects unknown versions and graph drift", () => {
  const invalid = structuredClone(referenceFixture);
  invalid.configVersion = 2;
  invalid.workflow.enabledStages.push("missing-stage");
  invalid.workflow.normalTransitions.grilling.push("missing-stage");

  const issues = validateStaffelConfig(invalid);
  assert.ok(issues.some((entry) => entry.path === "$.configVersion"));
  assert.ok(issues.some((entry) => entry.message.includes("missing stage missing-stage")));
  assert.throws(() => parseStaffelConfig(invalid), StaffelConfigValidationError);
});

test("configuration requires exact workflow, CLI, and plugin versions", () => {
  const invalid = structuredClone(referenceFixture);
  invalid.compatibility.workflow = "^0.1.0-alpha.1";
  invalid.compatibility.cli = "latest";
  invalid.compatibility.plugin = "*";

  const issues = validateStaffelConfig(invalid);
  assert.equal(
    issues.filter((entry) => entry.message.includes("exact semantic version")).length,
    3
  );
});

test("configuration rejects duplicate identifiers and unknown fields", () => {
  const invalid = structuredClone(referenceFixture);
  invalid.repository.taskTypes.push("Maintenance");
  invalid.workflow.enabledStages.push("cleanup-pending");
  invalid.unexpected = true;
  const issues = validateStaffelConfig(invalid);
  assert.ok(issues.some((entry) => entry.path === "$.unexpected"));
  assert.ok(issues.some((entry) => entry.path === "$.repository.taskTypes" && entry.message.includes("duplicates")));
  assert.ok(issues.some((entry) => entry.path === "$.workflow.enabledStages" && entry.message.includes("duplicates")));
});
