import { STAFFEL_CONFIG_VERSION } from "./config-schema.js";
import { StaffelConfigValidationError } from "./errors.js";
import type {
  StaffelConfig,
  StageDefinition,
  TransitionClassification,
  ValidationIssue,
} from "./types.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STAGE_KINDS = new Set(["ready", "active", "result", "lifecycle"]);

export function validateStaffelConfig(value: unknown): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: "$", message: "must be an object" }];
  }

  exactKeys(
    value,
    ["configVersion", "compatibility", "repository", "workflow", "tracker"],
    "$",
    issues
  );

  if (value.configVersion !== STAFFEL_CONFIG_VERSION) {
    issue(issues, "$.configVersion", `must equal ${STAFFEL_CONFIG_VERSION}`);
  }

  validateCompatibility(value.compatibility, issues);
  validateRepository(value.repository, issues);
  validateWorkflow(value.workflow, issues);
  validateTracker(value.tracker, issues);
  return issues;
}

export function parseStaffelConfig(value: unknown): StaffelConfig {
  const issues = validateStaffelConfig(value);
  if (issues.length > 0) {
    throw new StaffelConfigValidationError(issues);
  }
  return deepFreeze(value as StaffelConfig);
}

export function validateTransitionReason(
  classification: TransitionClassification,
  reason?: unknown
): string | null {
  if (reason !== undefined && reason !== null && /[\r\n]/.test(String(reason))) {
    throw new Error("Transition reason must be one line.");
  }

  const normalized = reason === undefined || reason === null
    ? ""
    : String(reason).trim();

  if (classification === "exceptional" && !normalized) {
    throw new Error("Exceptional transition requires --reason.");
  }

  return normalized || null;
}

function validateCompatibility(value: unknown, issues: ValidationIssue[]): void {
  const path = "$.compatibility";
  if (!recordAt(value, path, issues)) return;
  exactKeys(value, ["workflow", "cli", "plugin"], path, issues);
  for (const key of ["workflow", "cli", "plugin"] as const) {
    versionAt(value[key], `${path}.${key}`, issues);
  }
}

function validateRepository(value: unknown, issues: ValidationIssue[]): void {
  const path = "$.repository";
  if (!recordAt(value, path, issues)) return;
  exactKeys(value, ["timezone", "branchPrefix", "taskTypes", "paths"], path, issues);
  stringAt(value.timezone, `${path}.timezone`, issues);
  stringAt(value.branchPrefix, `${path}.branchPrefix`, issues);
  stringArrayAt(value.taskTypes, `${path}.taskTypes`, issues, true);

  const pathsPath = `${path}.paths`;
  if (!recordAt(value.paths, pathsPath, issues)) return;
  exactKeys(
    value.paths,
    ["registry", "taskPackets", "liveLedger", "rolePlaybooks"],
    pathsPath,
    issues
  );
  for (const key of ["registry", "taskPackets", "liveLedger", "rolePlaybooks"] as const) {
    stringAt(value.paths[key], `${pathsPath}.${key}`, issues);
  }
}

function validateWorkflow(value: unknown, issues: ValidationIssue[]): void {
  const path = "$.workflow";
  if (!recordAt(value, path, issues)) return;
  exactKeys(
    value,
    ["enabledStages", "stages", "normalTransitions", "blockedDestinations"],
    path,
    issues
  );
  const enabledStages = stringArrayAt(
    value.enabledStages,
    `${path}.enabledStages`,
    issues,
    true
  );

  const stages = validateStages(value.stages, `${path}.stages`, issues);
  const transitions = validateTransitions(
    value.normalTransitions,
    `${path}.normalTransitions`,
    issues
  );
  validateStringRecord(
    value.blockedDestinations,
    `${path}.blockedDestinations`,
    issues
  );

  if (!enabledStages || !stages) return;
  const enabled = new Set(enabledStages);
  for (const stageName of enabled) {
    if (!(stageName in stages)) {
      issue(issues, `${path}.enabledStages`, `references missing stage ${stageName}`);
    }
  }

  for (const [stageName, stage] of Object.entries(stages)) {
    if (stage.beginsAs && !enabled.has(stage.beginsAs)) {
      issue(issues, `${path}.stages.${stageName}.beginsAs`, `references disabled or missing stage ${stage.beginsAs}`);
    }
    for (const packetStage of stage.packetStages ?? []) {
      if (!enabled.has(packetStage)) {
        issue(issues, `${path}.stages.${stageName}.packetStages`, `references disabled or missing stage ${packetStage}`);
      }
    }
  }

  if (!transitions) return;
  for (const [from, destinations] of Object.entries(transitions)) {
    if (!enabled.has(from)) {
      issue(issues, `${path}.normalTransitions.${from}`, "source stage is disabled or missing");
    }
    for (const to of destinations) {
      if (!enabled.has(to)) {
        issue(issues, `${path}.normalTransitions.${from}`, `references disabled or missing stage ${to}`);
      }
    }
  }
}

function validateStages(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): Record<string, StageDefinition> | null {
  if (!recordAt(value, path, issues)) return null;
  if (Object.keys(value).length === 0) issue(issues, path, "must not be empty");
  const stages: Record<string, StageDefinition> = {};

  for (const [stageName, stageValue] of Object.entries(value)) {
    const stagePath = `${path}.${stageName}`;
    if (!recordAt(stageValue, stagePath, issues)) continue;
    exactKeys(
      stageValue,
      ["kind", "nextRole", "rolePlaybook", "trackerList", "status", "beginsAs", "packetStages"],
      stagePath,
      issues,
      ["beginsAs", "packetStages"]
    );
    if (typeof stageValue.kind !== "string" || !STAGE_KINDS.has(stageValue.kind)) {
      issue(issues, `${stagePath}.kind`, "must be ready, active, result, or lifecycle");
    }
    for (const key of ["nextRole", "rolePlaybook", "trackerList", "status"] as const) {
      stringAt(stageValue[key], `${stagePath}.${key}`, issues);
    }
    if (stageValue.beginsAs !== undefined) {
      stringAt(stageValue.beginsAs, `${stagePath}.beginsAs`, issues);
    }
    if (stageValue.packetStages !== undefined) {
      stringArrayAt(stageValue.packetStages, `${stagePath}.packetStages`, issues, true);
    }
    stages[stageName] = stageValue as unknown as StageDefinition;
  }
  return stages;
}

function validateTransitions(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): Record<string, readonly string[]> | null {
  if (!recordAt(value, path, issues)) return null;
  const transitions: Record<string, readonly string[]> = {};
  for (const [source, destinations] of Object.entries(value)) {
    const parsed = stringArrayAt(destinations, `${path}.${source}`, issues, false);
    if (parsed) transitions[source] = parsed;
  }
  return transitions;
}

function validateStringRecord(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): void {
  if (!recordAt(value, path, issues)) return;
  for (const [key, item] of Object.entries(value)) {
    stringAt(item, `${path}.${key}`, issues);
  }
}

function validateTracker(value: unknown, issues: ValidationIssue[]): void {
  const path = "$.tracker";
  if (!recordAt(value, path, issues)) return;
  if (value.provider === "none") {
    exactKeys(value, ["provider"], path, issues);
    return;
  }
  if (value.provider === "trello") {
    exactKeys(
      value,
      ["provider", "boardIdEnvironmentVariable", "apiKeyEnvironmentVariable", "tokenEnvironmentVariable"],
      path,
      issues
    );
    for (const key of ["boardIdEnvironmentVariable", "apiKeyEnvironmentVariable", "tokenEnvironmentVariable"] as const) {
      stringAt(value[key], `${path}.${key}`, issues);
    }
    return;
  }
  issue(issues, `${path}.provider`, "must be none or trello");
}

function exactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  issues: ValidationIssue[],
  optionalKeys: readonly string[] = []
): void {
  const allowed = new Set(allowedKeys);
  const optional = new Set(optionalKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, `${path}.${key}`, "is not allowed");
  }
  for (const key of allowed) {
    if (!optional.has(key) && !(key in value)) {
      issue(issues, `${path}.${key}`, "is required");
    }
  }
}

function recordAt(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  return true;
}

function stringAt(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || value.length === 0) {
    issue(issues, path, "must be a non-empty string");
    return false;
  }
  return true;
}

function versionAt(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!stringAt(value, path, issues)) return;
  if (!VERSION_PATTERN.test(value)) issue(issues, path, "must be an exact semantic version");
}

function stringArrayAt(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  requireItems: boolean
): readonly string[] | null {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return null;
  }
  if (requireItems && value.length === 0) issue(issues, path, "must not be empty");
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (strings.length !== value.length) issue(issues, path, "must contain only non-empty strings");
  if (new Set(strings).size !== strings.length) issue(issues, path, "must not contain duplicates");
  return strings;
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
