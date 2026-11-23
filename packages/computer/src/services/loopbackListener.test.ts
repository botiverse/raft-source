import assert from "node:assert/strict";
import { request } from "node:http";

import { LOOPBACK_HOST, startLoopbackListener, type LoopbackRejection } from "./loopbackListener";

const STATE = "s".repeat(32);

function get(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: LOOPBACK_HOST, port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `${LOOPBACK_HOST}:${port}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function refused(port: number): Promise<boolean> {
  return get(port, "/callback").then(
    () => false,
    () => true,
  );
}

test("listens on 127.0.0.1 only, with a callback return URI carrying the state", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  try {
    assert.ok(listener.port > 0);
    assert.equal(listener.returnUri, `http://127.0.0.1:${listener.port}/callback?state=${STATE}`);
  } finally {
    await listener.close();
  }
});

test("a valid callback settles with the code, serves the done page, and closes the listener", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  const waiting = listener.wait({ timeoutMs: 60_000 });
  const res = await get(listener.port, `/callback?state=${STATE}&code=one-time-code`);
  assert.equal(res.status, 200);
  assert.match(res.body, /go back to the terminal/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(await waiting, { status: "code", code: "one-time-code" });
  await listener.close();
  assert.equal(await refused(listener.port), true);
});

test("a callback with another state is answered 400 and ignored; the wait goes on", async () => {
  const rejected: LoopbackRejection[] = [];
  const listener = await startLoopbackListener({ state: STATE, onRejected: (why) => rejected.push(why) });
  const waiting = listener.wait({ timeoutMs: 60_000 });
  try {
    assert.equal((await get(listener.port, `/callback?state=${"x".repeat(32)}&code=attacker`)).status, 400);
    assert.equal((await get(listener.port, `/callback?code=attacker`)).status, 400);
    assert.equal((await get(listener.port, `/callback?state=${STATE}&state=${STATE}&code=c`)).status, 400);
    assert.deepEqual(rejected, ["state_mismatch", "state_mismatch", "state_mismatch"]);
    const ok = await get(listener.port, `/callback?state=${STATE}&code=real`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await waiting, { status: "code", code: "real" });
  } finally {
    await listener.close();
  }
});

test("access_denied settles as denied with the not-approved page", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  const waiting = listener.wait({ timeoutMs: 60_000 });
  const res = await get(listener.port, `/callback?state=${STATE}&error=access_denied`);
  assert.equal(res.status, 200);
  assert.match(res.body, /not approved/);
  assert.deepEqual(await waiting, { status: "denied" });
  await listener.close();
});

test("only GET /callback on our Host is served: other paths, methods and hosts are 404", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  const waiting = listener.wait({ timeoutMs: 60_000 });
  try {
    assert.equal((await get(listener.port, "/")).status, 404);
    assert.equal((await get(listener.port, `/callback/x?state=${STATE}&code=c`)).status, 404);
    assert.equal((await get(listener.port, `/callback?state=${STATE}&code=c`, { method: "POST" })).status, 404);
    assert.equal((await get(listener.port, `/callback?state=${STATE}&code=c`, { host: `evil.example:${listener.port}` })).status, 404);
    // None of those settled it.
    const ok = await get(listener.port, `/callback?state=${STATE}&code=c`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await waiting, { status: "code", code: "c" });
  } finally {
    await listener.close();
  }
});

test("the wait expires at its deadline and closes the listener", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  assert.deepEqual(await listener.wait({ timeoutMs: 20 }), { status: "expired" });
  await listener.close();
  assert.equal(await refused(listener.port), true);
});

test("an abort cancels the wait", async () => {
  const listener = await startLoopbackListener({ state: STATE });
  const ctl = new AbortController();
  const waiting = listener.wait({ timeoutMs: 60_000, signal: ctl.signal });
  ctl.abort();
  assert.deepEqual(await waiting, { status: "cancelled" });
  await listener.close();
});
