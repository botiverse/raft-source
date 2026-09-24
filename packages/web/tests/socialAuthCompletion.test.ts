import assert from "node:assert/strict";
import test from "node:test";
import { completeSocialAuthWithOneLinkRefresh } from "../src/utils/socialAuthCompletion";

function httpError(status: number, code: string): Error & {
  response: { status: number; data: { code: string } };
} {
  return Object.assign(new Error(code), { response: { status, data: { code } } });
}

test("link completion refreshes at most once after auth_required", async () => {
  let completionCalls = 0;
  let refreshCalls = 0;
  const result = await completeSocialAuthWithOneLinkRefresh({
    mode: "link",
    complete: async () => {
      completionCalls += 1;
      if (completionCalls === 1) throw httpError(401, "auth_required");
      return "linked";
    },
    refresh: async () => {
      refreshCalls += 1;
    },
  });

  assert.equal(result, "linked");
  assert.equal(completionCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("a second auth_required is returned without another refresh loop", async () => {
  let completionCalls = 0;
  let refreshCalls = 0;
  await assert.rejects(
    completeSocialAuthWithOneLinkRefresh({
      mode: "link",
      complete: async () => {
        completionCalls += 1;
        throw httpError(401, "auth_required");
      },
      refresh: async () => { refreshCalls += 1; },
    }),
    /auth_required/,
  );
  assert.equal(completionCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("link completion does not refresh on owner mismatch", async () => {
  let refreshCalls = 0;
  await assert.rejects(
    completeSocialAuthWithOneLinkRefresh({
      mode: "link",
      complete: async () => { throw httpError(403, "link_user_mismatch"); },
      refresh: async () => { refreshCalls += 1; },
    }),
    /link_user_mismatch/,
  );
  assert.equal(refreshCalls, 0);
});

test("login completion never enters the link refresh path", async () => {
  let refreshCalls = 0;
  await assert.rejects(
    completeSocialAuthWithOneLinkRefresh({
      mode: "login",
      complete: async () => { throw httpError(401, "auth_required"); },
      refresh: async () => { refreshCalls += 1; },
    }),
    /auth_required/,
  );
  assert.equal(refreshCalls, 0);
});
