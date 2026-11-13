import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { agents, machines, serverMembers, users } from "./schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";

// change_log batch 1b: machines (scope server) and the per-person sidebar and
// server order (scope user). See the change_log_machines_sidebar migration.

type Row = { scope_kind: string; scope_id: string; server_id: string | null; entity: string; entity_id: string; op: string };

test("change_log logs machines, agents moving between them, and the sidebar and server order", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => (await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, entity, entity_id, op
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[];
  const [owner] = await db.insert(users).values({ email: "clm-owner@test.com", name: "clmOwner", passwordHash: "x", emailVerified: true }).returning();
  const server = await createServer("Machines", "clm-machines", owner!.id);

  let mark = await watermark();
  const { machine } = await registerMachine(server.id, owner!.id, "clm-machine");
  assert.ok((await since(mark)).some((r) => r.entity === "machine" && r.entity_id === machine.id && r.scope_kind === "server" && r.scope_id === server.id));

  mark = await watermark();
  await db.update(machines).set({ lastHeartbeat: new Date() }).where(sql`id = ${machine.id}`);
  assert.deepEqual(await since(mark), [], "a heartbeat is liveness, not logged");
  await db.update(machines).set({ name: "clm-machine-2" }).where(sql`id = ${machine.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.entity, r.entity_id, r.op]), [["machine", machine.id, "upsert"]]);

  mark = await watermark();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "clm-agent", creatorType: "user", creatorId: owner!.id, machineId: machine.id }).returning();
  await db.update(agents).set({ machineId: null }).where(sql`id = ${agent!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.entity, r.entity_id]), [
    ["agent", agent!.id], ["machine", machine.id],
    ["agent", agent!.id], ["machine", machine.id],
  ], "an agent landing on or leaving a machine changes that machine's agent count");

  mark = await watermark();
  await db.update(serverMembers).set({ pinnedChannelIds: ["a"] }).where(sql`server_id = ${server.id} AND user_id = ${owner!.id}`);
  await db.update(serverMembers).set({ dismissedInviteStepAt: new Date() }).where(sql`server_id = ${server.id} AND user_id = ${owner!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity, r.entity_id]), [
    ["user", owner!.id, server.id, "sidebar_order", server.id],
  ], "pins are the member's sidebar; onboarding dismissals are not");

  mark = await watermark();
  await db.update(users).set({ serverSwitcherOrder: [server.id] }).where(sql`id = ${owner!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.server_id, r.entity, r.entity_id]), [
    ["user", null, "server_order", owner!.id],
  ], "the server switcher order is in every one of the person's streams");
});
