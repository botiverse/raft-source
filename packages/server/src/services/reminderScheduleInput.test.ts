import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveScheduleInput } from "./reminderScheduleInput.js";

// R4 deterministic contract: fake `now` pins the math.
// Pick a value that is not a round second, to catch accidental rounding.
const FIXED_NOW_MS = Date.parse("2026-04-20T12:34:56.789Z");

test("R4: delaySeconds resolves to fireAt = now + delaySeconds*1000", () => {
  const result = resolveScheduleInput({ delaySeconds: 60 }, FIXED_NOW_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fireAt.getTime(), FIXED_NOW_MS + 60_000);
  assert.equal(result.warning, undefined);
});

test("R4: delaySeconds below 24h does not surface a warning (relative path is trusted)", () => {
  const result = resolveScheduleInput({ delaySeconds: 3600 }, FIXED_NOW_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warning, undefined);
});

test("R4: delaySeconds beyond 24h still does not warn — warning is a fireAt-only guard", () => {
  // Agent side TZ bugs only apply to fireAt parsing. delaySeconds is server-
  // authoritative, so large relative delays are fine.
  const result = resolveScheduleInput({ delaySeconds: 7 * 24 * 3600 }, FIXED_NOW_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warning, undefined);
});

test("R4: XOR mutex — both delaySeconds AND fireAt is rejected", () => {
  const result = resolveScheduleInput(
    { delaySeconds: 60, fireAt: "2026-04-20T13:00:00.000Z" },
    FIXED_NOW_MS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /either delaySeconds or fireAt, not both/);
});

test("R4: XOR mutex — neither delaySeconds NOR fireAt is rejected", () => {
  const result = resolveScheduleInput({}, FIXED_NOW_MS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Provide delaySeconds.*or fireAt/);
});

test("R4: delaySeconds must be a positive integer", () => {
  assert.equal(resolveScheduleInput({ delaySeconds: 0 }, FIXED_NOW_MS).ok, false);
  assert.equal(resolveScheduleInput({ delaySeconds: -10 }, FIXED_NOW_MS).ok, false);
  assert.equal(resolveScheduleInput({ delaySeconds: 1.5 }, FIXED_NOW_MS).ok, false);
  assert.equal(resolveScheduleInput({ delaySeconds: "60" }, FIXED_NOW_MS).ok, false);
  assert.equal(resolveScheduleInput({ delaySeconds: Number.NaN }, FIXED_NOW_MS).ok, false);
});

test("R4: delaySeconds must be within 1 year", () => {
  const oneYear = 365 * 24 * 3600;
  assert.equal(resolveScheduleInput({ delaySeconds: oneYear }, FIXED_NOW_MS).ok, true);
  assert.equal(resolveScheduleInput({ delaySeconds: oneYear + 1 }, FIXED_NOW_MS).ok, false);
});

test("R4: fireAt in the past is rejected", () => {
  const result = resolveScheduleInput(
    { fireAt: new Date(FIXED_NOW_MS - 1000).toISOString() },
    FIXED_NOW_MS,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /future/);
});

test("R4: fireAt must be a valid ISO-8601 string", () => {
  assert.equal(resolveScheduleInput({ fireAt: "not-a-date" }, FIXED_NOW_MS).ok, false);
  assert.equal(resolveScheduleInput({ fireAt: 1234567890 }, FIXED_NOW_MS).ok, false);
});

test("R4: fireAt > 24h out surfaces a non-blocking warning (TZ guard)", () => {
  const fireAt = new Date(FIXED_NOW_MS + 25 * 3600 * 1000).toISOString();
  const result = resolveScheduleInput({ fireAt }, FIXED_NOW_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.warning);
  assert.match(result.warning!, /delaySeconds/);
  assert.match(result.warning!, /local clock/);
});

test("R4: fireAt within 24h does NOT warn", () => {
  const fireAt = new Date(FIXED_NOW_MS + 23 * 3600 * 1000).toISOString();
  const result = resolveScheduleInput({ fireAt }, FIXED_NOW_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warning, undefined);
});

test("R4: fireAt beyond 1 year horizon is rejected outright", () => {
  const fireAt = new Date(FIXED_NOW_MS + 366 * 24 * 3600 * 1000).toISOString();
  const result = resolveScheduleInput({ fireAt }, FIXED_NOW_MS);
  assert.equal(result.ok, false);
});
