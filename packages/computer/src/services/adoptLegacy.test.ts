// Byte-pin tests for the AdoptLegacyService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d / 35034229 / 240069cd AdoptLegacy byte-pin gates +
// onEvent + AbortSignal + secret-free invariant + closed-set sentinel pin).
//
// Companion: ../adopt.test.ts asserts the CLI adapter's resolveLegacyKey
// (4-channel exactly-one-source) + info()/fail() lines stay byte-identical.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";

import { ComputerServiceError } from "./errors.js";
import {
  adoptLegacy,
  adoptLegacyByDaemonId,
  adoptLegacyByFingerprint,
  type AdoptLegacyEvent,
  appendAdoptionLog,
  legacyLockOwnerPath,
} from "./adoptLegacy.js";
import { adoptionLogPath } from "../paths.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function withHome<T>(
  fn: (home: string) => Promise<T>,
  opts: { writeSession?: boolean; sessionOverride?: unknown } = {},
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-adopt-svc-"));
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

interface AdoptServerOptions {
  adopt?: { status: number; body: unknown };
  /** Queue of adopt responses consumed in order (takes precedence over
   *  `adopt` when non-empty) — lets a test serve auth_required first,
   *  success second (PR-A2 refresh-retry). */
  adoptQueue?: Array<{ status: number; body: unknown }>;
  /** Response for POST /api/auth/refresh (default 404). */
  refresh?: { status: number; body: unknown };
  preflight?: { status: number; body: unknown };
  adoptConn?: "destroy";
  onAdopt?: (body: { legacyApiKey?: string; name?: string }) => void;
}

async function startAdoptServer(
  opts: AdoptServerOptions,
): Promise<{ server: Server; baseUrl: string; seenAdoptKeys: () => string[]; seenPreflightApiKeys: () => string[]; refreshCallCount: () => number }> {
  const seenAdoptKeys: string[] = [];
  const seenPreflightApiKeys: string[] = [];
  const refreshCalls: number[] = [];
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/api/computer/adopt-legacy") {
          if (opts.adoptConn === "destroy") {
            req.socket.destroy();
            return;
          }
          const body = (await readBody(req)) as { legacyApiKey?: string; name?: string };
          seenAdoptKeys.push(String(body.legacyApiKey ?? ""));
          opts.onAdopt?.(body);
          const queued = opts.adoptQueue?.shift();
          if (queued) {
            res.writeHead(queued.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(queued.body));
            return;
          }
          const a = opts.adopt ?? {
            status: 201,
            body: {
              apiKey: "sk_computer_test1234567890abcdef",
              computerId: "cmp-1",
              machineId: "mch-1",
              serverId: SERVER_ID,
              resumed: false,
            },
          };
          res.writeHead(a.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(a.body));
          return;
        }
        if (req.method === "POST" && req.url === "/api/auth/refresh") {
          await readBody(req);
          refreshCalls.push(1);
          const r = opts.refresh ?? { status: 404, body: { error: "not handled" } };
          res.writeHead(r.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        if (req.method === "POST" && req.url === "/internal/computer/preflight") {
          const auth = req.headers.authorization ?? "";
          seenPreflightApiKeys.push(auth.replace(/^Bearer\s+/, ""));
          await readBody(req);
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
    seenAdoptKeys: () => seenAdoptKeys,
    seenPreflightApiKeys: () => seenPreflightApiKeys,
    refreshCallCount: () => refreshCalls.length,
  };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function seedLegacyOwnerFile(home: string, rawKey: string, contents: string): Promise<string> {
  const fp = createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
  const dir = join(home, "machines", `machine-${fp}`, "daemon.lock");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "owner.json");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function spawnLegacyDaemonProbe(markerPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {
          fs.writeFileSync(${JSON.stringify(markerPath)}, "signaled");
          setTimeout(() => process.exit(0), 500);
        });
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("legacy probe did not become ready")), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("legacy probe exited before ready"));
    });
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return child;
}

const LEGACY_KEY = `sk_machine_${"a".repeat(64)}`;
const LEGACY_PREFIX = LEGACY_KEY.slice(0, 8);

// --- Gate 1: happy path emits adopting + preflight + adopted; writes
// runner.state.json (0600) with adoptedFromLegacy flag; appends adoption.log
// success line; service event/result are SECRET-FREE (no raw fresh key,
// no raw legacy key). ---
test("adoptLegacy service: happy path emits adopting + preflight + adopted, writes runner.state.json (0600), appends adoption.log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({});
    const events: AdoptLegacyEvent[] = [];
    try {
      const result = await adoptLegacy(
        {
          serverSlug: "/legacy",
          serverUrl: ctx.baseUrl,
          rawKey: LEGACY_KEY,
          mode: "legacy_key_argv",
          redactedPrefix: LEGACY_PREFIX,
        },
        { onEvent: (e) => events.push(e) },
      );
      assert.equal(result.serverId, SERVER_ID);
      assert.equal(result.serverMachineId, "cmp-1");
      assert.equal(result.legacyMachineId, "mch-1");
      // serverSlug is normalized (leading "/" stripped) — byte-identical to
      // the pre-extraction adopt.ts write of slugForServer to the per-server
      // state file (`attachment.json` pre-v9, `runner.state.json` per §8.4).
      assert.equal(result.serverSlug, "legacy");
      assert.equal(result.serverUrl, ctx.baseUrl);
      assert.equal(result.resumed, false);
      assert.equal(result.apiKeyRedactedPrefix, "sk_compu");
      assert.ok(result.attachmentPath.startsWith(home));
      assert.equal(result.legacyStop.outcome, "absent");

      const persisted = JSON.parse(
        await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(persisted.kind, "computer-attachment");
      assert.equal(persisted.serverId, SERVER_ID);
      assert.equal(persisted.serverSlug, "legacy");
      assert.equal(persisted.apiKey, "sk_computer_test1234567890abcdef");
      assert.equal(persisted.adoptedFromLegacy, true);
      assert.equal(persisted.legacyMachineId, "mch-1");
      assert.equal(
        persisted.legacyApiKeyFingerprint,
        createHash("sha256").update(LEGACY_KEY).digest("hex").slice(0, 16),
      );
      assert.equal(persisted.serverUrl, ctx.baseUrl);
      // Raw legacy key MUST NOT appear in runner.state.json — only the freshly
      // minted sk_computer_*.
      assert.equal(JSON.stringify(persisted).includes(LEGACY_KEY), false);

      if (process.platform !== "win32") {
        const st = await stat(join(home, "computer", "servers", SERVER_ID, "runner.state.json"));
        assert.equal(st.mode & 0o077, 0);
      }

      // adoption.log appended with success line + only the redacted prefix.
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=succeeded/);
      assert.match(logText, /credential_bridge_mode=legacy_key_argv/);
      assert.match(logText, new RegExp(`legacy_key_prefix=${LEGACY_PREFIX}`));
      assert.match(logText, /computer_id=cmp-1/);
      assert.match(logText, /legacy_machine_id=mch-1/);
      assert.match(logText, new RegExp(`server_id=${SERVER_ID}`));
      assert.match(logText, /legacy_stop_outcome=absent/);
      assert.equal(logText.includes(LEGACY_KEY), false);

      // Server received the raw legacy key on the adopt POST.
      assert.equal(ctx.seenAdoptKeys()[0], LEGACY_KEY);
    } finally {
      await stop(ctx.server);
    }

    // adopting event
    const adopting = events.find((e) => e.type === "adopting");
    assert.ok(adopting && adopting.type === "adopting");
    assert.equal(adopting.serverSlug, "legacy");
    assert.equal(adopting.mode, "legacy_key_argv");
    // preflight event
    const preflight = events.find((e) => e.type === "preflight");
    assert.ok(preflight && preflight.type === "preflight");
    assert.equal(preflight.resumed, false);
    // adopted event — secret-free, only apiKeyRedactedPrefix.
    const adopted = events.find((e) => e.type === "adopted");
    assert.ok(adopted && adopted.type === "adopted");
    assert.equal(adopted.serverId, SERVER_ID);
    assert.equal(adopted.serverMachineId, "cmp-1");
    assert.equal(adopted.legacyMachineId, "mch-1");
    assert.equal(adopted.serverSlug, "legacy");
    assert.equal(adopted.resumed, false);
    assert.equal(adopted.apiKeyRedactedPrefix, "sk_compu");
    // §7 redaction invariant: raw apiKey + raw legacy key MUST NOT appear on
    // the event.
    const adoptedJson = JSON.stringify(adopted);
    assert.equal(adoptedJson.includes("sk_computer_test1234567890abcdef"), false);
    assert.equal(adoptedJson.includes(LEGACY_KEY), false);
  });
});

test("adoptLegacy service: live legacy daemon stops before runner.state.json is written", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({});
    const markerPath = join(home, "legacy-stop-signaled.txt");
    const child = await spawnLegacyDaemonProbe(markerPath);
    try {
      await seedLegacyOwnerFile(home, LEGACY_KEY, JSON.stringify({ pid: child.pid }));
      const statePath = join(home, "computer", "servers", SERVER_ID, "runner.state.json");
      const adoption = adoptLegacy({
        serverSlug: "/legacy",
        serverUrl: ctx.baseUrl,
        rawKey: LEGACY_KEY,
        mode: "legacy_key_argv",
        redactedPrefix: LEGACY_PREFIX,
      });

      await waitForFile(markerPath);
      await assert.rejects(
        () => readFile(statePath, "utf8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
        "runner.state.json must not be written while the legacy daemon is still exiting",
      );

      const result = await adoption;
      assert.equal(result.legacyStop.outcome, "stopped");

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.kind, "computer-attachment");
      assert.equal(persisted.adoptedFromLegacy, true);

      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=succeeded/);
      assert.match(logText, /legacy_stop_outcome=stopped/);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      await stop(ctx.server);
    }
  });
});

test("adoptLegacy service: fingerprint selector network failure throws ADOPT_NETWORK_FAILED with serverUrl and retry guidance", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({ adoptConn: "destroy" });
    const ownerPath = await seedLegacyOwnerFile(home, LEGACY_KEY, JSON.stringify({ pid: 999_999_999 }));
    try {
      await assert.rejects(
        () =>
          adoptLegacyByFingerprint({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            legacyMachineId: "legacy-machine-1",
            apiKeyFingerprint: createHash("sha256").update(LEGACY_KEY).digest("hex").slice(0, 16),
            legacyOwnerPath: ownerPath,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_NETWORK_FAILED");
          assert.match((err as ComputerServiceError).message, new RegExp(ctx.baseUrl.replaceAll(".", "\\.")));
          assert.match((err as ComputerServiceError).message, /Check the network\/VPN and --server-url/);
          assert.match((err as ComputerServiceError).message, /retry `raft-computer setup \/legacy`/);
          return true;
        },
      );

      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /credential_bridge_mode=legacy_fingerprint_roster/);
      assert.match(logText, /failure_reason=network_failed/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("adoptLegacy service: daemonId selector network failure throws ADOPT_NETWORK_FAILED with serverUrl and retry guidance", async () => {
  await withHome(async () => {
    const ctx = await startAdoptServer({ adoptConn: "destroy" });
    try {
      await assert.rejects(
        () =>
          adoptLegacyByDaemonId({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            legacyMachineId: "legacy-daemon-id-1",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_NETWORK_FAILED");
          assert.match((err as ComputerServiceError).message, new RegExp(ctx.baseUrl.replaceAll(".", "\\.")));
          assert.match((err as ComputerServiceError).message, /Check the network\/VPN and --server-url/);
          assert.match((err as ComputerServiceError).message, /retry `raft-computer setup \/legacy`/);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- PR-A2: auth_required → refresh session once → retry (the 0.71 case) ---
test("adoptLegacy service: fingerprint adoption retries once after session refresh on auth_required", async () => {
  await withHome(
    async (home) => {
      const ctx = await startAdoptServer({
        adoptQueue: [
          { status: 401, body: { code: "auth_required", error: "token expired" } },
        ],
        refresh: { status: 200, body: { accessToken: "user-token-2", refreshToken: "rt-2" } },
      });
      const ownerPath = await seedLegacyOwnerFile(home, LEGACY_KEY, JSON.stringify({ pid: 999_999_999 }));
      try {
        const result = await adoptLegacyByFingerprint({
          serverSlug: "/legacy",
          serverUrl: ctx.baseUrl,
          legacyMachineId: "legacy-machine-1",
          apiKeyFingerprint: createHash("sha256").update(LEGACY_KEY).digest("hex").slice(0, 16),
          legacyOwnerPath: ownerPath,
        });
        assert.equal(result.serverMachineId, "cmp-1");
        assert.equal(ctx.refreshCallCount(), 1);
        const logText = await readFile(adoptionLogPath(home), "utf8");
        assert.match(logText, /outcome=succeeded/);
        assert.doesNotMatch(logText, /failure_reason=auth_required/);
      } finally {
        await stop(ctx.server);
      }
    },
    {
      sessionOverride: {
        kind: "user-session",
        userId: "user-1",
        accessToken: "user-token-stale",
        refreshToken: "rt-1",
        serverUrl: "",
      },
    },
  );
});

test("adoptLegacy service: auth_required with failing refresh still surfaces ADOPT_AUTH_REQUIRED", async () => {
  await withHome(
    async (home) => {
      const ctx = await startAdoptServer({
        adoptQueue: [
          { status: 401, body: { code: "auth_required", error: "token expired" } },
          { status: 401, body: { code: "auth_required", error: "token expired" } },
        ],
        refresh: { status: 401, body: { error: "refresh token revoked" } },
      });
      const ownerPath = await seedLegacyOwnerFile(home, LEGACY_KEY, JSON.stringify({ pid: 999_999_999 }));
      try {
        await assert.rejects(
          () =>
            adoptLegacyByFingerprint({
              serverSlug: "/legacy",
              serverUrl: ctx.baseUrl,
              legacyMachineId: "legacy-machine-1",
              apiKeyFingerprint: createHash("sha256").update(LEGACY_KEY).digest("hex").slice(0, 16),
              legacyOwnerPath: ownerPath,
            }),
          (err: unknown) => {
            assert.ok(err instanceof ComputerServiceError);
            assert.equal((err as ComputerServiceError).code, "ADOPT_AUTH_REQUIRED");
            return true;
          },
        );
        const logText = await readFile(adoptionLogPath(home), "utf8");
        assert.match(logText, /failure_reason=auth_required/);
      } finally {
        await stop(ctx.server);
      }
    },
    {
      sessionOverride: {
        kind: "user-session",
        userId: "user-1",
        accessToken: "user-token-stale",
        refreshToken: "rt-1",
        serverUrl: "",
      },
    },
  );
});

// --- Gate 2: NO_USER_SESSION (file missing) ---
test("adoptLegacy service: missing user session throws NO_USER_SESSION", async () => {
  await withHome(
    async () => {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: "http://127.0.0.1:1",
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
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
test("adoptLegacy service: invalid user session shape throws INVALID_USER_SESSION", async () => {
  await withHome(
    async () => {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: "http://127.0.0.1:1",
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
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

// --- Gate 4: ADOPT_NOT_AUTHORIZED for empty slug AND for server 403 ---
test("adoptLegacy service: empty server slug throws ADOPT_NOT_AUTHORIZED", async () => {
  await withHome(async () => {
    await assert.rejects(
      () =>
        adoptLegacy({
          serverSlug: "",
          serverUrl: "http://127.0.0.1:1",
          rawKey: LEGACY_KEY,
          mode: "legacy_key_argv",
          redactedPrefix: LEGACY_PREFIX,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "ADOPT_NOT_AUTHORIZED");
        assert.equal((err as ComputerServiceError).message, "Server slug must not be empty.");
        return true;
      },
    );
  });
});

test("adoptLegacy service: 403 from server throws ADOPT_NOT_AUTHORIZED + appends failure log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 403, body: { code: "not_authorized" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_NOT_AUTHORIZED");
          assert.equal(
            (err as ComputerServiceError).message,
            "Not authorized to adopt this machine on this server. Check that you are a current member.",
          );
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=not_authorized/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("adoptLegacy service: unknown 403 stays unexpected instead of fabricating ADOPT_NOT_AUTHORIZED", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 403, body: { code: "edge_policy_denied" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_UNEXPECTED_RESPONSE");
          assert.match((err as ComputerServiceError).message, /status 403, code edge_policy_denied/);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /failure_reason=unexpected_response_edge_policy_denied/);
      assert.doesNotMatch(logText, /failure_reason=not_authorized/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("adoptLegacy service: code-less 403 stays unexpected instead of fabricating ADOPT_NOT_AUTHORIZED", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 403, body: null },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_UNEXPECTED_RESPONSE");
          assert.match((err as ComputerServiceError).message, /status 403, missing error code/);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /failure_reason=unexpected_response_missing_code/);
      assert.doesNotMatch(logText, /failure_reason=not_authorized/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("adoptLegacyByDaemonId service: typed missing row is actionable and writes no Computer state", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 404, body: { code: "legacy_machine_not_found" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacyByDaemonId({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            legacyMachineId: "0f0f0f0f-1111-2222-3333-444444444444",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LEGACY_MACHINE_NOT_FOUND");
          assert.match((err as ComputerServiceError).message, /no longer exists on this server or belongs to another server/i);
          assert.match((err as ComputerServiceError).message, /No local Computer state was written/);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /failure_reason=legacy_machine_not_found/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// Role gate (#wg-raft-computer 2026-06-05): server returns 403 `requires_admin`
// for a member who lacks manageMachines — even with raw legacy-key possession.
// Distinct from `not_authorized` so the caller renders "ask an admin".
test("adoptLegacy service: 403 requires_admin throws ADOPT_REQUIRES_ADMIN + appends failure log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 403, body: { code: "requires_admin" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_REQUIRES_ADMIN");
          assert.match((err as ComputerServiceError).message, /requires the admin or owner role/);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=requires_admin/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 5: ADOPT_DISABLED (404) + failure log ---
test("adoptLegacy service: 404 throws ADOPT_DISABLED + appends failure log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 404, body: {} },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_DISABLED");
          assert.match((err as ComputerServiceError).message, /Computer legacy adoption is not enabled on this server/);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=computer_adopt_disabled/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 6: LEGACY_KEY_INVALID (401 legacy_key_invalid) — preserves
// owner-evidence in message + appends failure log ---
test("adoptLegacy service: server legacy_key_invalid throws LEGACY_KEY_INVALID with owner evidence + log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 401, body: { code: "legacy_key_invalid" } },
    });
    try {
      await seedLegacyOwnerFile(
        home,
        LEGACY_KEY,
        JSON.stringify({ pid: process.pid, startedAt: "2026-05-24T00:00:00.000Z", serverUrl: ctx.baseUrl }),
      );
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LEGACY_KEY_INVALID");
          const msg = (err as ComputerServiceError).message;
          assert.match(msg, /Server rejected the legacy api key/);
          assert.match(msg, /Local legacy owner evidence for this key:/);
          assert.match(msg, /SLOCK_HOME=/);
          assert.match(msg, /owner=.*owner\.json/);
          assert.match(msg, new RegExp(`pid=${process.pid}`));
          assert.match(msg, /alive=true/);
          // Raw legacy key MUST NOT appear in the error message.
          assert.equal(msg.includes(LEGACY_KEY), false);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=legacy_key_invalid/);
      assert.equal(logText.includes(LEGACY_KEY), false);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 7: LEGACY_MACHINE_KEY_MIGRATED (409) + no preflight, no
// runner.state.json, failure log ---
test("adoptLegacy service: legacy_machine_key_migrated → fail-before-preflight, no runner.state.json, log failure", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 409, body: { code: "legacy_machine_key_migrated" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_env",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LEGACY_MACHINE_KEY_MIGRATED");
          assert.match((err as ComputerServiceError).message, /This machine has already been adopted/);
          return true;
        },
      );
      // No preflight should have been called.
      assert.equal(ctx.seenPreflightApiKeys().length, 0);
      // runner.state.json must NOT exist (fail-closed).
      await assert.rejects(
        () => readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=legacy_machine_key_migrated/);
      assert.match(logText, /credential_bridge_mode=legacy_key_env/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 8: ADOPT_AUTH_REQUIRED (401 auth_required) — login guidance ---
test("adoptLegacy service: 401 auth_required throws ADOPT_AUTH_REQUIRED with login guidance", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 401, body: { code: "auth_required" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_AUTH_REQUIRED");
          const msg = (err as ComputerServiceError).message;
          assert.match(msg, /Re-run `raft-computer login`/);
          assert.match(msg, /use the same `--server-url` if not on production/);
          assert.match(msg, /No local Computer state was written\./);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /failure_reason=auth_required/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 9: ADOPT_UNEXPECTED_RESPONSE (401 missing code) carries
// http_status + login hint ---
test("adoptLegacy service: 401 with no code throws ADOPT_UNEXPECTED_RESPONSE w/ login hint", async () => {
  await withHome(async () => {
    const ctx = await startAdoptServer({
      adopt: { status: 401, body: { error: "Invalid or expired token" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_UNEXPECTED_RESPONSE");
          const msg = (err as ComputerServiceError).message;
          assert.match(msg, /status 401, missing error code/);
          assert.match(msg, /re-run `raft-computer login` first/);
          assert.equal(msg.includes("ADOPT_AUTH_REQUIRED"), false);
          return true;
        },
      );
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 10: ADOPT_FAILED (generic unrecognized server error) ---
test("adoptLegacy service: generic 500 throws ADOPT_FAILED carrying the code + log", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      adopt: { status: 500, body: { code: "internal_adopt_error" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "ADOPT_FAILED");
          assert.match((err as ComputerServiceError).message, /Adoption failed at server exchange \(internal_adopt_error\)\./);
          return true;
        },
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /failure_reason=internal_adopt_error/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 11: PREFLIGHT_FAILED — fail-closed: zero runner.state.json
// residue + adoption.log preflight_<code> failure line ---
test("adoptLegacy service: preflight failure → PREFLIGHT_FAILED + zero runner.state.json residue + log preflight_<code>", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({
      preflight: { status: 500, body: { ok: false, code: "internal" } },
    });
    try {
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "PREFLIGHT_FAILED");
          assert.match((err as ComputerServiceError).message, /Server preflight failed \(internal\)/);
          assert.match((err as ComputerServiceError).message, /local state not written/);
          return true;
        },
      );
      // Fail-closed: runner.state.json MUST NOT exist after preflight failure.
      await assert.rejects(
        () => readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=preflight_internal/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 12: LEGACY_DAEMON_STOP_FAILED on owner_json_unparseable —
// fail-closed (no runner.state.json), failure log carries legacy_stop_*
// fields. ---
test("adoptLegacy service: unparseable owner.json → LEGACY_DAEMON_STOP_FAILED, fail-closed, log legacy_stop_error", async () => {
  await withHome(async (home) => {
    const ctx = await startAdoptServer({});
    try {
      await seedLegacyOwnerFile(home, LEGACY_KEY, "{not valid json");
      await assert.rejects(
        () =>
          adoptLegacy({
            serverSlug: "/legacy",
            serverUrl: ctx.baseUrl,
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          assert.equal((err as ComputerServiceError).code, "LEGACY_DAEMON_STOP_FAILED");
          assert.match((err as ComputerServiceError).message, /No local Computer state was written\./);
          return true;
        },
      );
      // fail-closed: no runner.state.json
      await assert.rejects(
        () => readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
      );
      const logText = await readFile(adoptionLogPath(home), "utf8");
      assert.match(logText, /outcome=failed/);
      assert.match(logText, /failure_reason=legacy_stop_error/);
      assert.match(logText, /legacy_stop_outcome=error/);
      assert.match(logText, /legacy_stop_reason=owner_json_unparseable/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// --- Gate 13: AbortSignal cancels before the network call ---
test("adoptLegacy service: pre-aborted AbortSignal throws AbortError, not ComputerServiceError", async () => {
  await withHome(async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        adoptLegacy(
          {
            serverSlug: "/legacy",
            serverUrl: "http://127.0.0.1:1",
            rawKey: LEGACY_KEY,
            mode: "legacy_key_argv",
            redactedPrefix: LEGACY_PREFIX,
          },
          { signal: ac.signal },
        ),
      (err: unknown) => {
        // Abort must NOT be reported as a §6/§9 closed-set adopt failure —
        // it's a client-driven cancellation, not a contract code.
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
  });
});

// --- Gate 14: legacyLockOwnerPath is moved into the service byte-identical ---
test("adoptLegacy service: legacyLockOwnerPath derives SHA-256(rawKey)[0..15] under <home>/machines/machine-<fp>/daemon.lock/owner.json", () => {
  const fp = createHash("sha256").update(LEGACY_KEY).digest("hex").slice(0, 16);
  const path = legacyLockOwnerPath("/tmp/slock-test-home", LEGACY_KEY);
  assert.equal(path, `/tmp/slock-test-home/machines/machine-${fp}/daemon.lock/owner.json`);
});

// --- Gate 15: appendAdoptionLog moved into service byte-identical
// (snake_case fields, redacted prefix, no raw key, 0o600). ---
test("adoptLegacy service: appendAdoptionLog writes snake_case fields, no raw key, 0o600", async () => {
  await withHome(async (home) => {
    await appendAdoptionLog(home, {
      mode: "legacy_key_argv",
      redactedPrefix: LEGACY_PREFIX,
      startedAt: new Date("2026-05-22T00:00:00Z"),
      outcome: "succeeded",
      computerId: "cmp-1",
      machineId: "mch-1",
      serverId: "srv-1",
      legacyStop: { attempted: true, pid: 42, outcome: "stopped" },
    });
    const path = adoptionLogPath(home);
    const text = await readFile(path, "utf8");
    assert.match(text, /outcome=succeeded/);
    assert.match(text, /credential_bridge_mode=legacy_key_argv/);
    assert.match(text, new RegExp(`legacy_key_prefix=${LEGACY_PREFIX}`));
    assert.match(text, /computer_id=cmp-1/);
    assert.match(text, /legacy_machine_id=mch-1/);
    assert.match(text, /server_id=srv-1/);
    assert.match(text, /legacy_stop_outcome=stopped/);
    assert.match(text, /legacy_stop_pid=42/);
    assert.equal(text.includes(LEGACY_KEY), false);
    if (process.platform !== "win32") {
      const st = await stat(path);
      assert.equal(st.mode & 0o077, 0);
    }
  });
});

// --- Gate 16: closed-set sentinel pin (4-rule sub-rule a + b for §6/§9 adopt) ---
//
// Cross-verifies the AdoptLegacyService failure surface against the §6/§9
// closed set without grep'ing source — every code we throw is named here,
// and every code named here MUST have a thrown call site in
// services/adoptLegacy.ts. If a future change adds, removes, or renames
// a §6/§9 adopt-axis code, this test fails before review.
//
// LEGACY_KEY_REQUIRED / LEGACY_KEY_MULTIPLE_SOURCES + the prefix-shape
// LEGACY_KEY_INVALID stay in the CLI adapter (resolveLegacyKey) — the
// service-side LEGACY_KEY_INVALID is the SERVER-rejected variant, a
// different §-axis rejection.
test("adoptLegacy service: §6/§9 closed-set adopt codes are exactly { 14 codes }", async () => {
  const expected = new Set([
    "NO_USER_SESSION",
    "INVALID_USER_SESSION",
    "ADOPT_NOT_AUTHORIZED",
    "ADOPT_REQUIRES_ADMIN",
    "ADOPT_DISABLED",
    "LEGACY_KEY_INVALID",
    "LEGACY_MACHINE_NOT_FOUND",
    "LEGACY_MACHINE_KEY_MIGRATED",
    "ADOPT_AUTH_REQUIRED",
    "ADOPT_UNEXPECTED_RESPONSE",
    "ADOPT_NETWORK_FAILED",
    "ADOPT_FAILED",
    "PREFLIGHT_FAILED",
    "LEGACY_DAEMON_STOP_FAILED",
  ]);
  const src = await readFile(new URL("./adoptLegacy.ts", import.meta.url), "utf8");
  const re = /new ComputerServiceError\(\s*"([A-Z_]+)"/g;
  const found = new Set<string>();
  for (const m of src.matchAll(re)) found.add(m[1]);
  assert.deepEqual([...found].sort(), [...expected].sort());
});
