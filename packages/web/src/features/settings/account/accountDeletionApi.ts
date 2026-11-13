/**
 * The web's calls to /api/me/account/deletion (packages/server/src/routes/
 * accountDeletion.ts; design "删除账号：服务端设计" §3, #triage:c3d9bd7c): a
 * person deleting their own account.
 *
 * A successful POST signs out every sign-in, this one included. While a
 * deletion is scheduled every other API answers 403 `account_deletion_pending`
 * (store/accountDeletionPending.ts, the page in pages/AccountDeletionPendingPage).
 */
import api from "../../../api/client";
import { parseMethods } from "../../../components/auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../../../components/auth/secondFactorSignIn";
import type { StepUpAnswer } from "../../../components/settings/secondFactorApi";
import { getApiErrorResponse } from "../../../utils/apiErrorResponse";
import { othersAgentOf, ownerOf, postNotifyAgentOwners, timeOf } from "../../computer/othersAgentsApi";
import type { AgentOwner, NotifyAgentOwnersResult, OthersAgent } from "../../computer/othersAgentsApi";

const BASE = "/me/account/deletion";

export interface AccountDeletionServer {
  id: string;
  name: string;
  slug: string;
}

/** A server the person is the only owner of, with other members (409 `sole_owner_servers`). */
export interface SoleOwnerServer extends AccountDeletionServer {
  memberCount: number;
}

/**
 * A shared server whose subscription the person pays for: it ends with its
 * current period. `periodEnd` is null when the server has no period end on
 * record (the row then names no date).
 */
export interface PaidServerEnding extends AccountDeletionServer {
  periodEnd: string | null;
}

/** What happens to one of the person's agents (app-managed agents aren't listed: they don't change). */
export type AgentOutcome = "transfer_to_owner" | "archive_personal_assistant" | "closes_with_server";

export interface AccountDeletionAgent {
  id: string;
  name: string;
  server: AccountDeletionServer;
  outcome: AgentOutcome;
  /** Who a `transfer_to_owner` agent goes to; null while the person is still that server's only owner. */
  toUser: { id: string; name: string } | null;
}

/** An agent bound to one of the person's computers (GET's `computers[].agents[]`). */
export interface AccountDeletionBoundAgent {
  id: string;
  name: string;
  ownedByMe: boolean;
  /** Only for another member's agent (`ownedByMe: false`); absent for the person's own. */
  owner?: AgentOwner;
  /** When Raft last reminded that owner to move it; absent for the person's own agents. */
  ownerNotifiedAt?: string | null;
  /** When the next reminder is allowed (once a day); null: now. Absent for the person's own agents. */
  ownerNextNotifyAt?: string | null;
  /** Another member's personal assistant (only its owner can move it); absent reads as false. */
  personalAssistant?: boolean;
}

/**
 * One of the person's own computers still attached to a server, with the
 * agents bound to it (GET's `computers`). The computer is deleted on the
 * deletion date. `ownedByMe` marks the person's own agents (ones they
 * created, or their personal assistant): they go to the server's owner, and
 * the person may move or archive them first (#12468). Other members' agents
 * on it hold the deletion up (#triage:d10ace06): the request revokes the
 * computer's keys at once, so they have to leave first, and only their owner
 * can move them (`owner`, `ownerNotifiedAt`; 409 `others_agents_on_computers`).
 */
export interface AccountDeletionComputer {
  id: string;
  name: string;
  server: AccountDeletionServer;
  agents: AccountDeletionBoundAgent[];
}

/** Another member's agent on one of the person's computers: it holds the deletion up until its owner moves it. */
export interface OthersAgentOnComputer extends OthersAgent {
  server: AccountDeletionServer;
  computer: { id: string; name: string };
}

/**
 * The checklist's facts (Archer's #12416 and its follow-ups). Every list is
 * optional on the wire: an older server sends none of them. `soleOwnerServers`,
 * `agents` and `computers` stay undefined when absent (the page then falls back
 * to the 409 at submit time and the generic agents copy; no computer rows);
 * the others read as empty.
 */
export interface AccountDeletionChecklist {
  soleMemberServers: AccountDeletionServer[];
  soleOwnerServers?: SoleOwnerServer[];
  paidServersEndingAtPeriodEnd: PaidServerEnding[];
  agents?: AccountDeletionAgent[];
  computers?: AccountDeletionComputer[];
  /** How long a request made now would wait, in days (#12468); absent from an older server: the page then names no date. */
  graceDays?: number;
}

export type SubscriptionRestorationResult = "restored" | "not_restored" | "unknown";
export type AccountDeletionRequestId = string & { readonly __accountDeletionRequestId: unique symbol };

function restorationOf(value: unknown): SubscriptionRestorationResult {
  return value === "restored" || value === "not_restored" ? value : "unknown";
}

export type AccountDeletionStatus = AccountDeletionChecklist & (
  | { status: "none"; subscriptionRestoration?: SubscriptionRestorationResult }
  | { status: "scheduled"; requestId?: AccountDeletionRequestId; requestedAt: string; scheduledFor: string; subscriptionCancellationUnconfirmed?: true }
);

/**
 * What the request carries to prove it's the person (one of them, or none
 * for the first try, which the server answers with the methods it wants).
 */
export type AccountDeletionProof =
  | Record<string, never>
  | { secondFactor: StepUpAnswer }
  | { password: string }
  | { emailCode: string };

function serversOf(value: unknown): AccountDeletionServer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string" || typeof record.slug !== "string") return [];
    return [{ id: record.id, slug: record.slug, name: typeof record.name === "string" ? record.name : record.slug }];
  });
}

/** The servers in `value`, each with the extra fields `read` takes from its own entry. */
function serversWith<T>(value: unknown, read: (record: Record<string, unknown>) => T): Array<AccountDeletionServer & T> {
  if (!Array.isArray(value)) return [];
  const records = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (record && typeof record.id === "string") records.set(record.id, record);
  }
  return serversOf(value).map((server) => ({ ...server, ...read(records.get(server.id) ?? {}) }));
}

function soleOwnerServersOf(value: unknown): SoleOwnerServer[] {
  return serversWith(value, (record) => ({ memberCount: typeof record.memberCount === "number" ? record.memberCount : 0 }));
}

function paidServersOf(value: unknown): PaidServerEnding[] {
  return serversWith(value, (record) => ({ periodEnd: typeof record.periodEnd === "string" && record.periodEnd ? record.periodEnd : null }));
}

const AGENT_OUTCOMES = new Set<string>(["transfer_to_owner", "archive_personal_assistant", "closes_with_server"]);

function agentsOf(value: unknown): AccountDeletionAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string" || typeof record.outcome !== "string" || !AGENT_OUTCOMES.has(record.outcome)) return [];
    const [server] = serversOf([record.server]);
    if (!server) return [];
    const to = record.toUser && typeof record.toUser === "object" ? record.toUser as Record<string, unknown> : null;
    const toUser = to && typeof to.id === "string" && typeof to.name === "string" ? { id: to.id, name: to.name } : null;
    return [{
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      server,
      outcome: record.outcome as AgentOutcome,
      toUser,
    }];
  });
}

/** The 409's `agents` (`others_agents_on_computers`), in the shape GET's computers give. */
function othersAgentsOf(value: unknown): OthersAgentOnComputer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string") return [];
    const [server] = serversOf([record.server]);
    const machine = record.computer && typeof record.computer === "object" ? record.computer as Record<string, unknown> : null;
    if (!server || !machine || typeof machine.id !== "string") return [];
    return [{
      ...othersAgentOf(record as Record<string, unknown> & { id: string }),
      server,
      computer: { id: machine.id, name: typeof machine.name === "string" ? machine.name : machine.id },
    }];
  });
}

function computersOf(value: unknown): AccountDeletionComputer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string") return [];
    const [server] = serversOf([record.server]);
    if (!server) return [];
    const agents = Array.isArray(record.agents) ? record.agents.flatMap((agent): AccountDeletionBoundAgent[] => {
      const bound = agent && typeof agent === "object" ? agent as Record<string, unknown> : null;
      if (!bound || typeof bound.id !== "string") return [];
      // An older server doesn't say whose it is: then it's the person's to handle.
      const ownedByMe = bound.ownedByMe !== false;
      const name = typeof bound.name === "string" ? bound.name : bound.id;
      // The server sends no owner fields for the person's own agents.
      return [ownedByMe
        ? { id: bound.id, name, ownedByMe }
        : {
          id: bound.id,
          name,
          ownedByMe,
          owner: ownerOf(bound.owner),
          ownerNotifiedAt: timeOf(bound.ownerNotifiedAt),
          ownerNextNotifyAt: timeOf(bound.ownerNextNotifyAt),
          personalAssistant: bound.personalAssistant === true,
        }];
    }) : [];
    return [{ id: record.id, name: typeof record.name === "string" ? record.name : record.id, server, agents }];
  });
}

/**
 * `soleMemberServers` (the servers with only this person in them, which close
 * with the account) comes with Archer's cleanup PR; until then it is absent
 * and reads as none.
 */
function statusOf(data: unknown): AccountDeletionStatus {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (record.status !== "none" && record.status !== "scheduled") throw new Error("Account deletion status could not be confirmed");
  if (record.status === "scheduled" && typeof record.scheduledFor !== "string") throw new Error("Account deletion status could not be confirmed");
  const checklist: AccountDeletionChecklist = {
    soleMemberServers: serversOf(record.soleMemberServers),
    paidServersEndingAtPeriodEnd: paidServersOf(record.paidServersEndingAtPeriodEnd),
    ...(Array.isArray(record.soleOwnerServers) ? { soleOwnerServers: soleOwnerServersOf(record.soleOwnerServers) } : {}),
    ...(Array.isArray(record.agents) ? { agents: agentsOf(record.agents) } : {}),
    ...(Array.isArray(record.computers) ? { computers: computersOf(record.computers) } : {}),
    ...(typeof record.graceDays === "number" && Number.isInteger(record.graceDays) && record.graceDays > 0 ? { graceDays: record.graceDays } : {}),
  };
  if (record.status === "scheduled" && typeof record.scheduledFor === "string") {
    return {
      ...checklist,
      status: "scheduled",
      ...(typeof record.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.requestId) ? { requestId: record.requestId as AccountDeletionRequestId } : {}),
      requestedAt: typeof record.requestedAt === "string" ? record.requestedAt : "",
      scheduledFor: record.scheduledFor,
      ...(record.subscriptionCancellationUnconfirmed === true ? { subscriptionCancellationUnconfirmed: true as const } : {}),
    };
  }
  return { ...checklist, status: "none", subscriptionRestoration: restorationOf(record.subscriptionRestoration) };
}

export async function fetchAccountDeletionStatus(requestId?: AccountDeletionRequestId): Promise<AccountDeletionStatus> {
  const { data } = await api.get(BASE, requestId ? { params: { requestId } } : undefined);
  return statusOf(data);
}

/**
 * 200: scheduled, and every sign-in (this one too) is signed out.
 *
 * `forceAgentIds` (Force Unbind and Request Deletion; contract agreed by
 * Archer and Tenny, #triage:d10ace06, server not merged yet): exactly the
 * other people's agents the person confirmed (ForceUnbindAgentsDialog). In
 * one transaction the server re-reads: any other agent now bound answers 409
 * `others_agents_on_computers` and nothing happens; otherwise it unbinds
 * those agents (not deleted), takes the computers offline, records an audit
 * entry, sends each owner a system notice and goes on with the request.
 */
export async function requestAccountDeletion(proof: AccountDeletionProof, forceAgentIds?: readonly string[]): Promise<AccountDeletionStatus> {
  const { data } = await api.post(BASE, forceAgentIds ? { ...proof, forceAgentIds: [...forceAgentIds] } : proof);
  return statusOf(data);
}

export async function cancelAccountDeletion(requestId: AccountDeletionRequestId): Promise<{ subscriptionRestoration: SubscriptionRestorationResult }> {
  if (!requestId) throw new Error("The deletion request has not been confirmed");
  const { data } = await api.delete<{ status?: unknown; subscriptionNotResumed?: boolean; subscriptionRestoration?: unknown }>(`${BASE}/requests/${encodeURIComponent(requestId)}`);
  if (data?.status !== "none") throw new Error("Account deletion cancellation could not be confirmed");
  // Missing billing evidence is unknown; never infer a restoration.
  return { subscriptionRestoration: data?.subscriptionNotResumed === true ? "not_restored" : restorationOf(data?.subscriptionRestoration) };
}

/** Someone who can become an Owner of a server the person is the only owner of. */
export interface TransferCandidate {
  userId: string;
  name: string;
}

/**
 * The server's people who can take it over: GET /servers/:id/members (the
 * directory Settings › Administration › Admins reads), sent with that
 * server's X-Server-Id, without the person and without guests. Agents aren't
 * in it (they can't be owners).
 */
export async function fetchTransferCandidates(serverId: string, selfUserId: string | null): Promise<TransferCandidate[]> {
  const { data } = await api.get(`/servers/${encodeURIComponent(serverId)}/members`, { headers: { "X-Server-Id": serverId } });
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const member = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!member || typeof member.userId !== "string" || member.userId === selfUserId || member.role === "guest") return [];
    const displayName = typeof member.displayName === "string" && member.displayName.trim() ? member.displayName : null;
    return [{ userId: member.userId, name: displayName ?? (typeof member.name === "string" ? member.name : member.userId) }];
  });
}

/** The member-role change Admins makes (PATCH /servers/:id/members/:userId), with that server's X-Server-Id. */
export async function makeServerOwner(serverId: string, userId: string): Promise<void> {
  await api.patch(
    `/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`,
    { role: "owner" },
    { headers: { "X-Server-Id": serverId } },
  );
}

/**
 * Archives one of the person's agents from Delete Account (optional: it goes
 * to the server's owner otherwise): the DELETE every Archive sends
 * (store/agentStore `deleteAgent`, the workspace kept), with that agent's
 * server's X-Server-Id.
 */
export async function archiveAgentForDeletion(serverId: string, agentId: string): Promise<void> {
  await api.delete(`/agents/${encodeURIComponent(agentId)}`, { data: { workspace: "keep" }, headers: { "X-Server-Id": serverId } });
}

/**
 * Notify Owner to Move It from Delete Account (othersAgentsApi.ts
 * postNotifyAgentOwners): POST /me/account/deletion/notify-agent-owners
 * `{ agentIds }`, contract by Archer (#triage:d10ace06). Any refusal (a 400,
 * or 403 once the deletion is requested) rejects.
 */
export function notifyAgentOwners(agentIds: string[]): Promise<NotifyAgentOwnersResult> {
  return postNotifyAgentOwners(`${BASE}/notify-agent-owners`, agentIds);
}

/** Only for a person with neither a password nor two-step verification: a 6-digit code, 10 minutes, once. */
export async function sendAccountDeletionEmailCode(): Promise<{ expiresAt: string | null }> {
  const { data } = await api.post<{ sent?: boolean; expiresAt?: unknown }>(`${BASE}/email-code`, {});
  return { expiresAt: typeof data?.expiresAt === "string" ? data.expiresAt : null };
}

/** How the request dialog asks the person to prove it's them, from the `methods` the server listed. */
export type AccountDeletionReauth =
  | { kind: "second_factor"; methods: SignInSecondFactorMethod[] }
  | { kind: "password" }
  | { kind: "email_code" };

export function accountDeletionReauthFor(methods: unknown): AccountDeletionReauth | null {
  const secondFactor = parseMethods(methods);
  if (secondFactor.length > 0) return { kind: "second_factor", methods: secondFactor };
  const listed = Array.isArray(methods) ? methods : [];
  if (listed.includes("password")) return { kind: "password" };
  if (listed.includes("email_code")) return { kind: "email_code" };
  return null;
}

/** A refusal the request dialog turns into its own step; anything else is shown where it happened. */
export type AccountDeletionRefusal =
  | { kind: "reauth"; reauth: AccountDeletionReauth }
  | { kind: "sole_owner"; servers: SoleOwnerServer[] }
  | { kind: "others_agents"; agents: OthersAgentOnComputer[] }
  | { kind: "sign_in_again" };

export function accountDeletionRefusalOf(err: unknown): AccountDeletionRefusal | null {
  const response = getApiErrorResponse(err);
  const data = (err as { response?: { data?: { methods?: unknown; servers?: unknown; agents?: unknown } } } | null)?.response?.data;
  if (response?.status === 409 && response.code === "sole_owner_servers") {
    return { kind: "sole_owner", servers: soleOwnerServersOf(data?.servers) };
  }
  // Checked after sole_owner_servers: other members' agents still on the person's computers.
  if (response?.status === 409 && response.code === "others_agents_on_computers") {
    return { kind: "others_agents", agents: othersAgentsOf(data?.agents) };
  }
  if (response?.status === 403 && response.code === "session_family_required") return { kind: "sign_in_again" };
  // 403 reauth_required; 409 email_code_not_available lists the methods to use instead.
  if ((response?.status === 403 && response.code === "reauth_required")
    || (response?.status === 409 && response.code === "email_code_not_available")) {
    const reauth = accountDeletionReauthFor(data?.methods);
    return reauth ? { kind: "reauth", reauth } : null;
  }
  return null;
}

// ── The emailed one-click cancel link (Tenny, #triage:d10ace06 e3526c4e) ──
//
// The server's route (routes/accountDeletion.ts accountDeletionCancelLinkHandler,
// mounted in app.ts with the auth rate limit):
//   POST /api/auth/account-deletion/cancel  { token }   (no session; requireAuth not mounted)
//     200 { status: "none" }                  cancelled; a "deletion cancelled" email follows
//     400 { code: "account_deletion_token_invalid" }
//                                             malformed, unknown, used, past the effective
//                                             time, or the request no longer pending
//     429                                     the auth rate limit: read as a failure to retry
// The token: one-time, tied to the deletion request, valid until its
// `scheduledFor`, cancel-only (it signs nobody in): `adcl_` and 43 base64url characters
// (32 random bytes; requests.ts issueAccountDeletionCancelToken). The email
// links to `/?cancel_account_deletion=<token>` (emailService.ts
// accountDeletionCancelUrl). An older server without the route answers its
// unknown-route 404, which reads as an invalid link.

/** The query parameter the emailed cancel link opens. */
export const ACCOUNT_DELETION_CANCEL_PARAM = "cancel_account_deletion";

/** The token of an emailed cancel link; only parseAccountDeletionCancelToken makes one. */
export type AccountDeletionCancelToken = string & { readonly __accountDeletionCancelToken: unique symbol };

const CANCEL_TOKEN_RE = /^adcl_[A-Za-z0-9_-]{43}$/;

/** A link's token in the server's shape (`adcl_` + 43 base64url characters), else null. */
export function parseAccountDeletionCancelToken(value: string | null | undefined): AccountDeletionCancelToken | null {
  return typeof value === "string" && CANCEL_TOKEN_RE.test(value) ? value as AccountDeletionCancelToken : null;
}

/** How the cancel link's click ended. `invalid` is final: another try can't help. */
export type CancelByLinkOutcome = "cancelled" | "cancelled_subscription_not_resumed" | "cancelled_subscription_unknown" | "invalid" | "failed";

/** The emailed cancel link's click, signed in or not. */
export async function cancelAccountDeletionByLink(token: AccountDeletionCancelToken): Promise<CancelByLinkOutcome> {
  try {
    const { data } = await api.post<{ subscriptionNotResumed?: boolean; subscriptionRestoration?: unknown }>("/auth/account-deletion/cancel", { token });
    return data?.subscriptionNotResumed === true || data?.subscriptionRestoration === "not_restored" ? "cancelled_subscription_not_resumed"
      : data?.subscriptionRestoration === "restored" ? "cancelled" : "cancelled_subscription_unknown";
  } catch (err) {
    const response = getApiErrorResponse(err);
    if (response?.status === 400 && response.code === "account_deletion_token_invalid") return "invalid";
    // The route not deployed (or off): the unknown-route 404.
    if (response?.status === 404) return "invalid";
    return "failed";
  }
}
