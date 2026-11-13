// antiproton held-call approvals, Raft's side (docs/contracts/hosted-agent-approvals.md;
// the contract: botiverse/antiproton docs/raft-approvals.md).
//
// A hosted agent's call that its mount's policy holds (or that the agent asked
// a person for) waits at antiproton. Raft shows each hold as an
// `agent:approve_call` action card to whoever decides, and decides it through
// antiproton when that person picks Approve or Deny:
// - antiproton pushes a hint (ids only), signed with an Ed25519 key that never
//   leaves antiproton, to POST /api/integrations/antiproton/approvals; Raft
//   verifies it with the configured public keys and pulls that agent's holds
//   with its provider token (never trusting the hint's body for anything but
//   what to pull). A reconcile of the provider-wide list every few minutes
//   covers lost hints;
// - one agent_runtime_approvals row per hold keeps what the cards show; its
//   state only moves forward and antiproton stays the source of truth;
// - the cards: the agent's owner (an assistant's owner, else its creator) while they are on the server,
//   else every human server owner and admin, one card each in their DM with
//   the agent, all for the same row. Whoever decides first wins and every
//   card shows how it ended;
// - a decision (agentApproveCallForm.ts) re-checks the person at the click,
//   not who the card went to, then calls antiproton's decide;
// - delivery, which only Raft knows: the hold's first card (or that nobody
//   can get one) is reported to antiproton once, so an expired hold tells
//   "nobody decided" from "nobody was asked". Never who was asked.
// The provider token never leaves this server process: not to an agent, a
// client, a log line or an audit row. The hint keys are public keys, not secret.
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { z } from "zod";
import {
  AGENT_APPROVE_CALL_DECISION_FIELD,
  asServerId,
  storedActionCardActionSchema,
  type ActionCardMetadata,
  type ActionCardResult,
  type AgentApproveCallAction,
  type AgentCallApprovalRole,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { ed25519PublicKeyProblem } from "../lib/ed25519PublicKey";
import { parseStrictJson, StrictJsonError, type StrictJsonValue } from "../lib/strictJson";
import {
  actionCards,
  agentRuntimeApprovalCards,
  agentRuntimeApprovalSync,
  agentRuntimeApprovals,
  agentRuntimeProvisions,
  agents,
  messages,
  serverMembers,
  users,
} from "../db/schema";
import type { ActionCardSubmittedInput } from "./actionCardForms";
import { ActionCardAlreadyExecutedError, emitActionCardMessageUpdated, postServerBuiltActionCard } from "./actionCardsService";
import { actionCardPresentationFor, storedActionCardSpecNames } from "./actionCardPresentation";
import {
  approvalEndedSentence,
  approveCallAction,
  approvalStatusMovesForward,
  holdFactsOf,
  providerApprovalItemSchema,
  sameHoldFacts,
  type ProviderApprovalItem,
} from "./agentRuntimeApprovalItem";
import {
  providerRequest,
  resolveProviderConfig,
  type AgentRuntimeProviderTarget,
  type ProviderCallResult,
  type ResolvedProviderConfig,
} from "./agentRuntimeProviderService";
import * as channelService from "./channelService";
import { recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import { mcpAgentOwnerUserId } from "./managedMcpConnectionOwnership";

// ---------------------------------------------------------------------------
// Configuration

/** antiproton's hint public keys per target: plain config, not secrets (parseApprovalHintPublicKeys). */
export const ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV = "ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS";
export const ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV = "ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS";
const TARGETS: readonly AgentRuntimeProviderTarget[] = ["default", "canary"];
const MAX_HINT_KEYS_BYTES = 4096;
/** A key id: in the config and in a hint's signature header. */
const HINT_KEY_ID_SOURCE = "[A-Za-z0-9._-]{1,64}";
const HINT_KEY_ID = new RegExp(`^${HINT_KEY_ID_SOURCE}$`, "u");
/** Standard base64 with its padding, of 32 bytes (a raw public key) and of 64 (a signature). */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/u;
const BASE64_64_BYTES_SOURCE = "[A-Za-z0-9+/]{86}==";
/** How far a hint's timestamp may be from Raft's clock, either way (contract: 300 s). */
export const APPROVAL_HINT_MAX_SKEW_SECONDS = 300;
/** A card for at most this many owners and admins of one server (the owner gone). */
const MAX_ADMIN_DECIDERS = 50;
const DECIDE_TIMEOUT_MS = 10_000;
const DECIDE_ATTEMPTS = 3;
let decideRetryDelayMs = 250;

/** Shorten the pause between decide retries (0: none). Test only. */
export function setApprovalDecideRetryDelayForTest(ms: number | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("approval test hooks are test-only");
  decideRetryDelayMs = ms ?? 250;
}

/** One of antiproton's hint signing keys, by the id its hints name it with. */
export interface ApprovalHintKey {
  keyId: string;
  /** The raw 32-byte Ed25519 public key. */
  raw: Buffer;
  publicKey: KeyObject;
}

export type ApprovalHintKeysParse = { ok: true; keys: ApprovalHintKey[] } | { ok: false; problem: string };

/**
 * A target's hint public keys: a JSON object of key id → standard base64
 * (padded, 44 characters) of the raw 32-byte Ed25519 public key,
 * `{"<key id>":"<public key>"}`; two ids at once while antiproton rotates.
 * All or nothing: any problem (not a strict JSON object, no key, a key id
 * twice or outside HINT_KEY_ID, a value that is not 32 bytes in canonical
 * base64 or not a usable Ed25519 point, one public key under two ids) refuses
 * the whole value, with what is wrong.
 */
export function parseApprovalHintPublicKeys(raw: string): ApprovalHintKeysParse {
  const fail = (problem: string): ApprovalHintKeysParse => ({ ok: false, problem });
  if (Buffer.byteLength(raw, "utf8") > MAX_HINT_KEYS_BYTES) return fail(`longer than ${MAX_HINT_KEYS_BYTES} bytes`);
  let value: Record<string, StrictJsonValue>;
  try {
    // Strict: JSON.parse would keep the last of a key id given twice.
    value = parseStrictJson(raw);
  } catch (err) {
    return fail(`not a JSON object of key id to public key (${err instanceof StrictJsonError ? err.message : "unreadable"})`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return fail("no key");
  const keys: ApprovalHintKey[] = [];
  for (const [keyId, encoded] of entries) {
    if (!HINT_KEY_ID.test(keyId)) return fail(`key id ${JSON.stringify(keyId.slice(0, 64))} is not 1 to 64 of A-Z a-z 0-9 . _ -`);
    if (typeof encoded !== "string" || !BASE64_32_BYTES.test(encoded) || Buffer.from(encoded, "base64").toString("base64") !== encoded) {
      return fail(`key ${keyId} is not the standard base64 of a raw 32-byte Ed25519 public key`);
    }
    const bytes = Buffer.from(encoded, "base64");
    const pointProblem = ed25519PublicKeyProblem(bytes);
    if (pointProblem) return fail(`key ${keyId} is not a usable Ed25519 public key: ${pointProblem}`);
    const same = keys.find((key) => key.raw.equals(bytes));
    if (same) return fail(`keys ${same.keyId} and ${keyId} are the same public key`);
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
    keys.push({ keyId, raw: bytes, publicKey });
  }
  return { ok: true, keys };
}

const hintKeysParsed = new Map<string, { raw: string; parsed: ApprovalHintKeysParse }>();
const hintKeysProblemsLogged = new Set<string>();

function logHintKeysProblemOnce(envName: string, raw: string, problem: string): void {
  const logged = `${envName}\n${raw}\n${problem}`;
  if (hintKeysProblemsLogged.has(logged)) return;
  hintKeysProblemsLogged.add(logged);
  console.error(`[approvals] ${envName} is ignored, so that target accepts no hints and serves no approvals: ${problem}`);
}

/** A key env var's keys: null when unset (no log) or refused (logged once per value). Parsed once per value. */
function hintKeysOf(envName: string, env: NodeJS.ProcessEnv): ApprovalHintKey[] | null {
  const raw = env[envName]?.trim();
  if (!raw) return null;
  let cached = hintKeysParsed.get(envName);
  if (cached?.raw !== raw) {
    cached = { raw, parsed: parseApprovalHintPublicKeys(raw) };
    hintKeysParsed.set(envName, cached);
  }
  if (!cached.parsed.ok) {
    logHintKeysProblemOnce(envName, raw, cached.parsed.problem);
    return null;
  }
  return cached.parsed.keys;
}

/**
 * The target's hint keys. The canary's are its own: a key id or public key
 * also in the default target's list refuses the canary's value (the key id is
 * not signed, so a shared key would let a hint pick its target).
 */
function hintKeys(target: AgentRuntimeProviderTarget, env: NodeJS.ProcessEnv): ApprovalHintKey[] | null {
  if (target === "default") return hintKeysOf(ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV, env);
  const keys = hintKeysOf(ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV, env);
  if (!keys) return null;
  const defaults = hintKeysOf(ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV, env) ?? [];
  const shared = keys.find((key) => defaults.some((other) => other.keyId === key.keyId || other.raw.equals(key.raw)));
  if (shared) {
    logHintKeysProblemOnce(
      ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV,
      env[ANTIPROTON_CANARY_APPROVAL_HINT_PUBLIC_KEYS_ENV]!.trim(),
      `key ${shared.keyId} is also in ${ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV}; the canary needs keys of its own`,
    );
    return null;
  }
  return keys;
}

/**
 * The target's approvals, when Raft serves them there: antiproton configured
 * for it (resolveProviderConfig: its URL and platform token; canary only on
 * staging) and its hint public keys set and valid. Either missing: no hints
 * accepted, no reconcile, no cards.
 */
export function approvalTargetConfig(target: AgentRuntimeProviderTarget, env: NodeJS.ProcessEnv = process.env): { provider: ResolvedProviderConfig; hintKeys: ApprovalHintKey[] } | null {
  const provider = resolveProviderConfig("antiproton", env, target);
  if (!provider) return null;
  const keys = hintKeys(target, env);
  return keys ? { provider, hintKeys: keys } : null;
}

export function configuredApprovalTargets(env: NodeJS.ProcessEnv = process.env): AgentRuntimeProviderTarget[] {
  return TARGETS.filter((target) => approvalTargetConfig(target, env) !== null);
}

const serverQuery = (raftServerId: string) => `?raftServerId=${encodeURIComponent(raftServerId)}`;

export function providerAgentApprovalsPath(raftAgentId: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}/approvals${serverQuery(raftServerId)}`;
}

export function providerApprovalDecidePath(raftAgentId: string, operationId: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}/approvals/${encodeURIComponent(operationId)}/decide${serverQuery(raftServerId)}`;
}

export function providerApprovalDeliveryPath(raftAgentId: string, operationId: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}/approvals/${encodeURIComponent(operationId)}/delivery${serverQuery(raftServerId)}`;
}

// ---------------------------------------------------------------------------
// The hint

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hintBodySchema = z.object({
  type: z.string().max(64).optional(),
  operationId: z.string().max(128).optional(),
  raftAgentId: z.string().regex(UUID),
  raftServerId: z.string().regex(UUID),
});

export type ApprovalHintVerdict =
  | { ok: true; target: AgentRuntimeProviderTarget; raftAgentId: string; raftServerId: string }
  | { ok: false; status: 400 | 401 | 404; code: string };

function ed25519Verifies(publicKey: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    return verifySignature(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

const HINT_SIGNATURE = new RegExp(`^keyid=(${HINT_KEY_ID_SOURCE}); ed25519=(${BASE64_64_BYTES_SOURCE})$`, "u");

/**
 * `keyid=<key id>; ed25519=<standard base64 of the 64-byte signature>`, exactly:
 * these two fields in this order, one `; ` between them, nothing else. Null
 * for anything else.
 */
export function parseApprovalHintSignature(header: string | undefined): { keyId: string; signature: Buffer } | null {
  const match = HINT_SIGNATURE.exec(header?.trim() ?? "");
  if (!match) return null;
  const signature = Buffer.from(match[2]!, "base64");
  // Canonical base64 only (Buffer ignores the last character's unused bits).
  if (signature.length !== 64 || signature.toString("base64") !== match[2]) return null;
  return { keyId: match[1]!, signature };
}

/**
 * A hint is antiproton's when its `X-Antiproton-Timestamp` is within
 * APPROVAL_HINT_MAX_SKEW_SECONDS and its `X-Antiproton-Signature`
 * (parseApprovalHintSignature) names a key id listed for a configured target
 * and holds a valid Ed25519 signature of "<timestamp>.<raw body>" under that
 * key. Only that key is tried: an unknown key id is refused, never checked
 * against the other keys. The target the key is listed for is where its agent
 * is pulled from. Only then is the body read, and only for which agent to pull.
 * There is no replay cache: a hint only says what to pull (pulls coalesce), and
 * the signed timestamp bounds a replay to the window.
 */
export function verifyApprovalHint(input: {
  body: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): ApprovalHintVerdict {
  const env = input.env ?? process.env;
  const keys = TARGETS.flatMap((target) => approvalTargetConfig(target, env)?.hintKeys.map((key) => ({ target, key })) ?? []);
  if (keys.length === 0) return { ok: false, status: 404, code: "not_found" };
  const timestamp = input.timestamp?.trim() ?? "";
  if (!/^\d{1,12}$/u.test(timestamp) || Math.abs(input.nowMs / 1000 - Number(timestamp)) > APPROVAL_HINT_MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, code: "approval_hint_timestamp_invalid" };
  }
  const signature = parseApprovalHintSignature(input.signature);
  // Key ids are unique across targets (hintKeys), so this is the one key the hint names.
  const named = signature ? keys.find(({ key }) => key.keyId === signature.keyId) : undefined;
  if (!signature || !named || !ed25519Verifies(named.key.publicKey, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.body]), signature.signature)) {
    return { ok: false, status: 401, code: "approval_hint_signature_invalid" };
  }
  const matched = named.target;
  let parsed: z.infer<typeof hintBodySchema> | null = null;
  try {
    const result = hintBodySchema.safeParse(JSON.parse(input.body.toString("utf8")));
    parsed = result.success ? result.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { ok: false, status: 400, code: "approval_hint_invalid" };
  return { ok: true, target: matched, raftAgentId: parsed.raftAgentId.toLowerCase(), raftServerId: parsed.raftServerId.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Agents and deciders

interface HostedAgent {
  id: string;
  serverId: string;
  name: string;
  displayName: string | null;
  assistantOwnerUserId: string | null;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
}

const hostedAgentColumns = {
  id: agents.id,
  serverId: agents.serverId,
  name: agents.name,
  displayName: agents.displayName,
  assistantOwnerUserId: agents.assistantOwnerUserId,
  creatorType: agents.creatorType,
  creatorId: agents.creatorId,
};
const LIVE_PROVISION_STATES = ["provisioning", "active", "failed"] as const;

/** A live agent of this server provisioned at antiproton on `target`; null for anything else (another server's, a computer agent, deleted). */
async function hostedAgent(target: AgentRuntimeProviderTarget, raftAgentId: string, raftServerId: string): Promise<HostedAgent | null> {
  if (!UUID.test(raftAgentId) || !UUID.test(raftServerId)) return null;
  const [row] = await getDb().select(hostedAgentColumns).from(agents)
    .innerJoin(agentRuntimeProvisions, eq(agentRuntimeProvisions.agentId, agents.id))
    .where(and(
      eq(agents.id, raftAgentId.toLowerCase()),
      eq(agents.serverId, raftServerId.toLowerCase()),
      isNull(agents.deletedAt),
      eq(agentRuntimeProvisions.provider, "antiproton"),
      eq(agentRuntimeProvisions.providerTarget, target),
      inArray(agentRuntimeProvisions.state, [...LIVE_PROVISION_STATES]),
    ))
    .limit(1);
  return row ?? null;
}

async function memberRole(serverId: string, userId: string): Promise<"owner" | "admin" | "member" | "guest" | null> {
  const [row] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).limit(1);
  return row?.role ?? null;
}

/** The agent's owner while they are on its server (mcpAgentOwnerUserId: an assistant's owner, else the human who created it); else null. */
async function presentOwnerId(agent: HostedAgent): Promise<string | null> {
  const ownerId = mcpAgentOwnerUserId(agent);
  return ownerId && await memberRole(agent.serverId, ownerId) ? ownerId : null;
}

/**
 * Who decides the agent's holds now: its owner while they are a member of the
 * server; otherwise every human owner and admin of the server (owners first,
 * at most MAX_ADMIN_DECIDERS).
 */
async function approvalDeciders(agent: HostedAgent): Promise<{ decider: AgentApproveCallAction["decider"]; userIds: string[] }> {
  const ownerId = await presentOwnerId(agent);
  if (ownerId) return { decider: "owner", userIds: [ownerId] };
  const admins = await getDb().select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, agent.serverId), inArray(serverMembers.role, ["owner", "admin"])))
    .orderBy(sql`case when ${serverMembers.role} = 'owner' then 0 else 1 end`, asc(serverMembers.userId))
    .limit(MAX_ADMIN_DECIDERS);
  return { decider: "server_admin", userIds: admins.map((row) => row.userId) };
}

/**
 * The grounds on which `userId` may decide this agent's holds at this moment,
 * whoever the card went to: its owner while they are on the server, and only
 * them; otherwise a server owner or admin. Null: they may not.
 */
export async function approverRole(agent: HostedAgent, userId: string): Promise<AgentCallApprovalRole | null> {
  const ownerId = await presentOwnerId(agent);
  if (ownerId) return userId === ownerId ? "agent_owner" : null;
  const role = await memberRole(agent.serverId, userId);
  return role === "owner" ? "server_owner" : role === "admin" ? "server_admin" : null;
}

// ---------------------------------------------------------------------------
// Faults, for tests of what one failure must not stop

type ApprovalFaultStage = "apply" | "sync" | "report";
let faultForTest: ((stage: ApprovalFaultStage, operationId: string) => boolean) | null = null;

/** Make `stage` throw for the holds `fault` names (null: none). Test only. */
export function setApprovalFaultForTest(fault: typeof faultForTest): void {
  if (process.env.NODE_ENV !== "test") throw new Error("approval test hooks are test-only");
  faultForTest = fault;
}

function injectFault(stage: ApprovalFaultStage, operationId: string): void {
  if (faultForTest?.(stage, operationId)) throw new Error(`injected ${stage} fault`);
}

/** A failure logged without the item or any secret: what failed, and the error's class. */
function logFailure(what: string, err: unknown): void {
  console.error(`[approvals] ${what} failed:`, err instanceof Error ? err.name : "unknown error");
}

// ---------------------------------------------------------------------------
// Holds

type HoldRow = typeof agentRuntimeApprovals.$inferSelect;
type ApprovalResult = Extract<ActionCardResult, { kind: "agent-call-approval" }>;
type Executor = ReturnType<typeof getDb>;

/** What every card of an ended (or approved and running) hold shows. */
export function approvalCardResult(hold: Pick<HoldRow, "status" | "decidedBy" | "decidedAt" | "item">): ApprovalResult | null {
  if (hold.status === "pending") return null;
  return {
    kind: "agent-call-approval",
    status: hold.status,
    decidedBy: hold.decidedBy ?? null,
    decidedAt: hold.decidedAt ? hold.decidedAt.toISOString() : null,
    outcome: hold.item.outcome,
  };
}

/**
 * Records what antiproton reports for one hold, in `tx`, under the hold's row
 * lock. A hold Raft never showed is recorded only while pending (an ended one
 * needs no card). A report never moves a hold back (approvalStatusMovesForward).
 * Returns the hold's id, whether anything changed, and `expired` when this
 * report is the one that ended it `expired` (once per hold: an end never
 * changes and the row lock serializes reports), with whether a card was ever
 * delivered; the caller audits it after the commit (auditApprovalExpired).
 */
async function recordProviderItem(
  tx: Executor,
  target: AgentRuntimeProviderTarget,
  agent: Pick<HostedAgent, "id" | "serverId">,
  item: ProviderApprovalItem,
): Promise<{ id: string; changed: boolean; expired?: { delivered: boolean } } | null> {
  const next = holdFactsOf(item);
  const providerUpdatedAt = item.updatedAt ? new Date(item.updatedAt) : null;
  const [current] = await tx.select().from(agentRuntimeApprovals)
    .where(and(eq(agentRuntimeApprovals.agentId, agent.id), eq(agentRuntimeApprovals.operationId, item.operationId)))
    .for("update")
    .limit(1);
  if (!current) {
    if (item.status !== "pending") return null;
    const [inserted] = await tx.insert(agentRuntimeApprovals).values({
      serverId: agent.serverId,
      agentId: agent.id,
      providerTarget: target,
      operationId: item.operationId,
      ...next,
      providerUpdatedAt,
    }).onConflictDoNothing().returning({ id: agentRuntimeApprovals.id });
    return inserted ? { id: inserted.id, changed: true } : null;
  }
  if (!approvalStatusMovesForward(current.status, next.status) || sameHoldFacts(current, next)) return { id: current.id, changed: false };
  await tx.update(agentRuntimeApprovals)
    .set({ ...next, ...(providerUpdatedAt ? { providerUpdatedAt } : {}), updatedAt: new Date() })
    .where(eq(agentRuntimeApprovals.id, current.id));
  const expired = next.status === "expired" && current.status !== "expired" ? { delivered: current.firstCardAt !== null } : undefined;
  return { id: current.id, changed: true, ...(expired ? { expired } : {}) };
}

/**
 * The hold ended `expired` (recordProviderItem said this report ended it):
 * audited once, with whether any card of it was ever delivered. The same
 * best-effort audit as a decision's; no person, card or message is named.
 */
async function auditApprovalExpired(hold: { id: string; serverId: string; agentId: string; operationId: string }, delivered: boolean): Promise<void> {
  await recordIntegrationAuditEventBestEffort({
    serverId: hold.serverId,
    eventType: "agent_runtime.approval_ended",
    outcome: "success",
    source: "system",
    actor: { type: "system" },
    requester: { type: "agent", id: hold.agentId },
    subject: { type: "agent", id: hold.agentId },
    target: { type: "agent_runtime_approval", id: hold.id },
    metadata: { operationId: hold.operationId, status: "expired", delivered },
  });
}

/** recordProviderItem in its own transaction, then the hold's cards brought in line when it changed. */
async function applyProviderItem(
  target: AgentRuntimeProviderTarget,
  agent: HostedAgent,
  item: ProviderApprovalItem,
  options: { io?: SocketServer | null; exceptMessageId?: string } = {},
): Promise<string | null> {
  injectFault("apply", item.operationId);
  const recorded = await getDb().transaction((tx) => recordProviderItem(tx as Executor, target, agent, item));
  if (recorded?.expired) {
    await auditApprovalExpired({ id: recorded.id, serverId: agent.serverId, agentId: agent.id, operationId: item.operationId }, recorded.expired.delivered);
  }
  // A concurrent first report inserted it: bring the cards in line all the same.
  const id = recorded?.id ?? (item.status === "pending" ? await holdIdOf(agent.id, item.operationId) : null);
  if (id && (recorded?.changed ?? true)) await syncApprovalCards(id, options);
  return id;
}

async function holdIdOf(agentId: string, operationId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: agentRuntimeApprovals.id }).from(agentRuntimeApprovals)
    .where(and(eq(agentRuntimeApprovals.agentId, agentId), eq(agentRuntimeApprovals.operationId, operationId))).limit(1);
  return row?.id ?? null;
}

/**
 * Holds antiproton no longer has (or no longer knows the agent of), or whose
 * agent is gone: Raft's own end, `unavailable`, which a later report from
 * antiproton supersedes. Only open holds (pending, approved) take it.
 */
async function markUnavailable(approvalIds: readonly string[], io: SocketServer | null | undefined): Promise<void> {
  if (approvalIds.length === 0) return;
  const ended = await getDb().update(agentRuntimeApprovals)
    .set({ status: "unavailable", updatedAt: new Date() })
    .where(and(inArray(agentRuntimeApprovals.id, [...approvalIds]), inArray(agentRuntimeApprovals.status, ["pending", "approved"])))
    .returning({ id: agentRuntimeApprovals.id });
  for (const { id } of ended) {
    try {
      await syncApprovalCards(id, { io });
    } catch (err) {
      logFailure("card update", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Cards

class CardNotNeeded extends Error {}

const isUniqueViolation = (err: unknown) => {
  const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
  return code === "23505";
};

/**
 * Brings one hold's cards in line with it. Pending: every current decider has
 * a card (a decider who joined since, or every owner and admin once the owner
 * left, gets one; nothing new once past its deadline, which antiproton ends,
 * or once its agent is gone), and a card that showed it unavailable is open
 * again. Otherwise: every card shows how it ended, `exceptMessageId` (the
 * card being decided on, which the decision writes itself) aside. One card
 * that fails does not stop the others. A pending hold that never had a card
 * and has nobody to send one to (no decider, or none whose DM with the agent
 * can be opened) records no_recipient, once, and reports it.
 */
export async function syncApprovalCards(approvalId: string, options: { io?: SocketServer | null; exceptMessageId?: string } = {}): Promise<void> {
  const [row] = await getDb().select({ hold: agentRuntimeApprovals, agent: { ...hostedAgentColumns, deletedAt: agents.deletedAt } })
    .from(agentRuntimeApprovals)
    .innerJoin(agents, eq(agents.id, agentRuntimeApprovals.agentId))
    .where(eq(agentRuntimeApprovals.id, approvalId)).limit(1);
  if (!row) return;
  const { hold, agent } = row;
  injectFault("sync", hold.operationId);
  const cards = await getDb().select({ userId: agentRuntimeApprovalCards.userId, messageId: agentRuntimeApprovalCards.messageId })
    .from(agentRuntimeApprovalCards).where(eq(agentRuntimeApprovalCards.approvalId, approvalId));
  const result = approvalCardResult(hold);
  const each = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      logFailure(what, err);
    }
  };
  if (result) {
    for (const card of cards) {
      if (card.messageId !== options.exceptMessageId) await each("card update", () => showApprovalResult(card.messageId, result, options.io));
    }
    return;
  }
  for (const card of cards) await each("card reopen", () => reopenApprovalCard(card.messageId, options.io));
  if (agent.deletedAt || (hold.expiresAt && hold.expiresAt.getTime() <= Date.now())) return;
  const deciders = await approvalDeciders(agent);
  const carded = new Set(cards.map((card) => card.userId));
  // Whether anyone has, or could get, a card.
  let reachable = cards.length > 0;
  for (const userId of deciders.userIds) {
    if (carded.has(userId)) continue;
    try {
      if (await postApprovalCard(hold, agent, userId, deciders.decider, options.io) !== "no_dm") reachable = true;
    } catch (err) {
      // A post that failed may yet reach its decider: no proof of nobody.
      reachable = true;
      logFailure("card post", err);
    }
  }
  if (!reachable && await recordNoRecipient(hold.id)) {
    await reportApprovalDeliveryBestEffort(hold.id);
  }
}

/**
 * One decider's card, in their DM with the agent: `no_dm` when that DM cannot
 * be opened (an assistant's, which is its owner's only), `not_needed` when the
 * hold is no longer pending or the person has a card already. The hold's first
 * card records `first_card_at` in its own transaction and, once that is over,
 * reports the delivery; no later card does either.
 */
async function postApprovalCard(
  hold: HoldRow,
  agent: HostedAgent,
  userId: string,
  decider: AgentApproveCallAction["decider"],
  io: SocketServer | null | undefined,
): Promise<"posted" | "no_dm" | "not_needed"> {
  const dm = await channelService.findOrCreateDM(agent.serverId, userId, agent.id);
  if (!dm) return "no_dm";
  const agentName = agent.displayName || agent.name;
  const action = approveCallAction({ approvalId: hold.id, agentId: agent.id, agentName, item: hold.item, expiresAt: hold.expiresAt, decider });
  let firstCard = false;
  try {
    await postServerBuiltActionCard({
      io,
      serverId: asServerId(agent.serverId),
      requesterAgentId: agent.id,
      channelId: dm.id,
      action,
      names: { agents: { [agent.id]: agentName } },
      async beforeCommit(tx, posted) {
        // Serialized with every state change of the hold and every other card
        // post (they lock its row; a share lock here would deadlock two first
        // cards upgrading it): a card is posted only while it is pending, and
        // once per person (the key refuses a second one; the loser posts nothing).
        const [still] = await tx.select({ status: agentRuntimeApprovals.status }).from(agentRuntimeApprovals)
          .where(eq(agentRuntimeApprovals.id, hold.id)).for("no key update").limit(1);
        if (still?.status !== "pending") throw new CardNotNeeded();
        await tx.insert(agentRuntimeApprovalCards).values({ approvalId: hold.id, userId, messageId: posted.messageId });
        // The hold's first card ever, and only that: a second decider's card,
        // or a card posted again after its message went, leaves it. A
        // no_recipient report made before is superseded: delivered is owed now.
        const [first] = await tx.update(agentRuntimeApprovals)
          .set({ firstCardAt: new Date(), deliveryReportedAt: null, deliveryReportResult: null })
          .where(and(eq(agentRuntimeApprovals.id, hold.id), isNull(agentRuntimeApprovals.firstCardAt)))
          .returning({ id: agentRuntimeApprovals.id });
        firstCard = first !== undefined;
      },
    });
  } catch (err) {
    if (err instanceof CardNotNeeded || isUniqueViolation(err)) return "not_needed";
    throw err;
  } finally {
    // After the card's transaction: committed (reported now), or rolled back
    // (nothing new is owed, and the reconcile resends whatever still is).
    if (firstCard) await reportApprovalDeliveryBestEffort(hold.id);
  }
  return "posted";
}

/** The approval card behind `messageId`, locked, with its stored metadata; null when it is not one. */
async function lockedApprovalCard(tx: Executor, messageId: string) {
  const [card] = await tx.select({
    id: actionCards.id, state: actionCards.state, payload: actionCards.payload, result: actionCards.result,
    executedAt: actionCards.executedAt, executedByUserId: actionCards.executedByUserId,
  }).from(actionCards).where(eq(actionCards.messageId, messageId)).for("update").limit(1);
  if (!card) return null;
  const action = storedActionCardActionSchema.safeParse(card.payload);
  if (!action.success || action.data.type !== "agent:approve_call") return null;
  const [message] = await tx.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId)).limit(1);
  const stored = message?.actionMetadata as ActionCardMetadata | null | undefined;
  if (!stored || stored.kind !== "action-card") return null;
  return { card, action: action.data, stored };
}

const resultStatusOf = (result: unknown): ApprovalResult["status"] | null => {
  const value = result as Partial<ApprovalResult> | null;
  return value?.kind === "agent-call-approval" && typeof value.status === "string" ? value.status : null;
};

/**
 * Writes `result` on one card, in `tx`: executed, executedAt set once, the
 * person who decided on it (if any) kept. Never moves a card's result back
 * (an executed run is not shown as approved again). `decider`: the person whose
 * decision this card records, with the values they submitted, so that their
 * execute finds it done by them. Returns whether it wrote.
 */
async function writeCardResult(
  tx: Executor,
  messageId: string,
  result: ApprovalResult,
  decider?: { userId: string; userName: string | null; submittedInput: ActionCardSubmittedInput },
): Promise<boolean> {
  const locked = await lockedApprovalCard(tx, messageId);
  if (!locked) return false;
  const { card, action, stored } = locked;
  if (card.state !== "prepared" && card.state !== "executed") return false;
  const shownStatus = card.state === "executed" ? resultStatusOf(card.result) : null;
  if (shownStatus && !approvalStatusMovesForward(shownStatus, result.status)) return false;
  // The decider's own card: theirs unless it already names someone.
  const attribute = decider && (card.state === "prepared" || card.executedByUserId === null) ? decider : null;
  if (card.state === "executed" && !attribute && isDeepStrictEqual(card.result, result)) return false;
  const now = new Date();
  const executedAt = card.executedAt ?? now;
  await tx.update(actionCards).set({
    state: "executed",
    result,
    executedAt,
    ...(attribute ? { executedByUserId: attribute.userId, submittedInput: attribute.submittedInput } : {}),
    updatedAt: now,
  }).where(eq(actionCards.id, card.id));
  const metadata: ActionCardMetadata = {
    ...stored,
    state: "executed",
    result,
    executedAt: stored.executedAt ?? executedAt.toISOString(),
    ...(attribute ? { executedByUserId: attribute.userId, executedByUserName: attribute.userName } : {}),
    presentation: actionCardPresentationFor(action, {
      result,
      names: storedActionCardSpecNames(stored.presentation),
      ...(stored.targetServerName ? { serverName: stored.targetServerName } : {}),
    }),
  };
  await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, messageId));
  return true;
}

/** A card shows how its hold ended (or that it was approved and runs). */
async function showApprovalResult(messageId: string, result: ApprovalResult, io: SocketServer | null | undefined): Promise<void> {
  const written = await getDb().transaction((tx) => writeCardResult(tx as Executor, messageId, result));
  if (written && io) await emitActionCardMessageUpdated(io, { id: messageId });
}

/** A card that showed its hold unavailable is open again when antiproton reports the hold pending after all. */
async function reopenApprovalCard(messageId: string, io: SocketServer | null | undefined): Promise<void> {
  const reopened = await getDb().transaction(async (tx) => {
    const locked = await lockedApprovalCard(tx as Executor, messageId);
    if (!locked || locked.card.state !== "executed" || locked.card.executedByUserId !== null || resultStatusOf(locked.card.result) !== "unavailable") return false;
    const now = new Date();
    await tx.update(actionCards).set({ state: "prepared", result: null, executedAt: null, updatedAt: now }).where(eq(actionCards.id, locked.card.id));
    const metadata: ActionCardMetadata = {
      ...locked.stored,
      state: "prepared",
      result: null,
      executedAt: null,
      presentation: actionCardPresentationFor(locked.action, {
        names: storedActionCardSpecNames(locked.stored.presentation),
        ...(locked.stored.targetServerName ? { serverName: locked.stored.targetServerName } : {}),
      }),
    };
    await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, messageId));
    return true;
  });
  if (reopened && io) await emitActionCardMessageUpdated(io, { id: messageId });
}

/**
 * The agent is being deleted (agentService.deleteAgent, in its transaction):
 * its open holds end `unavailable` and every card of them shows it. Agents are
 * soft-deleted, so nothing cascades. Nothing is broadcast here (the caller has
 * no socket server); emitAgentApprovalCards does that after the commit.
 */
export async function retireAgentApprovals(tx: Executor, agentId: string): Promise<void> {
  const ended = await tx.update(agentRuntimeApprovals)
    .set({ status: "unavailable", updatedAt: new Date() })
    .where(and(eq(agentRuntimeApprovals.agentId, agentId), inArray(agentRuntimeApprovals.status, ["pending", "approved"])))
    .returning();
  for (const hold of ended) {
    const result = approvalCardResult(hold)!;
    const cards = await tx.select({ messageId: agentRuntimeApprovalCards.messageId }).from(agentRuntimeApprovalCards)
      .where(eq(agentRuntimeApprovalCards.approvalId, hold.id));
    for (const card of cards) await writeCardResult(tx, card.messageId, result);
  }
}

/** Broadcasts every card of the agent's holds (after retireAgentApprovals committed). */
export async function emitAgentApprovalCards(io: SocketServer | null | undefined, agentId: string): Promise<void> {
  if (!io) return;
  const cards = await getDb().select({ messageId: agentRuntimeApprovalCards.messageId }).from(agentRuntimeApprovalCards)
    .innerJoin(agentRuntimeApprovals, eq(agentRuntimeApprovals.id, agentRuntimeApprovalCards.approvalId))
    .where(eq(agentRuntimeApprovals.agentId, agentId))
    .limit(500);
  for (const card of cards) await emitActionCardMessageUpdated(io, { id: card.messageId });
}

// ---------------------------------------------------------------------------
// Delivery reports

const DELIVERY_REPORT_TIMEOUT_MS = 10_000;
/** At most this many owed reports are resent per reconcile run, newest hold first. */
const DELIVERY_RESEND_LIMIT = 100;
/** A report still owed this long after its hold was created is no longer resent (antiproton ends a hold after 24 hours). */
export const DELIVERY_RESEND_WINDOW_MS = 7 * 24 * 60 * 60_000;

type DeliveryReportResult = NonNullable<HoldRow["deliveryReportResult"]>;

/**
 * antiproton's answer to a delivery report: final (recorded, never sent
 * again), or null (still owed: the reconcile resends it). A 404 is final only
 * with antiproton's `approval_not_found`; a bare one is a route that
 * antiproton does not have yet.
 */
function deliveryReportResultOf(res: ProviderCallResult): DeliveryReportResult | null {
  if (res.kind !== "response") return null;
  if (res.status >= 200 && res.status < 300) return "accepted";
  if (res.status === 409) return "not_pending";
  if (res.status === 404 && res.error?.code === "approval_not_found") return "not_found";
  return null;
}

/** Nobody can get the pending hold's card: recorded once, and never for a hold that ever had a card. Whether this call recorded it. */
async function recordNoRecipient(approvalId: string): Promise<boolean> {
  const [recorded] = await getDb().update(agentRuntimeApprovals)
    .set({ noRecipientAt: new Date() })
    .where(and(
      eq(agentRuntimeApprovals.id, approvalId),
      eq(agentRuntimeApprovals.status, "pending"),
      isNull(agentRuntimeApprovals.firstCardAt),
      isNull(agentRuntimeApprovals.noRecipientAt),
    ))
    .returning({ id: agentRuntimeApprovals.id });
  return recorded !== undefined;
}

/**
 * Tells antiproton how the hold's card went, when a report is owed (no final
 * answer yet): `delivered` at `first_card_at` once it ever had a card, else
 * `no_recipient` at `no_recipient_at`, read now, so no_recipient is never
 * sent once Raft has recorded a card. With the provider token, at the hold's
 * own target, like a decision. The body names no person, card or message. A
 * final answer is recorded only while the outcome it answers is still the one
 * owed: a no_recipient answer that arrives after a first card does not settle
 * the delivered report.
 */
async function reportApprovalDelivery(approvalId: string): Promise<void> {
  const [hold] = await getDb().select({
    agentId: agentRuntimeApprovals.agentId,
    serverId: agentRuntimeApprovals.serverId,
    providerTarget: agentRuntimeApprovals.providerTarget,
    operationId: agentRuntimeApprovals.operationId,
    firstCardAt: agentRuntimeApprovals.firstCardAt,
    noRecipientAt: agentRuntimeApprovals.noRecipientAt,
    deliveryReportedAt: agentRuntimeApprovals.deliveryReportedAt,
  }).from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.id, approvalId)).limit(1);
  if (!hold || hold.deliveryReportedAt) return;
  const delivered = hold.firstCardAt !== null;
  const body = hold.firstCardAt ? { outcome: "delivered", deliveredAt: hold.firstCardAt.toISOString() }
    : hold.noRecipientAt ? { outcome: "no_recipient", checkedAt: hold.noRecipientAt.toISOString() }
    : null;
  if (!body) return;
  const config = approvalTargetConfig(hold.providerTarget);
  if (!config) return;
  injectFault("report", hold.operationId);
  const res = await providerRequest(config.provider, "POST", providerApprovalDeliveryPath(hold.agentId, hold.operationId, hold.serverId), {
    body,
    timeoutMs: DELIVERY_REPORT_TIMEOUT_MS,
  });
  const result = deliveryReportResultOf(res);
  if (!result) {
    if (res.kind === "response" && (res.status === 401 || res.status === 403)) {
      console.warn("[approvals] delivery report refused (check the provider token):", res.status);
    } else {
      console.info("[approvals] delivery report deferred:", res.kind === "response" ? `http_${res.status}` : `network_${res.code}`);
    }
    return;
  }
  // antiproton has it, or no longer holds the call pending: either way, final.
  if (result !== "accepted") console.info("[approvals] delivery report final:", result);
  await getDb().update(agentRuntimeApprovals)
    .set({ deliveryReportedAt: new Date(), deliveryReportResult: result })
    .where(and(
      eq(agentRuntimeApprovals.id, approvalId),
      isNull(agentRuntimeApprovals.deliveryReportedAt),
      delivered ? isNotNull(agentRuntimeApprovals.firstCardAt) : isNull(agentRuntimeApprovals.firstCardAt),
    ));
}

async function reportApprovalDeliveryBestEffort(approvalId: string): Promise<void> {
  try {
    await reportApprovalDelivery(approvalId);
  } catch (err) {
    logFailure("delivery report", err);
  }
}

/**
 * The reconcile's resend, the only retry: each report the target still owes
 * (a card or no_recipient recorded, no final answer), for holds created within
 * DELIVERY_RESEND_WINDOW_MS, newest first, at most DELIVERY_RESEND_LIMIT a
 * run. One that fails is logged and the rest go on.
 */
async function resendDeliveryReports(target: AgentRuntimeProviderTarget): Promise<void> {
  const owed = await getDb().select({ id: agentRuntimeApprovals.id }).from(agentRuntimeApprovals)
    .where(and(
      eq(agentRuntimeApprovals.providerTarget, target),
      isNull(agentRuntimeApprovals.deliveryReportedAt),
      or(isNotNull(agentRuntimeApprovals.firstCardAt), isNotNull(agentRuntimeApprovals.noRecipientAt)),
      gt(agentRuntimeApprovals.createdAt, new Date(Date.now() - DELIVERY_RESEND_WINDOW_MS)),
    ))
    .orderBy(desc(agentRuntimeApprovals.createdAt))
    .limit(DELIVERY_RESEND_LIMIT);
  for (const hold of owed) await reportApprovalDeliveryBestEffort(hold.id);
}

// ---------------------------------------------------------------------------
// Pulling and reconciling

function parseItems(raw: unknown): ProviderApprovalItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = providerApprovalItemSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The operation ids a list names, read raw: an entry Raft cannot parse is still listed. */
function listedOperationIds(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.flatMap((entry) => {
    const id = (entry as { operationId?: unknown } | null)?.operationId;
    return typeof id === "string" ? [id] : [];
  }));
}

/**
 * One agent's holds, from its own object at antiproton (always current). The
 * agent's local holds are read once; a listed hold that changes nothing Raft
 * keeps (an ended one, most of the list) is skipped, so a hint costs the open
 * and changed holds, not every hold ever. A local hold still open that the
 * list does not name, or every one when antiproton answers 404 `not_found`
 * for the agent, ends `unavailable`.
 */
export async function pullAgentApprovals(input: { target: AgentRuntimeProviderTarget; raftAgentId: string; raftServerId: string; io?: SocketServer | null }): Promise<void> {
  const config = approvalTargetConfig(input.target);
  if (!config) return;
  const agent = await hostedAgent(input.target, input.raftAgentId, input.raftServerId);
  if (!agent) return;
  const res = await providerRequest(config.provider, "GET", providerAgentApprovalsPath(agent.id, agent.serverId));
  if (res.kind !== "response") return;
  const agentGone = res.status === 404 && res.error?.code === "not_found";
  if (res.status !== 200 && !agentGone) return;
  const raw = agentGone ? [] : (res.body as { approvals?: unknown } | null)?.approvals;
  const local = new Map((await getDb().select().from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.agentId, agent.id)))
    .map((hold) => [hold.operationId, hold]));
  for (const item of parseItems(raw)) {
    if (item.raftAgentId.toLowerCase() !== agent.id || item.raftServerId.toLowerCase() !== agent.serverId) continue;
    const hold = local.get(item.operationId);
    if (!hold ? item.status !== "pending" : !approvalStatusMovesForward(hold.status, item.status) || sameHoldFacts(hold, holdFactsOf(item))) continue;
    try {
      await applyProviderItem(input.target, agent, item, { io: input.io });
    } catch (err) {
      logFailure("hold update", err);
    }
  }
  const listed = listedOperationIds(raw);
  const missing = [...local.values()].filter((hold) => (hold.status === "pending" || hold.status === "approved") && !listed.has(hold.operationId));
  await markUnavailable(missing.map((hold) => hold.id), input.io);
}

const pulls = new Map<string, { again: boolean; done: Promise<void> }>();

/**
 * Pull one agent's holds, coalesced: hints for an agent whose pull is running
 * make one more pull after it, however many arrive.
 */
export function scheduleAgentApprovalPull(input: { target: AgentRuntimeProviderTarget; raftAgentId: string; raftServerId: string; io?: SocketServer | null }): Promise<void> {
  const key = `${input.target}:${input.raftServerId}:${input.raftAgentId}`;
  const running = pulls.get(key);
  if (running) {
    running.again = true;
    return running.done;
  }
  const entry = { again: false, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      do {
        entry.again = false;
        await pullAgentApprovals(input).catch((err) => logFailure("pull", err));
      } while (entry.again);
    } finally {
      pulls.delete(key);
    }
  })();
  pulls.set(key, entry);
  return entry.done;
}

/** Every pull in flight has settled. Test only. */
export async function settleApprovalPullsForTest(): Promise<void> {
  // The pulls are already running: wait for each in turn (no new work starts here).
  while (pulls.size > 0) {
    for (const entry of [...pulls.values()]) await entry.done;
  }
}

const RECONCILE_LEASE_MS = 4 * 60_000;
/** The provider-wide list is read from a little before the last change seen (contract: rows can lag by an alarm pass). */
export const RECONCILE_OVERLAP_MS = 10 * 60_000;
/** A row that keeps failing holds the watermark back at most this long after its last change, then is passed (and logged). */
export const RECONCILE_FAILED_ROW_GRACE_MS = 60 * 60_000;
const RECONCILE_PAGE_LIMIT = 200;
const RECONCILE_MAX_PAGES = 50;

/**
 * antiproton's provider-wide list since the watermark, every page: each hold
 * of an agent here recorded, cards in line. One replica at a time (a lease on
 * the target's row). A row that fails is logged and the rest go on.
 *
 * The watermark: rows come oldest change first, so it moves to the largest
 * `updatedAt` before the first row that failed, and the next run (reading
 * from RECONCILE_OVERLAP_MS before it) tries that row again. A row whose
 * last change is older than RECONCILE_FAILED_ROW_GRACE_MS no longer holds it
 * back: it is passed with a log line, and its hold is still covered by its
 * agent's hints and the local pass. Then the delivery reports still owed are
 * resent (resendDeliveryReports). Then the local pass: an open hold whose
 * agent is gone ends `unavailable`; a pending hold past its deadline is pulled
 * from its agent (which expires it there); every pending hold's cards follow
 * its deciders. Returns null when it did not run.
 */
export async function reconcileApprovals(input: { target: AgentRuntimeProviderTarget; io?: SocketServer | null }): Promise<{ pages: number; rows: number; failed: number } | null> {
  const config = approvalTargetConfig(input.target);
  if (!config) return null;
  const db = getDb();
  const now = new Date();
  await db.insert(agentRuntimeApprovalSync).values({ providerTarget: input.target }).onConflictDoNothing();
  const [leased] = await db.update(agentRuntimeApprovalSync)
    .set({ leaseUntil: new Date(now.getTime() + RECONCILE_LEASE_MS), updatedAt: now })
    .where(and(eq(agentRuntimeApprovalSync.providerTarget, input.target), or(isNull(agentRuntimeApprovalSync.leaseUntil), lt(agentRuntimeApprovalSync.leaseUntil, now))))
    .returning({ watermark: agentRuntimeApprovalSync.watermark });
  if (!leased) return null;
  let watermark = leased.watermark;
  let blocked = false;
  let pages = 0;
  let rows = 0;
  let failed = 0;
  let errorCode: string | null = null;
  try {
    const since = watermark ? new Date(watermark.getTime() - RECONCILE_OVERLAP_MS) : null;
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: String(RECONCILE_PAGE_LIMIT) });
      if (since) query.set("updatedSince", since.toISOString());
      if (cursor) query.set("cursor", cursor);
      const res: ProviderCallResult = await providerRequest(config.provider, "GET", `/provision/approvals?${query.toString()}`);
      if (res.kind !== "response") { errorCode = `network_${res.code}`; break; }
      if (res.status !== 200) { errorCode = `http_${res.status}`; break; }
      const body = res.body as { approvals?: unknown; nextCursor?: unknown } | null;
      for (const item of parseItems(body?.approvals)) {
        rows += 1;
        const changed = item.updatedAt ? new Date(item.updatedAt) : null;
        try {
          const agent = await hostedAgent(input.target, item.raftAgentId, item.raftServerId);
          if (agent) await applyProviderItem(input.target, agent, item, { io: input.io });
        } catch (err) {
          failed += 1;
          logFailure("reconcile row", err);
          // A recent row holds the watermark here so the next run retries it; an old one is passed.
          if (!changed || changed.getTime() > now.getTime() - RECONCILE_FAILED_ROW_GRACE_MS) blocked = true;
          continue;
        }
        if (!blocked && changed && (!watermark || changed > watermark)) watermark = changed;
      }
      pages += 1;
      cursor = typeof body?.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
    } while (cursor && pages < RECONCILE_MAX_PAGES);
  } catch (err) {
    errorCode = "internal_error";
    logFailure("reconcile", err);
  } finally {
    await db.update(agentRuntimeApprovalSync)
      .set({ watermark, leaseUntil: null, lastRunAt: now, lastErrorCode: errorCode ?? (failed > 0 ? "row_failed" : null), updatedAt: new Date() })
      .where(eq(agentRuntimeApprovalSync.providerTarget, input.target));
  }
  await resendDeliveryReports(input.target).catch((err) => logFailure("delivery resend", err));
  await sweepOpenHolds(input.target, input.io);
  return { pages, rows, failed };
}

async function sweepOpenHolds(target: AgentRuntimeProviderTarget, io: SocketServer | null | undefined): Promise<void> {
  const now = new Date();
  // Open holds of an agent that is no longer a live hosted agent here (deleted, moved off antiproton).
  const orphaned = await getDb().select({ id: agentRuntimeApprovals.id }).from(agentRuntimeApprovals)
    .innerJoin(agents, eq(agents.id, agentRuntimeApprovals.agentId))
    .leftJoin(agentRuntimeProvisions, and(
      eq(agentRuntimeProvisions.agentId, agentRuntimeApprovals.agentId),
      eq(agentRuntimeProvisions.providerTarget, target),
      inArray(agentRuntimeProvisions.state, [...LIVE_PROVISION_STATES]),
    ))
    .where(and(
      eq(agentRuntimeApprovals.providerTarget, target),
      inArray(agentRuntimeApprovals.status, ["pending", "approved"]),
      or(isNotNull(agents.deletedAt), isNull(agentRuntimeProvisions.agentId)),
    ))
    .limit(500);
  await markUnavailable(orphaned.map((hold) => hold.id), io);
  const overdue = await getDb().selectDistinct({ agentId: agentRuntimeApprovals.agentId, serverId: agentRuntimeApprovals.serverId })
    .from(agentRuntimeApprovals)
    .where(and(eq(agentRuntimeApprovals.providerTarget, target), eq(agentRuntimeApprovals.status, "pending"), lte(agentRuntimeApprovals.expiresAt, now)))
    .limit(200);
  for (const hold of overdue) await scheduleAgentApprovalPull({ target, raftAgentId: hold.agentId, raftServerId: hold.serverId, io });
  const open = await getDb().select({ id: agentRuntimeApprovals.id }).from(agentRuntimeApprovals)
    .where(and(eq(agentRuntimeApprovals.providerTarget, target), eq(agentRuntimeApprovals.status, "pending")))
    .orderBy(asc(agentRuntimeApprovals.expiresAt))
    .limit(500);
  for (const hold of open) {
    try {
      await syncApprovalCards(hold.id, { io });
    } catch (err) {
      logFailure("local pass", err);
    }
  }
}

const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Every 5 minutes (and once a minute after start): the reconcile of each configured target. */
export function startAgentRuntimeApprovalWorker(input: { io?: SocketServer | null } = {}): { stop(): void } {
  // Read the configuration now, so a refused hint key value is logged at start.
  configuredApprovalTargets();
  const run = () => {
    for (const target of configuredApprovalTargets()) {
      void reconcileApprovals({ target, io: input.io }).catch((err) => logFailure("reconcile", err));
    }
  };
  const first = setTimeout(run, 60_000);
  first.unref?.();
  const interval = setInterval(run, RECONCILE_INTERVAL_MS);
  interval.unref?.();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}

// ---------------------------------------------------------------------------
// Deciding

/** A decision that did not take effect and left this card as it was: the execute route answers with its status and code. */
export class ApprovalDecisionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type DecisionOutcome = "decided" | "replay" | "already_decided" | "expired" | "not_found" | "not_approver" | "unavailable" | "provider_error";

const outcomeOfEnd = (status: string): DecisionOutcome => (status === "expired" ? "expired" : status === "unavailable" ? "unavailable" : "already_decided");

/**
 * `userId` decides the hold behind the card `messageId` (its form `formId`).
 * Checked in this request, now, not by who the card went to: the hold is
 * open, the card is this hold's for this agent and server, and the person may
 * decide (approverRole); every attempt is audited with that click-time
 * result. Then antiproton decides it (idempotent per hold: a timeout or 5xx
 * is retried with the same decision, up to DECIDE_ATTEMPTS). No Raft lock is
 * held across that call: antiproton decides each hold once, atomically, and
 * answers whoever came second with the first decision.
 *
 * - antiproton recorded this person's decision (now, or their own replay):
 *   in one transaction the hold takes antiproton's returned state (only
 *   forward: a hint may have moved it on meanwhile) and this card is written
 *   executed, by them, with the values they submitted, so their execute finds
 *   their own completed card (a same-form retry). Every other card follows.
 * - The hold ended some other way (decided first by someone else, on the
 *   console, expired, gone): every card shows antiproton's record, this one
 *   included, and this person gets ActionCardAlreadyExecutedError with the
 *   refreshed card ("Already decided by a server admin."). The local hold is
 *   never set to this person's decision.
 * - Anything else (not theirs to decide, antiproton down or refusing):
 *   ApprovalDecisionError, and the card stays as it was.
 */
export async function decideApproval(input: {
  approvalId: string;
  agentId: string;
  serverId: string;
  userId: string;
  decision: "approve" | "deny";
  messageId: string;
  formId: string;
  io?: SocketServer | null;
}): Promise<ApprovalResult> {
  const [hold] = await getDb().select().from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.id, input.approvalId)).limit(1);
  const ours = hold && hold.agentId === input.agentId && hold.serverId === input.serverId ? hold : null;
  const audit = (outcome: DecisionOutcome, extra: { role?: AgentCallApprovalRole | null; providerStatus?: number | null; attempts?: number } = {}) =>
    recordIntegrationAuditEventBestEffort({
      serverId: input.serverId,
      eventType: "agent_runtime.approval_decided",
      outcome: outcome === "decided" || outcome === "replay" ? "success" : "failure",
      source: "action_card",
      actor: { type: "human", id: input.userId },
      requester: { type: "agent", id: input.agentId },
      subject: { type: "agent", id: input.agentId },
      target: { type: "agent_runtime_approval", id: input.approvalId },
      requestId: input.messageId,
      metadata: {
        operationId: ours?.operationId ?? null,
        decision: input.decision,
        role: extra.role ?? null,
        result: outcome,
        providerStatus: extra.providerStatus ?? null,
        attempts: extra.attempts ?? 0,
      },
    });
  /** The hold ended some other way: this card shows it, and the person learns how. */
  const endedElsewhere = async (outcome: DecisionOutcome, more: Parameters<typeof audit>[1] = {}): Promise<never> => {
    await syncApprovalCards(input.approvalId, { io: input.io });
    const [now] = await getDb().select().from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.id, input.approvalId)).limit(1);
    await audit(now ? outcomeOfEnd(now.status) : outcome, more);
    const [card] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, input.messageId)).limit(1);
    const metadata = card?.actionMetadata as ActionCardMetadata | null | undefined;
    if (now && metadata?.kind === "action-card" && metadata.state === "executed") {
      throw new ActionCardAlreadyExecutedError(metadata, approvalEndedSentence(now));
    }
    throw new ApprovalDecisionError(409, "APPROVAL_ALREADY_DECIDED", now ? approvalEndedSentence(now) : "This call can no longer be decided here.");
  };

  if (!ours) {
    await audit("unavailable");
    throw new ApprovalDecisionError(409, "APPROVAL_UNAVAILABLE", "This call can no longer be decided here.");
  }
  const agent = await hostedAgent(ours.providerTarget, ours.agentId, ours.serverId);
  if (!agent) {
    await markUnavailable([ours.id], input.io);
    return endedElsewhere("unavailable");
  }
  if (ours.status !== "pending") return endedElsewhere(outcomeOfEnd(ours.status));
  const role = await approverRole(agent, input.userId);
  if (!role) {
    await audit("not_approver");
    throw new ApprovalDecisionError(403, "NOT_APPROVER", "Only the agent's owner decides this call, or a server owner or admin once the owner has left the server.");
  }
  const config = approvalTargetConfig(ours.providerTarget);
  if (!config) {
    await audit("unavailable", { role });
    throw new ApprovalDecisionError(503, "APPROVALS_UNAVAILABLE", "Approvals are not available on this server right now.");
  }

  let attempts = 0;
  let res: ProviderCallResult;
  for (;;) {
    attempts += 1;
    res = await providerRequest(config.provider, "POST", providerApprovalDecidePath(agent.id, ours.operationId, agent.serverId), {
      body: { decision: input.decision, decidedBy: { raftUserId: input.userId, role } },
      timeoutMs: DECIDE_TIMEOUT_MS,
    });
    const retryable = res.kind === "network" || res.status >= 500;
    if (!retryable || attempts >= DECIDE_ATTEMPTS) break;
    if (decideRetryDelayMs > 0) await sleep(decideRetryDelayMs * attempts);
  }
  const providerStatus = res.kind === "response" ? res.status : null;
  const facts = { role, providerStatus, attempts };
  const body = res.kind === "response" ? res.body as { approval?: unknown; replay?: unknown } | null : null;
  const reported = body?.approval === undefined ? null : providerApprovalItemSchema.safeParse(body.approval);
  const item = reported?.success && reported.data.operationId === ours.operationId ? reported.data : null;

  if (res.kind === "response" && res.status === 200 && item) {
    // A replay is this person's own decision only when antiproton recorded it as theirs.
    const recordedBy = (body?.approval as { decidedBy?: { raftUserId?: unknown } } | undefined)?.decidedBy?.raftUserId;
    if (body?.replay === true && recordedBy !== input.userId) {
      await applyProviderItem(ours.providerTarget, agent, item, { io: input.io });
      return endedElsewhere("already_decided", facts);
    }
    const userName = await userDisplayName(input.userId);
    const { shown: result, expired } = await getDb().transaction(async (tx) => {
      const recorded = await recordProviderItem(tx as Executor, ours.providerTarget, agent, item);
      const [updated] = recorded ? await tx.select().from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.id, recorded.id)).limit(1) : [];
      const shown = updated ? approvalCardResult(updated) : null;
      if (!shown) return { shown: null, expired: recorded?.expired };
      await writeCardResult(tx as Executor, input.messageId, shown, {
        userId: input.userId,
        userName,
        submittedInput: { form: input.formId, values: { [AGENT_APPROVE_CALL_DECISION_FIELD]: input.decision } },
      });
      return { shown, expired: recorded?.expired };
    });
    if (expired) await auditApprovalExpired(ours, expired.delivered);
    if (!result) {
      await audit("provider_error", facts);
      throw new ApprovalDecisionError(502, "APPROVAL_PROVIDER_REJECTED", "antiproton answered without recording the decision.");
    }
    await syncApprovalCards(input.approvalId, { io: input.io, exceptMessageId: input.messageId });
    if (input.io) await emitActionCardMessageUpdated(input.io, { id: input.messageId });
    await audit(body?.replay === true ? "replay" : "decided", facts);
    return result;
  }
  if (res.kind === "response" && res.status === 409) {
    if (item) await applyProviderItem(ours.providerTarget, agent, item, { io: input.io });
    return endedElsewhere(res.error?.code === "approval_expired" ? "expired" : "already_decided", facts);
  }
  if (res.kind === "response" && res.status === 404 && (res.error?.code === "approval_not_found" || res.error?.code === "not_found")) {
    await markUnavailable([ours.id], input.io);
    return endedElsewhere("not_found", facts);
  }
  await audit("provider_error", facts);
  if (res.kind === "network" || res.status >= 500) {
    throw new ApprovalDecisionError(503, "APPROVAL_PROVIDER_UNAVAILABLE", "antiproton did not answer. Try again: deciding again is safe.");
  }
  if (res.status === 200) {
    // antiproton recorded something Raft could not read: the next hint or reconcile shows it.
    throw new ApprovalDecisionError(502, "APPROVAL_PROVIDER_REJECTED", "antiproton's answer could not be read. The card updates once it can be.");
  }
  console.error("[approvals] decide refused:", res.status, res.error?.code ?? "unknown");
  throw new ApprovalDecisionError(502, "APPROVAL_PROVIDER_REJECTED", "antiproton refused this decision.");
}

async function userDisplayName(userId: string): Promise<string | null> {
  const [user] = await getDb().select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.displayName ?? user?.name ?? null;
}
