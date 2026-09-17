import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  FileWorkflowLockAdapter,
  GitCliAdapter,
  NodeWorkflowStorageAdapter,
  Sha256ContentHasher,
  SystemClockAdapter,
} from "../adapters/node.js";
import {
  NoTrackerAdapter,
  TrelloTrackerAdapter,
  trelloCredentialsFromEnvironment,
} from "../adapters/tracker.js";
import type { TrackerPort } from "../application/tracker.js";
import { WorkflowService } from "../application/workflow-service.js";
import {
  findLiveLedgerEntry,
  packetStage,
  parseLiveLedger,
  parseTaskPacket,
  parseTaskRegistry,
} from "../core/documents.js";
import { BLANK_LIVE_LEDGER_TEMPLATE, BLANK_TASK_REGISTRY_TEMPLATE } from "../core/templates.js";
import type { StaffelConfig, TaskRegistryEntry } from "../core/types.js";
import { parseStaffelConfig } from "../core/validation.js";
import { getExpectedPacketStages, getStage } from "../core/workflow.js";
import { normalizeTaskId } from "../core/normalization.js";
import { configError, normalizeCliError, stateError } from "./errors.js";
import { STAFFEL_CLI_VERSION } from "./contracts.js";
import { DEFAULT_STAFFEL_CONFIG, renderDefaultConfigModule } from "./default-config.js";

export interface RuntimeOptions {
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly coordinationRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface StaffelRuntime {
  readonly options: RuntimeOptions;
  readonly config: StaffelConfig;
  readonly storage: NodeWorkflowStorageAdapter;
  readonly git: GitCliAdapter;
  readonly tracker: TrackerPort;
  readonly service: WorkflowService;
}

export async function loadRuntime(options: RuntimeOptions): Promise<StaffelRuntime> {
  const config = await loadConfig(options.repositoryRoot, options.configPath);
  const storage = new NodeWorkflowStorageAdapter(config, {
    repositoryRoot: options.repositoryRoot,
    coordinationRoot: options.coordinationRoot,
  });
  const git = new GitCliAdapter(options.repositoryRoot);
  const tracker = createTracker(config, options.environment);
  const ledgerPath = resolveConfiguredPath(options.coordinationRoot, config.repository.paths.liveLedger);
  const service = new WorkflowService({
    config,
    storage,
    git,
    clock: new SystemClockAdapter(),
    hasher: new Sha256ContentHasher(),
    lock: new FileWorkflowLockAdapter(`${ledgerPath}.lock`),
    stageSync: config.tracker.provider === "none" ? undefined : tracker,
  });
  return { options, config, storage, git, tracker, service };
}

export async function loadConfig(repositoryRoot: string, configPath: string): Promise<StaffelConfig> {
  const absolute = resolveConfiguredPath(repositoryRoot, configPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw configError(`Staffel configuration does not exist: ${absolute}`);
  }
  try {
    const url = pathToFileURL(absolute);
    url.searchParams.set("mtime", String(statSync(absolute).mtimeMs));
    const loaded = await import(url.href) as { readonly default?: unknown };
    return parseStaffelConfig(loaded.default);
  } catch (error) {
    if (error instanceof Error && error.name === "StaffelConfigValidationError") throw error;
    throw configError(
      `Could not load Staffel configuration: ${absolute}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

export function createTracker(
  config: StaffelConfig,
  environment: NodeJS.ProcessEnv = process.env
): TrackerPort {
  if (config.tracker.provider === "none") return new NoTrackerAdapter();
  return new TrelloTrackerAdapter(
    config.tracker,
    trelloCredentialsFromEnvironment(config.tracker, environment)
  );
}

export async function initializeRepository(input: {
  readonly options: RuntimeOptions;
  readonly dryRun: boolean;
}): Promise<unknown> {
  const { options } = input;
  const configFile = resolveConfiguredPath(options.repositoryRoot, options.configPath);
  const configExists = existsSync(configFile);
  const config = configExists
    ? await loadConfig(options.repositoryRoot, options.configPath)
    : parseStaffelConfig(structuredClone(DEFAULT_STAFFEL_CONFIG));
  const configContent = configExists ? readFileSync(configFile, "utf8") : renderDefaultConfigModule();
  const registryFile = resolveConfiguredPath(options.repositoryRoot, config.repository.paths.registry);
  const packetsDirectory = resolveConfiguredPath(options.repositoryRoot, config.repository.paths.taskPackets);
  const ledgerFile = resolveConfiguredPath(options.coordinationRoot, config.repository.paths.liveLedger);
  const configRepoPath = repoRelativePath(options.repositoryRoot, configFile);
  const registryRepoPath = repoRelativePath(options.repositoryRoot, registryFile);
  if (!configRepoPath || !registryRepoPath) {
    throw stateError("staffel init requires the config and task registry to be inside the repository.");
  }
  const targets = [
    { path: configFile, content: configContent, kind: "config" },
    { path: registryFile, content: BLANK_TASK_REGISTRY_TEMPLATE, kind: "registry" },
    { path: ledgerFile, content: BLANK_LIVE_LEDGER_TEMPLATE, kind: "ledger" },
  ] as const;
  for (const target of targets) {
    if (existsSync(target.path) && readFileSync(target.path, "utf8") !== target.content) {
      if (target.kind === "config") continue;
      throw stateError(`Refusing to overwrite existing ${target.kind}: ${target.path}`);
    }
  }
  const git = new GitCliAdapter(options.repositoryRoot);
  try {
    if (!git.currentBranch()) throw new Error("detached");
  } catch {
    throw stateError("staffel init requires an existing Git repository.");
  }
  const gitignoreFile = path.join(options.repositoryRoot, ".gitignore");
  const ledgerIgnore = repoRelativePath(options.repositoryRoot, ledgerFile);
  const lockIgnore = ledgerIgnore ? `${ledgerIgnore}.lock` : null;
  const existingGitignore = existsSync(gitignoreFile) ? readFileSync(gitignoreFile, "utf8") : "";
  let nextGitignore = existingGitignore;
  for (const ignored of [ledgerIgnore, lockIgnore]) {
    if (ignored && !isIgnoredLine(nextGitignore, ignored)) {
      nextGitignore = `${nextGitignore}${nextGitignore && !nextGitignore.endsWith("\n") ? "\n" : ""}${ignored}\n`;
    }
  }
  const artifactsComplete = targets.every((target) => existsSync(target.path)) &&
    existsSync(packetsDirectory) && nextGitignore === existingGitignore;
  const alreadyComplete = artifactsComplete &&
    git.changedPaths([configRepoPath, registryRepoPath, ".gitignore"]).length === 0;
  const plannedPaths = [
    ...targets.filter((target) => !existsSync(target.path)).map((target) => target.path),
    ...(!existsSync(packetsDirectory) ? [packetsDirectory] : []),
    ...(nextGitignore !== existingGitignore ? [gitignoreFile] : []),
  ];
  if (input.dryRun) {
    return {
      operation: "init",
      dryRun: true,
      alreadyComplete,
      wouldCreate: plannedPaths,
      commit: null,
    };
  }
  if (alreadyComplete) {
    return { operation: "init", dryRun: false, alreadyComplete: true, created: [], commit: null };
  }
  const unrelatedBefore = git.changedPaths().filter((item) => {
    const allowed = [configRepoPath, registryRepoPath, ".gitignore"];
    return !allowed.includes(item);
  });
  if (unrelatedBefore.length > 0) {
    throw stateError(`Refusing to initialize with unrelated local changes: ${unrelatedBefore.join(", ")}`);
  }
  const modifiedTracked = git.changedPaths([configRepoPath, registryRepoPath, ".gitignore"])
    .filter((item) => git.readHeadFile(item) !== null);
  if (modifiedTracked.length > 0) {
    throw stateError(`Refusing to initialize with pre-existing tracked changes: ${modifiedTracked.join(", ")}`);
  }
  for (const target of targets) {
    if (!existsSync(target.path)) {
      mkdirSync(path.dirname(target.path), { recursive: true });
      writeFileSync(target.path, target.content);
    }
  }
  mkdirSync(packetsDirectory, { recursive: true });
  if (nextGitignore !== existingGitignore) writeFileSync(gitignoreFile, nextGitignore);
  const commitPaths = [configRepoPath, registryRepoPath];
  if (nextGitignore !== existingGitignore) commitPaths.push(".gitignore");
  git.stage(commitPaths);
  const commit = git.stagedPaths().length > 0
    ? git.commit("chore: initialize Staffel workflow")
    : git.headCommit();
  return {
    operation: "init",
    dryRun: false,
    alreadyComplete: false,
    created: plannedPaths,
    commit,
  };
}

export function repositoryStatus(runtime: StaffelRuntime): unknown {
  const registry = parseTaskRegistry(runtime.storage.readRegistry());
  const ledger = parseLiveLedger(runtime.storage.readLedger());
  return {
    operation: "status",
    repository: runtime.options.repositoryRoot,
    tracker: runtime.config.tracker.provider,
    tasks: registry.map((entry) => {
      const active = ledger.find((item) => item.taskId === entry.taskId);
      return {
        task: entry.taskId,
        name: entry.name,
        type: entry.taskType,
        packet: entry.packetPath,
        stage: active?.fields.Stage ?? null,
        status: active?.fields.Status ?? null,
      };
    }),
  };
}

export async function doctor(runtime: StaffelRuntime): Promise<unknown> {
  let gitBranch = "";
  try {
    gitBranch = runtime.git.currentBranch();
  } catch {
    // Report the failed probe alongside the other installation diagnostics.
  }
  const diagnostics = [
    fileDiagnostic("registry", resolveConfiguredPath(runtime.options.repositoryRoot, runtime.config.repository.paths.registry)),
    fileDiagnostic("ledger", resolveConfiguredPath(runtime.options.coordinationRoot, runtime.config.repository.paths.liveLedger)),
    directoryDiagnostic("packets", resolveConfiguredPath(runtime.options.repositoryRoot, runtime.config.repository.paths.taskPackets)),
    {
      ok: runtime.config.compatibility.cli === STAFFEL_CLI_VERSION,
      code: "compatibility.cli",
      message: `Configured ${runtime.config.compatibility.cli}; running ${STAFFEL_CLI_VERSION}.`,
    },
    {
      ok: Boolean(gitBranch),
      code: "installation.git",
      message: gitBranch ? `Attached to Git branch ${gitBranch}.` : "Not attached to a Git branch.",
    },
    ...await runtime.tracker.diagnose(),
  ];
  return { operation: "doctor", healthy: diagnostics.every((item) => item.ok), diagnostics };
}

export async function diagnoseInstallation(options: RuntimeOptions): Promise<unknown> {
  const configFile = resolveConfiguredPath(options.repositoryRoot, options.configPath);
  if (!existsSync(configFile) || !statSync(configFile).isFile()) {
    return {
      operation: "doctor",
      healthy: false,
      diagnostics: [{
        ok: false,
        code: "installation.config",
        message: `Missing file: ${configFile}`,
      }],
    };
  }
  try {
    const result = await doctor(await loadRuntime(options)) as {
      readonly operation: string;
      readonly healthy: boolean;
      readonly diagnostics: readonly unknown[];
    };
    return {
      ...result,
      diagnostics: [
        { ok: true, code: "installation.config", message: configFile },
        ...result.diagnostics,
      ],
    };
  } catch (error) {
    const normalized = normalizeCliError(error);
    return {
      operation: "doctor",
      healthy: false,
      diagnostics: [{ ok: false, code: normalized.code, message: normalized.message }],
    };
  }
}

export function validateEmbeddedV1(runtime: StaffelRuntime, dryRun: boolean): unknown {
  const registryContent = runtime.storage.readRegistry();
  const ledgerContent = runtime.storage.readLedger();
  const registry = parseTaskRegistry(registryContent);
  const ledger = parseLiveLedger(ledgerContent);
  const ids = new Set<string>();
  const packets = new Map<string, string>();
  const artifacts: Array<{ path: string; sha256: string }> = [];
  artifacts.push(digestArtifact(runtime.config.repository.paths.registry, registryContent));
  artifacts.push(digestArtifact(runtime.config.repository.paths.liveLedger, ledgerContent));
  for (const entry of registry) {
    if (ids.has(entry.taskId)) throw stateError(`Duplicate embedded-v1 registry task #${entry.taskId}.`);
    ids.add(entry.taskId);
    if (!runtime.storage.packetExists(entry.packetPath)) {
      throw stateError(`Missing embedded-v1 packet for task #${entry.taskId}: ${entry.packetPath}`);
    }
    const content = runtime.storage.readPacket(entry.packetPath);
    const packetId = embeddedV1PacketId(content);
    if (entry.taskId !== packetId) {
      throw stateError(`Embedded-v1 packet identity mismatch for task #${entry.taskId}.`);
    }
    packetStage(content);
    packets.set(entry.taskId, content);
    artifacts.push(digestArtifact(entry.packetPath, content));
  }
  for (const entry of ledger) {
    if (ledger.filter((item) => item.taskId === entry.taskId).length > 1) {
      throw stateError(`Duplicate embedded-v1 live-ledger task #${entry.taskId}.`);
    }
    if (!ids.has(entry.taskId)) {
      throw stateError(`Live ledger task #${entry.taskId} has no embedded-v1 registry entry.`);
    }
    const stage = entry.fields.Stage;
    if (!stage) throw stateError(`Live ledger task #${entry.taskId} has no Stage.`);
    const registryEntry = registry.find((item) => item.taskId === entry.taskId);
    const packetContent = packets.get(entry.taskId);
    if (!registryEntry || !packetContent) throw stateError(`Missing embedded-v1 identity for task #${entry.taskId}.`);
    if (entry.name !== registryEntry.name || entry.fields["Task packet"] !== registryEntry.packetPath) {
      throw stateError(`Embedded-v1 ledger identity mismatch for task #${entry.taskId}.`);
    }
    // Archived packets only need a stable identity and stage. Active packets must
    // also satisfy the executable packet contract used by workflow transitions.
    const packet = parseTaskPacket(packetContent);
    assertPacketIdentity(registryEntry, packet.taskId, packet.name, packet.taskType);
    if (stage !== "dispatching") {
      getStage(runtime.config, stage);
      if (!getExpectedPacketStages(runtime.config, stage).includes(packet.stage)) {
        throw stateError(
          `Embedded-v1 packet stage ${packet.stage} is incompatible with ledger stage ${stage} for task #${entry.taskId}.`
        );
      }
    }
  }
  return {
    operation: "migrate",
    from: "embedded-v1",
    dryRun,
    rewritten: false,
    valid: true,
    counts: { registry: registry.length, packets: artifacts.length - 2, ledger: ledger.length },
    artifacts,
  };
}

function embeddedV1PacketId(content: string): string {
  const title = content.replace(/\r\n/g, "\n").split("\n", 1)[0] ?? "";
  const match = title.match(/^#\s*#?\s*0*(\d+[A-Za-z]?)\s+\S/);
  if (!match?.[1]) throw stateError("Embedded-v1 packet is missing its task title.");
  return normalizeTaskId(match[1]);
}

export function trackerTask(runtime: StaffelRuntime, taskId: string): {
  readonly taskId: string;
  readonly title: string;
  readonly taskType: string;
  readonly packetPath: string;
} {
  const entry = taskRegistryEntry(runtime, taskId);
  return {
    taskId: entry.taskId,
    title: `#${entry.taskId} ${entry.name}`,
    taskType: entry.taskType,
    packetPath: entry.packetPath,
  };
}

export function activeTaskTrackerDestination(runtime: StaffelRuntime, taskId: string): string | null {
  const stage = findLiveLedgerEntry(runtime.storage.readLedger(), normalizeTaskId(taskId))?.fields.Stage;
  return stage && stage !== "dispatching" ? getStage(runtime.config, stage).trackerList : null;
}

function taskRegistryEntry(runtime: StaffelRuntime, taskId: string): TaskRegistryEntry {
  const normalized = normalizeTaskId(taskId);
  const matches = parseTaskRegistry(runtime.storage.readRegistry())
    .filter((entry) => entry.taskId === normalized);
  if (matches.length !== 1) throw stateError(`Expected exactly one registry entry for task #${taskId}.`);
  return matches[0] as TaskRegistryEntry;
}

function assertPacketIdentity(
  entry: TaskRegistryEntry,
  taskId: string,
  name: string,
  taskType: string
): void {
  if (entry.taskId !== taskId || entry.name !== name || entry.taskType !== taskType) {
    throw stateError(`Embedded-v1 packet identity mismatch for task #${entry.taskId}.`);
  }
}

function digestArtifact(artifactPath: string, content: string) {
  return { path: artifactPath, sha256: createHash("sha256").update(content).digest("hex") };
}

function fileDiagnostic(name: string, filePath: string) {
  const ok = existsSync(filePath) && statSync(filePath).isFile();
  return { ok, code: `installation.${name}`, message: ok ? filePath : `Missing file: ${filePath}` };
}

function directoryDiagnostic(name: string, directoryPath: string) {
  const ok = existsSync(directoryPath) && statSync(directoryPath).isDirectory();
  return { ok, code: `installation.${name}`, message: ok ? directoryPath : `Missing directory: ${directoryPath}` };
}

function resolveConfiguredPath(root: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? path.normalize(configuredPath) : path.resolve(root, configuredPath);
}

function repoRelativePath(repositoryRoot: string, filePath: string): string | null {
  const relative = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
  return relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}

function isIgnoredLine(content: string, repoPath: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === repoPath);
}
