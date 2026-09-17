import path from "node:path";

import { CLI_COMMANDS, STAFFEL_CAPABILITIES_V1, type CliCommand } from "./contracts.js";
import { normalizeCliError, usageError } from "./errors.js";
import {
  activeTaskTrackerDestination,
  diagnoseInstallation,
  initializeRepository,
  loadRuntime,
  repositoryStatus,
  trackerTask,
  validateEmbeddedV1,
  type RuntimeOptions,
} from "./runtime.js";

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface CliRunResult {
  readonly exitCode: number;
}

const COMMAND_ALIASES: Readonly<Record<string, CliCommand>> = Object.freeze({
  initialize: "init",
  begin: "stage",
  "agent:dispatch": "dispatch",
  "agent:stage": "stage",
  "agent:handoff": "handoff",
  "trello:agent": "tracker",
});

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env
): Promise<CliRunResult> {
  let command: CliCommand | null = null;
  try {
    const parsed = parseArguments(argv);
    command = parsed.command;
    const result = await executeCommand(parsed.command, parsed.options, environment);
    io.writeStdout(`${JSON.stringify({ ok: true, command, result })}\n`);
    return { exitCode: 0 };
  } catch (error) {
    const normalized = normalizeCliError(error);
    io.writeStdout(`${JSON.stringify({
      ok: false,
      command,
      error: {
        code: normalized.code,
        message: normalized.message,
        exitCode: normalized.exitCode,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    })}\n`);
    return { exitCode: normalized.exitCode };
  }
}

async function executeCommand(
  command: CliCommand,
  options: Readonly<Record<string, string | boolean>>,
  environment: NodeJS.ProcessEnv
): Promise<unknown> {
  validateCommandOptions(command, options);
  if (command === "capabilities") return STAFFEL_CAPABILITIES_V1;
  const runtimeOptions = resolveRuntimeOptions(options, environment);
  const dryRun = booleanOption(options, "dry-run");
  if (command === "init") return initializeRepository({ options: runtimeOptions, dryRun });
  if (command === "doctor") return diagnoseInstallation({ ...runtimeOptions, environment });
  if (command === "migrate" && requiredOption(options, "from") !== "embedded-v1") {
    throw usageError("Only --from embedded-v1 is supported.");
  }
  const runtime = await loadRuntime({ ...runtimeOptions, environment });
  switch (command) {
    case "dispatch":
      return runtime.service.dispatch({
        taskId: requiredOption(options, "task"),
        name: requiredOption(options, "name"),
        taskType: requiredOption(options, "type"),
        stage: requiredOption(options, "stage"),
        goal: requiredOption(options, "goal"),
        slug: stringOption(options, "slug"),
        handoff: stringOption(options, "handoff"),
        startPrompt: stringOption(options, "start-prompt"),
        dryRun,
      });
    case "stage":
      return runtime.service.begin({ taskId: requiredOption(options, "task"), dryRun });
    case "handoff":
      return runtime.service.handoff({
        taskId: requiredOption(options, "task"),
        to: requiredOption(options, "to"),
        reason: stringOption(options, "reason"),
        startPrompt: stringOption(options, "start-prompt"),
        dryRun,
      });
    case "tracker": {
      const task = trackerTask(runtime, requiredOption(options, "task"));
      const current = await runtime.tracker.inspect(task);
      const destination = stringOption(options, "to");
      if (!destination || dryRun) {
        return {
          operation: "tracker",
          provider: runtime.tracker.provider,
          task: task.taskId,
          current,
          destination: destination ?? activeTaskTrackerDestination(runtime, task.taskId),
          dryRun,
        };
      }
      return {
        operation: "tracker",
        provider: runtime.tracker.provider,
        task: task.taskId,
        current,
        synced: await runtime.tracker.sync(task, destination),
        dryRun: false,
      };
    }
    case "status":
      return repositoryStatus(runtime);
    case "migrate": {
      return validateEmbeddedV1(runtime, dryRun);
    }
    default:
      throw usageError(`Unsupported command: ${command}`);
  }
}

const COMMON_OPTIONS = ["repository", "config", "coordination-root", "json"] as const;
const COMMAND_OPTIONS: Readonly<Record<CliCommand, readonly string[]>> = Object.freeze({
  init: [...COMMON_OPTIONS, "dry-run"],
  dispatch: [...COMMON_OPTIONS, "dry-run", "task", "name", "type", "stage", "goal", "slug", "handoff", "start-prompt"],
  stage: [...COMMON_OPTIONS, "dry-run", "task"],
  handoff: [...COMMON_OPTIONS, "dry-run", "task", "to", "reason", "start-prompt"],
  tracker: [...COMMON_OPTIONS, "dry-run", "task", "to"],
  status: COMMON_OPTIONS,
  doctor: COMMON_OPTIONS,
  capabilities: ["json"],
  migrate: [...COMMON_OPTIONS, "dry-run", "from"],
});
const REQUIRED_OPTIONS: Readonly<Partial<Record<CliCommand, readonly string[]>>> = Object.freeze({
  dispatch: ["task", "name", "type", "stage", "goal"],
  stage: ["task"],
  handoff: ["task", "to"],
  tracker: ["task"],
  migrate: ["from"],
});

function validateCommandOptions(
  command: CliCommand,
  options: Readonly<Record<string, string | boolean>>
): void {
  const allowed = new Set(COMMAND_OPTIONS[command]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw usageError(`Unknown option for ${command}: --${key}`);
  }
  booleanOption(options, "json");
  if (allowed.has("dry-run")) booleanOption(options, "dry-run");
  for (const required of REQUIRED_OPTIONS[command] ?? []) requiredOption(options, required);
}

function parseArguments(argv: readonly string[]): {
  readonly command: CliCommand;
  readonly options: Readonly<Record<string, string | boolean>>;
} {
  const [commandInput, ...rest] = argv;
  if (!commandInput) throw usageError("A command is required.", { commands: CLI_COMMANDS });
  const command = CLI_COMMANDS.includes(commandInput as CliCommand)
    ? commandInput as CliCommand
    : COMMAND_ALIASES[commandInput];
  if (!command) throw usageError(`Unknown command: ${commandInput}`, { commands: CLI_COMMANDS });
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw usageError(`Unexpected positional argument: ${String(token)}`);
    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!rawKey) throw usageError("Option names must not be empty.");
    if (rawKey in options) throw usageError(`Option --${rawKey} was provided more than once.`);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[rawKey] = next;
      index += 1;
    } else {
      options[rawKey] = true;
    }
  }
  return { command, options };
}

function resolveRuntimeOptions(
  options: Readonly<Record<string, string | boolean>>,
  environment: NodeJS.ProcessEnv
): RuntimeOptions {
  const repositoryRoot = path.resolve(
    stringOption(options, "repository") ?? environment.STAFFEL_REPOSITORY ?? process.cwd()
  );
  const coordinationRoot = path.resolve(
    stringOption(options, "coordination-root") ?? environment.STAFFEL_COORDINATION_ROOT ?? repositoryRoot
  );
  return {
    repositoryRoot,
    coordinationRoot,
    configPath: stringOption(options, "config") ?? environment.STAFFEL_CONFIG ?? "staffel.config.mjs",
  };
}

function requiredOption(options: Readonly<Record<string, string | boolean>>, name: string): string {
  const value = stringOption(options, name);
  if (!value) throw usageError(`--${name} is required.`);
  return value;
}

function stringOption(
  options: Readonly<Record<string, string | boolean>>,
  name: string
): string | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw usageError(`--${name} requires a value.`);
  return value;
}

function booleanOption(options: Readonly<Record<string, string | boolean>>, name: string): boolean {
  const value = options[name];
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw usageError(`--${name} must be a boolean flag.`);
}
