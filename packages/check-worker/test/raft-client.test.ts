import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_CHECK_SHOT_MAX_BYTES, ARTIFACT_CHECK_VIEWPORTS, type ArtifactCheckReport } from "@botiverse/raft-shared/src/artifactCheckContract";

import { parseLease, postResult, postResultWithRetry, requestLease, resultForm, RESULT_RETRY_DELAYS_MS } from "../src/raftClient";
import { API_ORIGIN, fakeClock, fakeRaft, leaseFor, SPLIT_PNG, WHITE_PNG, WORKER_TOKEN } from "./fakes";

/**
 * The check Worker's calls to Raft (src/raftClient.ts; shared artifactCheckContract.ts): the
 * lease and the result, with fetch mocked. The server's side is checkTask.api.test.ts's.
 */

const apiWith = (raft: ReturnType<typeof fakeRaft>) => ({ origin: API_ORIGIN, token: WORKER_TOKEN, fetch: raft.fetch });
const okReport = (overrides: Partial<ArtifactCheckReport> = {}): ArtifactCheckReport => ({
  checkId: leaseFor().checkId,
  lease: leaseFor().lease,
  load: { outcome: "ok" },
  consoleErrors: [],
  blockedResources: [],
  ...overrides,
});

test("lease: POST with the Worker's bearer to /internal/artifacts-check/lease; 200 is the lease", async () => {
  const raft = fakeRaft({ leases: [leaseFor()] });
  const answer = await requestLease(apiWith(raft));
  assert.deepEqual(answer, { kind: "leased", lease: leaseFor() });
  assert.equal(raft.calls.length, 1);
  assert.equal(raft.calls[0]!.url, `${API_ORIGIN}/internal/artifacts-check/lease`);
  assert.equal(raft.calls[0]!.method, "POST");
  assert.equal(raft.calls[0]!.authorization, `Bearer ${WORKER_TOKEN}`);
});

test("lease: 204 is nothing to run; 401/403 refused; 5xx, 429 and a network error unavailable; other answers invalid", async () => {
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [204] }))), { kind: "none" });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [401] }))), { kind: "refused", status: 401 });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [403] }))), { kind: "refused", status: 403 });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [503] }))), { kind: "unavailable", status: 503 });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [429] }))), { kind: "unavailable", status: 429 });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [new TypeError("fetch failed")] }))), { kind: "unavailable", status: 0 });
  assert.deepEqual(await requestLease(apiWith(fakeRaft({ leases: [404] }))), { kind: "invalid", status: 404 });
});

test("lease: a 200 that isn't a lease is invalid: missing ids, a non-https url, a lease that isn't a time", () => {
  assert.ok(parseLease(leaseFor()));
  for (const bad of [
    null,
    [],
    { ...leaseFor(), checkId: "" },
    { ...leaseFor(), artifactId: 7 },
    { ...leaseFor(), url: "http://w-1.content.example/_raft/open?ticket=x" },
    { ...leaseFor(), url: "javascript:alert(1)" },
    { ...leaseFor(), url: "not a url" },
    { ...leaseFor(), lease: "soon" },
    { ...leaseFor(), leaseExpiresAt: "later" },
  ]) {
    assert.equal(parseLease(bad), null, JSON.stringify(bad));
  }
});

test("lease: its viewports are kept when each is one the result takes; else the contract's", () => {
  const phoneOnly = [{ shot: "phone", width: 390, height: 844, deviceScaleFactor: 2, mobile: true }];
  assert.deepEqual(parseLease({ ...leaseFor(), viewports: phoneOnly })!.viewports, phoneOnly);
  for (const viewports of [undefined, [], [{ shot: "tablet", width: 800, height: 600, deviceScaleFactor: 1, mobile: false }], [ARTIFACT_CHECK_VIEWPORTS[0], ARTIFACT_CHECK_VIEWPORTS[0]], [{ ...ARTIFACT_CHECK_VIEWPORTS[0], width: 0 }]]) {
    assert.deepEqual(parseLease({ ...leaseFor(), viewports })!.viewports, ARTIFACT_CHECK_VIEWPORTS, JSON.stringify(viewports));
  }
  // Extra fields (the contract is additive) are fine.
  assert.ok(parseLease({ ...leaseFor(), somethingNew: true }));
});

test("result: the form has the report as JSON and a PNG part per shot, named by shot, for a load that was ok", async () => {
  const form = resultForm(okReport(), { desktop: SPLIT_PNG, phone: WHITE_PNG });
  assert.deepEqual(JSON.parse(form.get("report") as string), okReport());
  const desktop = form.get("desktop") as File;
  const phone = form.get("phone") as File;
  assert.equal(desktop.type, "image/png");
  assert.equal(desktop.name, "desktop.png");
  assert.deepEqual(new Uint8Array(await desktop.arrayBuffer()), SPLIT_PNG);
  assert.deepEqual(new Uint8Array(await phone.arrayBuffer()), WHITE_PNG);
  assert.deepEqual([...form.keys()].sort(), ["desktop", "phone", "report"]);
});

test("result: no screenshot for a load that wasn't ok; a part that isn't a PNG, or is too large, is left out", () => {
  assert.deepEqual([...resultForm(okReport({ load: { outcome: "timeout" } }), { desktop: SPLIT_PNG }).keys()], ["report"]);
  assert.deepEqual([...resultForm(okReport({ load: { outcome: "error", errorClass: "http_401" } }), { desktop: SPLIT_PNG }).keys()], ["report"]);
  const notPng = new TextEncoder().encode("<html>not a png</html>");
  const tooLarge = new Uint8Array(ARTIFACT_CHECK_SHOT_MAX_BYTES + 1);
  tooLarge.set(SPLIT_PNG.subarray(0, 8));
  assert.deepEqual([...resultForm(okReport(), { desktop: notPng, phone: tooLarge }).keys()], ["report"]);
  assert.deepEqual([...resultForm(okReport(), { phone: SPLIT_PNG }).keys()], ["report", "phone"]);
});

test("result: POST to …/:checkId/result with the bearer; 200 recorded, 409 conflict, 401 refused, 5xx unavailable, 400/404/413 rejected", async () => {
  const raft = fakeRaft({ leases: [], results: [{ status: 200, body: { status: "done" } }] });
  assert.deepEqual(await postResult(apiWith(raft), okReport(), { desktop: SPLIT_PNG }), { kind: "recorded", status: "done" });
  assert.equal(raft.calls[0]!.url, `${API_ORIGIN}/internal/artifacts-check/${leaseFor().checkId}/result`);
  assert.equal(raft.calls[0]!.method, "POST");
  assert.equal(raft.calls[0]!.authorization, `Bearer ${WORKER_TOKEN}`);
  assert.ok(raft.calls[0]!.form?.get("desktop"));

  const answer = async (result: { status: number; body?: unknown } | Error) => postResult(apiWith(fakeRaft({ leases: [], results: [result] })), okReport(), {});
  assert.deepEqual(await answer({ status: 200, body: { status: "failed" } }), { kind: "recorded", status: "failed" });
  assert.deepEqual(await answer({ status: 200, body: { status: "weird" } }), { kind: "rejected", status: 200 });
  assert.deepEqual(await answer({ status: 409, body: { error: "x" } }), { kind: "conflict" });
  assert.deepEqual(await answer({ status: 401 }), { kind: "refused", status: 401 });
  assert.deepEqual(await answer({ status: 503 }), { kind: "unavailable", status: 503 });
  assert.deepEqual(await answer(new TypeError("fetch failed")), { kind: "unavailable", status: 0 });
  for (const status of [400, 404, 413]) assert.deepEqual(await answer({ status }), { kind: "rejected", status });
});

test("result: an unavailable answer is tried again within the lease; a conflict or a rejection is not", async () => {
  const clock = fakeClock();
  const raft = fakeRaft({ leases: [], results: [{ status: 503 }, { status: 200, body: { status: "done" } }] });
  assert.deepEqual(await postResultWithRetry(apiWith(raft), leaseFor(), okReport(), {}, clock), { kind: "recorded", status: "done" });
  assert.equal(raft.calls.length, 2);

  const conflict = fakeRaft({ leases: [], results: [{ status: 409 }, { status: 200, body: { status: "done" } }] });
  assert.deepEqual(await postResultWithRetry(apiWith(conflict), leaseFor(), okReport(), {}, fakeClock()), { kind: "conflict" });
  assert.equal(conflict.calls.length, 1);

  const down = fakeRaft({ leases: [], results: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }] });
  assert.deepEqual(await postResultWithRetry(apiWith(down), leaseFor(), okReport(), {}, fakeClock()), { kind: "unavailable", status: 503 });
  assert.equal(down.calls.length, 1 + RESULT_RETRY_DELAYS_MS.length);
});

test("result: no try is started once the lease is about to run out", async () => {
  const clock = fakeClock();
  const lease = leaseFor({ leaseExpiresAt: new Date(clock.now() + 4_000).toISOString() });
  const raft = fakeRaft({ leases: [], results: [{ status: 503 }, { status: 200, body: { status: "done" } }] });
  assert.deepEqual(await postResultWithRetry(apiWith(raft), lease, okReport(), {}, clock), { kind: "unavailable", status: 503 });
  assert.equal(raft.calls.length, 1);
});
