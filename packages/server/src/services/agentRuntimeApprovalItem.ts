// antiproton's approval item (raft-agent-provider.v1, botiverse/antiproton
// docs/raft-approvals.md "The approval item"), parsed where it enters Raft
// and kept as Raft stores it: only the fields a card shows or a decision
// needs, each one plain text without control or bidi characters and cut to
// its slot (plainActionCardText). Everything in it came from antiproton, and
// `args.summary`, `outcome.summary` and `route` may carry what the agent
// wrote: Raft never renders any of it as markup or a link. Pure: no I/O.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  AGENT_CALL_APPROVAL_DESCRIPTION_MAX,
  AGENT_CALL_APPROVAL_ROLES,
  AGENT_CALL_APPROVAL_SUMMARY_MAX,
  plainActionCardText,
  type AgentApproveCallAction,
  type AgentCallApprovalDecidedBy,
  type AgentCallApprovalRole,
  type AgentCallApprovalStatus,
} from "@botiverse/raft-shared";

/** antiproton's states (a hold Raft can no longer find is Raft's own `unavailable`). */
export const PROVIDER_APPROVAL_STATUSES = ["pending", "approved", "executed", "failed", "denied", "expired"] as const;
export type ProviderApprovalStatus = (typeof PROVIDER_APPROVAL_STATUSES)[number];

/** How far each of antiproton's states is along a hold's life. */
const STATUS_RANK: Readonly<Record<ProviderApprovalStatus, number>> = {
  pending: 0, approved: 1, executed: 2, failed: 2, denied: 2, expired: 2,
};

/**
 * Whether a hold in `current` may take `next` (the same state is newer data).
 * antiproton's states only move forward: pending, approved, then one end that
 * never changes. `unavailable` is Raft's guess that antiproton no longer has
 * the hold: an open hold may become it, and whatever antiproton reports later
 * supersedes it.
 */
export function approvalStatusMovesForward(current: AgentCallApprovalStatus, next: AgentCallApprovalStatus): boolean {
  if (current === "unavailable") return true;
  if (next === "unavailable") return STATUS_RANK[current] < 2;
  if (STATUS_RANK[current] === 2) return current === next;
  return STATUS_RANK[next] >= STATUS_RANK[current];
}

/** Whether a hold in `status` is over for good (antiproton's own end; `unavailable` is not). */
export const isFinalApprovalStatus = (status: AgentCallApprovalStatus) => status !== "unavailable" && STATUS_RANK[status] === 2;

const text = (max: number) => z.string().max(20_000).transform((value) => plainActionCardText(value, max));
const multiline = (max: number) => z.string().max(20_000).transform((value) => plainActionCardText(value, max, { multiline: true }));
const isoTime = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO time")
  .transform((value) => new Date(value).toISOString());
const excerpt = z.object({
  summary: multiline(AGENT_CALL_APPROVAL_SUMMARY_MAX).catch(""),
  truncated: z.boolean().catch(false),
  withheld: z.boolean().catch(false),
});

/** `decidedBy` as antiproton records it; Raft keeps the role, never the Raft user id or console sign-in. */
const decidedBySchema = z.union([
  z.object({ via: z.literal("raft"), role: z.enum(AGENT_CALL_APPROVAL_ROLES) }).transform((by): AgentCallApprovalDecidedBy => ({ via: "raft", role: by.role })),
  z.object({ via: z.literal("console") }).transform((): AgentCallApprovalDecidedBy => ({ via: "console" })),
  z.object({ via: z.literal("expiry") }).transform((): AgentCallApprovalDecidedBy => ({ via: "expiry" })),
]);

/** Ids antiproton uses: `op_…` operation ids, `raft_…` agent ids (bounded, printable, no separators). */
const providerId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/**
 * One item from any of antiproton's three approval reads. Unknown fields are
 * dropped (a newer antiproton adds some); a known field with a bad value
 * refuses the item, except the display texts, which fall back to empty.
 */
export const providerApprovalItemSchema = z.object({
  operationId: providerId,
  providerAgentId: providerId,
  raftAgentId: z.string().min(1).max(128),
  raftServerId: z.string().min(1).max(128),
  status: z.enum(PROVIDER_APPROVAL_STATUSES),
  mount: text(80).catch(""),
  plugin: text(120).nullable().catch(null),
  tool: text(120).catch(""),
  service: text(80).nullable().catch(null),
  action: text(80).nullable().catch(null),
  args: excerpt.nullable().catch(null),
  outcome: excerpt.nullable().catch(null),
  heldBy: z.enum(["policy", "agent"]).catch("policy"),
  route: z.object({
    method: text(16),
    path: text(400),
    repo: text(140).nullable().optional().catch(null),
    pr: z.union([z.number().int().nonnegative(), z.string().max(20)]).nullable().optional().catch(null),
  }).nullable().optional().catch(null),
  description: text(AGENT_CALL_APPROVAL_DESCRIPTION_MAX).catch(""),
  createdAt: isoTime,
  expiresAt: isoTime.nullable(),
  decidedAt: isoTime.nullable().catch(null),
  decidedBy: decidedBySchema.nullable().catch(null),
  /** Only on the provider-wide list: the row's last change. */
  updatedAt: isoTime.optional(),
});
export type ProviderApprovalItem = z.infer<typeof providerApprovalItemSchema>;

/** What agent_runtime_approvals.item keeps: the item's display fields, as parsed. */
export interface AgentRuntimeApprovalItem {
  providerAgentId: string;
  mount: string;
  plugin: string | null;
  tool: string;
  service: string | null;
  action: string | null;
  heldBy: "policy" | "agent";
  summary: string;
  summaryTruncated: boolean;
  summaryWithheld: boolean;
  request: string | null;
  description: string;
  createdAt: string;
  outcome: { summary: string; truncated: boolean; withheld: boolean } | null;
}

export function storedApprovalItem(item: ProviderApprovalItem): AgentRuntimeApprovalItem {
  const route = item.route;
  const pr = route?.pr === null || route?.pr === undefined || route.pr === "" ? "" : ` #${route.pr}`;
  const where = route?.repo ? ` (${route.repo}${pr})` : pr ? ` (${pr.trim()})` : "";
  return {
    providerAgentId: item.providerAgentId,
    mount: item.mount,
    plugin: item.plugin || null,
    tool: item.tool,
    service: item.service || null,
    action: item.action || null,
    heldBy: item.heldBy,
    summary: item.args?.withheld ? "" : item.args?.summary ?? "",
    summaryTruncated: item.args?.truncated ?? false,
    summaryWithheld: item.args?.withheld ?? false,
    request: route && (route.method || route.path) ? plainActionCardText(`${route.method} ${route.path}${where}`, 600) || null : null,
    description: item.description,
    createdAt: item.createdAt,
    outcome: item.outcome ? { ...item.outcome, summary: item.outcome.withheld ? "" : item.outcome.summary } : null,
  };
}

/** What Raft keeps of a hold, as compared with what antiproton reports. */
export interface StoredHoldFacts {
  status: AgentCallApprovalStatus;
  item: AgentRuntimeApprovalItem;
  expiresAt: Date | null;
  decidedAt: Date | null;
  decidedBy: AgentCallApprovalDecidedBy | null;
}

/** The facts `item` would store. */
export function holdFactsOf(item: ProviderApprovalItem): StoredHoldFacts {
  return {
    status: item.status,
    item: storedApprovalItem(item),
    expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
    decidedAt: item.decidedAt ? new Date(item.decidedAt) : null,
    decidedBy: item.decidedBy,
  };
}

/** Whether recording `next` would change nothing Raft keeps. */
export function sameHoldFacts(current: StoredHoldFacts, next: StoredHoldFacts): boolean {
  return current.status === next.status && isDeepStrictEqual(current.item, next.item)
    && current.expiresAt?.getTime() === next.expiresAt?.getTime() && current.decidedAt?.getTime() === next.decidedAt?.getTime()
    && isDeepStrictEqual(current.decidedBy ?? null, next.decidedBy ?? null);
}

const DECIDED_BY_TEXT: Readonly<Record<AgentCallApprovalRole, string>> = {
  agent_owner: "the agent's owner",
  server_owner: "a server owner",
  server_admin: "a server admin",
};

/** How a hold ended, for the person whose decision came too late (the card itself shows it too). */
export function approvalEndedSentence(ended: { status: AgentCallApprovalStatus; decidedBy: AgentCallApprovalDecidedBy | null }): string {
  if (ended.status === "expired") return "Nobody decided this call in time; it expired and nothing was run.";
  if (ended.status === "unavailable") return "antiproton no longer has this call; nothing will run.";
  const by = ended.decidedBy?.via === "raft" ? DECIDED_BY_TEXT[ended.decidedBy.role] : ended.decidedBy?.via === "console" ? "the antiproton console" : null;
  return by ? `Already decided by ${by}.` : "Already decided.";
}

/** The call as a person reads it: `service · action` when the call names both, else `mount.tool`. */
export function approvalCallLabel(item: Pick<AgentRuntimeApprovalItem, "mount" | "tool" | "service" | "action">): string {
  const label = item.service && item.action ? `${item.service} · ${item.action}` : [item.mount, item.tool].filter(Boolean).join(".");
  return plainActionCardText(label || "call", 200);
}

/** The card for one decider: the hold's item, and who the card goes to. */
export function approveCallAction(input: {
  approvalId: string;
  agentId: string;
  agentName: string;
  item: AgentRuntimeApprovalItem;
  expiresAt: Date | null;
  decider: AgentApproveCallAction["decider"];
}): AgentApproveCallAction {
  const { item } = input;
  return {
    type: "agent:approve_call",
    approvalId: input.approvalId,
    agentId: input.agentId,
    agentName: plainActionCardText(input.agentName, 120) || "agent",
    call: approvalCallLabel(item),
    plugin: item.plugin,
    heldBy: item.heldBy,
    summary: item.summary,
    summaryTruncated: item.summaryTruncated,
    summaryWithheld: item.summaryWithheld,
    request: item.request,
    description: item.description,
    createdAt: item.createdAt,
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    decider: input.decider,
  };
}
