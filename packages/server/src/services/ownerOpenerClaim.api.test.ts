import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { claimOwnerOpener, createServer, OWNER_OPENER_CLAIM_LEASE_MS, releaseOwnerOpenerClaim } from "./serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// The owner opener has several concurrent entry points (import hook, survey save,
// agent start, setup backstop): exactly one may brief and post it.
test("the owner opener is claimed by one sender at a time; a released or stale claim can be taken; a late release cannot clear a takeover; a sent opener cannot", async ({ app }) => {
  assert.ok(app.baseUrl);
  const [owner] = await getDb().insert(users).values({
    email: "opener-claim@slock.test", name: "opener-claim", displayName: "Owner", passwordHash: "unused", emailVerified: true,
  }).returning();
  const server = await createServer("Opener claim", "opener-claim", owner!.id);
  const now = new Date();

  const racers = await Promise.all(Array.from({ length: 5 }, () => claimOwnerOpener(server.id, owner!.id, now)));
  assert.equal(racers.filter(Boolean).length, 1, "exactly one concurrent claim wins");
  const first = racers.find(Boolean)!;
  assert.equal(await claimOwnerOpener(server.id, owner!.id, now), null);

  await releaseOwnerOpenerClaim(server.id, owner!.id, first);
  const second = await claimOwnerOpener(server.id, owner!.id, now);
  assert.ok(second, "a released claim can be taken");

  const afterLease = new Date(now.getTime() + OWNER_OPENER_CLAIM_LEASE_MS + 1);
  const takeover = await claimOwnerOpener(server.id, owner!.id, afterLease);
  assert.ok(takeover, "a dead sender's claim expires");
  // The slow sender fails late: its release must not clear the new holder's claim.
  await releaseOwnerOpenerClaim(server.id, owner!.id, second);
  assert.equal(await claimOwnerOpener(server.id, owner!.id, afterLease), null, "the takeover still holds the claim");
  await releaseOwnerOpenerClaim(server.id, owner!.id, takeover);

  await getDb().update(serverMembers).set({ onboardingOwnerOpenerV2SentAt: now })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner!.id)));
  assert.equal(await claimOwnerOpener(server.id, owner!.id, afterLease), null, "a sent opener is never claimed again");
});
