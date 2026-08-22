export function normalizeTaskId(value: unknown): string {
  const match = String(value)
    .trim()
    .match(/^#?0*(\d+)([a-z]?)$/i);

  if (!match) {
    throw new Error(`Invalid task id: ${String(value)}`);
  }

  return `${Number(match[1])}${match[2]?.toUpperCase() ?? ""}`;
}
