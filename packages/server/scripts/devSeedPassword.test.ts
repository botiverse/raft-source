import assert from "node:assert/strict";

import {
  DEFAULT_SEED_PASSWORD,
  explicitSeedPassword,
  resetExistingSeedUserPassword,
  seedPassword,
} from "./devSeedPassword";

const user = { id: "00000000-0000-4000-8000-000000000001", email: "admin@slock.ai" };
const fakeHash = async (password: string) => `hash(${password})`;

test("RAFTDEV_SEED_PASSWORD selects the seed password; blank means the default", () => {
  assert.equal(seedPassword({}), DEFAULT_SEED_PASSWORD);
  assert.equal(seedPassword({ RAFTDEV_SEED_PASSWORD: "  " }), DEFAULT_SEED_PASSWORD);
  assert.equal(explicitSeedPassword({ RAFTDEV_SEED_PASSWORD: " r4nd0m " }), "r4nd0m");
  assert.equal(explicitSeedPassword({}), null);
});

test("an existing seed account is re-hashed with an explicit seed password", async () => {
  const updates: [string, string][] = [];
  const reset = await resetExistingSeedUserPassword({
    user,
    explicitPassword: "r4nd0m",
    hash: fakeHash,
    update: async (id, passwordHash) => { updates.push([id, passwordHash]); },
  });
  assert.equal(reset, true);
  assert.deepEqual(updates, [[user.id, "hash(r4nd0m)"]]);
});

test("without an explicit seed password an existing account is left alone", async () => {
  const updates: [string, string][] = [];
  const reset = await resetExistingSeedUserPassword({
    user,
    explicitPassword: explicitSeedPassword({}),
    hash: fakeHash,
    update: async (id, passwordHash) => { updates.push([id, passwordHash]); },
  });
  assert.equal(reset, false);
  assert.deepEqual(updates, []);
});
