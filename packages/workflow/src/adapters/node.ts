import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { StaffelConfig } from "../core/types.js";
import type {
  ClockPort,
  ContentHasherPort,
  GitRepositoryPort,
  ProcessPort,
  ProcessResult,
  ProcessRunOptions,
  WorkflowLockPort,
  WorkflowStoragePort,
} from "../application/ports.js";

export class NodeProcessAdapter implements ProcessPort {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): ProcessResult {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = result.status ?? 1;
    const output = {
      status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
    if (status !== 0 && !options.allowFailure) {
      const detail = output.stderr.trim() || output.stdout.trim();
      throw new Error(`${command} failed (${status}): ${detail}`);
    }
    return output;
  }
}

export class GitCliAdapter implements GitRepositoryPort {
  readonly repositoryRoot: string;
  readonly #process: ProcessPort;

  constructor(repositoryRoot: string, process: ProcessPort = new NodeProcessAdapter()) {
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.#process = process;
  }

  currentBranch(): string {
    return this.#git(["branch", "--show-current"]).stdout.trim();
  }

  branchExists(branch: string): boolean {
    return this.#git(["show-ref", "--verify", `refs/heads/${branch}`], true).status === 0;
  }

  switchBranch(branch: string): void {
    this.#git(["switch", branch]);
  }

  createBranch(branch: string): void {
    this.#git(["switch", "-c", branch]);
  }

  changedPaths(paths: readonly string[] = []): readonly string[] {
    const args = ["status", "--porcelain", "--untracked-files=all"];
    if (paths.length > 0) args.push("--", ...paths);
    return statusPaths(this.#git(args).stdout);
  }

  headCommit(): string {
    return this.#git(["rev-parse", "HEAD"]).stdout.trim();
  }

  parentCommit(): string | null {
    const result = this.#git(["rev-parse", "HEAD^"], true);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  readHeadFile(repoPath: string): string | null {
    return this.#readObject(`HEAD:${repoPath}`);
  }

  readIndexFile(repoPath: string): string | null {
    return this.#readObject(`:${repoPath}`);
  }

  stage(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.#git(["add", "--", ...paths]);
  }

  stagedPaths(): readonly string[] {
    return this.#git(["diff", "--cached", "--name-only"])
      .stdout.split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  commit(message: string): string {
    this.#git(["commit", "-m", message]);
    return this.headCommit();
  }

  #readObject(specifier: string): string | null {
    const exists = this.#git(["cat-file", "-e", specifier], true);
    if (exists.status !== 0) return null;
    return this.#git(["show", specifier]).stdout;
  }

  #git(args: readonly string[], allowFailure = false): ProcessResult {
    return this.#process.run("git", args, {
      cwd: this.repositoryRoot,
      allowFailure,
    });
  }
}

export interface NodeWorkflowStorageOptions {
  readonly repositoryRoot: string;
  readonly coordinationRoot?: string;
}

export class NodeWorkflowStorageAdapter implements WorkflowStoragePort {
  readonly repositoryRoot: string;
  readonly #coordinationRoot: string;
  readonly #config: StaffelConfig;

  constructor(config: StaffelConfig, options: NodeWorkflowStorageOptions) {
    this.#config = config;
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.#coordinationRoot = path.resolve(options.coordinationRoot ?? options.repositoryRoot);
  }

  readRegistry(): string {
    return readFileSync(this.#repositoryPath(this.#config.repository.paths.registry), "utf8");
  }

  writeRegistry(content: string): void {
    this.#write(this.#repositoryPath(this.#config.repository.paths.registry), content);
  }

  readLedger(): string {
    return readFileSync(this.#coordinationPath(this.#config.repository.paths.liveLedger), "utf8");
  }

  writeLedger(content: string): void {
    this.#write(this.#coordinationPath(this.#config.repository.paths.liveLedger), content);
  }

  packetExists(packetPath: string): boolean {
    const filePath = this.#repositoryPath(packetPath);
    return existsSync(filePath) && statSync(filePath).isFile();
  }

  readPacket(packetPath: string): string {
    return readFileSync(this.#repositoryPath(packetPath), "utf8");
  }

  writePacket(packetPath: string, content: string): void {
    this.#write(this.#repositoryPath(packetPath), content);
  }

  #repositoryPath(configuredPath: string): string {
    return resolveConfiguredPath(this.repositoryRoot, configuredPath);
  }

  #coordinationPath(configuredPath: string): string {
    return resolveConfiguredPath(this.#coordinationRoot, configuredPath);
  }

  #write(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

}

export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export class Sha256ContentHasher implements ContentHasherPort {
  hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}

export class FileWorkflowLockAdapter implements WorkflowLockPort {
  readonly #lockPath: string;

  constructor(lockPath: string) {
    this.#lockPath = path.resolve(lockPath);
  }

  async withLock<T>(callback: () => T | Promise<T>): Promise<T> {
    mkdirSync(path.dirname(this.#lockPath), { recursive: true });
    let descriptor: number;
    try {
      descriptor = openSync(this.#lockPath, "wx");
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Staffel workflow lock already exists: ${this.#lockPath}`, {
          cause: error,
        });
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      closeSync(descriptor);
      rmSync(this.#lockPath, { force: true });
      throw error;
    }
    try {
      return await callback();
    } finally {
      closeSync(descriptor);
      rmSync(this.#lockPath, { force: true });
    }
  }
}

function resolveConfiguredPath(root: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(root, configuredPath);
}

function statusPaths(output: string): readonly string[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(" -> ").at(-1) ?? "")
    .map((item) => item.replace(/^"|"$/g, ""));
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
