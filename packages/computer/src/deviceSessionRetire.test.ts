// Device-auth design v2 §4 step 2: the Computer retires its own device session
// at service start (deviceSessionRetire.ts), against a fake server.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withComputerMutationLock } from "./concurrency";
import {
  claimDeviceSessionRetireReport,
  deviceSessionRetireReportPath,
  logoutTimeoutMs,
  retireOwnDeviceSession,
  scheduleDeviceSessionRetire,
  type DeviceSessionRetireDeps,
  type DeviceSessionRetireOutcome,
  type DeviceSessionRetireReport,
} from "./deviceSessionRetire";
import { runService } from "./service";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const KEY_A = "sk_computer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "sk_computer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REFRESH_TOKEN = "refresh-secret-0123456789";

function jwt(offsetSeconds: number, tag: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offsetSeconds, tag })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const FRESH_TOKEN = jwt(900, "fresh");
const EXPIRED_TOKEN = jwt(-60, "expired");

interface Seen {
  path: string;
  authorization?: string;
  computerKey?: string;
  body?: string;
}

type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>;

async function startFakeServer(handler: Handler): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const entry: Seen = {
      path: req.url ?? "",
      ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers["x-raft-computer-key"] === "string" ? { computerKey: req.headers["x-raft-computer-key"] } : {}),
      ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    };
    seen.push(entry);
    await handler(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The retire endpoint's contract (server routes/computerRetireSession.ts), with `goodKey` issued by the session. */
function retireEndpoint(goodKey: string, opts: { token?: string; answer?: { status: number; body: unknown } } = {}): Handler {
  return (req, res) => {
    if (req.path !== "/api/computer/retire-session") return json(res, 404, { error: "not found" });
    if (req.authorization !== `Bearer ${opts.token ?? FRESH_TOKEN}`) return json(res, 401, { error: "Invalid or expired token", code: "auth_required" });
    if (req.computerKey !== goodKey) return json(res, 403, { error: "This Computer key wasn't issued by this session", code: "computer_key_family_mismatch" });
    if (opts.answer) return json(res, opts.answer.status, opts.answer.body);
    return json(res, 200, { ok: true, retired: true, alreadyRetired: false });
  };
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-retire-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function sessionFile(home: string): string {
  return join(home, "computer", "user-session.json");
}

async function writeSession(home: string, serverUrl: string, accessToken: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(home, "computer"), { recursive: true });
  await writeFile(
    sessionFile(home),
    JSON.stringify({ kind: "user-session", schemaVersion: 1, userId: "user-1", accessToken, refreshToken: REFRESH_TOKEN, serverUrl, createdAt: "2026-10-01T00:00:00.000Z", ...extra }, null, 2),
    { mode: 0o600 },
  );
}

async function writeAttachment(home: string, serverId: string, serverUrl: string, apiKey: string): Promise<void> {
  const dir = join(home, "computer", "servers", serverId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "runner.state.json"),
    JSON.stringify({ kind: "computer-attachment", serverId, serverSlug: `s-${serverId.slice(0, 4)}`, serverMachineId: `cm-${serverId.slice(0, 4)}`, apiKey, serverUrl, attachedAt: "2026-10-01T00:00:00.000Z" }),
    { mode: 0o600 },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const defaults: DeviceSessionRetireDeps = {};

/** Fails the test if anything asks /api/auth/refresh: the retire never refreshes. */
function noRefresh(handler: Handler): Handler {
  return (req, res) => {
    if (req.path === "/api/auth/refresh") throw new Error("the retire must never refresh");
    return handler(req, res);
  };
}

test("success: the session's own key retires it and user-session.json is deleted", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_A));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "retired", deleted: true, keysTried: 1, httpStatus: 200 });
      assert.equal(await exists(sessionFile(home)), false);
      assert.equal(server.seen.length, 1);
      assert.equal(server.seen[0]!.path, "/api/computer/retire-session");
      assert.equal(server.seen[0]!.body, undefined, "no body: the proofs are the two headers");
      assert.equal(await exists(join(home, "computer", "servers", SERVER_A, "runner.state.json")), true, "the machine key stays");
    });
  } finally {
    await server.close();
  }
});

test("a key from another family is refused (403), the next key is tried and retires the session", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_B));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "retired");
      assert.equal(outcome.keysTried, 2);
      assert.deepEqual(server.seen.map((s) => s.computerKey), [KEY_A, KEY_B]);
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("already retired answers ok: the file is deleted", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_A, { answer: { status: 200, body: { ok: true, retired: true, alreadyRetired: true } } }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "already_retired");
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("409 session_revoked: the file is deleted (unusable; its keys are already revoked server-side)", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_A, { answer: { status: 409, body: { error: "revoked", code: "session_revoked" } } }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "session_revoked", deleted: true, keysTried: 1, httpStatus: 409 });
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("network error: the file is kept, the outcome is transient, and the next start retires it", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_A));
  const url = server.url;
  await server.close();
  await withHome(async (home) => {
    await writeSession(home, url, FRESH_TOKEN);
    await writeAttachment(home, SERVER_A, url, KEY_A);
    const before = await readFile(sessionFile(home), "utf8");
    const offline = await retireOwnDeviceSession(home, { ...defaults, requestTimeoutMs: 2_000 });
    assert.equal(offline.reason, "network_error");
    assert.equal(offline.deleted, false);
    assert.equal(await readFile(sessionFile(home), "utf8"), before, "kept byte for byte");

    // Next start: the server is back (same origin is not reusable, so point
    // both files at the new one).
    const back = await startFakeServer(retireEndpoint(KEY_A));
    try {
      await writeSession(home, back.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, back.url, KEY_A);
      const online = await retireOwnDeviceSession(home, defaults);
      assert.equal(online.reason, "retired");
      assert.equal(await exists(sessionFile(home)), false);
    } finally {
      await back.close();
    }
  });
});

test("5xx: kept and transient", async () => {
  const server = await startFakeServer((_req, res) => json(res, 503, { error: "down" }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "server_error");
      assert.equal(outcome.keysTried, 1, "a 5xx stops: the next key would get the same");
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await server.close();
  }
});

test("an older server without the endpoint (404): deleted locally, no further keys, no logout", async () => {
  const server = await startFakeServer((_req, res) => json(res, 404, { error: "not found" }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "endpoint_unavailable", deleted: true, keysTried: 1, httpStatus: 404 });
      assert.equal(server.seen.length, 1, "the server never said it is a device login: no logout");
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

/** `POST /api/auth/logout` (server routes/auth.ts): always `{ ok: true }`. */
function withLogout(handler: Handler, answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }): Handler {
  return (req, res) => {
    if (req.path === "/api/auth/logout") return json(res, answer.status, answer.body);
    return handler(req, res);
  };
}

test("every key refused (403: a device login none of these keys came from): it logs itself out with its own refresh token, then the file is deleted", async () => {
  const server = await startFakeServer(noRefresh(withLogout(retireEndpoint("sk_computer_none"))));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "no_matching_key", deleted: true, keysTried: 2, httpStatus: 403, logout: "ok" });
      const logout = server.seen.filter((r) => r.path === "/api/auth/logout");
      assert.equal(logout.length, 1);
      assert.deepEqual(JSON.parse(logout[0]!.body ?? "null"), { refreshToken: REFRESH_TOKEN });
      assert.equal(logout[0]!.computerKey, undefined, "a key never goes to the logout");
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("every key refused and the logout fails: the file is deleted anyway", async () => {
  const server = await startFakeServer(withLogout(retireEndpoint("sk_computer_none"), { status: 500, body: { error: "Logout failed" } }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "no_matching_key", deleted: true, keysTried: 1, httpStatus: 403, logout: "failed" });
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("every key refused with 401 only (revoked keys): the session's kind is unknown, so no logout; the file is deleted", async () => {
  const server = await startFakeServer(withLogout((_req, res) => json(res, 401, { error: "not accepted", code: "computer_key_invalid" })));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "no_matching_key", deleted: true, keysTried: 1, httpStatus: 401 });
      assert.equal(server.seen.some((r) => r.path === "/api/auth/logout"), false);
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("every key refused with 403 but the file has no refresh token: nothing to log out with, the file is deleted", async () => {
  const server = await startFakeServer(withLogout(retireEndpoint("sk_computer_none")));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN, { refreshToken: undefined });
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "no_matching_key", deleted: true, keysTried: 1, httpStatus: 403 });
      assert.equal(server.seen.some((r) => r.path === "/api/auth/logout"), false);
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("keys refused with 401 and 403 mixed: one 403 is enough to know it is a device login, so it logs out", async () => {
  const retire = retireEndpoint("sk_computer_none");
  const server = await startFakeServer(withLogout((req, res) => {
    if (req.computerKey === KEY_A) return json(res, 401, { error: "not accepted", code: "computer_key_invalid" });
    return retire(req, res);
  }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "no_matching_key");
      assert.equal(outcome.keysTried, 2);
      assert.equal(outcome.logout, "ok");
      assert.equal(outcome.deleted, true);
    });
  } finally {
    await server.close();
  }
});

test("every key refused while the service starts stopping: kept for the next start (no logout, no delete)", async () => {
  const stop = new AbortController();
  const server = await startFakeServer(withLogout(retireEndpoint("sk_computer_none")));
  // The stop lands after the last key's refusal was fully read (a stop during
  // a request ends that request as "cancelled" on its own).
  const fetchFn = (async (url: string, init?: object) => {
    const res = await fetch(url, init as RequestInit);
    const body = await res.text();
    if (url.endsWith("/api/computer/retire-session")) stop.abort();
    return new Response(body, { status: res.status, headers: res.headers });
  }) as unknown as NonNullable<DeviceSessionRetireDeps["fetchFn"]>;
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, { ...defaults, fetchFn, signal: stop.signal });
      assert.equal(outcome.reason, "cancelled");
      assert.equal(outcome.deleted, false);
      assert.equal(server.seen.some((r) => r.path === "/api/auth/logout"), false);
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await server.close();
  }
});

test("the logout's timeout keeps the locked attempt under what a CLI command waits for the lock", () => {
  // Budget 4 s + at most 0.5 s past it: under the ~5.6 s lock wait (concurrency.ts).
  assert.equal(logoutTimeoutMs(10_000, 10_000 - 3_000), 1_500, "plenty of budget left: the 1.5 s cap");
  assert.equal(logoutTimeoutMs(10_000, 10_000 - 200), 700, "little left: the rest plus 0.5 s");
  assert.equal(logoutTimeoutMs(10_000, 10_000), 500, "budget used up: 0.5 s");
  assert.equal(logoutTimeoutMs(10_000, 10_000 + 2_000), 100, "past the budget: the 100 ms floor");
});

test("a hung logout fails the logout but still deletes the file", async () => {
  const retire = retireEndpoint("sk_computer_none");
  const server = await startFakeServer((req, res) => {
    if (req.path === "/api/auth/logout") return; // never answers
    return retire(req, res);
  });
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, { ...defaults, attemptBudgetMs: 100 });
      assert.equal(outcome.logout, "failed");
      assert.equal(outcome.deleted, true);
    });
  } finally {
    await server.close();
  }
});

test("a passing failure on the last attempt deletes the file without a logout; on the first it is kept", async () => {
  const server = await startFakeServer(withLogout((_req, res) => json(res, 503, { error: "down" })));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const first = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(first, { reason: "server_error", deleted: false, keysTried: 1, httpStatus: 503 });
      assert.equal(await exists(sessionFile(home)), true);
      const last = await retireOwnDeviceSession(home, { ...defaults, lastAttempt: true });
      assert.deepEqual(last, { reason: "server_error", deleted: true, keysTried: 1, httpStatus: 503 });
      assert.equal(server.seen.some((r) => r.path === "/api/auth/logout"), false);
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("a key attached to another server origin is never sent", async () => {
  const sessionServer = await startFakeServer(retireEndpoint(KEY_A));
  const otherServer = await startFakeServer(retireEndpoint(KEY_A));
  try {
    await withHome(async (home) => {
      await writeSession(home, sessionServer.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, otherServer.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "no_attached_key");
      assert.equal(sessionServer.seen.length + otherServer.seen.length, 0);
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await sessionServer.close();
    await otherServer.close();
  }
});

test("a session rewritten while the retire ran (a new login) is kept", async () => {
  let home = "";
  const retire = retireEndpoint(KEY_A);
  const server = await startFakeServer(async (req, res) => {
    await writeSession(home, "http://elsewhere.invalid", jwt(900, "new-login"));
    return retire(req, res);
  });
  try {
    await withHome(async (h) => {
      home = h;
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "session_changed");
      assert.equal(outcome.deleted, false);
      assert.match(await readFile(sessionFile(home), "utf8"), /elsewhere\.invalid/);
    });
  } finally {
    await server.close();
  }
});

test("no session file: nothing sent, nothing logged; an unreadable one is left alone", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER_A, "http://127.0.0.1:9", KEY_A);
    assert.equal((await retireOwnDeviceSession(home, defaults)).reason, "no_session");
    await writeFile(sessionFile(home), "{not json");
    assert.equal((await retireOwnDeviceSession(home, defaults)).reason, "session_invalid");
    assert.equal(await exists(sessionFile(home)), true);
  });
});

test("schedule: returns at once, attempts after the delay, retries once after a transient failure", async () => {
  const calls: number[] = [];
  const lines: string[] = [];
  const results: DeviceSessionRetireOutcome[] = [
    { reason: "network_error", deleted: false, keysTried: 1 },
    { reason: "retired", deleted: true, keysTried: 1, httpStatus: 200 },
  ];
  const schedule = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 5,
    retryDelayMs: 5,
    log: (line) => lines.push(line),
    attemptFn: async () => {
      calls.push(Date.now());
      return results[calls.length - 1]!;
    },
  });
  assert.equal(calls.length, 0, "nothing runs synchronously in the service start");
  const outcomes = await schedule.done;
  assert.deepEqual(outcomes.map((o) => o.reason), ["network_error", "retired"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^Service startup: device session retire: network_error \(attempt 1, keys tried 1, user-session\.json kept\)\.\n$/);
  assert.match(lines[1]!, /^Service startup: device session retire: retired \(attempt 2, keys tried 1, http 200, user-session\.json deleted\)\.\n$/);
});

test("schedule: no retry after a final outcome, at most one retry, and cancel stops a pending attempt", async () => {
  let calls = 0;
  const final = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 1,
    retryDelayMs: 1,
    log: () => {},
    attemptFn: async () => { calls += 1; return { reason: "no_matching_key", deleted: false, keysTried: 2 }; },
  });
  assert.equal((await final.done).length, 1);
  assert.equal(calls, 1);

  calls = 0;
  const transient = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 1,
    retryDelayMs: 1,
    log: () => {},
    attemptFn: async () => { calls += 1; return { reason: "server_error", deleted: false, keysTried: 1 }; },
  });
  assert.equal((await transient.done).length, 2);
  assert.equal(calls, 2, "one attempt per start plus one delayed retry, never a loop");

  calls = 0;
  const cancelled = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 60_000,
    log: () => {},
    attemptFn: async () => { calls += 1; return { reason: "retired", deleted: true, keysTried: 1 }; },
  });
  cancelled.cancel();
  assert.deepEqual(await cancelled.done, []);
  assert.equal(calls, 0);
});

test("schedule: a throwing attempt or logger never escapes", async () => {
  const schedule = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 1,
    log: () => { throw new Error("log broke"); },
    attemptFn: async () => { throw new Error("boom"); },
  });
  const outcomes = await schedule.done;
  assert.equal(outcomes[0]!.reason, "internal_error");
});

test("no secret (access token, refresh token, key) appears in any logged line", async () => {
  const lines: string[] = [];
  const answers: Array<{ status: number; body: unknown }> = [
    { status: 409, body: { code: "session_revoked" } },
    { status: 503, body: { error: "down" } },
  ];
  for (const answer of [undefined, ...answers]) {
    const server = await startFakeServer(retireEndpoint(KEY_B, answer ? { answer } : {}));
    try {
      await withHome(async (home) => {
        await writeSession(home, server.url, FRESH_TOKEN);
        await writeAttachment(home, SERVER_A, server.url, KEY_A);
        await writeAttachment(home, SERVER_B, server.url, KEY_B);
        const schedule = scheduleDeviceSessionRetire(home, { ...defaults, initialDelayMs: 1, retryDelayMs: 1, log: (line) => lines.push(line) });
        await schedule.done;
      });
    } finally {
      await server.close();
    }
  }
  assert.ok(lines.length >= 3);
  const all = lines.join("");
  for (const secret of [FRESH_TOKEN, REFRESH_TOKEN, KEY_A, KEY_B, "sk_computer_", "Bearer"]) {
    assert.ok(!all.includes(secret), `log must not carry ${secret.slice(0, 12)}…`);
  }
});

test("runService schedules the retire without awaiting it: the start completes although the retire never settles", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-retire-svc-"));
  const old = { raft: process.env.RAFT_HOME, slock: process.env.SLOCK_HOME };
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  let scheduledFor: string | null = null;
  let cancelled = false;
  let ipcReady = false;
  let guard: NodeJS.Timeout | undefined;
  try {
    const started = runService({
      detectSystemdSupervisorFn: async () => null,
      externalSupervisorOptInFn: () => false,
      shutdownServiceFn: async () => {},
      scheduleDeviceSessionRetireFn: (slockHome) => {
        scheduledFor = slockHome;
        // Also a thenable that never settles: a service start that awaited
        // the retire would hang here and lose the race below.
        const handle = { cancel: () => { cancelled = true; }, then: (_resolve: unknown) => {} };
        return handle;
      },
      afterIpcReady: async (shutdown) => {
        ipcReady = true;
        await shutdown();
      },
    });
    await Promise.race([
      started,
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("runService waited for the retire")), 20_000); }),
    ]);
    assert.equal(ipcReady, true);
    assert.equal(scheduledFor, home);
    assert.equal(cancelled, true, "shutdown cancels a pending retire");
  } finally {
    clearTimeout(guard);
    if (old.raft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = old.raft;
    if (old.slock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = old.slock;
    await rm(home, { recursive: true, force: true });
  }
});

test("a redirect is never followed: the key does not reach the redirect target", async () => {
  const target = await startFakeServer(retireEndpoint(KEY_A));
  const server = await startFakeServer((_req, res) => {
    res.writeHead(307, { Location: `${target.url}/api/computer/retire-session` });
    res.end();
  });
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "unexpected_response", deleted: true, keysTried: 1, httpStatus: 307 });
      assert.equal(target.seen.length, 0);
      assert.equal(server.seen.length, 1, "no logout after an answer that says nothing about the session");
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
    await target.close();
  }
});

test("a busy mutation lock (a CLI attach/setup running) skips the attempt without sending anything", async () => {
  const server = await startFakeServer(retireEndpoint(KEY_A));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await withComputerMutationLock(home, () => retireOwnDeviceSession(home, defaults));
      assert.equal(outcome.reason, "lock_busy");
      assert.equal(server.seen.length, 0);
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await server.close();
  }
});

test("401 computer_key_invalid (a revoked key) moves on to the next key", async () => {
  const retire = retireEndpoint(KEY_B);
  const server = await startFakeServer((req, res) => {
    if (req.computerKey === KEY_A) return json(res, 401, { error: "not accepted", code: "computer_key_invalid" });
    return retire(req, res);
  });
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "retired");
      assert.equal(outcome.keysTried, 2);
    });
  } finally {
    await server.close();
  }
});

test("429: kept and transient", async () => {
  const server = await startFakeServer((_req, res) => json(res, 429, { error: "slow down" }));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.equal(outcome.reason, "rate_limited");
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await server.close();
  }
});

test("a hung server: the attempt ends at its budget (timed_out, transient) and cancel aborts one in flight", async () => {
  const server = await startFakeServer(() => { /* never answers */ });
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const timedOut = await retireOwnDeviceSession(home, { ...defaults, attemptBudgetMs: 300 });
      assert.equal(timedOut.reason, "timed_out");

      const schedule = scheduleDeviceSessionRetire(home, { ...defaults, initialDelayMs: 1, retryDelayMs: 1, log: () => {} });
      while (server.seen.length < 2) await new Promise((r) => setTimeout(r, 10));
      schedule.cancel();
      const outcomes = await schedule.done;
      assert.deepEqual(outcomes.map((o) => o.reason), ["cancelled"]);
      assert.equal(await exists(sessionFile(home)), true);
    });
  } finally {
    await server.close();
  }
});

test("an expired access token is sent as the file has it (no refresh) and retires the session", async () => {
  const server = await startFakeServer(noRefresh(retireEndpoint(KEY_A, { token: EXPIRED_TOKEN })));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, EXPIRED_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      const outcome = await retireOwnDeviceSession(home, defaults);
      assert.deepEqual(outcome, { reason: "retired", deleted: true, keysTried: 1, httpStatus: 200 });
      assert.deepEqual(server.seen.map((s) => s.path), ["/api/computer/retire-session"]);
      assert.equal(await exists(sessionFile(home)), false);
    });
  } finally {
    await server.close();
  }
});

test("409 session_not_device (a web session an older Desktop copied in): only the local file is deleted, nothing retried", async () => {
  const server = await startFakeServer(noRefresh((_req, res) =>
    json(res, 409, { error: "This is not a device login session; there is nothing to retire", code: "session_not_device" })));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, EXPIRED_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const schedule = scheduleDeviceSessionRetire(home, { initialDelayMs: 1, retryDelayMs: 1, log: () => {} });
      const outcomes = await schedule.done;
      assert.deepEqual(outcomes, [{ reason: "session_not_device", deleted: true, keysTried: 1, httpStatus: 409 }]);
      assert.equal(server.seen.length, 1, "no second key, no retry, no logout (it would sign the Desktop out)");
      assert.equal(await exists(sessionFile(home)), false);
      assert.equal(await exists(join(home, "computer", "servers", SERVER_A, "runner.state.json")), true, "machine keys stay");
    });
  } finally {
    await server.close();
  }
});

test("401 auth_required (the token can never be accepted: bad signature, no family, session or account gone): deleted, logged, not refreshed, not retried", async () => {
  const server = await startFakeServer(noRefresh(retireEndpoint(KEY_A, { token: "some-other-token" })));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await writeAttachment(home, SERVER_B, server.url, KEY_B);
      const lines: string[] = [];
      const schedule = scheduleDeviceSessionRetire(home, { initialDelayMs: 1, retryDelayMs: 1, log: (line) => lines.push(line) });
      const outcomes = await schedule.done;
      assert.deepEqual(outcomes, [{ reason: "session_token_rejected", deleted: true, keysTried: 1, httpStatus: 401 }]);
      assert.equal(server.seen.length, 1, "the token is the problem: no other key, no retry");
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /device session retire: session_token_rejected .*user-session\.json deleted/);
      assert.equal(await exists(sessionFile(home)), false);
      assert.equal(await exists(join(home, "computer", "servers", SERVER_A, "runner.state.json")), true, "machine keys stay");
    });
  } finally {
    await server.close();
  }
});

test("schedule: the retry is the last attempt, and the start's last outcome is reported once", async () => {
  const seenLast: Array<boolean | undefined> = [];
  const reports: DeviceSessionRetireReport[] = [];
  const schedule = scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 1,
    retryDelayMs: 1,
    log: () => {},
    report: async (r) => { reports.push(r); },
    attemptFn: async (_home, deps) => {
      seenLast.push(deps?.lastAttempt);
      return seenLast.length === 1
        ? { reason: "network_error", deleted: false, keysTried: 1 }
        : { reason: "network_error", deleted: true, keysTried: 1 };
    },
  });
  await schedule.done;
  assert.deepEqual(seenLast, [false, true]);
  assert.deepEqual(reports, [{ reason: "network_error", deleted: true, keysTried: 1, attempt: 2 }]);

  const none: DeviceSessionRetireReport[] = [];
  await scheduleDeviceSessionRetire("/nonexistent", {
    initialDelayMs: 1,
    log: () => {},
    report: async (r) => { none.push(r); },
    attemptFn: async () => ({ reason: "no_session", deleted: false, keysTried: 0 }),
  }).done;
  assert.deepEqual(none, [], "nothing to report when there was no session");
});

test("the report file: codes and counts only, claimed once (the first runner takes it)", async () => {
  const server = await startFakeServer(withLogout(retireEndpoint("sk_computer_none")));
  try {
    await withHome(async (home) => {
      await writeSession(home, server.url, FRESH_TOKEN);
      await writeAttachment(home, SERVER_A, server.url, KEY_A);
      await scheduleDeviceSessionRetire(home, { initialDelayMs: 1, log: () => {} }).done;
      const raw = await readFile(deviceSessionRetireReportPath(home), "utf8");
      for (const secret of [FRESH_TOKEN, REFRESH_TOKEN, KEY_A, server.url, "user-1"]) {
        assert.equal(raw.includes(secret), false, "no secret, id or URL in the report");
      }
      const [first, second] = await Promise.all([claimDeviceSessionRetireReport(home), claimDeviceSessionRetireReport(home)]);
      const claimed = [first, second].filter((r) => r !== null);
      assert.deepEqual(claimed, [{ reason: "no_matching_key", deleted: true, keysTried: 1, attempt: 1, httpStatus: 403, logout: "ok" }]);
      assert.equal(await claimDeviceSessionRetireReport(home), null);
      assert.equal(await exists(deviceSessionRetireReportPath(home)), false);
    });
  } finally {
    await server.close();
  }
});
