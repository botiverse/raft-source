// External channel invites as product events (#wg-rbac:#60; Nova's contract,
// #proj-analytics:51bc46e0): the invite emails a host sends, the invitee
// opening the invite page, and anyone opening the invite link signed out. Server facts: best effort, never throw, never
// delay the caller. Enums and booleans only: never an address or its domain,
// the invite's id or token, the channel, or (for the page view) the host
// server or the inviter.

import { createHash } from "node:crypto";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { classifyRequesterUserAgent } from "../middleware/publicRequester";
import type { ExternalInviteForInvitee, ExternalInviteNotAddressed, InviteEmailObserver } from "./externalInviteService";
import { getProductEventSink } from "./productEventIngest";
import { firstSeenToday, recordServerProductEvent } from "./serverProductEvents";

/**
 * `external_invite_email_sent`, one per invite email handed to the mail
 * provider: what a send or resend passes to the invite service as its
 * `onEmails`. Counted for the host server and the person who sent them.
 * One after another, so a send of 20 reads the analytics gate one at a time.
 */
export function inviteEmailRecorder(req: Request, actorUserId: string, trigger: "send" | "resend"): InviteEmailObserver {
  const sink = getProductEventSink(req.app);
  return ({ hostServerId, sent, failed }) => {
    void (async () => {
      const results = [...Array<"sent">(sent).fill("sent"), ...Array<"failed">(failed).fill("failed")];
      for (const result of results) {
        await recordServerProductEvent(sink, {
          event: "external_invite_email_sent",
          userId: actorUserId,
          serverId: asServerId(hostServerId),
          properties: { trigger, result },
        });
      }
    })();
  };
}

/** The ways of joining an invite page's answer offers, as `external_invite_page_viewed` names them. */
export interface ExternalInvitePageWays {
  guest_offered: boolean;
  connect_offered: boolean;
  request_approval_offered: boolean;
  new_server_offered: boolean;
}

/**
 * Which ways in the page's `options` offer, as the web shows them
 * (ExternalInvitePage): the Guest and new-server rows follow `options.guest`
 * and `options.newServer`; the one "connect servers" row lists
 * `options.connect.servers`, where a server the person owns or administers
 * connects now (`connect_offered`) and one they are only a member of asks
 * its owner or admin (`request_approval_offered`). A server at its own
 * plan's limit (`atLimit`) is listed but cannot be chosen: not offered.
 */
export function externalInvitePageWays(options: ExternalInviteForInvitee["options"]): ExternalInvitePageWays {
  const choosable = options.connect.servers.filter((server) => !server.atLimit);
  return {
    guest_offered: options.guest,
    connect_offered: choosable.some((server) => server.canConnectDirectly),
    request_approval_offered: choosable.some((server) => server.needsApproval),
    new_server_offered: options.newServer,
  };
}

/**
 * Whether the invite's host server has product analytics on (#wg-rbac:#60,
 * Tenny): off, nothing is recorded about its invites, whoever opens them.
 * Read from the invite's host, not from any server on the row (these rows
 * have none). A host that is gone records nothing either.
 */
export async function hostRecordsInviteEvents(hostServerId: string): Promise<boolean> {
  const [host] = await getDb().select({ enabled: servers.productAnalyticsEnabled }).from(servers).where(eq(servers.id, hostServerId));
  return host?.enabled === true;
}

/**
 * `likely_bot` of `external_invite_link_opened`: judged once, from the
 * User-Agent the request sent, by the fixed classes the request span already
 * uses (publicRequester): anything but a browser or a Raft App is likely a
 * bot (a crawler, a link unfurler, a script, no User-Agent at all). A rough
 * judgment: a User-Agent is whatever the caller says. The User-Agent itself
 * is never kept, logged or recorded.
 */
export function likelyBotUserAgent(userAgent: string | undefined): boolean {
  const requester = classifyRequesterUserAgent(userAgent);
  return requester !== "browser" && requester !== "raft_app";
}

/**
 * `external_invite_link_opened`, after GET /api/external-invites/:token/preview
 * (signed out) answered 200: at most once per invite, UTC day and
 * `likely_bot` (so at most two rows: a scanner's open does not hide a
 * person's), whoever opened it. No person and no server on the row
 * (analytics_id and server_id null), nor the invite: the dedupe key is the
 * day, a SHA-256 of the invite id and the boolean, kept only in Redis and this
 * process for 26 hours (firstSeenToday). Nothing for an invite whose host has
 * product analytics off (`hostRecordsInviteEvents`, read by the preview's own
 * read of the host). `likelyBot` is decided by the route from the
 * User-Agent; only the boolean reaches here.
 */
export function recordExternalInviteLinkOpened(req: Request, inviteId: string, hostRecordsInviteEvents: boolean, likelyBot: boolean): void {
  if (!hostRecordsInviteEvents) return;
  const sink = getProductEventSink(req.app);
  void (async () => {
    try {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const invite = createHash("sha256").update(inviteId).digest("hex");
      // likely_bot is in the key (Nova, #14526): a mail scanner opening the link first does not hide the person's open.
      if (!await firstSeenToday(`external-invite-link-opened:${day}:${invite}:${likelyBot ? "bot" : "not_bot"}`, now)) return;
      await recordServerProductEvent(sink, {
        event: "external_invite_link_opened",
        userId: null,
        serverId: null,
        properties: { likely_bot: likelyBot },
        now,
      });
    } catch (err) {
      console.warn("[product-events] external_invite_link_opened not recorded:", err instanceof Error ? err.name : "unknown");
    }
  })();
}

/** `new_account`: the account is younger than this at the view (the server does not record which invite, if any, an account was created for). */
export const NEW_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `external_invite_page_viewed`, after GET /api/external-invites/:token
 * answered 200. Only the invited account's view of an open invite: not
 * another account holding the link (`addressedToYou: false`), not the
 * receipt of an accepted one. Once per person, invite and UTC day: the key
 * is the user id and a SHA-256 of the invite id, kept only in Redis (26
 * hours) and this process (firstSeenToday). No server on the row. Nothing
 * for an invite whose host has product analytics off (from the release that ships #14526); the
 * viewer's own usage-data choice still applies on top (recordServerProductEvent).
 */
export function recordExternalInvitePageViewed(
  req: Request,
  userId: string,
  invite: { id: string; hostServerId: string },
  page: ExternalInviteForInvitee | ExternalInviteNotAddressed,
): void {
  if (!("options" in page) || page.status === "accepted") return;
  const ways = externalInvitePageWays(page.options);
  const sink = getProductEventSink(req.app);
  void (async () => {
    try {
      if (!await hostRecordsInviteEvents(invite.hostServerId)) return;
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const inviteHash = createHash("sha256").update(invite.id).digest("hex");
      if (!await firstSeenToday(`external-invite-page-viewed:${day}:${userId}:${inviteHash}`, now)) return;
      const [user] = await getDb().select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
      if (!user) return;
      await recordServerProductEvent(sink, {
        event: "external_invite_page_viewed",
        userId,
        serverId: null,
        properties: { ...ways, new_account: now - user.createdAt.getTime() < NEW_ACCOUNT_MAX_AGE_MS },
        now,
      });
    } catch (err) {
      console.warn("[product-events] external_invite_page_viewed not recorded:", err instanceof Error ? err.name : "unknown");
    }
  })();
}
