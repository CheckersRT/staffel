import { StaffelConfigValidationError } from "../core/errors.js";
import { TrackerAdapterError } from "../adapters/tracker.js";

export const CLI_EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  config: 3,
  state: 4,
  tracker: 5,
  internal: 10,
});

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, exitCode: number, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(message: string, details?: unknown): CliError {
  return new CliError("cli.usage", message, CLI_EXIT_CODES.usage, details);
}

export function configError(message: string, details?: unknown): CliError {
  return new CliError("config.invalid", message, CLI_EXIT_CODES.config, details);
}

export function stateError(message: string, details?: unknown): CliError {
  return new CliError("state.invalid", message, CLI_EXIT_CODES.state, details);
}

export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof StaffelConfigValidationError) {
    return configError(error.message, { issues: error.issues });
  }
  if (error instanceof TrackerAdapterError) {
    return new CliError(error.code, error.message, CLI_EXIT_CODES.tracker);
  }
  if (error instanceof Error) {
    const isState = /task|packet|ledger|registry|checkout|branch|transition|workflow|artifact|stage|local changes|\bgit\b|\bhead\b|commit|ENOENT/i.test(error.message);
    return new CliError(
      isState ? "state.operation_failed" : "internal.unexpected",
      error.message,
      isState ? CLI_EXIT_CODES.state : CLI_EXIT_CODES.internal
    );
  }
  return new CliError("internal.unexpected", String(error), CLI_EXIT_CODES.internal);
}
