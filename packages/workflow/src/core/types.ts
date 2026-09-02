export type StageKind = "ready" | "active" | "result" | "lifecycle";

export interface StageDefinition {
  readonly kind: StageKind;
  readonly nextRole: string;
  readonly rolePlaybook: string;
  readonly trackerList: string;
  readonly status: string;
  readonly beginsAs?: string;
  readonly packetStages?: readonly string[];
}

export type NormalTransitionMap = Readonly<
  Record<string, readonly string[]>
>;

export interface WorkflowDefinition {
  readonly enabledStages: readonly string[];
  readonly stages: Readonly<Record<string, StageDefinition>>;
  readonly normalTransitions: NormalTransitionMap;
  readonly blockedDestinations: Readonly<Record<string, string>>;
}

export interface RepositoryPaths {
  readonly registry: string;
  readonly taskPackets: string;
  readonly liveLedger: string;
  readonly rolePlaybooks: string;
}

export interface RepositoryConfig {
  readonly timezone: string;
  readonly branchPrefix: string;
  readonly taskTypes: readonly string[];
  readonly paths: RepositoryPaths;
}

export interface NoTrackerConfig {
  readonly provider: "none";
}

export interface TrelloTrackerConfig {
  readonly provider: "trello";
  readonly boardIdEnvironmentVariable: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly tokenEnvironmentVariable: string;
  readonly listIds: Readonly<Record<string, string>>;
  readonly taskTypeLabelIds: Readonly<Record<string, string>>;
}

export type TrackerConfig = NoTrackerConfig | TrelloTrackerConfig;

export interface StaffelConfigV1 {
  readonly configVersion: 1;
  readonly compatibility: {
    readonly workflow: string;
    readonly cli: string;
    readonly plugin: string;
  };
  readonly repository: RepositoryConfig;
  readonly workflow: WorkflowDefinition;
  readonly tracker: TrackerConfig;
}

export type StaffelConfig = StaffelConfigV1;

export type TransitionClassification = "normal" | "exceptional";

export interface ValidatedTransition {
  readonly from: string;
  readonly to: string;
  readonly classification: TransitionClassification;
  readonly reason: string | null;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface StaffelTemplatesV1 {
  readonly version: 1;
  readonly taskRegistry: string;
  readonly taskPacket: string;
  readonly liveLedger: string;
}

export type TransitionOperation = "begin" | "handoff";

export interface TransitionReservation {
  readonly operation: TransitionOperation;
  readonly from: string;
  readonly to: string;
  readonly reason: string | null;
  readonly baseCommit: string | null;
  readonly expectedPacketHash: string | null;
  readonly packetCommit: string | null;
}

export interface TaskPacket {
  readonly taskId: string;
  readonly name: string;
  readonly taskType: string;
  readonly stage: string;
  readonly nextRole: string;
  readonly rolePlaybook: string;
  readonly stageBrief: string;
  readonly content: string;
}

export interface LiveLedgerEntry {
  readonly taskId: string;
  readonly name: string;
  readonly section: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface TaskRegistryEntry {
  readonly taskId: string;
  readonly name: string;
  readonly taskType: string;
  readonly packetPath: string;
  readonly section: string;
}
