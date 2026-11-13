import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { installFakeRedis } from "../test/fakeRedis";
import { createSharedSlots } from "./sharedSlots";

// Slots held across replicas (sharedSlots.ts, Artifacts' imports at once):
// every replica takes its leases in the one Redis, so a third holder is
// refused whichever replica it reaches; a lease comes back when given back,
// or at its expiry when its holder never does (a replica that died); without
// Redis, or when it errors, a replica holds its own in memory.

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

test("two replicas share one name's slots: a third holder is refused on either; giving one back lets the next in", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  const [replicaA, replicaB] = [createSharedSlots(), createSharedSlots()];
  fake.clock.now = 1_000_000;
  const first = await replicaA.take("imports:s1", 2, 360_000, fake.clock.now);
  const second = await replicaB.take("imports:s1", 2, 360_000, fake.clock.now);
  assert.equal(first.taken && second.taken, true);
  assert.deepEqual(await replicaA.take("imports:s1", 2, 360_000, fake.clock.now), { taken: false });
  assert.deepEqual(await replicaB.take("imports:s1", 2, 360_000, fake.clock.now), { taken: false });
  assert.equal((await replicaA.take("imports:s2", 2, 360_000, fake.clock.now)).taken, true, "another name, its own slots");
  // B's holder finished: its lease is given back in Redis, so A takes it.
  if (second.taken) await second.release();
  if (second.taken) await second.release();
  assert.equal(fake.leases.get("imports:s1")?.size, 1, "given back once however often it is released");
  assert.equal((await replicaA.take("imports:s1", 2, 360_000, fake.clock.now)).taken, true);
  assert.deepEqual(await replicaB.take("imports:s1", 2, 360_000, fake.clock.now), { taken: false });
});

test("a lease never given back (its replica died mid-way) ends at its expiry", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  const slots = createSharedSlots();
  fake.clock.now = 2_000_000;
  for (let i = 0; i < 2; i += 1) assert.equal((await slots.take("imports:s1", 2, 360_000, fake.clock.now)).taken, true);
  assert.deepEqual(await slots.take("imports:s1", 2, 360_000, fake.clock.now + 359_999), { taken: false });
  assert.equal((await slots.take("imports:s1", 2, 360_000, fake.clock.now + 360_000)).taken, true, "both expired: a slot again");
});

test("without Redis, or when it errors, a replica holds its leases in its own memory, still at most the limit", async () => {
  const fake = installFakeRedis({ failing: true });
  restore = fake.restore;
  const slots = createSharedSlots();
  const first = await slots.take("imports:s1", 2, 360_000, 3_000_000);
  assert.equal(first.taken && (await slots.take("imports:s1", 2, 360_000, 3_000_000)).taken, true);
  assert.deepEqual(await slots.take("imports:s1", 2, 360_000, 3_000_000), { taken: false }, "never admitting everyone");
  if (first.taken) await first.release();
  assert.equal((await slots.take("imports:s1", 2, 360_000, 3_000_000)).taken, true, "given back in memory, where it was taken");
  fake.restore();
  restore = null;
  const alone = createSharedSlots();
  assert.equal((await alone.take("imports:s9", 1, 1_000, 4_000_000)).taken, true);
  assert.deepEqual(await alone.take("imports:s9", 1, 1_000, 4_000_000), { taken: false });
});
