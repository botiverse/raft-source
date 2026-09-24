/**
 * Format an agent-facing timestamp as an explicitly-labelled UTC value.
 *
 * Keep the space separator used by existing Raft message/log output while
 * adding the `Z` suffix that makes the timezone unambiguous.
 */
export function formatUtcTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : String(value);
  }
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}
