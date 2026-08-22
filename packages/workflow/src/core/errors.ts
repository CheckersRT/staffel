import type { ValidationIssue } from "./types.js";

export class StaffelConfigValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Invalid Staffel configuration:\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}`
    );
    this.name = "StaffelConfigValidationError";
    this.issues = issues;
  }
}
