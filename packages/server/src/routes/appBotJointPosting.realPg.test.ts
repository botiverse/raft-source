import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql, eq } from "drizzle-orm";
import { issueManagedAppBotCredential } from "../services/appBotIdentityService";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { createTestApp } from "../test/integration/app";
import { tokenForHuman } from "../test/integration/credentials";
import { createServer, headers, seedUser } from "./channels.api.fixtures";
import { createOAuthClient } from "../services/oauthService";
import { createManagedAppBot, uninstallManagedAppBot } from "../services/appBotIdentityService";
import { addAgent } from "../services/channelService";
import { JointChannelAccessChangedError, lockJointPostingAuthority } from "../lib/channelActorPermissions";

const PG_URL = process.env.APP_BOT_JOINT_REAL_PG_URL;
test("joint posting pins the current bot grant against concurrent revocation (real PG)",
  { skip: !PG_URL, timeout: 60_000 }, async () => {
  assert.ok(PG_URL);
  const name = `app_bot_joint_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let revoke: pg.Client | undefined;
  let release: (() => void) | undefined;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(PG_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
    finally { await pool.end(); }
    await initDatabase(url.toString());
    app = await createTestApp(0, { humanActivityMuteFlagDefaultEnabled: true });
    const suffix = randomUUID().slice(0, 8);
    const hostOwner = await seedUser(`joint-host-${suffix}@slock.test`, `joint-host-${suffix}`);
    const targetOwner = await seedUser(`joint-target-${suffix}@slock.test`, `joint-target-${suffix}`);
    const host = await createServer("Joint host", `joint-host-${suffix}`, hostOwner.id);
    const target = await createServer("Joint target", `joint-target-${suffix}`, targetOwner.id);
    const hostToken = await tokenForHuman(hostOwner.email), targetToken = await tokenForHuman(targetOwner.email);
    const created = await fetch(`${app.baseUrl}/api/channels`, { method: "POST", headers: headers(hostToken, host.id),
      body: JSON.stringify({ name: `joint-${suffix}`, visibility: "joint", targetServerSlug: target.slug,
        invitedPeople: [`@${targetOwner.name}`] }) });
    assert.equal(created.status, 200);
    const info = await created.json() as { jointInvite: { id: string } };
    const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${info.jointInvite.id}/accept`,
      { method: "POST", headers: headers(targetToken, target.id) });
    assert.equal(accepted.status, 200);
    const channel = await accepted.json() as { id: string };
    const client = await createOAuthClient({ serverId: target.id, createdByUserId: targetOwner.id,
      clientId: `joint-app-${suffix}`, name: "Joint Bot", enableBot: true });
    const db = getDb();
    const [install] = await db.insert(schema.oauthClientInstalls).values({ serverId: target.id, clientId: client.client.id,
      installedByUserId: targetOwner.id, status: "active", botGrant: "granted" }).returning();
    const bot = await db.transaction(tx => createManagedAppBot(tx, { installId: install!.id, serverId: target.id }));
    await addAgent(channel.id, bot.agentId);
    let locked!: () => void;
    const lockedPromise = new Promise<void>(resolve => { locked = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const sendTx = db.transaction(async tx => { await lockJointPostingAuthority(channel.id, "agent", bot.agentId, tx); locked(); await barrier; });
    await lockedPromise;
    revoke = new pg.Client({ connectionString: url.toString(), application_name: "cardy-app-bot-revoke-test" });
    await revoke.connect();
    let revoked = false;
    const revokePromise = revoke.query("UPDATE oauth_client_installs SET bot_grant='revoked' WHERE id=$1", [install!.id])
      .then(() => { revoked = true; });
    let observedWaiting = false;
    for (let i = 0; i < 50; i++) {
      const observed = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1", ["cardy-app-bot-revoke-test"]);
      if (observed.rows[0]?.wait_event_type === "Lock") { observedWaiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(observedWaiting, true, "revocation must wait for the authorized write transaction");
    assert.equal(revoked, false);
    assert.ok(release); release(); release = undefined;
    await sendTx; await revokePromise;
    await assert.rejects(db.transaction(tx => lockJointPostingAuthority(channel.id, "agent", bot.agentId, tx)), JointChannelAccessChangedError);

    // Reverse the order: a revoke which acquired the install lock first must
    // commit before a new posting check can observe and deny it.
    await revoke.query("UPDATE oauth_client_installs SET bot_grant='granted' WHERE id=$1", [install!.id]);
    await revoke.query("BEGIN");
    await revoke.query("UPDATE oauth_client_installs SET bot_grant='revoked' WHERE id=$1", [install!.id]);
    const revokePid = (await revoke.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const waitingSend = db.transaction(tx => lockJointPostingAuthority(channel.id, "agent", bot.agentId, tx));
    // Attach a handler immediately, so a bad early rejection cannot become an
    // unhandled promise while the lock-wait observation runs.
    const sendResult = waitingSend.then(() => null, error => error);
    let senderWaiting = false;
    for (let i = 0; i < 50; i++) {
      const observed = await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [revokePid]);
      if (observed.rowCount) { senderWaiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(senderWaiting, true, "posting must wait for the revoke holding the install lock");
    await revoke.query("COMMIT");
    assert.ok(await sendResult instanceof JointChannelAccessChangedError);
    await revoke.query("UPDATE oauth_client_installs SET bot_grant='granted' WHERE id=$1", [install!.id]);
    let clientLocked!: () => void, releaseIssuer!: () => void;
    const hasClientLock = new Promise<void>(r => { clientLocked = r; });
    const allowIssuer = new Promise<void>(r => { releaseIssuer = r; });
    let issuerPid = 0;
    // Pause at the service's first client-row lock, then run the real service
    // in that same transaction. All data and connections are local synthetic.
    const issuance = db.transaction(async tx => {
      await tx.select({ id: schema.oauthClients.id }).from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, client.client.id)).for("update");
      issuerPid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      clientLocked();
      await allowIssuer;
      return issueManagedAppBotCredential({ clientId: client.client.id, installationId: install!.id, rotate: true }, tx as typeof db);
    }).then(() => null, error => error);
    await hasClientLock;
    const posting = db.transaction(tx => lockJointPostingAuthority(channel.id, "agent", bot.agentId, tx))
      .then(() => null, error => error);
    let waitsOnClient = false;
    for (let i = 0; i < 100; i++) {
      const observed = await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [issuerPid]);
      if (observed.rowCount) { waitsOnClient = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    releaseIssuer();
    const [postError, issueError] = await Promise.all([posting, issuance]);
    assert.equal(waitsOnClient, true, "posting must actually wait on the credential service's client lock");
    assert.equal(postError, null, "posting must complete without a lock-order deadlock");
    assert.equal(issueError, null, "actual credential issuance must complete without a lock-order deadlock");

    // Hold only the installation, as a sender does before it reaches the
    // binding. The real uninstall must wait *before* taking that binding;
    // otherwise sender and uninstall can each hold the other's next lock.
    await revoke.query("BEGIN");
    await revoke.query("SELECT id FROM oauth_client_installs WHERE id=$1 FOR SHARE", [install!.id]);
    const senderPid = (await revoke.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const uninstall = db.transaction(async tx => {
      await uninstallManagedAppBot(tx, { installId: install!.id });
      await tx.delete(schema.oauthClientInstalls).where(eq(schema.oauthClientInstalls.id, install!.id));
    })
      .then(() => null, error => error);
    let uninstallWaiting = false;
    for (let i = 0; i < 100; i++) {
      const observed = await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [senderPid]);
      if (observed.rowCount) { uninstallWaiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let bindingAvailable = true;
    try { await revoke.query("SELECT id FROM app_bot_bindings WHERE install_id=$1 FOR UPDATE NOWAIT", [install!.id]); }
    catch { bindingAvailable = false; }
    await revoke.query(bindingAvailable ? "COMMIT" : "ROLLBACK");
    const uninstallError = await uninstall;
    assert.equal(uninstallWaiting, true, "uninstall must wait for the posting transaction's installation lock");
    assert.equal(bindingAvailable, true, "uninstall must not hold the binding while waiting for installation");
    assert.equal(uninstallError, null);
    await assert.rejects(db.transaction(tx => lockJointPostingAuthority(channel.id, "agent", bot.agentId, tx)), JointChannelAccessChangedError);

  } finally {
    release?.();
    await revoke?.end().catch(() => {});
    await app?.close().catch(() => {});
    await closeDatabase().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
