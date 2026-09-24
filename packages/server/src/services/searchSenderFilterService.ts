import * as channelService from "./channelService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import * as serverService from "./serverService.js";

type SearchSenderRequester =
  | { type: "agent"; id: string }
  | { type: "user"; id: string }
  | null;

function normalizeMemberHandleRef(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("member ref must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("member ref must not be empty");
  }
  const handle = trimmed.replace(/^@/, "").trim();
  if (!handle) {
    throw new Error("member handle must not be empty");
  }
  return handle;
}

/**
 * Agent-facing member-ref search contract:
 * - agent-facing member refs are handles (`@handle` or `handle`), not UUIDs;
 * - the server resolves handle -> internal sender id and applies visibility;
 * - unknown or invisible members return one not-found shape instead of a
 *   silent empty search result. Ambiguous human/agent handles are explicit.
 *
 * `senderId` remains accepted as a low-level compatibility path.
 */
export async function resolveSearchSenderFilter(
  serverId: string,
  requester: SearchSenderRequester,
  rawSender: unknown,
  rawSenderId: unknown,
): Promise<
  | { ok: true; senderId?: string }
  | { ok: false; status: 400 | 404 | 409; error: string; errorCode: string }
> {
  if (rawSender !== undefined && rawSenderId !== undefined) {
    return {
      ok: false,
      status: 400,
      error: "Use either sender or senderId, not both",
      errorCode: "invalid_member_ref",
    };
  }

  if (rawSenderId !== undefined) {
    if (typeof rawSenderId !== "string" || !rawSenderId.trim()) {
      return {
        ok: false,
        status: 400,
        error: "senderId must be a non-empty string",
        errorCode: "invalid_member_ref",
      };
    }
    return { ok: true, senderId: rawSenderId.trim() };
  }

  let handle: string | null;
  try {
    handle = normalizeMemberHandleRef(rawSender);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "Invalid member ref",
      errorCode: "invalid_member_ref",
    };
  }
  if (!handle) return { ok: true };

  const [humanId, agentId] = await Promise.all([
    channelService.resolveUserByName(serverId, handle),
    channelService.resolveAgentByName(serverId, handle),
  ]);

  const humanDirectoryHidden = humanId
    ? await shouldHideHumanSender(serverId, requester)
    : false;
  const visibleHumanId = humanDirectoryHidden ? null : humanId;

  if (visibleHumanId && agentId) {
    return {
      ok: false,
      status: 409,
      error: `Member @${handle} is ambiguous`,
      errorCode: "ambiguous_member_ref",
    };
  }

  const senderId = visibleHumanId ?? agentId ?? undefined;
  if (!senderId) {
    return {
      ok: false,
      status: 404,
      error: `Member not found: @${handle}`,
      errorCode: "member_not_found",
    };
  }

  return { ok: true, senderId };
}

async function shouldHideHumanSender(serverId: string, requester: SearchSenderRequester): Promise<boolean> {
  if (!requester) return false;
  if (requester.type === "agent") {
    // Route/service permission reads go through actorPermissions so future
    // actor-scope rules have one boundary instead of scattered raw role reads.
    const role = await getActorServerRoleInServer(serverId, "agent", requester.id);
    return role === "member" && await serverService.isHumanDirectoryHidden(serverId);
  }
  return serverService.shouldHideHumanDirectoryFromRequester(serverId, requester.id);
}
