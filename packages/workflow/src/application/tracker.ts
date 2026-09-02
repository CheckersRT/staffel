import type { Awaitable, StageSyncPort } from "./ports.js";

export interface TrackerDiagnostic {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

export interface TrackerPort extends StageSyncPort {
  readonly provider: "none" | "trello";
  diagnose(): Awaitable<readonly TrackerDiagnostic[]>;
}
