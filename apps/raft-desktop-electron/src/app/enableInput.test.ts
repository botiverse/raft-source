import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEnableInput } from "./enableInput.js";

// Ablation for fix #1: the enable guard must reject a malformed/empty payload
// BEFORE the (destructive) shared-session write. With the guard OFF, such a
// payload would proceed to clobber a working session then fail attach; the guard
// ON rejects it up front. Here we prove the guard's classification is correct.

test("#1 valid payload passes", () => {
  assert.equal(
    isValidEnableInput({ serverSlug: "s", serverUrl: "https://api.raft.build", accessToken: "a", refreshToken: "r" }),
    true,
  );
});

test("#1 empty/missing tokens are rejected (would otherwise clobber the session)", () => {
  const base = { serverSlug: "s", serverUrl: "https://api.raft.build", accessToken: "a", refreshToken: "r" };
  assert.equal(isValidEnableInput({ ...base, accessToken: "" }), false);
  assert.equal(isValidEnableInput({ ...base, refreshToken: "" }), false);
  assert.equal(isValidEnableInput({ ...base, accessToken: undefined }), false);
});

test("#1 missing server fields are rejected", () => {
  const base = { serverSlug: "s", serverUrl: "https://api.raft.build", accessToken: "a", refreshToken: "r" };
  assert.equal(isValidEnableInput({ ...base, serverSlug: "" }), false);
  assert.equal(isValidEnableInput({ ...base, serverUrl: "" }), false);
});

test("#1 garbage inputs are rejected without throwing", () => {
  for (const bad of [null, undefined, 42, "x", {}, { accessToken: 1, refreshToken: 2 }]) {
    assert.equal(isValidEnableInput(bad), false);
  }
});
