import {
  appendTaskRegistryEntry,
  assertReservationEquals,
  finalizeLiveLedgerDispatch,
  finalizeLiveLedgerTransition,
  findLiveLedgerEntry,
  formatTimestamp,
  insertLiveLedgerEntry,
  packetSection,
  paddedTaskId,
  parseTaskPacket,
  parseTaskRegistry,
  pendingTransition,
  recordLiveLedgerPacketCommit,
  renderLiveLedgerEntry,
  renderTaskPacket,
  renderTaskRegistryEntry,
  reserveLiveLedgerTransition,
  slugifyTaskName,
  transitionTaskPacket,
} from "../core/documents.js";
import { normalizeTaskId } from "../core/normalization.js";
import type {
  LiveLedgerEntry,
  StaffelConfig,
  TaskPacket,
  TransitionReservation,
} from "../core/types.js";
import {
  getBeginDestination,
  getExpectedPacketStages,
  getStage,
  isRoleActiveStage,
  validateTransition,
} from "../core/workflow.js";
import type {
  ClockPort,
  ContentHasherPort,
  GitRepositoryPort,
  StageSyncPort,
  StageSyncState,
  StageSyncTask,
  WorkflowLockPort,
  WorkflowStoragePort,
} from "./ports.js";

export interface WorkflowServiceDependencies {
  readonly config: StaffelConfig;
  readonly storage: WorkflowStoragePort;
  readonly git: GitRepositoryPort;
  readonly clock: ClockPort;
  readonly hasher: ContentHasherPort;
  readonly lock: WorkflowLockPort;
  readonly stageSync?: StageSyncPort;
}

export interface DispatchTaskInput {
  readonly taskId: string;
  readonly name: string;
  readonly taskType: string;
  readonly stage: string;
  readonly goal: string;
  readonly slug?: string;
  readonly handoff?: string | null;
  readonly startPrompt?: string | null;
  readonly dryRun?: boolean;
}

export interface DispatchTaskResult {
  readonly task: string;
  readonly title: string;
  readonly operation: "dispatch";
  readonly type: string;
  readonly branch: string;
  readonly packetPath: string;
  readonly stage: string;
  readonly nextRole: string;
  readonly rolePlaybook: string;
  readonly stageSyncFrom: string | null;
  readonly stageSyncTo: string;
  readonly dryRun: boolean;
  readonly alreadyComplete: boolean;
  readonly artifactCommit: string | null;
  readonly verified: boolean;
}

export interface BeginTaskInput {
  readonly taskId: string;
  readonly dryRun?: boolean;
}

export interface BeginTaskResult {
  readonly task: string;
  readonly title: string;
  readonly operation: "begin";
  readonly from: string;
  readonly to: string;
  readonly packetStage: string;
  readonly stageSyncFrom: string | null;
  readonly stageSyncTo: string;
  readonly dryRun: boolean;
  readonly alreadyComplete: boolean;
  readonly verified: boolean;
}

export interface HandoffTaskInput {
  readonly taskId: string;
  readonly to: string;
  readonly reason?: string | null;
  readonly startPrompt?: string | null;
  readonly dryRun?: boolean;
}

export interface HandoffTaskResult {
  readonly task: string;
  readonly title: string;
  readonly operation: "handoff";
  readonly from: string;
  readonly to: string;
  readonly classification: "normal" | "exceptional";
  readonly reason: string | null;
  readonly packet: string;
  readonly stageSyncFrom: string | null;
  readonly stageSyncTo: string;
  readonly dryRun: boolean;
  readonly alreadyComplete: boolean;
  readonly wouldCommit: readonly string[];
  readonly packetCommit: string | null;
  readonly verified: boolean;
}

interface TaskContext {
  readonly taskId: string;
  readonly title: string;
  readonly entry: LiveLedgerEntry;
  readonly packetPath: string;
  readonly packet: TaskPacket;
  readonly branch: string;
  readonly ledger: string;
}

interface HandoffPlan {
  readonly content: string;
  readonly reservation: TransitionReservation;
  readonly needsCommit: boolean;
  readonly existingCommit: string | null;
}

export class WorkflowService {
  readonly #config: StaffelConfig;
  readonly #storage: WorkflowStoragePort;
  readonly #git: GitRepositoryPort;
  readonly #clock: ClockPort;
  readonly #hasher: ContentHasherPort;
  readonly #lock: WorkflowLockPort;
  readonly #stageSync?: StageSyncPort;

  constructor(dependencies: WorkflowServiceDependencies) {
    this.#config = dependencies.config;
    this.#storage = dependencies.storage;
    this.#git = dependencies.git;
    this.#clock = dependencies.clock;
    this.#hasher = dependencies.hasher;
    this.#lock = dependencies.lock;
    this.#stageSync = dependencies.stageSync;
    if (this.#storage.repositoryRoot !== this.#git.repositoryRoot) {
      throw new Error("Storage and Git adapters must target the same repository root.");
    }
  }

  async dispatch(input: DispatchTaskInput): Promise<DispatchTaskResult> {
    const taskId = normalizeTaskId(input.taskId);
    const taskType = this.#taskType(input.taskType);
    const destination = getStage(this.#config, input.stage);
    const slug = input.slug ? slugifyTaskName(input.slug) : slugifyTaskName(input.name);
    const branch = `${this.#config.repository.branchPrefix}${paddedTaskId(taskId)}-${slug}`;
    const packetPath = joinRepoPath(
      this.#config.repository.paths.taskPackets,
      `${paddedTaskId(taskId)}-${slug}.md`
    );
    const task = this.#syncTask(taskId, input.name, taskType, packetPath);
    const currentSync = await this.#inspectStage(task);
    const resultBase = {
      task: taskId,
      title: task.title,
      operation: "dispatch" as const,
      type: taskType,
      branch,
      packetPath,
      stage: input.stage,
      nextRole: destination.nextRole,
      rolePlaybook: destination.rolePlaybook,
      stageSyncFrom: currentSync.position,
      stageSyncTo: destination.trackerList,
    };
    if (input.dryRun) {
      const registry = await this.#storage.readRegistry();
      const ledger = await this.#storage.readLedger();
      this.#assertStableIdentity(this.#registryIdentity(registry, taskId), {
        taskId,
        name: input.name,
        taskType,
        packetPath,
      });
      const ledgerEntry = findLiveLedgerEntry(ledger, taskId);
      if (ledgerEntry) this.#assertLedgerIdentity(ledgerEntry, input.name, branch, packetPath);
      return {
        ...resultBase,
        dryRun: true,
        alreadyComplete: false,
        artifactCommit: null,
        verified: true,
      };
    }

    return this.#lock.withLock(async () => {
      await this.#ensureTaskBranch(branch);
      const registry = await this.#storage.readRegistry();
      const ledger = await this.#storage.readLedger();
      const existingEntry = findLiveLedgerEntry(ledger, taskId);
      const existingRegistry = this.#registryIdentity(registry, taskId);
      this.#assertStableIdentity(existingRegistry, {
        taskId,
        name: input.name,
        taskType,
        packetPath,
      });
      if (existingEntry) {
        this.#assertLedgerIdentity(existingEntry, input.name, branch, packetPath);
        if (existingEntry.fields.Stage === input.stage) {
          const context = await this.#loadTaskContext(taskId);
          await this.#verifyCompleted(context, input.stage, "dispatch");
          return {
            ...resultBase,
            stageSyncFrom: (await this.#inspectStage(task)).position,
            dryRun: false,
            alreadyComplete: true,
            artifactCommit: await this.#git.headCommit(),
            verified: true,
          };
        }
        if (existingEntry.fields.Stage !== "dispatching") {
          throw new Error(`Task #${taskId} is already at ${existingEntry.fields.Stage}.`);
        }
      }

      const registryEntry = renderTaskRegistryEntry({
        taskId,
        name: input.name,
        taskType,
        packetPath,
        registryPath: this.#config.repository.paths.registry,
      });
      const expectedRegistry = existingRegistry
        ? registry
        : appendTaskRegistryEntry(registry, registryEntry);
      const generatedPacket = renderTaskPacket(this.#config, {
        taskId,
        name: input.name,
        taskType,
        packetPath,
        branch,
        stage: input.stage,
        goal: input.goal,
        registryEntry,
        handoff: input.handoff,
        startPrompt: input.startPrompt,
      });
      const packetAtHead = await this.#git.readHeadFile(packetPath);
      const expectedPacket = packetAtHead ?? generatedPacket;
      if (packetAtHead) this.#assertPacketIdentity(parseTaskPacket(packetAtHead), taskId, input.name);
      await this.#assertArtifactState(
        this.#config.repository.paths.registry,
        registry,
        await this.#git.readHeadFile(this.#config.repository.paths.registry),
        await this.#git.readIndexFile(this.#config.repository.paths.registry),
        expectedRegistry
      );
      const currentPacket = (await this.#storage.packetExists(packetPath))
        ? await this.#storage.readPacket(packetPath)
        : null;
      await this.#assertArtifactState(
        packetPath,
        currentPacket,
        packetAtHead,
        await this.#git.readIndexFile(packetPath),
        expectedPacket
      );

      if (!existingEntry) {
        const reservedLedger = insertLiveLedgerEntry(
          ledger,
          renderLiveLedgerEntry({
            taskId,
            name: input.name,
            status: "dispatching",
            stage: "dispatching",
            nextRole: destination.nextRole,
            branch,
            worktree: this.#storage.repositoryRoot,
            packetPath,
            handoff: input.handoff,
            goal: input.goal,
            timestamp: this.#timestamp(),
          })
        );
        await this.#storage.writeLedger(reservedLedger);
      }
      if (registry !== expectedRegistry) await this.#storage.writeRegistry(expectedRegistry);
      if (currentPacket !== expectedPacket) await this.#storage.writePacket(packetPath, expectedPacket);
      const artifactCommit = await this.#commitArtifacts(
        [packetPath, this.#config.repository.paths.registry],
        `chore: dispatch task #${taskId}`,
        new Map([
          [packetPath, expectedPacket],
          [this.#config.repository.paths.registry, expectedRegistry],
        ])
      );

      const synced = await this.#syncStage(task, destination.trackerList, currentSync);
      const latestLedger = await this.#storage.readLedger();
      const finalized = finalizeLiveLedgerDispatch(
        this.#config,
        latestLedger,
        taskId,
        input.stage,
        synced.reference ?? (this.#config.tracker.provider === "none" ? "none" : null),
        this.#timestamp()
      );
      await this.#storage.writeLedger(finalized.content);
      const context = await this.#loadTaskContext(taskId);
      await this.#verifyCompleted(context, input.stage, "dispatch");
      return {
        ...resultBase,
        stageSyncFrom: currentSync.position,
        dryRun: false,
        alreadyComplete: false,
        artifactCommit,
        verified: true,
      };
    });
  }

  async begin(input: BeginTaskInput): Promise<BeginTaskResult> {
    const initial = await this.#loadTaskContext(input.taskId);
    const from = initial.entry.fields.Stage;
    if (!from) throw new Error(`Live-ledger task #${initial.taskId} has no Stage.`);
    await this.#assertClean();
    this.#assertPacketCompatible(initial.packet.stage, from);
    const existingPending = pendingTransition(initial.entry);
    if (existingPending && existingPending.operation !== "begin") {
      throw new Error("A different handoff transition is pending.");
    }
    const task = this.#syncTask(initial.taskId, initial.packet.name, initial.packet.taskType, initial.packetPath);
    const currentSync = await this.#inspectStage(task);
    if (!existingPending && isRoleActiveStage(this.#config, from)) {
      await this.#verifyCompleted(initial, from, "begin");
      return {
        task: initial.taskId,
        title: initial.title,
        operation: "begin",
        from,
        to: from,
        packetStage: initial.packet.stage,
        stageSyncFrom: currentSync.position,
        stageSyncTo: getStage(this.#config, from).trackerList,
        dryRun: Boolean(input.dryRun),
        alreadyComplete: true,
        verified: true,
      };
    }
    const to = getBeginDestination(this.#config, from);
    const reservation: TransitionReservation = {
      operation: "begin",
      from,
      to,
      reason: null,
      baseCommit: null,
      expectedPacketHash: null,
      packetCommit: null,
    };
    if (existingPending) assertReservationEquals(existingPending, reservation);
    this.#assertStageSyncPosition(
      currentSync,
      existingPending
        ? [getStage(this.#config, from).trackerList, getStage(this.#config, to).trackerList]
        : [getStage(this.#config, from).trackerList]
    );
    const resultBase = {
      task: initial.taskId,
      title: initial.title,
      operation: "begin" as const,
      from,
      to,
      packetStage: initial.packet.stage,
      stageSyncFrom: currentSync.position,
      stageSyncTo: getStage(this.#config, to).trackerList,
    };
    if (input.dryRun) {
      return { ...resultBase, dryRun: true, alreadyComplete: false, verified: true };
    }
    return this.#lock.withLock(async () => {
      const context = await this.#loadTaskContext(initial.taskId);
      const pending = pendingTransition(context.entry);
      this.#assertLockedContext(initial, context, from, Boolean(pending));
      if (pending) assertReservationEquals(pending, reservation);
      else {
        const reserved = reserveLiveLedgerTransition(
          context.ledger,
          context.taskId,
          reservation,
          this.#timestamp()
        );
        await this.#storage.writeLedger(reserved.content);
      }
      await this.#syncStage(task, getStage(this.#config, to).trackerList, currentSync);
      const latestLedger = await this.#storage.readLedger();
      const finalized = finalizeLiveLedgerTransition(
        this.#config,
        latestLedger,
        context.taskId,
        to,
        null,
        reservation,
        this.#timestamp()
      );
      await this.#storage.writeLedger(finalized.content);
      await this.#verifyCompleted(await this.#loadTaskContext(context.taskId), to, "begin");
      return { ...resultBase, dryRun: false, alreadyComplete: false, verified: true };
    });
  }

  async handoff(input: HandoffTaskInput): Promise<HandoffTaskResult> {
    const initial = await this.#loadTaskContext(input.taskId);
    const from = initial.entry.fields.Stage;
    if (!from) throw new Error(`Live-ledger task #${initial.taskId} has no Stage.`);
    const destination = getStage(this.#config, input.to);
    const task = this.#syncTask(initial.taskId, initial.packet.name, initial.packet.taskType, initial.packetPath);
    const currentSync = await this.#inspectStage(task);
    const existingPending = pendingTransition(initial.entry);
    if (
      !existingPending &&
      from === input.to &&
      initial.packet.stage === input.to &&
      (currentSync.position === null || currentSync.position === destination.trackerList)
    ) {
      await this.#verifyCompleted(initial, input.to, "handoff");
      return {
        task: initial.taskId,
        title: initial.title,
        operation: "handoff",
        from,
        to: input.to,
        classification: "normal",
        reason: null,
        packet: initial.packetPath,
        stageSyncFrom: currentSync.position,
        stageSyncTo: destination.trackerList,
        dryRun: Boolean(input.dryRun),
        alreadyComplete: true,
        wouldCommit: [],
        packetCommit: await this.#git.headCommit(),
        verified: true,
      };
    }
    const transition = validateTransition(this.#config, from, input.to, input.reason);
    this.#assertStageSyncPosition(
      currentSync,
      existingPending
        ? [getStage(this.#config, from).trackerList, destination.trackerList]
        : [getStage(this.#config, from).trackerList]
    );
    if (existingPending) {
      this.#assertPendingMatches(existingPending, {
        operation: "handoff",
        from,
        to: input.to,
        reason: transition.reason,
      });
    }
    const plan = existingPending
      ? await this.#planResumedHandoff(initial, existingPending, input.startPrompt)
      : await this.#planFreshHandoff(initial, input.to, transition.reason, input.startPrompt);
    const resultBase = {
      task: initial.taskId,
      title: initial.title,
      operation: "handoff" as const,
      from,
      to: input.to,
      classification: transition.classification,
      reason: transition.reason,
      packet: initial.packetPath,
      stageSyncFrom: currentSync.position,
      stageSyncTo: destination.trackerList,
    };
    if (input.dryRun) {
      return {
        ...resultBase,
        dryRun: true,
        alreadyComplete: false,
        wouldCommit: plan.needsCommit ? [initial.packetPath] : [],
        packetCommit: plan.existingCommit,
        verified: true,
      };
    }
    return this.#lock.withLock(async () => {
      const lockedContext = await this.#loadTaskContext(initial.taskId);
      const lockedPending = pendingTransition(lockedContext.entry);
      this.#assertLockedContext(initial, lockedContext, from, Boolean(lockedPending));
      if (lockedPending) assertReservationEquals(lockedPending, plan.reservation);
      const lockedSync = await this.#inspectStage(task);
      this.#assertStageSyncPosition(
        lockedSync,
        lockedPending
          ? [getStage(this.#config, from).trackerList, destination.trackerList]
          : [getStage(this.#config, from).trackerList]
      );
      let exactReservation = plan.reservation;
      const packetCommit = await executeHandoffTransaction({
        fresh: !existingPending,
        existingCommit: plan.existingCommit,
        commitRecorded: Boolean(existingPending?.packetCommit),
        stageAtDestination: lockedSync.position === destination.trackerList,
        reserve: async () => {
          const latest = await this.#storage.readLedger();
          const reserved = reserveLiveLedgerTransition(
            latest,
            initial.taskId,
            exactReservation,
            this.#timestamp()
          );
          if (reserved.changed) await this.#storage.writeLedger(reserved.content);
        },
        commit: async () => {
          if (!plan.needsCommit) {
            if (!plan.existingCommit) throw new Error("Missing resumed packet commit.");
            return plan.existingCommit;
          }
          if ((await this.#git.headCommit()) !== exactReservation.baseCommit) {
            throw new Error("HEAD changed after handoff preflight.");
          }
          await this.#storage.writePacket(initial.packetPath, plan.content);
          return this.#commitPacket(initial.packetPath, input.to, plan.content);
        },
        recordCommit: async (commit) => {
          const latest = await this.#storage.readLedger();
          const recorded = recordLiveLedgerPacketCommit(
            latest,
            initial.taskId,
            commit,
            exactReservation
          );
          await this.#storage.writeLedger(recorded.content);
          const pending = pendingTransition(recorded.entry);
          if (!pending) throw new Error("Packet commit was not recorded.");
          exactReservation = pending;
        },
        syncStage: () => this.#syncStage(task, destination.trackerList, lockedSync),
        finalize: async () => {
          const latest = await this.#storage.readLedger();
          const finalized = finalizeLiveLedgerTransition(
            this.#config,
            latest,
            initial.taskId,
            input.to,
            transition.reason,
            exactReservation,
            this.#timestamp()
          );
          await this.#storage.writeLedger(finalized.content);
        },
        verify: async (commit) => {
          await this.#verifyCompleted(
            await this.#loadTaskContext(initial.taskId),
            input.to,
            "handoff",
            exactReservation.expectedPacketHash,
            commit
          );
        },
      });
      return {
        ...resultBase,
        dryRun: false,
        alreadyComplete: false,
        wouldCommit: [],
        packetCommit,
        verified: true,
      };
    });
  }

  async #loadTaskContext(taskIdInput: string): Promise<TaskContext> {
    const taskId = normalizeTaskId(taskIdInput);
    const ledger = await this.#storage.readLedger();
    const entry = findLiveLedgerEntry(ledger, taskId);
    if (!entry) throw new Error(`Missing live-ledger task #${taskId}.`);
    const packetPath = entry.fields["Task packet"];
    const branch = entry.fields.Branch;
    if (!packetPath || !branch) {
      throw new Error(`Live-ledger task #${taskId} is missing Branch or Task packet.`);
    }
    const currentBranch = await this.#git.currentBranch();
    if (!currentBranch) throw new Error("The current checkout is detached; attach the task branch first.");
    if (branch !== currentBranch) {
      throw new Error(`Task #${taskId} expects branch ${branch}, got ${currentBranch}.`);
    }
    const worktree = entry.fields.Worktree;
    if (worktree && worktree !== this.#storage.repositoryRoot) {
      throw new Error(`Task #${taskId} expects worktree ${worktree}, got ${this.#storage.repositoryRoot}.`);
    }
    const packet = parseTaskPacket(await this.#storage.readPacket(packetPath));
    this.#assertPacketIdentity(packet, taskId, entry.name);
    const registry = await this.#storage.readRegistry();
    const registryIdentity = this.#registryIdentity(registry, taskId);
    if (!registryIdentity) throw new Error(`Task registry identity mismatch for #${taskId}.`);
    this.#assertStableIdentity(registryIdentity, {
      taskId,
      name: entry.name,
      taskType: packet.taskType,
      packetPath,
    });
    return {
      taskId,
      title: `#${taskId} ${entry.name}`,
      entry,
      packetPath,
      packet,
      branch,
      ledger,
    };
  }

  async #planFreshHandoff(
    context: TaskContext,
    to: string,
    reason: string | null,
    startPrompt?: string | null
  ): Promise<HandoffPlan> {
    const changed = await this.#git.changedPaths();
    if (changed.length !== 1 || changed[0] !== context.packetPath) {
      throw new Error("Fresh handoff requires the task packet as the only local change.");
    }
    const headPacket = await this.#git.readHeadFile(context.packetPath);
    if (!headPacket) throw new Error(`Task packet is not committed: ${context.packetPath}`);
    if (packetSection(headPacket, "Stage Brief") === context.packet.stageBrief) {
      throw new Error("Fresh handoff requires an authored Stage Brief change.");
    }
    this.#assertPacketCompatible(context.packet.stage, context.entry.fields.Stage ?? "");
    const content = transitionTaskPacket(this.#config, {
      content: context.packet.content,
      taskId: context.taskId,
      name: context.packet.name,
      branch: context.branch,
      packetPath: context.packetPath,
      from: context.entry.fields.Stage ?? "",
      to,
      reason,
      startPrompt,
    });
    return {
      content,
      reservation: {
        operation: "handoff",
        from: context.entry.fields.Stage ?? "",
        to,
        reason,
        baseCommit: await this.#git.headCommit(),
        expectedPacketHash: await this.#hasher.hash(content),
        packetCommit: null,
      },
      needsCommit: true,
      existingCommit: null,
    };
  }

  async #planResumedHandoff(
    context: TaskContext,
    reservation: TransitionReservation,
    startPrompt?: string | null
  ): Promise<HandoffPlan> {
    const changed = await this.#git.changedPaths();
    if (changed.some((item) => item !== context.packetPath)) {
      throw new Error("Pending handoff has unrelated local changes.");
    }
    let content = context.packet.content;
    if ((await this.#hasher.hash(content)) !== reservation.expectedPacketHash) {
      content = transitionTaskPacket(this.#config, {
        content,
        taskId: context.taskId,
        name: context.packet.name,
        branch: context.branch,
        packetPath: context.packetPath,
        from: reservation.from,
        to: reservation.to,
        reason: reservation.reason,
        startPrompt,
      });
      if ((await this.#hasher.hash(content)) !== reservation.expectedPacketHash) {
        throw new Error("Pending handoff packet does not match the reserved packet hash.");
      }
    }
    const head = await this.#git.headCommit();
    const headPacket = await this.#git.readHeadFile(context.packetPath);
    if (!headPacket) throw new Error(`Task packet is not committed: ${context.packetPath}`);
    const headHash = await this.#hasher.hash(headPacket);
    if (reservation.packetCommit) {
      if (head !== reservation.packetCommit || headHash !== reservation.expectedPacketHash) {
        throw new Error("Recorded handoff commit or packet blob does not match HEAD.");
      }
      return { content, reservation, needsCommit: false, existingCommit: head };
    }
    if (head === reservation.baseCommit) {
      return { content, reservation, needsCommit: true, existingCommit: null };
    }
    if (
      (await this.#git.parentCommit()) === reservation.baseCommit &&
      headHash === reservation.expectedPacketHash
    ) {
      return { content, reservation, needsCommit: false, existingCommit: head };
    }
    throw new Error("HEAD moved away from the reserved handoff base commit.");
  }

  async #verifyCompleted(
    context: TaskContext,
    stage: string,
    operation: "dispatch" | "begin" | "handoff",
    expectedHash: string | null = null,
    expectedCommit: string | null = null
  ): Promise<void> {
    if ((await this.#git.changedPaths()).length > 0) {
      throw new Error("Completed workflow checkout is not clean.");
    }
    const destination = getStage(this.#config, stage);
    if (
      context.entry.fields.Stage !== stage ||
      context.entry.fields.Status !== destination.status ||
      context.entry.fields["Next role"] !== destination.nextRole
    ) {
      throw new Error("Final ledger stage, status, or next role failed verification.");
    }
    if (context.entry.fields["Pending transition"]) {
      throw new Error("Final ledger still has a pending transition.");
    }
    const sync = await this.#inspectStage(
      this.#syncTask(context.taskId, context.packet.name, context.packet.taskType, context.packetPath)
    );
    if (sync.position !== null && sync.position !== destination.trackerList) {
      throw new Error(`Stage synchronizer is at ${sync.position}, expected ${destination.trackerList}.`);
    }
    const committedPacket = await this.#git.readHeadFile(context.packetPath);
    if (!committedPacket || committedPacket !== context.packet.content) {
      throw new Error("Working packet does not match the committed packet.");
    }
    if (expectedCommit && (await this.#git.headCommit()) !== expectedCommit) {
      throw new Error("Final HEAD does not match the handoff packet commit.");
    }
    if (operation === "begin") {
      this.#assertPacketCompatible(context.packet.stage, stage);
    } else if (context.packet.stage !== stage) {
      throw new Error("Final packet stage failed verification.");
    }
    if (expectedHash && (await this.#hasher.hash(committedPacket)) !== expectedHash) {
      throw new Error("Final committed packet hash failed verification.");
    }
  }

  async #ensureTaskBranch(branch: string): Promise<void> {
    const current = await this.#git.currentBranch();
    if (current === branch) return;
    if ((await this.#git.changedPaths()).length > 0) {
      throw new Error(`Refusing to attach ${branch} with unrelated local changes.`);
    }
    if (await this.#git.branchExists(branch)) await this.#git.switchBranch(branch);
    else await this.#git.createBranch(branch);
  }

  async #commitArtifacts(
    paths: readonly string[],
    message: string,
    expected: ReadonlyMap<string, string>
  ): Promise<string> {
    const changed = await this.#git.changedPaths(paths);
    if (changed.length === 0) {
      for (const [repoPath, content] of expected) {
        if ((await this.#git.readHeadFile(repoPath)) !== content) {
          throw new Error(`Committed content invariant failed for ${repoPath}.`);
        }
      }
      return this.#git.headCommit();
    }
    const unrelated = (await this.#git.changedPaths()).filter((item) => !paths.includes(item));
    if (unrelated.length > 0) {
      throw new Error(`Refusing to commit workflow artifacts with unrelated changes: ${unrelated.join(", ")}`);
    }
    await this.#git.stage(paths);
    const staged = await this.#git.stagedPaths();
    if (!sameStringSet(staged, changed)) {
      throw new Error(`Workflow staging invariant failed: ${staged.join(", ")}`);
    }
    for (const repoPath of staged) {
      if ((await this.#git.readIndexFile(repoPath)) !== expected.get(repoPath)) {
        throw new Error(`Staged content invariant failed for ${repoPath}.`);
      }
    }
    return this.#git.commit(message);
  }

  async #commitPacket(packetPath: string, to: string, content: string): Promise<string> {
    const changed = await this.#git.changedPaths();
    if (changed.length !== 1 || changed[0] !== packetPath) {
      throw new Error("Packet-only commit invariant failed.");
    }
    await this.#git.stage([packetPath]);
    const staged = await this.#git.stagedPaths();
    if (staged.length !== 1 || staged[0] !== packetPath) {
      throw new Error(`Packet-only staging invariant failed: ${staged.join(", ")}`);
    }
    if ((await this.#git.readIndexFile(packetPath)) !== content) {
      throw new Error("Handoff staged packet content failed verification.");
    }
    return this.#git.commit(
      `docs: hand off task #${parseTaskPacket(content).taskId} to ${to}`
    );
  }

  async #assertArtifactState(
    artifactPath: string,
    current: string | null,
    committed: string | null,
    staged: string | null,
    expected: string
  ): Promise<void> {
    for (const [label, content] of [
      [artifactPath, current],
      [`${artifactPath} (staged)`, staged],
    ] as const) {
      if (content === null) {
        if (committed !== null) throw new Error(`Ambiguous local deletion of ${label}.`);
        continue;
      }
      if (content !== committed && content !== expected) {
        throw new Error(
          `Ambiguous local changes in ${label}. Expected committed content or exact generated content.`
        );
      }
    }
  }

  #registryIdentity(registry: string, taskId: string) {
    const matches = parseTaskRegistry(registry).filter((entry) => entry.taskId === taskId);
    if (matches.length > 1) throw new Error(`Task #${taskId} has duplicate registry entries.`);
    return matches[0] ?? null;
  }

  #assertStableIdentity(
    actual: { readonly taskId: string; readonly name: string; readonly taskType: string; readonly packetPath: string } | null,
    expected: { readonly taskId: string; readonly name: string; readonly taskType: string; readonly packetPath: string }
  ): void {
    if (!actual) return;
    for (const key of ["taskId", "name", "taskType", "packetPath"] as const) {
      if (normalize(actual[key]) !== normalize(expected[key])) {
        throw new Error(`Task #${expected.taskId} ${key} is ${actual[key]}, not ${expected[key]}.`);
      }
    }
  }

  #assertLedgerIdentity(
    entry: LiveLedgerEntry,
    name: string,
    branch: string,
    packetPath: string
  ): void {
    for (const [label, actual, expected] of [
      ["name", entry.name, name],
      ["branch", entry.fields.Branch, branch],
      ["task packet", entry.fields["Task packet"], packetPath],
    ] as const) {
      if (normalize(actual) !== normalize(expected)) {
        throw new Error(`Task #${entry.taskId} ${label} is ${String(actual)}, not ${expected}.`);
      }
    }
  }

  #assertPacketIdentity(packet: TaskPacket, taskId: string, name: string): void {
    if (packet.taskId !== taskId || normalize(packet.name) !== normalize(name)) {
      throw new Error(`Task packet identity mismatch for #${taskId}.`);
    }
  }

  #assertPacketCompatible(packetStageValue: string, ledgerStage: string): void {
    const expected = getExpectedPacketStages(this.#config, ledgerStage);
    if (!expected.includes(packetStageValue)) {
      throw new Error(
        `Packet stage ${packetStageValue} is not valid while ledger stage is ${ledgerStage}.`
      );
    }
  }

  #assertPendingMatches(
    pending: TransitionReservation,
    expected: Pick<TransitionReservation, "operation" | "from" | "to" | "reason">
  ): void {
    for (const key of ["operation", "from", "to", "reason"] as const) {
      if (pending[key] !== expected[key]) {
        throw new Error(
          `Pending transition ${key} mismatch: expected ${String(expected[key])}, got ${String(pending[key])}.`
        );
      }
    }
  }

  #assertLockedContext(
    initial: TaskContext,
    current: TaskContext,
    expectedStage: string,
    hasPending: boolean
  ): void {
    if (current.entry.fields.Stage !== expectedStage) {
      throw new Error("Live-ledger task changed after preflight; retry from fresh state.");
    }
    if (current.packet.content !== initial.packet.content) {
      throw new Error("Task packet changed after preflight; retry from fresh state.");
    }
    if (!hasPending && current.entry.section !== initial.entry.section) {
      throw new Error("Live-ledger task changed after preflight; retry from fresh state.");
    }
    if (hasPending && pendingTransition(initial.entry)) {
      if (current.entry.section !== initial.entry.section) {
        throw new Error("Pending transition changed after preflight; retry from fresh state.");
      }
    }
  }

  #assertStageSyncPosition(current: StageSyncState, allowed: readonly string[]): void {
    if (current.position !== null && !allowed.includes(current.position)) {
      throw new Error(
        `Stage synchronizer is at ${current.position}, expected ${allowed.join(" or ")}.`
      );
    }
  }

  async #assertClean(): Promise<void> {
    const changed = await this.#git.changedPaths();
    if (changed.length > 0) throw new Error("Role begin requires a clean checkout.");
  }

  #taskType(value: string): string {
    const configured = this.#config.repository.taskTypes.find(
      (item) => item.toLowerCase() === value.trim().toLowerCase()
    );
    if (!configured) {
      throw new Error(
        `Unsupported task type: ${value}. Supported: ${this.#config.repository.taskTypes.join(", ")}`
      );
    }
    return configured;
  }

  #timestamp(): string {
    return formatTimestamp(this.#clock.now(), this.#config.repository.timezone);
  }

  #syncTask(taskId: string, name: string, taskType: string, packetPath: string): StageSyncTask {
    return { taskId, title: `#${taskId} ${name}`, taskType, packetPath };
  }

  async #inspectStage(task: StageSyncTask): Promise<StageSyncState> {
    return this.#stageSync?.inspect(task) ?? { position: null, reference: null };
  }

  async #syncStage(
    task: StageSyncTask,
    destination: string,
    current: StageSyncState
  ): Promise<StageSyncState> {
    if (!this.#stageSync || current.position === destination) return current;
    const synced = await this.#stageSync.sync(task, destination);
    if (synced.position !== destination) {
      throw new Error(`Stage synchronizer is at ${String(synced.position)}, expected ${destination}.`);
    }
    return synced;
  }
}

export interface ExecuteHandoffTransactionInput {
  readonly fresh: boolean;
  readonly existingCommit: string | null;
  readonly commitRecorded: boolean;
  readonly stageAtDestination: boolean;
  readonly reserve: () => void | Promise<void>;
  readonly commit: () => string | Promise<string>;
  readonly recordCommit: (commit: string) => void | Promise<void>;
  readonly syncStage: () => unknown | Promise<unknown>;
  readonly finalize: () => void | Promise<void>;
  readonly verify: (commit: string) => void | Promise<void>;
}

export async function executeHandoffTransaction(
  input: ExecuteHandoffTransactionInput
): Promise<string> {
  if (input.fresh) await input.reserve();
  const packetCommit = input.existingCommit ?? (await input.commit());
  if (!input.commitRecorded) await input.recordCommit(packetCommit);
  if (!input.stageAtDestination) await input.syncStage();
  await input.finalize();
  await input.verify(packetCommit);
  return packetCommit;
}

function joinRepoPath(directory: string, fileName: string): string {
  return `${directory.replace(/\/+$/, "")}/${fileName}`.replace(/^\.\//, "");
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}
