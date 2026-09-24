/**
 * Benchmark: GET /api/servers/:id/sidebar-order restore path.
 *
 * Run: pnpm --filter @botiverse/raft-server exec tsx scripts/perf/sidebarOrderBench.ts
 *
 * Seeds an in-memory PGlite database with N ordered sidebar ids, enables the
 * request trace sink, and exercises the HTTP route. This is the POC guard for
 * the semantic tracing facade: migrating the route must preserve trace shape
 * and keep p50 flat at N=100/500/1000.
 */
import argon2 from "argon2";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { openTestApp } from "../../src/test/integration/app.js";
import { getDb } from "../../src/db/index.js";
import {
  users,
  serverMembers, agents
} from "../../src/db/schema.js";
import { createServer, updateMemberSidebarOrder } from "../../src/services/serverService.js";
import { createChannel, findOrCreateDM, addHuman } from "../../src/services/channelService.js";

type Scale = { label: string; ids: number };

const SCALES: Scale[] = [
  { label: "N=100", ids: 100 },
  { label: "N=500", ids: 500 },
  { label: "N=1000", ids: 1000 },
];

const PASSWORD = "password123";

async function seedSidebarFixture(count: number) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `sidebar-owner-${count}@bench.local`,
    name: `sidebar-owner-${count}`,
    displayName: "Sidebar Owner",
    passwordHash: await argon2.hash(PASSWORD),
    emailVerified: true,
  }).returning();

  const server = await createServer(`Sidebar Bench ${count}`, `sidebar-bench-${count}`, owner.id);

  const channelIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const channel = await createChannel(server.id, `bench-channel-${count}-${i}`);
    await addHuman(channel.id, owner.id);
    channelIds.push(channel.id);
  }

  const agentRows = await db.insert(agents).values(
    Array.from({ length: count }, (_, i) => ({
      serverId: server.id,
      name: `sidebar-agent-${count}-${i}`,
      displayName: `Sidebar Agent ${i}`,
      status: "inactive" as const,
      runtime: "codex" as const,
      model: "sonnet",
      executionMode: "byoc" as const,
    })),
  ).returning({ id: agents.id });
  const agentIds = agentRows.map((row) => row.id);

  const dmIds: string[] = [];
  const dmLimit = Math.min(count, 50);
  for (let i = 0; i < dmLimit; i++) {
    const dm = await findOrCreateDM(server.id, owner.id, agentIds[i]!);
    if (dm) dmIds.push(dm.id);
  }

  const staleIds = Array.from({ length: Math.min(count, 50) }, (_, i) => `stale-${count}-${i}`);
  await updateMemberSidebarOrder(server.id, owner.id, {
    channelOrder: [...staleIds, ...channelIds],
    agentOrder: [...agentIds, ...staleIds],
    dmOrder: [...staleIds, ...dmIds],
    pinnedChannelIds: [...channelIds.slice(0, Math.min(count, 100)), ...dmIds, ...staleIds],
    pinnedAgentIds: [...agentIds.slice(0, Math.min(count, 100)), ...staleIds],
    pinnedOrder: [
      ...staleIds,
      ...channelIds.slice(0, Math.min(count, 100)),
      ...agentIds.slice(0, Math.min(count, 100)),
      ...dmIds,
    ],
    hiddenDmIds: [...dmIds, ...staleIds],
  });

  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers);
  if (!member) throw new Error("expected seeded server member");

  return { owner, server };
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed with ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { accessToken: string };
  return body.accessToken;
}

function formatMs(ms: number): string {
  return ms.toFixed(1).padStart(8);
}

async function runScale(scale: Scale) {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const { owner, server } = await seedSidebarFixture(scale.ids);
    const token = await login(app.baseUrl, owner.email);
    const url = `${app.baseUrl}/api/servers/${server.id}/sidebar-order`;
    const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id };

    const warm = await fetch(url, { headers });
    if (warm.status !== 200) throw new Error(`warm request failed with ${warm.status}`);
    await warm.arrayBuffer();
    sink.clear();

    const REPS = 10;
    const latenciesMs: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      const res = await fetch(url, { headers });
      const body = await res.json() as { channelOrder: string[]; agentOrder: string[] };
      const t1 = performance.now();
      if (res.status !== 200) throw new Error(`request failed with ${res.status}`);
      if (body.channelOrder.length !== scale.ids || body.agentOrder.length !== scale.ids) {
        throw new Error(`unexpected order sizes: channel=${body.channelOrder.length} agent=${body.agentOrder.length}`);
      }
      latenciesMs.push(t1 - t0);
      sink.clear();
    }
    latenciesMs.sort((a, b) => a - b);
    const p50 = latenciesMs[Math.floor(REPS * 0.5)]!;
    const p95 = latenciesMs[Math.floor(REPS * 0.95)]!;
    const min = latenciesMs[0]!;
    const max = latenciesMs[REPS - 1]!;
    console.log(
      `${scale.label.padEnd(8)} ids=${scale.ids.toString().padStart(5)}  ` +
      `min=${formatMs(min)}ms  p50=${formatMs(p50)}ms  ` +
      `p95=${formatMs(p95)}ms  max=${formatMs(max)}ms`,
    );
  } finally {
    await app.close();
  }
}

async function main() {
  for (const scale of SCALES) {
    await runScale(scale);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
