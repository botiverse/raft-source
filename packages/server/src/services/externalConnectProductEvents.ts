// `external_channel_connect_finished` (cindyz via Warden, 2026-11-12,
// #wg-rbac:db8d6e83): one row each time an attempt to join or connect to an
// external channel finishes, successful or not. The request that made the
// attempt records it once its answer is decided (one row per server a
// multi-connect chose); the connect worker records its settlement of one that
// was answered `connecting` (`async`). No dedupe: every attempt is a row, and
// nothing a GET (the page the web reloads while connecting) answers is one.
// Server facts: best effort, never throw, never delay the caller. Enums and
// booleans only: never the invite or its token, the channel, the host server
// on an invitee's row, a server's name or the error text.

import { and, eq } from "drizzle-orm";
import {
  asServerId,
  EXTERNAL_CONNECT_REFUSAL_CODES,
  type ExternalConnectFinishedResult,
  type ExternalConnectPath,
  type ExternalConnectRefusalCode,
  type PaywallLimitSide,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelExternalInvites, channelServerConnectRequests, serverMembers, servers } from "../db/schema";
import { hashToken } from "./externalInviteService";
import type { ProductEventSink } from "./productEventScopeDbWriter";
import { recordServerProductEvent } from "./serverProductEvents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How one attempt finished: a result other than a refusal, or a refusal with its code (and a limit's side). */
export type ConnectFinishedOutcome =
  | { result: Exclude<ExternalConnectFinishedResult, "refused"> }
  | { result: "refused"; refusalCode: ExternalConnectRefusalCode; limitSide?: PaywallLimitSide };

/**
 * Whose workspace the row is counted under (the contract's attribution, Nova
 * #14526): a server the request names (the connecting server, the host for
 * host_direct, the request's server for self_connect, a server the caller
 * just created), kept only when the caller is a full member of it, never on
 * a Guest seat; null, no server.
 */
export type ConnectFinishedServer = string | null;

/**
 * The channel's host server, read after the answer (never slowing it): by id,
 * the invite's host by its token, or a connect request's host by its id. Its product analytics off, the row is
 * not written at all (whatever the row's own server); otherwise its plan is
 * `host_plan`. Null: no host known (an unknown token, a request not found):
 * written, with no `host_plan`.
 */
export type ConnectFinishedHost = { hostServerId: string } | { inviteToken: string } | { connectRequestId: string } | null;

export interface ConnectFinishedRow {
  path: ExternalConnectPath;
  outcome: ConnectFinishedOutcome;
  async: boolean;
  multi: boolean;
  server: ConnectFinishedServer;
  host: ConnectFinishedHost;
}

/**
 * A refusal code as the event lists it: one these routes answer, else `other`.
 * `connecting` (the host side's "a connection is under way") is the same
 * refusal as the invitee side's `connect_in_progress`.
 */
export function connectRefusalCode(code: string): ExternalConnectRefusalCode {
  if (code === "connecting") return "connect_in_progress";
  return (EXTERNAL_CONNECT_REFUSAL_CODES as readonly string[]).includes(code) ? code as ExternalConnectRefusalCode : "other";
}

/** A refusal's outcome from its code (as the answer or the span names it) and a limit refusal's side. */
export function refusedOutcome(code: string, limitSide?: unknown): ConnectFinishedOutcome {
  return {
    result: "refused",
    refusalCode: connectRefusalCode(code),
    ...(limitSide === "host" || limitSide === "connecting" ? { limitSide } : {}),
  };
}

// The worker has no request: its rows go to the sink the server set at startup
// (null in tests and without ScopeDB: nothing written).
let workerSink: ProductEventSink | null = null;

export function setExternalConnectWorkerProductEventSink(sink: ProductEventSink | null): void {
  workerSink = sink;
}

/** The row's server: the named one, only when the caller holds a full (non-Guest) seat on it. */
async function rowServerId(server: ConnectFinishedServer, userId: string | null): Promise<string | null> {
  if (server === null || userId === null || !UUID.test(server)) return null;
  const [seat] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server), eq(serverMembers.userId, userId)));
  return seat && seat.role !== "guest" ? server : null;
}

interface HostFacts {
  /** The host's product analytics switch: false, nothing about its invites is recorded. */
  recordsInviteEvents: boolean;
  plan: "free" | "paid";
}

async function hostFactsOf(source: Exclude<ConnectFinishedHost, null>): Promise<HostFacts | null> {
  const db = getDb();
  const columns = { plan: servers.plan, enabled: servers.productAnalyticsEnabled };
  let rows: Array<{ plan: string; enabled: boolean }>;
  if ("hostServerId" in source) {
    rows = await db.select(columns).from(servers).where(eq(servers.id, source.hostServerId));
  } else if ("inviteToken" in source) {
    rows = await db.select(columns).from(channelExternalInvites)
      .innerJoin(servers, eq(servers.id, channelExternalInvites.hostServerId))
      .where(eq(channelExternalInvites.tokenHash, hashToken(source.inviteToken)));
  } else {
    if (!UUID.test(source.connectRequestId)) return null;
    rows = await db.select(columns).from(channelServerConnectRequests)
      .innerJoin(servers, eq(servers.id, channelServerConnectRequests.hostServerId))
      .where(eq(channelServerConnectRequests.id, source.connectRequestId));
  }
  const [row] = rows;
  return row ? { recordsInviteEvents: row.enabled, plan: row.plan === "free" ? "free" : "paid" } : null;
}

/**
 * The rows of one finished request (or worker settlement), in order, without
 * awaiting. `userId`: the caller (the worker's: the joiner); its analytics id
 * follows their usage-data choice, and a row whose own server turned product
 * analytics off is not written (recordServerProductEvent). Nor is any row of
 * an attempt on a host whose product analytics is off (Tenny, #wg-rbac:#60:
 * a row with no server is no way around the host's switch). The host is read
 * once for all rows that name it.
 */
export function recordExternalConnectFinished(sink: ProductEventSink | null, userId: string | null, rows: readonly ConnectFinishedRow[]): void {
  if (rows.length === 0) return;
  void (async () => {
    const hosts = new Map<string, Promise<HostFacts | null>>();
    for (const row of rows) {
      try {
        const key = row.host === null ? null : JSON.stringify(row.host);
        if (row.host !== null && key !== null && !hosts.has(key)) hosts.set(key, hostFactsOf(row.host));
        const host = key === null ? null : await hosts.get(key)!;
        if (host && !host.recordsInviteEvents) continue;
        const serverId = await rowServerId(row.server, userId);
        await recordServerProductEvent(sink, {
          event: "external_channel_connect_finished",
          userId,
          serverId: serverId === null ? null : asServerId(serverId),
          properties: {
            path: row.path,
            result: row.outcome.result,
            ...(row.outcome.result === "refused" ? { refusal_code: row.outcome.refusalCode } : {}),
            ...(row.outcome.result === "refused" && row.outcome.limitSide ? { limit_side: row.outcome.limitSide } : {}),
            async: row.async,
            multi: row.multi,
            ...(host ? { host_plan: host.plan } : {}),
          },
        });
      } catch (err) {
        console.warn("[product-events] external_channel_connect_finished not recorded:", err instanceof Error ? err.name : "unknown");
      }
    }
  })();
}

/** The worker's settlement rows (no request): to the startup sink. */
export function recordWorkerConnectFinished(userId: string | null, rows: readonly ConnectFinishedRow[]): void {
  recordExternalConnectFinished(workerSink, userId, rows);
}
