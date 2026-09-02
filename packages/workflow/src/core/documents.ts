import { normalizeTaskId } from "./normalization.js";
import { BLANK_TASK_PACKET_TEMPLATE } from "./templates.js";
import type {
  LiveLedgerEntry,
  StaffelConfig,
  TaskPacket,
  TaskRegistryEntry,
  TransitionReservation,
} from "./types.js";
import { getStage } from "./workflow.js";

export interface RenderTaskPacketInput {
  readonly taskId: string;
  readonly name: string;
  readonly taskType: string;
  readonly packetPath: string;
  readonly branch: string;
  readonly stage: string;
  readonly goal: string;
  readonly registryEntry: string;
  readonly handoff?: string | null;
  readonly plan?: string | null;
  readonly adr?: string | null;
  readonly pullRequest?: string | null;
  readonly startPrompt?: string | null;
}

export interface TransitionTaskPacketInput {
  readonly content: string;
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly packetPath: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string | null;
  readonly startPrompt?: string | null;
}

export interface RenderLiveLedgerEntryInput {
  readonly taskId: string;
  readonly name: string;
  readonly status: string;
  readonly stage: string;
  readonly nextRole: string;
  readonly branch: string;
  readonly worktree: string;
  readonly packetPath: string;
  readonly handoff?: string | null;
  readonly goal: string;
  readonly timestamp: string;
  readonly tracker?: string | null;
}

export interface LedgerMutation {
  readonly content: string;
  readonly entry: LiveLedgerEntry;
  readonly changed: boolean;
}

export function canonicalTaskPacket(content: string): string {
  return String(content)
    .replace(/\r\n/g, "\n")
    .replace(/(^## [^\n]+\n)\n{2,}/gm, "$1\n")
    .replace(/\n{3,}(?=## )/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

export function packetSection(content: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  const match = String(content).match(
    new RegExp(`^## ${escaped}\\s*$\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m")
  );
  if (!match?.[1]) throw new Error(`Packet is missing ## ${heading}.`);
  return match[1].trim();
}

export function packetStage(content: string): string {
  return requiredMatch(content, /^- Stage:\s*(\S+)\s*$/m, "packet Stage");
}

export function parseTaskPacket(content: string): TaskPacket {
  const canonical = canonicalTaskPacket(content);
  const [title = ""] = canonical.split("\n", 1);
  const identity = title.match(/^#?0*(\d+[A-Za-z]?)\s+(.+)$/);
  if (!identity?.[1] || !identity[2]) {
    throw new Error("Task packet title must be '#<task> <name>'.");
  }
  const stable = packetSection(canonical, "Stable Brief");
  const current = packetSection(canonical, "Current Stage");
  return {
    taskId: normalizeTaskId(identity[1]),
    name: identity[2].trim(),
    taskType: requiredMatch(stable, /^- Type:\s*(.+?)\s*$/m, "packet Type"),
    stage: requiredMatch(current, /^- Stage:\s*(\S+)\s*$/m, "packet Stage"),
    nextRole: requiredMatch(current, /^- Next role:\s*(.+?)\s*$/m, "packet Next role"),
    rolePlaybook: requiredMatch(current, /^- Role playbook:\s*(.+?)\s*$/m, "packet Role playbook"),
    stageBrief: packetSection(canonical, "Stage Brief"),
    content: canonical,
  };
}

export function renderTaskRegistryEntry(input: {
  readonly taskId: string;
  readonly name: string;
  readonly taskType: string;
  readonly packetPath: string;
  readonly registryPath: string;
}): string {
  const taskId = normalizeTaskId(input.taskId);
  const link = relativeRepoPath(parentRepoPath(input.registryPath), input.packetPath);
  return [
    `- [ ] #${taskId} ${input.name}.`,
    `      Type: ${input.taskType}`,
    `      Task packet: [${input.packetPath}](${link})`,
  ].join("\n");
}

export function parseTaskRegistry(content: string): readonly TaskRegistryEntry[] {
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  const entries: TaskRegistryEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(
      /^\s*-\s*\[[ xX]\]\s*#?0*(\d+[A-Za-z]?)\s+(.+?)\.?\s*$/
    );
    if (!heading?.[1] || !heading[2]) continue;
    let end = index + 1;
    while (end < lines.length && !/^\s*-\s*\[[ xX]\]\s*#?0*\d+[A-Za-z]?\s+/.test(lines[end] ?? "")) {
      end += 1;
    }
    const section = lines.slice(index, end).join("\n").trimEnd();
    const taskType = requiredMatch(section, /^\s*Type:\s*(.+?)\s*$/mi, "registry Type");
    const packetPath = requiredMatch(
      section,
      /^\s*Task packet:\s*\[([^\n]+)]\([^)]+\)\s*$/mi,
      "registry Task packet"
    );
    entries.push({
      taskId: normalizeTaskId(heading[1]),
      name: heading[2].trim().replace(/\.$/, ""),
      taskType,
      packetPath,
      section,
    });
  }
  return entries;
}

export function appendTaskRegistryEntry(content: string, entry: string): string {
  const current = String(content).replace(/\r\n/g, "\n").trimEnd();
  return `${current}\n\n${entry.trim()}\n`;
}

export function renderTaskPacket(
  config: StaffelConfig,
  input: RenderTaskPacketInput
): string {
  const taskId = normalizeTaskId(input.taskId);
  const destination = getStage(config, input.stage);
  const prompt = input.startPrompt?.trim() || defaultStartPrompt({
    taskId,
    name: input.name,
    branch: input.branch,
    packetPath: input.packetPath,
    rolePlaybook: destination.rolePlaybook,
  });
  const values: Readonly<Record<string, string>> = {
    taskId,
    taskName: input.name,
    taskType: input.taskType,
    handoff: input.handoff?.trim() || "None linked",
    plan: input.plan?.trim() || "None linked",
    adr: input.adr?.trim() || "None linked",
    pullRequest: input.pullRequest?.trim() || "None linked",
    stage: input.stage,
    nextRole: destination.nextRole,
    rolePlaybook: destination.rolePlaybook,
    goal: input.goal,
    registryEntry: `\`\`\`markdown\n${input.registryEntry.trim()}\n\`\`\``,
    startPrompt: `\`\`\`text\n${prompt}\n\`\`\``,
  };
  return canonicalTaskPacket(
    BLANK_TASK_PACKET_TEMPLATE.replace(/\{\{([A-Za-z]+)\}\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Unknown task-packet template value: ${key}`);
      return value;
    })
  );
}

export function transitionTaskPacket(
  config: StaffelConfig,
  input: TransitionTaskPacketInput
): string {
  const destination = getStage(config, input.to);
  let current = packetSection(input.content, "Current Stage")
    .replace(/^- Stage:.*$/m, `- Stage: ${input.to}`)
    .replace(/^- Next role:.*$/m, `- Next role: ${destination.nextRole}`)
    .replace(/^- Role playbook:.*$/m, `- Role playbook: ${destination.rolePlaybook}`)
    .replace(/\n- Exceptional transition:.*$/m, "")
    .replace(/\n- Transition reason:.*$/m, "");
  if (input.reason) {
    current += `\n- Exceptional transition: ${input.from} -> ${input.to}`;
    current += `\n- Transition reason: ${input.reason}`;
  }
  const prompt = input.startPrompt?.trim() || defaultStartPrompt({
    taskId: normalizeTaskId(input.taskId),
    name: input.name,
    branch: input.branch,
    packetPath: input.packetPath,
    rolePlaybook: destination.rolePlaybook,
  });
  return canonicalTaskPacket(
    replacePacketSection(
      replacePacketSection(input.content, "Current Stage", current),
      "Start Prompt",
      `\`\`\`text\n${prompt}\n\`\`\``
    )
  );
}

export function parseLiveLedger(content: string): readonly LiveLedgerEntry[] {
  const active = String(content).match(
    /^## Active Workstreams\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m
  )?.[1] ?? "";
  const headings = [...active.matchAll(/^###\s+#?0*(\d+[A-Za-z]?)\s+(.+)$/gim)];
  return headings.map((match, index) => {
    const start = match.index;
    const end = headings[index + 1]?.index ?? active.length;
    const section = active.slice(start, end).trimEnd();
    const fields: Record<string, string> = {};
    for (const field of section.matchAll(/^([^\n:]+):\s*(.*?)\s*$/gm)) {
      const key = field[1]?.trim();
      if (key) fields[key] = field[2]?.trim() ?? "";
    }
    return {
      taskId: normalizeTaskId(match[1]),
      name: match[2]?.trim() ?? "",
      section,
      fields,
    };
  });
}

export function findLiveLedgerEntry(content: string, taskId: string): LiveLedgerEntry | null {
  const normalized = normalizeTaskId(taskId);
  return parseLiveLedger(content).find((entry) => entry.taskId === normalized) ?? null;
}

export function renderLiveLedgerEntry(input: RenderLiveLedgerEntryInput): string {
  const taskId = normalizeTaskId(input.taskId);
  return `### ${paddedTaskId(taskId).toUpperCase()} ${input.name}\n\nStatus: ${input.status}\nStage: ${input.stage}\nNext role: ${input.nextRole}\nOwner: Staffel workflow\nBranch: ${input.branch}\nWorktree: ${input.worktree}\nPR: none\nTask packet: ${input.packetPath}\nPlan: none\nHandoff: ${input.handoff?.trim() || "none"}\nADR: none\nTracker: ${input.tracker?.trim() || "pending"}\nLast update: ${input.timestamp}\n\nGoal:\n\n- ${input.goal}\n\nLikely touched areas:\n\n- To be determined.\n\nCurrent state:\n\n- Dispatched and ready for ${input.stage}.\n\nVerification:\n\n- Dispatch invariants pending.\n\nMerge notes:\n\n- None yet.\n`;
}

export function insertLiveLedgerEntry(content: string, entry: string): string {
  const marker = "## Active Workstreams";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing ${marker} in live ledger.`);
  const insertIndex = markerIndex + marker.length;
  return `${content.slice(0, insertIndex)}\n\n${entry.trimEnd()}\n${content
    .slice(insertIndex)
    .replace(/^\s*/, "\n")}`;
}

export function pendingTransition(entry: LiveLedgerEntry): TransitionReservation | null {
  const value = entry.fields["Pending transition"];
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (!isTransitionReservation(parsed)) {
    throw new Error(`Invalid pending transition for task #${entry.taskId}.`);
  }
  return parsed;
}

export function reserveLiveLedgerTransition(
  content: string,
  taskId: string,
  reservation: TransitionReservation,
  timestamp: string
): LedgerMutation {
  const entry = requiredLedgerEntry(content, taskId);
  const existing = pendingTransition(entry);
  if (existing) {
    assertReservationEquals(existing, reservation);
    return { content, entry, changed: false };
  }
  requireLedgerFields(entry, ["Last update"]);
  const encoded = JSON.stringify(reservation);
  const updated = entry.section.replace(
    /^Last update:.*$/m,
    `Pending transition: ${encoded}\nLast update: ${timestamp}`
  );
  return replaceLedgerEntry(content, entry, updated, true);
}

export function recordLiveLedgerPacketCommit(
  content: string,
  taskId: string,
  commit: string,
  expected: TransitionReservation
): LedgerMutation {
  const entry = requiredLedgerEntry(content, taskId);
  const pending = pendingTransition(entry);
  if (!pending) throw new Error("Missing pending transition during commit recording.");
  assertReservationEquals(pending, expected);
  const recorded = { ...pending, packetCommit: commit };
  const updated = entry.section.replace(
    /^Pending transition:.*$/m,
    `Pending transition: ${JSON.stringify(recorded)}`
  );
  return replaceLedgerEntry(content, entry, updated, true);
}

export function finalizeLiveLedgerTransition(
  config: StaffelConfig,
  content: string,
  taskId: string,
  to: string,
  reason: string | null,
  expected: TransitionReservation,
  timestamp: string
): LedgerMutation {
  const entry = requiredLedgerEntry(content, taskId);
  const pending = pendingTransition(entry);
  if (!pending) throw new Error("Missing pending transition during finalization.");
  assertReservationEquals(pending, expected);
  requireLedgerFields(entry, ["Status", "Stage", "Next role", "Last update"]);
  const destination = getStage(config, to);
  let updated = entry.section
    .replace(/^Status:.*$/m, `Status: ${destination.status}`)
    .replace(/^Stage:.*$/m, `Stage: ${to}`)
    .replace(/^Next role:.*$/m, `Next role: ${destination.nextRole}`)
    .replace(/^Pending transition:.*\n/m, "")
    .replace(/^Last update:.*$/m, `Last update: ${timestamp}`);
  if (reason && /^Current state:\s*$/m.test(updated)) {
    updated = updated.replace(
      /(^Current state:\s*$[\s\S]*?)(?=^Verification:\s*$)/m,
      `$1- Exceptional transition ${pending.from} -> ${to}: ${reason}\n\n`
    );
  } else if (reason) {
    throw new Error(`Live-ledger task #${entry.taskId} is missing Current state.`);
  }
  return replaceLedgerEntry(content, entry, updated, true);
}

export function finalizeLiveLedgerDispatch(
  config: StaffelConfig,
  content: string,
  taskId: string,
  stage: string,
  trackerReference: string | null,
  timestamp: string
): LedgerMutation {
  const entry = requiredLedgerEntry(content, taskId);
  requireLedgerFields(entry, ["Status", "Stage", "Next role", "Last update"]);
  const destination = getStage(config, stage);
  let updated = entry.section
    .replace(/^Status:.*$/m, `Status: ${destination.status}`)
    .replace(/^Stage:.*$/m, `Stage: ${stage}`)
    .replace(/^Next role:.*$/m, `Next role: ${destination.nextRole}`)
    .replace(/^Last update:.*$/m, `Last update: ${timestamp}`)
    .replace(/^- Dispatch invariants pending\.$/m, "- Dispatch invariants verified.");
  if (trackerReference) {
    if (/^Tracker:.*$/m.test(updated)) {
      updated = updated.replace(/^Tracker:.*$/m, `Tracker: ${trackerReference}`);
    } else if (/^Trello:.*$/m.test(updated)) {
      updated = updated.replace(/^Trello:.*$/m, `Trello: ${trackerReference}`);
    }
  }
  return replaceLedgerEntry(content, entry, updated, true);
}

export function assertReservationEquals(
  actual: TransitionReservation,
  expected: TransitionReservation
): void {
  for (const key of [
    "operation",
    "from",
    "to",
    "reason",
    "baseCommit",
    "expectedPacketHash",
    "packetCommit",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Pending transition ${key} mismatch: expected ${String(expected[key])}, got ${String(actual[key])}.`
      );
    }
  }
}

export function paddedTaskId(value: string): string {
  const normalized = normalizeTaskId(value);
  const match = normalized.match(/^(\d+)([A-Z]?)$/);
  if (!match?.[1]) throw new Error(`Invalid task id: ${value}`);
  return `${match[1].padStart(4, "0")}${match[2]?.toLowerCase() ?? ""}`;
}

export function slugifyTaskName(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!slug) throw new Error(`Could not derive a task slug from: ${value}`);
  return slug;
}

export function formatTimestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${timeZone}`;
}

function replacePacketSection(content: string, heading: string, body: string): string {
  const escaped = escapeRegExp(heading);
  const regex = new RegExp(
    `(^## ${escaped}\\s*$\\n)[\\s\\S]*?(?=^## |(?![\\s\\S]))`,
    "m"
  );
  if (!regex.test(content)) throw new Error(`Packet is missing ## ${heading}.`);
  return content.replace(regex, (_match, prefix: string) => `${prefix}\n${body.trim()}\n\n`);
}

function defaultStartPrompt(input: {
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly packetPath: string;
  readonly rolePlaybook: string;
}): string {
  return `#${input.taskId} ${input.name}\n\nContinue task #${input.taskId} on branch ${input.branch}. Read ${input.packetPath}, ${input.rolePlaybook}, and the live ledger entry. Confirm the checkout and branch before editing.`;
}

function requiredLedgerEntry(content: string, taskId: string): LiveLedgerEntry {
  const entry = findLiveLedgerEntry(content, taskId);
  if (!entry) throw new Error(`Missing live-ledger task #${normalizeTaskId(taskId)}.`);
  return entry;
}

function requireLedgerFields(entry: LiveLedgerEntry, fields: readonly string[]): void {
  for (const field of fields) {
    if (!(field in entry.fields)) {
      throw new Error(`Live-ledger task #${entry.taskId} is missing ${field}.`);
    }
  }
}

function replaceLedgerEntry(
  content: string,
  entry: LiveLedgerEntry,
  updatedSection: string,
  changed: boolean
): LedgerMutation {
  if (!content.includes(entry.section)) {
    throw new Error("Ledger section compare-before-replace failed.");
  }
  const updatedContent = content.replace(entry.section, updatedSection);
  const updatedEntry = requiredLedgerEntry(updatedContent, entry.taskId);
  return { content: updatedContent, entry: updatedEntry, changed };
}

function isTransitionReservation(value: unknown): value is TransitionReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.operation === "begin" || item.operation === "handoff") &&
    typeof item.from === "string" &&
    typeof item.to === "string" &&
    (item.reason === null || typeof item.reason === "string") &&
    (item.baseCommit === null || typeof item.baseCommit === "string") &&
    (item.expectedPacketHash === null || typeof item.expectedPacketHash === "string") &&
    (item.packetCommit === null || typeof item.packetCommit === "string")
  );
}

function requiredMatch(text: string, regex: RegExp, label: string): string {
  const match = String(text).match(regex);
  if (!match?.[1]) throw new Error(`Missing ${label}.`);
  return match[1].trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parentRepoPath(value: string): string {
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function relativeRepoPath(fromDirectory: string, toPath: string): string {
  const from = fromDirectory.split("/").filter(Boolean);
  const to = toPath.replace(/^\.\//, "").split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/") || ".";
}
