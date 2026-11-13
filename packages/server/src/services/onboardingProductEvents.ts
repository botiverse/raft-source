// The new-user journey before a person has a server (#proj-onboarding:#2, Ferry): the
// verification email, verifying it, identity setup, the first server. The web sends no
// client events until there is a server to send them to (analytics/track.ts), so the
// server records these. Best effort: never throws, never delays the caller. The client is
// what the request says (X-Raft-Client-Platform), `unknown` when it does not.

import type { Request } from "express";
import { and, eq, lt, ne } from "drizzle-orm";
import { SERVER_SETUP_BLOCK_REASONS, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { servers } from "../db/schema";
import type { ServerSetupGateReason } from "./serverSetupStateService";
import { requestClientPlatform } from "./productEventContext";
import { getProductEventSink } from "./productEventIngest";
import { recordServerProductEvent } from "./serverProductEvents";

// `server_setup_blocked.reason` names projection gate reasons: a renamed reason must break the build here.
const SETUP_BLOCK_REASONS_ARE_GATE_REASONS: readonly ServerSetupGateReason[] = SERVER_SETUP_BLOCK_REASONS;
void SETUP_BLOCK_REASONS_ARE_GATE_REASONS;

function requestPlatform(req: Request) {
  return requestClientPlatform(req.get("x-raft-client-platform"), req.get("user-agent"));
}

export function recordEmailVerificationSent(
  req: Request,
  userId: string,
  trigger: "signup" | "resend",
  result: "sent" | "failed" | "rate_limited",
): void {
  void recordServerProductEvent(getProductEventSink(req.app), {
    event: "email_verification_sent",
    userId,
    serverId: null,
    properties: { trigger, result, platform: requestPlatform(req) },
  });
}

export function recordEmailVerified(req: Request, userId: string): void {
  void recordServerProductEvent(getProductEventSink(req.app), {
    event: "email_verified",
    userId,
    serverId: null,
    properties: { platform: requestPlatform(req) },
  });
}

export function recordAccountProfileCompleted(req: Request, userId: string): void {
  void recordServerProductEvent(getProductEventSink(req.app), {
    event: "account_profile_completed",
    userId,
    serverId: null,
    properties: { platform: requestPlatform(req) },
  });
}

/**
 * After the server committed: `first_server` = its owner owned no server created before it, deleted ones
 * included (one created at the same moment in another tab does not count against it).
 */
export function recordServerCreated(req: Request, server: { id: string; createdAt: Date }, ownerUserId: string): void {
  const platform = requestPlatform(req);
  const sink = getProductEventSink(req.app);
  const serverId = server.id;
  void (async () => {
    try {
      const [other] = await getDb().select({ id: servers.id }).from(servers)
        .where(and(
          eq(servers.ownerId, ownerUserId),
          ne(servers.id, serverId),
          eq(servers.kind, "normal"),
          lt(servers.createdAt, new Date(server.createdAt)),
        ))
        .limit(1);
      await recordServerProductEvent(sink, {
        event: "server_created",
        userId: ownerUserId,
        serverId: asServerId(serverId),
        properties: { first_server: !other, platform },
      });
    } catch (err) {
      console.warn("[product-events] server_created not recorded:", err instanceof Error ? err.name : "unknown");
    }
  })();
}
