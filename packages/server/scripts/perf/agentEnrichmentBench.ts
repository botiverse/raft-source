/**
 * Benchmark: batched vs per-agent enrichAgentWithCreatorProfile.
 *
 * Run: npx tsx packages/server/scripts/perf/agentEnrichmentBench.ts
 *
 * Seeds an in-memory PGlite database with N agents (mixed creator types),
 * runs both code paths against the same dataset, and prints per-call latency.
 * This isolates the enrichment cost from network/Express/orchestrator/runtime
 * profile lookups so the delta is unambiguous.
 */
import { initDatabase, getDb, closeDatabase } from "../../src/db/index.js";
import { agents, servers, serverMembers, users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  enrichAgentWithCreatorProfile,
  batchEnrichAgentsWithCreatorProfile,
} from "../../src/services/agentService.js";

async function seed(agentCount: number) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "bench@example.com",
    name: "bench",
    passwordHash: "h",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Bench",
    slug: "bench",
    ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: user.id,
    role: "owner",
  });

  const rows: any[] = [];
  for (let i = 0; i < agentCount; i++) {
    rows.push({
      serverId: server.id,
      name: `bench-agent-${i.toString().padStart(5, "0")}`,
      status: "active" as const,
      runtime: i % 2 === 0 ? "claude" : "codex",
      model: "sonnet",
      executionMode: "byoc" as const,
      // mix: 30% user-created, 50% agent-created (chained), 20% creator-less
      ...(i % 10 < 3
        ? { creatorType: "user" as const, creatorId: user.id }
        : {}),
    });
  }
  const inserted = await db.insert(agents).values(rows).returning();

  // Wire some agent-typed creators by chaining 50% of agents to a creator-of-the-prior
  const updates: { id: string; creatorId: string }[] = [];
  for (let i = 1; i < inserted.length; i++) {
    if (i % 10 >= 3 && i % 10 < 8) {
      updates.push({ id: inserted[i]!.id, creatorId: inserted[i - 1]!.id });
    }
  }
  // Apply chained creator updates (one transaction would be faster but this
  // is a one-shot benchmark setup)
  for (const u of updates) {
    await db.update(agents)
      .set({ creatorType: "agent", creatorId: u.creatorId })
      .where(eq(agents.id, u.id));
  }

  return { server, items: inserted };
}

async function main() {
  const counts = [100, 500, 1000];
  await initDatabase("pglite://");

  for (const N of counts) {
    // Reset DB per scale: drop everything by re-init
    await closeDatabase();
    await initDatabase("pglite://");
    const { items } = await seed(N);

    // Per-agent (current code path)
    const t0 = performance.now();
    const sequential = await Promise.all(items.map((a) => enrichAgentWithCreatorProfile(a)));
    const t1 = performance.now();

    // Batched (new code path)
    const t2 = performance.now();
    const batched = await batchEnrichAgentsWithCreatorProfile(items);
    const t3 = performance.now();

    const seqMs = (t1 - t0).toFixed(1);
    const batMs = (t3 - t2).toFixed(1);
    const speedup = ((t1 - t0) / Math.max(t3 - t2, 0.01)).toFixed(1);
    console.log(
      `N=${N.toString().padStart(4)}  per-agent ${seqMs.padStart(8)}ms  batched ${batMs.padStart(8)}ms  speedup ${speedup}x  ` +
      `(seq.length=${sequential.length} bat.length=${batched.length})`
    );
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
