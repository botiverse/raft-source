import { expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { agents, channels, channelAgents, channelHumans, featureFlags, messages, raftbenchConfigs, raftbenchFindings, serverAgentMembers, serverMembers, servers, raftbenchReaderGrants } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { setReaderGrant } from "../raftbench/readers";
import { sourceContentVersion } from "../raftbench/service";
import type { Database as Db } from "../db";
import type { createSeed } from "../test/integration/seed";

// A barrier between the read's first checks and its final ones: a test can
// change state there without timing (readers.ts reads through listFindings).
const barrier = vi.hoisted(() => ({ midRead: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("../raftbench/findings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../raftbench/findings")>();
  return {
    ...actual,
    listFindings: async (...args: Parameters<typeof actual.listFindings>) => {
      const result = await actual.listFindings(...args);
      await barrier.midRead?.();
      return result;
    },
  };
});

const test = createApiTest();
const serverId = "90623df1-20ed-4321-88a1-e4e2b411a252";
type Ctx = { app: { baseUrl: string }; db: Db; seed: ReturnType<typeof createSeed>; onTestFinished: (fn: () => void) => void };

/** A staging pilot server: analysis over #visible and #hidden; Reader can read only #visible. */
async function setUp({ app, db, seed, onTestFinished }: Ctx) {
  const old = process.env.DEPLOYMENT_ENV; process.env.DEPLOYMENT_ENV = "staging";
  onTestFinished(() => { if (old === undefined) delete process.env.DEPLOYMENT_ENV; else process.env.DEPLOYMENT_ENV = old; });
  const owner = await seed.human(), admin = await seed.human();
  await db.insert(featureFlags).values({ key: "raftbench_overview_v0", randomizationUnit: "server", salt: "synthetic", defaultEnabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, killSwitch: false, defaultEnabled: true } });
  await db.insert(servers).values({ id: serverId, ownerId: owner.id, name: "Synthetic", slug: "synthetic-readers" });
  await db.insert(serverMembers).values([{ serverId, userId: owner.id, role: "owner", setupStatus: "complete" }, { serverId, userId: admin.id, role: "admin", setupStatus: "complete" }]);
  const [service, reader] = await db.insert(agents).values([{ serverId, name: "Analysis", runtime: "external" }, { serverId, name: "Reader", runtime: "external" }]).returning();
  await db.insert(serverAgentMembers).values([service, reader].map(a => ({ serverId, agentId: a.id })));
  const [a,b] = await db.insert(channels).values([{ serverId, name: "visible", type: "private" }, { serverId, name: "hidden", type: "private" }]).returning();
  await db.insert(channelHumans).values([a,b].map(c=>({channelId:c.id,userId:owner.id})));
  await db.insert(channelAgents).values([{ channelId:a.id,agentId:service.id },{channelId:b.id,agentId:service.id},{channelId:a.id,agentId:reader.id}]);
  const [ma,mb] = await db.insert(messages).values([a,b].map(c=>({channelId:c.id,senderId:owner.id,senderType:"user" as const,content:`Synthetic ${c.name}`}))).returning();
  await db.insert(raftbenchConfigs).values({serverId,configuredByUserId:owner.id,enabled:true,agentId:service.id,channelIds:[a.id,b.id],revision:1});
  await mintAgentCredential({agentId:service.id,scopes:["read","raftbench"],name:"Service",issuedVia: "human", createdByUserId:owner.id});
  const cred=await mintAgentCredential({agentId:reader.id,scopes:["read"],name:"Reader",issuedVia: "human", createdByUserId:owner.id});
  const ref=(m:typeof ma)=>({channelId:m.channelId,storageChannelId:m.channelId,messageId:m.id,sourceVersion:sourceContentVersion(m.content)});
  const pattern={kind:"repeated_attempt" as const,explanation:"Synthetic finding",evidence:[{target:"#visible",messageId:ma.id}],counterevidence:[],evidenceLevel:"conversation_only" as const,intent:"unknown" as const,suggestion:"Investigate"};
  await db.insert(raftbenchFindings).values([... [1,2].map(i=>({serverId,revision:1,fingerprint:`visible-${i}`,sourceRefs:[ref(ma)],pattern})),{serverId,revision:1,fingerprint:"hidden",sourceRefs:[ref(ma),ref(mb)],pattern:{...pattern,explanation:"PRIVATE SYNTHETIC",counterevidence:[{target:"#hidden",messageId:mb.id}]}}]);
  const call=(q="")=>fetch(`${app.baseUrl}/internal/agent-api/raftbench/findings${q}`,{headers:{Authorization:`Bearer ${cred.apiKey}`}});
  return { owner, admin, reader, a, b, ma, cred, ref, call };
}

test("reader grants and all-source visibility fence findings, counts and cursors", async ({ app, db, seed, onTestFinished }) => {
  const { owner, admin, reader, b, ma, cred, ref, call } = await setUp({ app, db, seed, onTestFinished });
  const context = async () => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${cred.apiKey}` } });
    expect(response.status).toBe(200);
    return (await response.json()).agent;
  };
  expect(await context()).not.toHaveProperty("raftbenchReader");
  // An SDK caller sees only the code and the next action, so each names what a reader can do.
  const refusal = async (q = "") => { const r = await call(q); const body = await r.json(); return { status: r.status, code: body.code, next: body.suggestedNextAction as string }; };
  { const denied=await refusal(); expect(denied).toMatchObject({ status: 403, code: "raftbench_reader_not_authorized" }); expect(denied.next).toContain("allow this agent in RaftBench settings"); }
  await setReaderGrant(serverId,admin.id,reader.id,true);
  expect((await context()).raftbenchReader).toBe(true);
  // A missing optional-feature table must not break identity bootstrap.
  await db.execute(sql`ALTER TABLE raftbench_reader_grants RENAME TO synthetic_unavailable_reader_grants`);
  try { expect(await context()).not.toHaveProperty("raftbenchReader"); }
  finally { await db.execute(sql`ALTER TABLE synthetic_unavailable_reader_grants RENAME TO raftbench_reader_grants`); }
  expect((await context()).raftbenchReader).toBe(true);
  await db.update(raftbenchConfigs).set({ enabled: false }).where(eq(raftbenchConfigs.serverId, serverId));
  expect(await context()).not.toHaveProperty("raftbenchReader");
  await db.update(raftbenchConfigs).set({ enabled: true }).where(eq(raftbenchConfigs.serverId, serverId));
  const response=await call("?limit=1"), first=await response.json();
  expect(response.status,JSON.stringify(first)).toBe(200);expect(first.total).toBe(2);expect(first.findings).toHaveLength(1);expect(first.nextCursor).toBeTruthy();
  expect(JSON.stringify(first)).not.toContain("PRIVATE");expect(JSON.stringify(first)).not.toContain(ma.content);
  expect(await db.select().from(raftbenchFindings)).toHaveLength(3);
  expect((await call("?limit=21")).status).toBe(400);expect((await call(`?serverId=${serverId}`)).status).toBe(400);
  const second=await(await call(`?limit=1&cursor=${first.nextCursor}`)).json();expect(second.findings[0].id).not.toBe(first.findings[0].id);
  // Malformed persisted metadata must not pass SQL three-valued visibility logic.
  await db.update(raftbenchFindings).set({ sourceRefs: sql`jsonb_build_array((${JSON.stringify(ref(ma))}::jsonb) - 'channelId')` }).where(eq(raftbenchFindings.fingerprint, "hidden"));
  expect((await(await call()).json()).total).toBe(2);
  await setReaderGrant(serverId,admin.id,reader.id,false);expect((await call()).status).toBe(403);
  expect(await context()).not.toHaveProperty("raftbenchReader");
  await setReaderGrant(serverId,admin.id,reader.id,true);expect(await refusal(`?limit=1&cursor=${first.nextCursor}`)).toMatchObject({ status: 409, code: "raftbench_cursor_stale", next: "Read the first page again without a cursor." });
  // Analysis turned off, or its sources changed: the reader tells the person who asked; no service-run steps.
  await db.update(raftbenchConfigs).set({ enabled: false }).where(eq(raftbenchConfigs.serverId, serverId));
  { const off = await refusal(); expect(off).toMatchObject({ status: 403, code: "raftbench_disabled" }); expect(off.next).toContain("Tell the person who asked"); }
  await db.update(raftbenchConfigs).set({ enabled: true }).where(eq(raftbenchConfigs.serverId, serverId));
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, b.id));
  { const unavailable = await refusal(); expect(unavailable).toMatchObject({ status: 409, code: "raftbench_findings_unavailable" }); expect(unavailable.next).toContain("Tell the person who asked"); expect(unavailable.next).not.toMatch(/run|context/i); }
  await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, b.id));
  await db.update(serverMembers).set({role:"member"}).where(eq(serverMembers.userId,admin.id));expect(await refusal()).toMatchObject({ status: 403, code: "raftbench_reader_not_authorized" });
  expect(await context()).not.toHaveProperty("raftbenchReader");
  await expect(setReaderGrant(serverId,admin.id,reader.id,true)).rejects.toThrow();
  await setReaderGrant(serverId,owner.id,reader.id,true);
  await db.update(messages).set({content:"edited"}).where(eq(messages.id,ma.id));
  expect((await(await call()).json()).total).toBe(0);expect(await db.select().from(raftbenchFindings)).toHaveLength(0);expect(await db.select().from(raftbenchReaderGrants)).toHaveLength(4);
});

test("a change during the read returns no findings: a re-read when analysis, the grant decision or channel access changed; an administrator when the grant is gone", async ({ app, db, seed, onTestFinished }) => {
  const { owner, admin, reader, a, call } = await setUp({ app, db, seed, onTestFinished });
  await setReaderGrant(serverId, admin.id, reader.id, true);
  // `change` runs after the first checks and the findings query, before the final checks.
  const readWhile = async (change: () => Promise<unknown>) => {
    barrier.midRead = change;
    try {
      const response = await call();
      const body = await response.json();
      return { status: response.status, code: body.code, next: body.suggestedNextAction, body };
    } finally { barrier.midRead = undefined; }
  };
  const noFindings = (result: { body: Record<string, unknown> }) => {
    expect(result.body).not.toHaveProperty("findings");
    expect(JSON.stringify(result.body)).not.toContain("Synthetic finding");
  };

  const untouched = await readWhile(async () => {});
  expect(untouched.status, JSON.stringify(untouched.body)).toBe(200);
  expect(untouched.body.findings).toHaveLength(2);

  const reread = { status: 409, code: "raftbench_findings_changed", next: "Read the first page again without a cursor." };
  const revision = await readWhile(() => db.update(raftbenchConfigs).set({ revision: 2 }).where(eq(raftbenchConfigs.serverId, serverId)));
  expect(revision).toMatchObject(reread); noFindings(revision);
  await db.update(raftbenchConfigs).set({ revision: 1 }).where(eq(raftbenchConfigs.serverId, serverId));

  const regranted = await readWhile(() => setReaderGrant(serverId, admin.id, reader.id, true));
  expect(regranted).toMatchObject(reread); noFindings(regranted);

  const channelAccess = await readWhile(() => db.delete(channelAgents).where(eq(channelAgents.agentId, reader.id)));
  expect(channelAccess).toMatchObject(reread); noFindings(channelAccess);
  await db.insert(channelAgents).values({ channelId: a.id, agentId: reader.id });

  const notAllowed = { status: 403, code: "raftbench_reader_not_authorized" };
  const revoked = await readWhile(() => setReaderGrant(serverId, owner.id, reader.id, false));
  expect(revoked).toMatchObject(notAllowed); noFindings(revoked);
  expect(revoked.next).toContain("allow this agent in RaftBench settings");
  await setReaderGrant(serverId, admin.id, reader.id, true);

  const demoted = await readWhile(() => db.update(serverMembers).set({ role: "member" }).where(eq(serverMembers.userId, admin.id)));
  expect(demoted).toMatchObject(notAllowed); noFindings(demoted);
});
