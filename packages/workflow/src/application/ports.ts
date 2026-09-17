export type Awaitable<T> = T | Promise<T>;

export interface WorkflowStoragePort {
  readonly repositoryRoot: string;
  readRegistry(): Awaitable<string>;
  writeRegistry(content: string): Awaitable<void>;
  readLedger(): Awaitable<string>;
  writeLedger(content: string): Awaitable<void>;
  packetExists(packetPath: string): Awaitable<boolean>;
  readPacket(packetPath: string): Awaitable<string>;
  writePacket(packetPath: string, content: string): Awaitable<void>;
}

export interface GitRepositoryPort {
  readonly repositoryRoot: string;
  currentBranch(): Awaitable<string>;
  branchExists(branch: string): Awaitable<boolean>;
  switchBranch(branch: string): Awaitable<void>;
  createBranch(branch: string): Awaitable<void>;
  changedPaths(paths?: readonly string[]): Awaitable<readonly string[]>;
  headCommit(): Awaitable<string>;
  parentCommit(): Awaitable<string | null>;
  readHeadFile(repoPath: string): Awaitable<string | null>;
  readIndexFile(repoPath: string): Awaitable<string | null>;
  stage(paths: readonly string[]): Awaitable<void>;
  stagedPaths(): Awaitable<readonly string[]>;
  commit(message: string): Awaitable<string>;
}

export interface ClockPort {
  now(): Date;
}

export interface ContentHasherPort {
  hash(content: string): Awaitable<string>;
}

export interface WorkflowLockPort {
  withLock<T>(callback: () => Awaitable<T>): Promise<T>;
}

export interface StageSyncState {
  readonly position: string | null;
  readonly reference: string | null;
}

export interface StageSyncTask {
  readonly taskId: string;
  readonly title: string;
  readonly taskType: string;
  readonly packetPath: string;
}

export interface StageSyncPort {
  inspect(task: StageSyncTask): Awaitable<StageSyncState>;
  sync(task: StageSyncTask, destination: string): Awaitable<StageSyncState>;
}

export interface ProcessRunOptions {
  readonly cwd: string;
  readonly allowFailure?: boolean;
}

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessPort {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): ProcessResult;
}

export class NoopWorkflowLock implements WorkflowLockPort {
  async withLock<T>(callback: () => Awaitable<T>): Promise<T> {
    return await callback();
  }
}
