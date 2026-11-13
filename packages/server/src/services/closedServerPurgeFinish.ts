// Closed-server purge, the finish: what happens to a server in `rows_deleted`
// (design "Purging closed servers 30 days after closing" v6, "After the
// channels, per server"). The run reaches it as it reaches the delete
// (closedServerPurgeDelete.ts): only for a server the flag gives `delete`
// through a rule naming it, under the same claim, lease, eligibility re-check
// under the row lock, run guards and per-server error back-off; every step's
// work is a batch of that purge.
//
// The steps, in order, each idempotent (it acts on what is still there, so a
// run again finds nothing to do and fails nothing). The finish stops at the
// first step that is not done, so a later step never runs before an earlier
// one:
//  1. hosted_runtimes: the hosted runtimes (our cloud computers) of the
//     server's agents, through the agent-delete path's own tombstone
//     (agentRuntimeProvisionService.beginProvisionedAgentDeletion, with no
//     actor: audited as the system): credentials revoked and the provision
//     set to `deleting` in the batch's transaction; after commit the worker
//     is kicked (kickAgentRuntimeProvisionWorker), and it DELETEs the agent,
//     workspace with it, at the provider, retrying with backoff until a 2xx
//     or 404 (state `deleted`). Done once every provision is `deleting` or
//     `deleted`: the provider's delete then runs on the worker's own retries,
//     as an attachment's bytes run on the attachment GC's. An agent mid-
//     migration (getAgentMigrationGateActive) is left as account deletion
//     leaves it: the step waits and the server is tried again a day later.
//  2. wechat_bridge: removeWeChatBridgeOfDeletedServer, which the close
//     already ran (serverService.softDeleteServerInTransaction); again here
//     so nothing bound since is left (iLink has no revoke: Raft forgets the
//     token).
//  3. server_rows: every table closedServerPurgeClassification.ts marks
//     `server_rows`, in its order, ROW_BATCH rows a batch (by the server, or
//     for a key to agents by the server's agents). Stays: a row naming a kept
//     channel (joint projection, canonical channel, receipt channel, what is
//     under them) in any of its channel columns, as the earlier steps keep
//     them; a row a kept row names through RESTRICT / NO ACTION. The
//     classification's test (on the migrated database) holds every foreign
//     key to servers and agents to a decision.
//  4. (8) agent_tombstones: the agents rows stay (kept channels' messages and
//     receipt channels name them), scrubbed: a placeholder name
//     (`deleted-agent-<id>`), and display name, avatar, description, env
//     vars, runtime config and last runtime error cleared; id, server,
//     timestamps and status fields stay.
// Known gaps, not in any step: a cleared channel's upload sessions and
// share_artifacts go by cascade with the channel, leaving an upload
// session's `upload_reservation` hold and a share artifact's stored image
// without a row (no foreign key reaches them).
// No "server gone" event: the close already told the apps
// (`server.member_removed`, reason `server_deleted`; Tenny #55 (1)).
//  5. credential_revoke: each managed MCP OAuth Connection's tokens revoked
//     at the provider (RFC 7009, closedServerPurgeRevoke.ts), once a run,
//     then its row deleted; a failure keeps it and the server waits a day,
//     until REVOKE_ATTEMPTS failures (then deleted all the same, recorded).
//     Then the rest of the server's managed MCP and provider connection rows
//     (API keys: no provider revokes them; deleting our copy is the action).
//  6. app_installs: every install of the server uninstalled by the system
//     (oauthService.uninstallOAuthClientInstallsOfClosedServer: the person's
//     uninstall, audited as `system`, reason `closed_server_purge`): bot
//     unbound, grants, tokens and consents revoked, requests denied, queued
//     deliveries suppressed; then the server's remaining app rows. Then the
//     apps the server owns that were never shared (ownAppNeverSharedSql:
//     `server_local`, still `private`, no install on another server, no share
//     link, no bridge registration or official-registry entry naming it):
//     deleted with everything that cascades from them (their app roots by
//     the 0407 root-sync trigger); then any app root (raft_apps) of the
//     server still left with no profile, a safety net. A published or shared
//     app stays: other servers' installs depend on it.
//  7. slack_bridge: the server's bridge rows (bindings, a kept channel's
//     too, identity links, user groups, OAuth attempts, install grants);
//     then each install the server owns that no other server holds a grant
//     on: its token revoked at Slack (auth.revoke through the Slack runtime,
//     closedServerPurgeRevoke.ts; the same retries), then the install and,
//     by cascade, its credential; then the server's grants nothing names.
//  8. agent_tombstones (below; last, after the uninstall archives bot agents).
// When every step is done: purged_at set and `done` (the tombstone keeps its
// slug). Kept as in the delete: joint channels and projections, migration
// receipt channels, billing and audit rows; the old CDN bucket is never sent
// anything.
import { and, asc, eq, gt, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import type { DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { agentRuntimeProvisions, externalAppInstalls, externalAppInstallServerGrants, managedMcpCredentials } from "../db/schema";
import { closedServerPurgeRowDeletes, type ClosedServerPurgeRowDelete, type ClosedServerPurgeRowStep } from "./closedServerPurgeClassification";
import { attemptCredentialRevoke, revokeManagedMcpOAuthTokens, type ClosedServerPurgeRevokers } from "./closedServerPurgeRevoke";
import { announcePermissionUpdatesChanged } from "./listChangedRealtime";
import { uninstallOAuthClientInstallsOfClosedServer } from "./oauthService";
import { getAgentMigrationGateActive } from "./agentMigrationService";
import { beginProvisionedAgentDeletion, kickAgentRuntimeProvisionWorker } from "./agentRuntimeProvisionService";
import { removeWeChatBridgeOfDeletedServer } from "./wechatBridgeCleanup";

/** One batch of the server's purge (its transaction, after the lease check). */
export type ClosedServerPurgeBatch = <T>(work: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;

export interface ClosedServerPurgeFinishInput {
  serverId: ServerId;
  batch: ClosedServerPurgeBatch;
  /** Adds to the server's counts (the delete event's attributes). */
  add: (key: string, n: number) => void;
  clock: () => Date;
  /** The channels the purge keeps (closedServerPurgeDelete.ts keptChannelsOf): rows naming one stay. */
  keepChannelIds: readonly string[];
  /** The provider revoke calls (closedServerPurgeRevoke.ts). */
  revokers?: ClosedServerPurgeRevokers;
}

/**
 * A step of the finish: `run` answers `done`, or `waiting` (something it
 * can't do yet, retried a day later); `pending` names why a step has no
 * implementation (the server stays in `rows_deleted`).
 */
export type ClosedServerPurgeFinishStep =
  | { name: string; run: (input: ClosedServerPurgeFinishInput) => Promise<"done" | "waiting"> }
  | { name: string; pending: string };

const PROVISION_BATCH = 100;
const LIVE_PROVISION_STATES = ["provisioning", "active", "failed"] as const;

interface ProvisionPage { n: number; last: string | null; queued: number; skipped: number }

/** Step 1 (header). */
async function deleteHostedRuntimes({ serverId, batch, add, clock }: ClosedServerPurgeFinishInput): Promise<"done" | "waiting"> {
  let waiting = false;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: ProvisionPage = await batch(async (tx): Promise<ProvisionPage> => {
      const rows: Array<{ agentId: string }> = await tx.select({ agentId: agentRuntimeProvisions.agentId }).from(agentRuntimeProvisions)
        .where(and(
          eq(agentRuntimeProvisions.serverId, serverId),
          inArray(agentRuntimeProvisions.state, [...LIVE_PROVISION_STATES]),
          ...(cursor ? [gt(agentRuntimeProvisions.agentId, cursor)] : []),
        ))
        .orderBy(asc(agentRuntimeProvisions.agentId))
        .limit(PROVISION_BATCH);
      const migrating = await getAgentMigrationGateActive(rows.map((row) => row.agentId), tx, clock());
      let queued = 0;
      let skipped = 0;
      for (const row of rows) {
        if (migrating.get(row.agentId)) {
          skipped += 1;
          continue;
        }
        if (await beginProvisionedAgentDeletion(tx, row.agentId, null)) queued += 1;
      }
      return { n: rows.length, last: rows[rows.length - 1]?.agentId ?? null, queued, skipped };
    });
    add("hosted_runtimes_deletion_queued", page.queued);
    add("hosted_runtimes_skipped_migrating", page.skipped);
    // After the commit that made the tombstones: the provider DELETE never runs before the credentials are revoked.
    if (page.queued > 0) kickAgentRuntimeProvisionWorker();
    if (page.skipped > 0) waiting = true;
    if (page.n < PROVISION_BATCH) break;
    after = page.last;
  }
  const [deleting] = await batch((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(agentRuntimeProvisions)
    .where(and(eq(agentRuntimeProvisions.serverId, serverId), eq(agentRuntimeProvisions.state, "deleting"))));
  add("hosted_runtimes_awaiting_provider", Number(deleting?.n ?? 0));
  return waiting ? "waiting" : "done";
}

/** Step 2 (header). */
async function removeWeChatBridge({ serverId, batch, add }: ClosedServerPurgeFinishInput): Promise<"done"> {
  add("wechat_bridge_bindings_removed", await batch((tx) => removeWeChatBridgeOfDeletedServer(tx, { serverId })));
  return "done";
}

const ROW_BATCH = 1_000;

/**
 * The rows of `t` (the entry's table) server_rows deletes: the server's (or
 * its agents'), except those naming a kept channel in a channel column and
 * those a kept row names (unlessReferencedBy). Count mode counts the same.
 */
export function closedServerPurgeRowScope(entry: ClosedServerPurgeRowDelete, serverId: ServerId, keepChannelIds: readonly string[]): SQL {
  const column = sql`t.${sql.identifier(entry.column)}`;
  const parts: SQL[] = [entry.agentKey
    ? sql`${column} IN (SELECT id FROM agents WHERE server_id = ${serverId})`
    : sql`${column} = ${serverId}`];
  if (keepChannelIds.length > 0) {
    const kept = sql.join(keepChannelIds.map((id) => sql`${id}::uuid`), sql`, `);
    for (const channel of entry.channelColumns) {
      const ref = sql`t.${sql.identifier(channel)}`;
      parts.push(sql`(${ref} IS NULL OR ${ref} NOT IN (${kept}))`);
    }
  }
  for (const ref of entry.unlessReferencedBy) {
    const [refTable, refColumn] = ref.split(".") as [string, string];
    parts.push(sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(refTable)} r WHERE r.${sql.identifier(refColumn)} = t.id)`);
  }
  return sql.join(parts, sql` AND `);
}

/** One batch of one server_rows table: at most ROW_BATCH rows, located through ctid so the LIMIT applies to the delete. */
async function deleteRowBatch(tx: DatabaseExecutor, entry: ClosedServerPurgeRowDelete, serverId: ServerId, keepChannelIds: readonly string[]): Promise<number> {
  const table = sql.identifier(entry.table);
  const deleted = await tx.execute(sql`
    DELETE FROM ${table} WHERE ctid = ANY(ARRAY(
      SELECT t.ctid FROM ${table} t WHERE ${closedServerPurgeRowScope(entry, serverId, keepChannelIds)} LIMIT ${ROW_BATCH}))
    RETURNING 1`);
  return (deleted as unknown as { rows: unknown[] }).rows.length;
}

/** Step 3 (header). */
async function deleteServerRows(input: ClosedServerPurgeFinishInput): Promise<"done"> {
  await deleteStepRows(input, "server_rows");
  return "done";
}

/** A row step's own deletes (all of them, or those `which` selects), in order. */
async function deleteStepRows(
  { serverId, batch, add, keepChannelIds }: ClosedServerPurgeFinishInput,
  step: ClosedServerPurgeRowStep,
  which: (entry: ClosedServerPurgeRowDelete) => boolean = () => true,
): Promise<void> {
  for (const entry of closedServerPurgeRowDeletes(step).filter(which)) {
    for (;;) {
      const n = await batch((tx) => deleteRowBatch(tx, entry, serverId, keepChannelIds));
      if (n > 0) add(`${step}_${entry.table}`, n);
      add(`${step}_deleted`, n);
      if (n < ROW_BATCH) break;
    }
  }
}

const UNINSTALL_BATCH = 20;

/** Step 5 (header). */
async function revokeCredentials(input: ClosedServerPurgeFinishInput): Promise<"done" | "waiting"> {
  const { serverId, batch, add } = input;
  const oauth = await batch((tx) => tx.select({ id: managedMcpCredentials.id, encryptedOAuth: managedMcpCredentials.encryptedOAuth }).from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, serverId), isNotNull(managedMcpCredentials.encryptedOAuth))));
  let waiting = false;
  for (const credential of oauth) {
    const revoke = input.revokers?.managedMcpOAuth ?? revokeManagedMcpOAuthTokens;
    const attempt = await attemptCredentialRevoke({
      serverId, kind: "managed_mcp_oauth", targetType: "managed_mcp_credential", targetId: credential.id,
      call: () => revoke(credential.encryptedOAuth!),
    });
    countRevoke(add, attempt);
    if (attempt.next === "wait") {
      waiting = true;
      continue;
    }
    await batch((tx) => tx.delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, credential.id)));
  }
  if (waiting) return "waiting";
  await deleteStepRows(input, "credential_revoke");
  return "done";
}

/** Step 6 (header). */
async function uninstallApps(input: ClosedServerPurgeFinishInput): Promise<"done"> {
  const { serverId, batch, add } = input;
  for (;;) {
    const uninstalled = await batch((tx) => uninstallOAuthClientInstallsOfClosedServer(tx as DatabaseTransaction, { serverId, limit: UNINSTALL_BATCH }));
    add("app_installs_uninstalled", uninstalled.length);
    add("app_grants_revoked", uninstalled.reduce((n, entry) => n + entry.revokedGrantCount, 0));
    add("app_tokens_revoked", uninstalled.reduce((n, entry) => n + entry.revokedTokenCount, 0));
    if (uninstalled.length < UNINSTALL_BATCH) break;
  }
  await deleteStepRows(input, "app_installs");
  for (;;) {
    const n = await batch(async (tx) => ((await tx.execute(sql`
      DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE ${ownAppNeverSharedSql(serverId)} LIMIT ${UNINSTALL_BATCH})
      RETURNING 1`)) as unknown as { rows: unknown[] }).rows.length);
    add("own_apps_deleted", n);
    // The permission-updates list reads oauth_clients (a closed server's readers are gone; the ping is the rule).
    if (n > 0) announcePermissionUpdatesChanged([serverId]);
    if (n < UNINSTALL_BATCH) break;
  }
  const roots = await batch(async (tx) => ((await tx.execute(sql`
    DELETE FROM raft_apps r WHERE r.server_id = ${serverId}
       AND NOT EXISTS (SELECT 1 FROM app_oauth_profiles p WHERE p.app_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM app_mcp_profiles m WHERE m.app_id = r.id)
    RETURNING 1`)) as unknown as { rows: unknown[] }).rows.length);
  add("app_roots_deleted", roots);
  const [kept] = await batch((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM oauth_clients c WHERE c.server_id = ${serverId}`)
    .then((result) => (result as unknown as { rows: Array<{ n: number }> }).rows));
  add("own_apps_kept_shared", Number(kept?.n ?? 0));
  return "done";
}

/**
 * The apps (`oauth_clients c`) server `serverId` owns that were never shared,
 * so nothing outside the server depends on them: `server_local` (an app only
 * its own server runs; a `slock_builtin` or `third_party_global` app is
 * everyone's), still `private` (never in publication), not installed on any
 * other server, no share link ever made for it, and no bridge registration
 * or official-registry entry naming it (both RESTRICT). Count mode counts the
 * same.
 */
export function ownAppNeverSharedSql(serverId: ServerId): SQL {
  return sql`c.server_id = ${serverId} AND c.app_type = 'server_local' AND c.publish_status = 'private'
    AND NOT EXISTS (SELECT 1 FROM oauth_client_installs i WHERE i.client_id = c.id AND i.server_id <> ${serverId})
    AND NOT EXISTS (SELECT 1 FROM oauth_client_share_links l WHERE l.client_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM external_app_registrations r WHERE r.oauth_client_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM official_app_registry o WHERE o.oauth_client_id = c.id)`;
}

/** Step 7 (header). */
async function removeSlackBridge(input: ClosedServerPurgeFinishInput): Promise<"done" | "waiting"> {
  const { serverId, batch, add } = input;
  const serverGrants = (entry: ClosedServerPurgeRowDelete) => entry.table === "external_app_server_grants";
  await deleteStepRows(input, "slack_bridge", (entry) => !serverGrants(entry));
  const owned = await batch((tx) => tx.select({ id: externalAppInstalls.id }).from(externalAppInstalls).where(eq(externalAppInstalls.serverId, serverId)));
  let waiting = false;
  for (const install of owned) {
    // This server's own grants are gone (above): any left are another server's, which still uses the install.
    const [shared] = await batch((tx) => tx.select({ id: externalAppInstallServerGrants.id }).from(externalAppInstallServerGrants)
      .where(eq(externalAppInstallServerGrants.installId, install.id)).limit(1));
    if (shared) {
      add("slack_installs_shared_kept", 1);
      continue;
    }
    const revoke = input.revokers?.slackInstallToken;
    const attempt = await attemptCredentialRevoke({
      serverId, kind: "slack_install", targetType: "external_app_install", targetId: install.id,
      call: async () => {
        // No Slack runtime here (the bridge not configured): nothing can unseal the token.
        if (!revoke) return { kind: "nothing_to_revoke" };
        const outcome = await revoke(install.id);
        return outcome.kind === "no_credential" ? { kind: "nothing_to_revoke" } : outcome;
      },
    });
    countRevoke(add, attempt);
    if (attempt.next === "wait") {
      waiting = true;
      continue;
    }
    // Its credential, grant receipts, identity links and user groups go by cascade.
    const deleted = await batch((tx) => tx.delete(externalAppInstalls).where(eq(externalAppInstalls.id, install.id)).returning({ id: externalAppInstalls.id }));
    add("slack_installs_deleted", deleted.length);
  }
  if (waiting) return "waiting";
  await deleteStepRows(input, "slack_bridge", serverGrants);
  return "done";
}

function countRevoke(add: ClosedServerPurgeFinishInput["add"], attempt: Awaited<ReturnType<typeof attemptCredentialRevoke>>): void {
  add(`credentials_${attempt.outcome.kind}`, 1);
  if (attempt.gaveUp) add("credentials_revoke_gave_up", 1);
}

/** Step 4 (header): the agents rows' content cleared, ROW_BATCH at a time; a scrubbed row is not touched again. */
async function scrubAgentTombstones({ serverId, batch, add }: ClosedServerPurgeFinishInput): Promise<"done"> {
  const placeholder = sql`'deleted-agent-' || replace(a.id::text, '-', '')`;
  for (;;) {
    const n = await batch(async (tx) => (await tx.execute(sql`
      UPDATE agents a SET name = ${placeholder}, display_name = NULL, avatar_url = NULL, description = NULL,
             env_vars = NULL, runtime_config = NULL, last_runtime_error = NULL
       WHERE a.id IN (
         SELECT a.id FROM agents a WHERE a.server_id = ${serverId}
            AND (a.name <> ${placeholder} OR a.display_name IS NOT NULL OR a.avatar_url IS NOT NULL OR a.description IS NOT NULL
                 OR a.env_vars IS NOT NULL OR a.runtime_config IS NOT NULL OR a.last_runtime_error IS NOT NULL)
          LIMIT ${ROW_BATCH})
      RETURNING 1`) as unknown as { rows: unknown[] }).rows.length);
    add("agent_tombstones_scrubbed", n);
    if (n < ROW_BATCH) return "done";
  }
}

/** The finish's steps, in order (header). */
export const CLOSED_SERVER_PURGE_FINISH_STEPS: readonly ClosedServerPurgeFinishStep[] = [
  { name: "hosted_runtimes", run: deleteHostedRuntimes },
  { name: "wechat_bridge", run: removeWeChatBridge },
  { name: "server_rows", run: deleteServerRows },
  { name: "credential_revoke", run: revokeCredentials },
  { name: "app_installs", run: uninstallApps },
  { name: "slack_bridge", run: removeSlackBridge },
  { name: "agent_tombstones", run: scrubAgentTombstones },
];

/**
 * Run the steps in order until one is not done. True when every step is
 * done (the caller sets purged_at); the steps left are counted
 * (`finish_steps_left`, `finish_pending_<step>` / `finish_waiting_<step>`).
 */
export async function finishClosedServerPurge(
  input: ClosedServerPurgeFinishInput,
  steps: readonly ClosedServerPurgeFinishStep[] = CLOSED_SERVER_PURGE_FINISH_STEPS,
): Promise<boolean> {
  for (const [index, step] of steps.entries()) {
    const outcome = "pending" in step ? "pending" : await step.run(input);
    if (outcome === "done") continue;
    input.add(`finish_${outcome}_${step.name}`, 1);
    // Every step after it waits too; the pending ones among them are named, so telemetry shows all that is missing.
    for (const later of steps.slice(index + 1)) if ("pending" in later) input.add(`finish_pending_${later.name}`, 1);
    input.add("finish_steps_left", steps.length - index);
    return false;
  }
  return true;
}
