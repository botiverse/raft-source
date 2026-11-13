import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DatabaseExecutor } from "../db/index";
import { slackBotWakeIsLimited } from "./slackBotWakeLimit";

test("only the same bot and pair's last five minutes of agent-mentioned messages suppress a wake", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE external_message_author_facts (message_id uuid, projection_id uuid, provider text,
      app_registration_id text, install_id text, workspace_id text, external_conversation_id text,
      actor_kind text, created_at timestamptz);
      CREATE TABLE external_inbound_events (provider text, status text, app_registration_id text, install_id text,
        workspace_id text, provider_conversation_id text, binding_id text, payload_erased_at timestamptz, committed_message_id uuid);
      CREATE TABLE message_mentions (message_id uuid, target_type text);`);
    const projectionId = randomUUID(), messageId = randomUUID();
    const scope = { db: drizzle(pg) as unknown as DatabaseExecutor, projectionId, registrationId: "r", installId: "i",
      workspaceId: "w", providerConversationId: "c", bindingId: "b", messageId, now: new Date() };
    const insert = async (opts: { age?: string; pair?: string; actor?: string; target?: string; duplicates?: boolean } = {}) => {
      const id = randomUUID();
      await pg.query(`INSERT INTO external_message_author_facts VALUES ($1,$2,'slack','r','i','w','c','bot',
        now() - $3::interval)`, [id, opts.actor ?? projectionId, opts.age ?? "1 minute"]);
      await pg.query("INSERT INTO external_inbound_events VALUES ('slack','committed','r','i','w','c',$1,$2::timestamptz - $3::interval,$4)",
        [opts.pair ?? "b", scope.now.toISOString(), opts.age ?? "1 minute", id]);
      await pg.query("INSERT INTO message_mentions VALUES ($1,$2)", [id, opts.target ?? "agent"]);
      if (opts.duplicates) await pg.query("INSERT INTO message_mentions VALUES ($1,'agent')", [id]);
    };
    for (let n = 0; n < 4; n++) await insert({ duplicates: true });
    await insert({ age: "6 minutes" });
    await insert({ pair: "other" });
    await insert({ actor: randomUUID() });
    await insert({ target: "user" });
    assert.equal(await slackBotWakeIsLimited(scope), false);
    await insert();
    assert.equal(await slackBotWakeIsLimited(scope), true);
    await pg.query("UPDATE external_message_author_facts SET created_at = '2001-01-01T00:00:00Z'");
    assert.equal(await slackBotWakeIsLimited(scope), true, "provider timestamps cannot evade the server delivery window");
    assert.equal(await slackBotWakeIsLimited({ ...scope, bindingId: "other" }), false);
    await pg.query("UPDATE external_inbound_events SET payload_erased_at = $1::timestamptz - interval '6 minutes'", [scope.now.toISOString()]);
    assert.equal(await slackBotWakeIsLimited(scope), false, "five quiet minutes restore wake delivery");
  } finally { await pg.close(); }
});
