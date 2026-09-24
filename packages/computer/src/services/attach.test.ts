// Byte-pin tests for the AttachService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d/35034229 Attach byte-pin gates 1-10 + onEvent +
// AbortSignal + secret-free invariant).
//
// Companion: ../attach.test.ts asserts the CLI adapter still emits the
// pre-extraction info()/fail() lines byte-identically.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ComputerServiceError } from "./errors.js";
import { attach } from "./attach.js";
import type { ComputerApiEvent } from "../lib/events.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

function jwtExp(offsetSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offsetSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function withHome<T>(fn: (home: string) => Promise<T>, opts: { writeSession?: boolean; sessionOverride?: unknown } = {}): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-attach-svc-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    if (opts.writeSession !== false) {
      await mkdir(join(home, "computer"), { recursive: true });
      await writeFile(
        join(home, "computer", "user-session.json"),
        opts.sessionOverride !== undefined
          ? typeof opts.sessionOverride === "string"
            ? opts.sessionOverride
            : JSON.stringify(opts.sessionOverride)
          : JSON.stringify({
              kind: "user-session",
              userId: "user-1",
              accessToken: "user-token",
              serverUrl: "",
            }),
      );
    }
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeLocalAttachment(home: string, serverUrl: string): Promise<void> {
  const dir = join(home, "computer", "servers", SERVER_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "runner.state.json"),
    JSON.stringify({
      kind: "computer-attachment",
      serverId: SERVER_ID,
      serverSlug: "alpha",
      serverMachineId: "cm-existing",
      machineId: "machine-existing",
      apiKey: "sk_computer_existing1234567890abcdef",
      serverUrl,
      attachedAt: "2026-07-02T00:00:00.000Z",
    }),
  );
}

interface AttachServerOptions {
  attach?: { status: number; body: unknown };
  preflight?: { status: number; body: unknown };
  refresh?: { status: number; body: unknown };
  attachConn?: "destroy";
}

async function startAttachServer(opts: AttachServerOptions): Promise<{ server: Server; baseUrl: string; seenAttachNames: () => string[]; seenPreflightApiKeys: () => string[]; seenAttachAuth: () => string[]; seenRefreshTokens: () => string[] }> {
  const seenAttachNames: string[] = [];
  const seenPreflightApiKeys: string[] = [];
  const seenAttachAuth: string[] = [];
  const seenRefreshTokens: string[] = [];
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/api/auth/refresh") {
          const body = await readBody(req);
          seenRefreshTokens.push(String(body.refreshToken ?? ""));
          const refresh = opts.refresh ?? {
            status: 401,
            body: { code: "refresh_unavailable" },
          };
          res.writeHead(refresh.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(refresh.body));
          return;
        }
        if (req.method === "POST" && req.url === "/api/computer/attach") {
          if (opts.attachConn === "destroy") {
            req.socket.destroy();
            return;
          }
          const body = await readBody(req);
          seenAttachNames.push(String(body.name ?? ""));
          seenAttachAuth.push(String(req.headers.authorization ?? ""));
          const a = opts.attach ?? {
            status: 201,
            body: {
              apiKey: "sk_computer_test1234567890abcdef",
              serverMachineId: "cm-test",
              serverId: SERVER_ID,
              serverSlug: "alpha",
              resumed: false,
            },
          };
          res.writeHead(a.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(a.body));
          return;
        }
        if (req.method === "POST" && req.url === "/internal/computer/preflight") {
          const body = await readBody(req);
          // preflight uses bearer auth; capture via header instead.
          const auth = req.headers.authorization ?? "";
          seenPreflightApiKeys.push(auth.replace(/^Bearer\s+/, ""));
          void body;
          const p = opts.preflight ?? { status: 200, body: { ok: true, serverSlug: "alpha" } };
          res.writeHead(p.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(p.body));
          return;
        }
        res.writeHead(404).end();
      })().catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no test server address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    seenAttachNames: () => seenAttachNames,
    seenPreflightApiKeys: () => seenPreflightApiKeys,
    seenAttachAuth: () => seenAttachAuth,
    seenRefreshTokens: () => seenRefreshTokens,
  };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

// --- Gate 1: happy path emits attaching + preflight + attached, persists attachment ---
test("attach service: happy path emits attaching + preflight + attached, writes runner.state.json (0600)", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({});
    const events: ComputerApiEvent[] = [];
    try {
      const result = await attach(
        { serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home },
        { onEvent: (e) => events.push(e) },
      );
      assert.equal(result.serverId, SERVER_ID);
      assert.equal(result.serverMachineId, "cm-test");
      assert.equal(result.serverSlug, "alpha");
      assert.equal(result.serverUrl, ctx.baseUrl);
      assert.equal(result.resumed, false);
      assert.equal(result.apiKeyRedactedPrefix, "sk_compu");
      assert.ok(result.attachmentPath.startsWith(home));

      const persisted = JSON.parse(
        await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(persisted.kind, "computer-attachment");
      assert.equal(persisted.serverId, SERVER_ID);
      assert.equal(persisted.serverSlug, "alpha");
      assert.equal(persisted.apiKey, "sk_computer_test1234567890abcdef");
      assert.equal(persisted.serverUrl, ctx.baseUrl);
    } finally {
      await stop(ctx.server);
    }

    // attaching event
    const attaching = events.find((e) => e.kind === "attach.attaching");
    assert.ok(attaching && attaching.kind === "attach.attaching");
    assert.equal(attaching.serverSlug, "alpha");
    // preflight event
    const preflight = events.find((e) => e.kind === "attach.preflight");
    assert.ok(preflight && preflight.kind === "attach.preflight");
    assert.equal(preflight.resumed, false);
    // attached event — secret-free, only apiKeyRedactedPrefix.
    const attached = events.find((e) => e.kind === "attach.attached");
    assert.ok(attached && attached.kind === "attach.attached");
    assert.equal(attached.serverId, SERVER_ID);
    assert.equal(attached.serverMachineId, "cm-test");
    assert.equal(attached.serverSlug, "alpha");
    assert.equal(attached.resumed, false);
    assert.equal(attached.apiKeyRedactedPrefix, "sk_compu");
    // §7 redaction invariant: raw apiKey MUST NOT appear on the event.
    assert.equal((attached as Record<string, unknown>).apiKey, undefined);
  });
});

test("attach service: existing local attachment is idempotent and does not call server attach by name", async () => {
  await withHome(
    async (home) => {
      const ctx = await startAttachServer({});
      const events: ComputerApiEvent[] = [];
      try {
        await writeLocalAttachment(home, ctx.baseUrl);
        const result = await attach(
          { serverSlug: "/alpha", serverUrl: ctx.baseUrl, name: "Ignored Display Name", slockHome: home },
          { onEvent: (e) => events.push(e) },
        );
        assert.equal(result.serverId, SERVER_ID);
        assert.equal(result.serverMachineId, "cm-existing");
        assert.equal(result.machineId, "machine-existing");
        assert.equal(result.resumed, true);
        assert.deepEqual(ctx.seenAttachNames(), [], "local idempotency must not call /api/computer/attach");
        assert.deepEqual(ctx.seenPreflightApiKeys(), ["sk_computer_existing1234567890abcdef"]);
      } finally {
        await stop(ctx.server);
      }

      const preflight = events.find((e) => e.kind === "attach.preflight");
      assert.ok(preflight && preflight.kind === "attach.preflight");
      assert.equal(preflight.resumed, true);
      const attached = events.find((e) => e.kind === "attach.attached");
      assert.ok(attached && attached.kind === "attach.attached");
      assert.equal(attached.resumed, true);
    },
    { writeSession: false },
  );
});

test("attach service: existing local attachment with revoked key fails closed instead of fresh-attaching", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      preflight: { status: 401, body: { code: "computer_key_revoked" } },
    });
    try {
      await writeLocalAttachment(home, ctx.baseUrl);
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, name: "New Name", slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "PREFLIGHT_FAILED");
          assert.match((err as ComputerServiceError).message, /not creating a fresh attachment/);
          assert.match((err as ComputerServiceError).message, /recover\/rebind/);
          return true;
        },
      );
      assert.deepEqual(ctx.seenAttachNames(), [], "revoked local proof must not fall through to name-based attach");
      assert.match(
        await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
        /sk_computer_existing/,
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

test("attach service: existing local attachment with unreachable preflight asks user to retry", async () => {
  await withHome(async (home) => {
    await writeLocalAttachment(home, "http://127.0.0.1:1");
    await assert.rejects(
      () => attach({ serverSlug: "/alpha", serverUrl: "http://127.0.0.1:1", name: "New Name", slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "PREFLIGHT_FAILED");
        assert.match((err as ComputerServiceError).message, /failed preflight \(request_failed\)/);
        assert.match((err as ComputerServiceError).message, /Network or server may be unavailable/);
        assert.match((err as ComputerServiceError).message, /Retry later/);
        assert.doesNotMatch((err as ComputerServiceError).message, /recover\/rebind/);
        assert.doesNotMatch((err as ComputerServiceError).message, /remove local state/);
        return true;
      },
    );
    assert.match(
      await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
      /sk_computer_existing/,
    );
  });
});

test("attach service: same slug with explicit different serverUrl fails closed instead of name-binding", async () => {
  await withHome(async (home) => {
    await writeLocalAttachment(home, "https://api.one.example.test");
    await assert.rejects(
      () => attach({ serverSlug: "/alpha", serverUrl: "https://api.two.example.test", name: "New Name", slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "ATTACH_FAILED");
        assert.match((err as ComputerServiceError).message, /refusing to use display name or slug to bind identity/);
        assert.match((err as ComputerServiceError).message, /raft-computer setup \/alpha/);
        assert.doesNotMatch((err as ComputerServiceError).message, /remove local state/);
        return true;
      },
    );
  });
});

test("attach service: expired user session silently refreshes before attach", async () => {
  await withHome(
    async (home) => {
      const ctx = await startAttachServer({
        refresh: {
          status: 200,
          body: { accessToken: "fresh-user-token", refreshToken: "fresh-refresh-token" },
        },
      });
      try {
        const result = await attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home });
        assert.equal(result.serverId, SERVER_ID);
        assert.deepEqual(ctx.seenRefreshTokens(), ["old-refresh-token"]);
        assert.deepEqual(ctx.seenAttachAuth(), ["Bearer fresh-user-token"]);
        const refreshed = JSON.parse(
          await readFile(join(home, "computer", "user-session.json"), "utf8"),
        ) as Record<string, unknown>;
        assert.equal(refreshed.accessToken, "fresh-user-token");
        assert.equal(refreshed.refreshToken, "fresh-refresh-token");
        assert.equal(refreshed.name, "Cindy");
      } finally {
        await stop(ctx.server);
      }
    },
    {
      sessionOverride: {
        kind: "user-session",
        userId: "user-1",
        accessToken: jwtExp(-60),
        refreshToken: "old-refresh-token",
        serverUrl: "",
        name: "Cindy",
      },
    },
  );
});

// --- Gate 2: NO_USER_SESSION (file missing) ---
test("attach service: missing user session throws NO_USER_SESSION", async () => {
  await withHome(
    async (home) => {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: "http://127.0.0.1:1", slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "NO_USER_SESSION");
          assert.match((err as ComputerServiceError).message, /No user session at .+\. Run `raft-computer login` first\./);
          return true;
        },
      );
    },
    { writeSession: false },
  );
});

// --- Gate 3: INVALID_USER_SESSION (file present but malformed) ---
test("attach service: invalid user session shape throws INVALID_USER_SESSION", async () => {
  await withHome(
    async (home) => {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: "http://127.0.0.1:1", slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "INVALID_USER_SESSION");
          assert.match((err as ComputerServiceError).message, /User session at .+ is invalid\. Re-run `raft-computer login`\./);
          return true;
        },
      );
    },
    { sessionOverride: { kind: "garbage", accessToken: "" } },
  );
});

// --- Gate 4: ATTACH_NOT_AUTHORIZED for empty slug AND for server 403 ---
test("attach service: empty server slug throws ATTACH_NOT_AUTHORIZED", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => attach({ serverSlug: "", serverUrl: "http://127.0.0.1:1", slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "ATTACH_NOT_AUTHORIZED");
        assert.equal((err as ComputerServiceError).message, "Server slug must not be empty.");
        return true;
      },
    );
  });
});

test("attach service: 403 from server throws ATTACH_NOT_AUTHORIZED", async () => {
  await withHome(
    async (home) => {
      const ctx = await startAttachServer({
        attach: { status: 403, body: { code: "not_authorized" } },
      });
      try {
        await assert.rejects(
          () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
          (err: unknown) => {
            assert.ok(err instanceof ComputerServiceError);
            assert.equal((err as ComputerServiceError).code, "ATTACH_NOT_AUTHORIZED");
            assert.match((err as ComputerServiceError).message, /Server \/alpha is not available to the account/);
            assert.match((err as ComputerServiceError).message, /\(@cindy\)/);
            assert.match((err as ComputerServiceError).message, /SLOCK_HOME=.*raft-computer login/);
            assert.match((err as ComputerServiceError).message, /SLOCK_HOME=.*raft-computer setup '\/alpha'/);
            assert.match((err as ComputerServiceError).message, /https:\/\/app\.raft\.build\/s\/alpha\//);
            assert.doesNotMatch((err as ComputerServiceError).message, /cindy@example\.io|raft-computer logout/);
            return true;
          },
        );
      } finally {
        await stop(ctx.server);
      }
    },
    {
      sessionOverride: {
        kind: "user-session",
        userId: "user-1",
        accessToken: "user-token",
        serverUrl: "",
        email: "cindy@example.io",
        name: "cindy",
        displayName: "Cindy",
      },
    },
  );
});

// Role gate (#wg-raft-computer 2026-06-05): server returns 403 with code
// `requires_admin` for a member who lacks the manageMachines capability —
// distinct from `not_authorized` so the caller renders "ask an admin", not a
// misleading "you're not a member".
test("attach service: 403 requires_admin throws ATTACH_REQUIRES_ADMIN, not ATTACH_NOT_AUTHORIZED", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 403, body: { code: "requires_admin" } },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ATTACH_REQUIRES_ADMIN");
          assert.match((err as ComputerServiceError).message, /requires the admin or owner role/);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 5: ATTACH_DISABLED (404 with no code / disabled code) ---
test("attach service: 404 plain throws ATTACH_DISABLED", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 404, body: {} },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ATTACH_DISABLED");
          assert.match((err as ComputerServiceError).message, /Computer attach is not enabled on this server/);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 6: ATTACH_SERVER_NOT_FOUND (404 with not_authorized / server_not_found code) ---
test("attach service: 404 with server_not_found code throws ATTACH_SERVER_NOT_FOUND", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 404, body: { code: "server_not_found" } },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/missing-server", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ATTACH_SERVER_NOT_FOUND");
          assert.match((err as ComputerServiceError).message, /Server \/missing-server was not found on/);
          assert.match((err as ComputerServiceError).message, /Check the slug spelling and --server-url, then retry\./);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 7: USER_SESSION_EXPIRED (401 session_invalid) ---
test("attach service: 401 session_invalid throws USER_SESSION_EXPIRED", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 401, body: {} },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "USER_SESSION_EXPIRED");
          assert.equal(
            (err as ComputerServiceError).message,
            "Your user session is no longer valid. Re-run `raft-computer login`.",
          );
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 8: ATTACH_REQUEST_FAILED (network drop) ---
test("attach service: connection drop throws ATTACH_REQUEST_FAILED", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({ attachConn: "destroy" });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ATTACH_REQUEST_FAILED");
          assert.match((err as ComputerServiceError).message, /Could not reach .+ while attaching to \/alpha\./);
          assert.match((err as ComputerServiceError).message, /Check --server-url \/ network connectivity, then retry\./);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 9: COMPUTER_NAME_COLLISION (server returns the explicit code) ---
test("attach service: COMPUTER_NAME_COLLISION error code is preserved byte-identical", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 409, body: { code: "COMPUTER_NAME_COLLISION" } },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, name: "Bench Rig", slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "COMPUTER_NAME_COLLISION");
          assert.equal(
            (err as ComputerServiceError).message,
            'A Computer named "Bench Rig" already exists on that server. Run `raft-computer attach /alpha --name <uniqueName>`.',
          );
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 10: ATTACH_FAILED (generic unrecognized server error) ---
test("attach service: generic server error throws ATTACH_FAILED carrying the code", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      attach: { status: 500, body: { code: "internal_attach_error" } },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ATTACH_FAILED");
          assert.match((err as ComputerServiceError).message, /Attach failed \(internal_attach_error\)\./);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 11: PREFLIGHT_FAILED leaves zero local-state residue (fail-closed) ---
test("attach service: preflight failure throws PREFLIGHT_FAILED + ZERO local-state residue", async () => {
  await withHome(async (home) => {
    const ctx = await startAttachServer({
      preflight: { status: 200, body: { ok: false, code: "schema_mismatch" } },
    });
    try {
      await assert.rejects(
        () => attach({ serverSlug: "/alpha", serverUrl: ctx.baseUrl, slockHome: home }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "PREFLIGHT_FAILED");
          assert.match((err as ComputerServiceError).message, /Server preflight failed \(schema_mismatch\)\./);
          assert.match((err as ComputerServiceError).message, /nothing was written locally/);
          return true;
        },
      );
      // Fail-closed invariant: runner.state.json MUST NOT exist after preflight failure.
      await assert.rejects(
        () => readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 12: AbortSignal cancels before the network call ---
test("attach service: pre-aborted AbortSignal throws AbortError, not ComputerServiceError", async () => {
  await withHome(async (home) => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => attach({ serverSlug: "/alpha", serverUrl: "http://127.0.0.1:1", slockHome: home }, { signal: ac.signal }),
      (err: unknown) => {
        // Abort must NOT be reported as a §6/§9 closed-set attach failure —
        // it's a client-driven cancellation, not a contract code.
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
  });
});
