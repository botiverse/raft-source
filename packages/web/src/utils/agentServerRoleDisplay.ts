/**
 * What the agent-detail Role chip shows for a given wire `serverRole`.
 *
 * Product decision (artin, task #261, 2026-09-03): an unrecognized non-empty role shows the
 * name the server sent (first letter upper-cased, mirroring mobile); an absent role
 * (agent has no server-membership row) or a deleted agent shows no chip at all. Wire fact
 * behind "absent = no membership row": `server_agent_members.role` is NOT NULL DEFAULT
 * with a composite primary key, so "member without a role" cannot exist in the database.
 * The previous "No role" chip described a state that does not exist.
 */
export type AgentServerRoleDisplay =
  | { kind: "known"; role: "admin" | "member" }
  | { kind: "unrecognized"; label: string }
  | { kind: "hidden" };

export function resolveAgentServerRoleDisplay(
  serverRole: string | null | undefined,
  deletedAt: string | null | undefined = null,
): AgentServerRoleDisplay {
  if (deletedAt) return { kind: "hidden" };
  const raw = serverRole?.trim();
  if (!raw) return { kind: "hidden" };
  if (raw === "admin" || raw === "member") return { kind: "known", role: raw };
  return { kind: "unrecognized", label: titleCaseFirst(raw) };
}

/** Same rule as mobile's `replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it }`. */
function titleCaseFirst(value: string): string {
  const first = value.charAt(0);
  const upper = first.toUpperCase();
  return first === first.toLowerCase() && upper !== first ? upper + value.slice(1) : value;
}
