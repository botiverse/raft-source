import assert from "node:assert/strict";
import test from "node:test";
import { createUpgradeInfoReader } from "./upgradeInfo.ts";

test("upgrade display requests share a flight and cache successful results only until expiry", async () => {
  let now = 0;
  let calls = 0;
  let finish!: (value: string | null) => void;
  const read = createUpgradeInfoReader(() => { calls++; return new Promise((r) => { finish = r; }); }, () => now, 100);
  const first = read();
  assert.equal(read(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish("1.0.1");
  assert.deepEqual(await first, { latestVersion: "1.0.1" });
  now = 99;
  assert.deepEqual(await read(), { latestVersion: "1.0.1" });
  assert.equal(calls, 1);
  now = 100;
  const next = read();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish("1.0.2");
  assert.deepEqual(await next, { latestVersion: "1.0.2" });
});

test("offline and null results are not cached, so a later request can recover", async () => {
  let calls = 0;
  const read = createUpgradeInfoReader(async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    return calls === 2 ? null : "1.0.3";
  });
  assert.deepEqual(await read(), { latestVersion: null });
  assert.deepEqual(await read(), { latestVersion: null });
  assert.deepEqual(await read(), { latestVersion: "1.0.3" });
  assert.equal(calls, 3);
});
