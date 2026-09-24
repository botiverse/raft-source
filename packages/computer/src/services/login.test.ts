// Byte-pin tests for the LoginService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d Login byte-pin gates 1-4 + onEvent + AbortSignal).
//
// Companion: ../login.test.ts asserts the CLI adapter still emits the
// pre-extraction info()/fail() lines byte-identically.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ComputerServiceError } from "./errors.js";
import { login } from "./login.js";
import type { ComputerApiEvent } from "../lib/events.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-login-svc-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

async function withProxyEnv<T>(env: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const old = new Map<(typeof PROXY_ENV_KEYS)[number], string | undefined>();
  for (const key of PROXY_ENV_KEYS) {
    old.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key as (typeof PROXY_ENV_KEYS)[number]] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface DeviceServerOptions {
  authorize?: { status: number; body: unknown };
  token?: Array<{ status: number; body: unknown }>;
  /** GET /api/auth/me response for the login-time identity enrichment (#112). */
  meStatus?: number;
  meBody?: unknown;
}

async function startDeviceServer(opts: DeviceServerOptions): Promise<{ server: Server; baseUrl: string; tokenCalls: () => number }> {
  let tokenIdx = 0;
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/device/authorize") {
        const a = opts.authorize ?? {
          status: 201,
          body: {
            deviceCode: "dvc_test",
            userCode: "ABCD-1234",
            verificationUri: "/login/device",
            verificationUriComplete: "/login/device?user_code=ABCD-1234",
            expiresIn: 30,
            interval: 1,
          },
        };
        res.statusCode = a.status;
        res.end(JSON.stringify(a.body));
        return;
      }
      if (req.url === "/api/auth/device/token") {
        const seq = opts.token ?? [
          { status: 200, body: { accessToken: "access", refreshToken: "refresh", userId: "user-1" } },
        ];
        const next = seq[Math.min(tokenIdx, seq.length - 1)];
        tokenIdx += 1;
        res.statusCode = next.status;
        res.end(JSON.stringify(next.body));
        return;
      }
      if (req.url === "/api/auth/me") {
        // task #112: login enriches the session with the user's display
        // identity via GET /api/auth/me. `meStatus`/`meBody` let a test omit
        // or fail this without failing login (best-effort enrichment).
        const status = opts.meStatus ?? 200;
        const body = opts.meBody ?? { id: "user-1", email: "user1@example.io", name: "user one", displayName: "User One" };
        res.statusCode = status;
        res.end(JSON.stringify(body));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no test server address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    tokenCalls: () => tokenIdx,
  };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

// --- Gate 1: happy path emits device-code + approved, persists session ---
test("login service: happy path emits device-code + approved, writes user-session.json", async () => {
  await withHome(async (home) => {
    const ctx = await startDeviceServer({});
    const events: ComputerApiEvent[] = [];
    try {
      const result = await login(
        { serverUrl: ctx.baseUrl, slockHome: home },
        { onEvent: (e) => events.push(e) },
      );
      assert.equal(result.userId, "user-1");
      assert.ok(result.sessionPath.startsWith(home));
      const persisted = JSON.parse(await readFile(result.sessionPath, "utf8"));
      assert.equal(persisted.kind, "user-session");
      assert.equal(persisted.userId, "user-1");
      assert.equal(persisted.accessToken, "access");
      assert.equal(persisted.serverUrl, ctx.baseUrl);
      // task #112: login enriched the session from GET /api/auth/me.
      assert.equal(persisted.displayName, "User One");
      assert.equal(persisted.name, "user one");
      assert.equal(persisted.email, "user1@example.io");
    } finally {
      await stop(ctx.server);
    }
    const deviceCode = events.find((e) => e.kind === "login.device-code");
    assert.ok(deviceCode && deviceCode.kind === "login.device-code");
    assert.equal(deviceCode.userCode, "ABCD-1234");
    assert.match(deviceCode.verifyUrl, /\/login\/device\?user_code=ABCD-1234$/);
    // expiresAt is ISO not seconds (Hao msg=51a17400 byte-pin).
    assert.match(deviceCode.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(deviceCode.expiresInSeconds, 30);
    const approved = events.find((e) => e.kind === "login.approved");
    assert.ok(approved && approved.kind === "login.approved");
    assert.equal(approved.userId, "user-1");
  });
});

// --- task #112: identity enrichment is BEST-EFFORT — a /me failure must NOT
// fail an otherwise-successful login; the session just lacks the display
// fields and presenters fall back to the userId. ---
test("login service: /me failure → login still succeeds, session has no display identity", async () => {
  await withHome(async (home) => {
    const ctx = await startDeviceServer({ meStatus: 500, meBody: { error: "boom" } });
    try {
      const result = await login({ serverUrl: ctx.baseUrl, slockHome: home });
      assert.equal(result.userId, "user-1");
      const persisted = JSON.parse(await readFile(result.sessionPath, "utf8"));
      assert.equal(persisted.userId, "user-1", "login persisted despite /me failure");
      assert.equal(persisted.displayName, undefined, "no display fields when /me failed");
      assert.equal(persisted.email, undefined);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 2: DEVICE_AUTHORIZE_FAILED (transport / server) ---
test("login service: device-authorize transport failure throws DEVICE_AUTHORIZE_FAILED with cause + actionable hint", async () => {
  await withHome(async (home) => {
    const baseUrl = "http://127.0.0.1:1"; // port 1 — guaranteed unreachable
    await assert.rejects(
      () => login({ serverUrl: baseUrl, slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "DEVICE_AUTHORIZE_FAILED");
        assert.match((err as ComputerServiceError).message, /Could not start device login at http:\/\/127\.0\.0\.1:1: .+\. Check that the server URL is correct and reachable\./);
        assert.notEqual((err as ComputerServiceError).cause, undefined);
        return true;
      },
    );
  });
});

test("login service: device-authorize honors HTTP_PROXY instead of going direct", async () => {
  await withProxyEnv({ HTTP_PROXY: "http://127.0.0.1:1" }, async () => {
    await withHome(async (home) => {
      const ctx = await startDeviceServer({});
      try {
        await assert.rejects(
          () => login({ serverUrl: ctx.baseUrl, slockHome: home }),
          (err: unknown) => {
            assert.ok(err instanceof ComputerServiceError);
            assert.equal((err as ComputerServiceError).code, "DEVICE_AUTHORIZE_FAILED");
            assert.match((err as ComputerServiceError).message, /Could not start device login at/);
            assert.equal(ctx.tokenCalls(), 0, "authorize never reached the direct origin");
            return true;
          },
        );
      } finally {
        await stop(ctx.server);
      }
    });
  });
});

test("login service: device-authorize honors NO_PROXY bypass for local server", async () => {
  await withProxyEnv({ HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" }, async () => {
    await withHome(async (home) => {
      const ctx = await startDeviceServer({});
      try {
        const result = await login({ serverUrl: ctx.baseUrl, slockHome: home });
        assert.equal(result.userId, "user-1");
        assert.equal(ctx.tokenCalls(), 1, "direct origin path was used after NO_PROXY bypass");
      } finally {
        await stop(ctx.server);
      }
    });
  });
});

// --- Gate 3: LOGIN_DENIED (server returned access_denied) ---
test("login service: token poll → access_denied throws LOGIN_DENIED", async () => {
  await withHome(async (home) => {
    const ctx = await startDeviceServer({
      token: [{ status: 400, body: { code: "access_denied" } }],
    });
    try {
      await assert.rejects(
        () => login({ serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LOGIN_DENIED");
          assert.equal((err as ComputerServiceError).message, "Login was denied in the approval page.");
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 4: LOGIN_EXPIRED (server returned expired_token) ---
test("login service: token poll → expired_token throws LOGIN_EXPIRED", async () => {
  await withHome(async (home) => {
    const ctx = await startDeviceServer({
      token: [{ status: 400, body: { code: "expired_token" } }],
    });
    try {
      await assert.rejects(
        () => login({ serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LOGIN_EXPIRED");
          assert.equal((err as ComputerServiceError).message, "Login request expired before approval. Re-run `raft-computer login`.");
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 5: LOGIN_FAILED (server returned an unrecognized error code) ---
test("login service: token poll → unrecognized server code throws LOGIN_FAILED carrying the code", async () => {
  await withHome(async (home) => {
    const ctx = await startDeviceServer({
      token: [{ status: 500, body: { code: "internal_oauth_error" } }],
    });
    try {
      await assert.rejects(
        () => login({ serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LOGIN_FAILED");
          assert.match((err as ComputerServiceError).message, /Login failed \(internal_oauth_error\)\./);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 6: AbortSignal cancels the polling loop deterministically ---
test("login service: AbortSignal aborts the polling loop without throwing ComputerServiceError", async () => {
  await withHome(async (home) => {
    // Authorize OK, but token endpoint stays "pending" forever — service
    // must wait between polls and observe the abort signal.
    const ctx = await startDeviceServer({
      token: [{ status: 400, body: { code: "authorization_pending" } }],
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    try {
      await assert.rejects(
        () => login({ serverUrl: ctx.baseUrl, slockHome: home }, { signal: ac.signal }),
        (err: unknown) => {
          // Abort must NOT be reported as a §6 closed-set login failure —
          // it's a client-driven cancellation, not a contract code.
          assert.ok(!(err instanceof ComputerServiceError));
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});
