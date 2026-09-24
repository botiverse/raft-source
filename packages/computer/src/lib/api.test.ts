import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { serverAttachmentPath, serverManagedFlagPath, userSessionPath } from "../paths.js";
import { createComputerApi } from "./api.js";
import { ComputerError } from "./errors.js";
import { present, CliExit, formatHumanError } from "../output.js";
import { LEGACY_PRODUCTION_SERVER_URL } from "../serverUrl.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-api-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

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

async function startWorkspaceServer(opts: {
  refreshDelayMs?: number;
  rejectRepeatedRefresh?: boolean;
  role?: string;
} = {}): Promise<{
  server: Server;
  baseUrl: string;
  seenRefreshTokens: string[];
  seenListAuth: string[];
}> {
  const seenRefreshTokens: string[] = [];
  const seenListAuth: string[] = [];
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/api/auth/refresh") {
          const body = await readBody(req);
          seenRefreshTokens.push(String(body.refreshToken ?? ""));
          if (opts.rejectRepeatedRefresh && seenRefreshTokens.length > 1) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: "refresh_token_rotated" }));
            return;
          }
          if (opts.refreshDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, opts.refreshDelayMs));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accessToken: "fresh-user-token", refreshToken: "fresh-refresh-token" }));
          return;
        }
        if (req.method === "GET" && req.url === "/api/servers/") {
          seenListAuth.push(String(req.headers.authorization ?? ""));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{
            id: "server-1",
            name: "Botiverse",
            slug: "botiverse",
            role: opts.role ?? "owner",
          }]));
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
    seenRefreshTokens,
    seenListAuth,
  };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("createComputerApi.getStatus returns a Computer status report", async () => {
  await withHome(async (home) => {
    const api = createComputerApi(home);
    const report = await api.getStatus();
    assert.equal(report.slockHome, home);
    assert.equal(report.loggedIn, false);
    assert.deepEqual(report.servers, []);
    assert.equal(report.service.running, false);
  });
});

test("createComputerApi.resetRunner returns not-found for an unattached serverId (RESULT, not throw)", async () => {
  await withHome(async (home) => {
    const api = createComputerApi(home);
    const result = await api.resetRunner("11111111-1111-4111-8111-111111111111");
    assert.equal(result.status, "not-found");
    if (result.status !== "not-found") return;
    assert.equal(result.serverId, "11111111-1111-4111-8111-111111111111");
  });
});

test("createComputerApi.listWorkspaces refreshes an expired user session before listing", async () => {
  await withHome(async (home) => {
    const ctx = await startWorkspaceServer();
    try {
      await mkdir(join(home, "computer"), { recursive: true });
      await writeFile(
        join(home, "computer", "user-session.json"),
        JSON.stringify({
          kind: "user-session",
          userId: "user-1",
          accessToken: jwtExp(-60),
          refreshToken: "old-refresh-token",
          serverUrl: ctx.baseUrl,
          displayName: "Cindy",
        }),
      );
      const result = await createComputerApi(home).listWorkspaces();
      assert.equal(result.status, "success");
      if (result.status === "success") {
        assert.deepEqual(result.workspaces.map((w) => w.slug), ["botiverse"]);
      }
      assert.deepEqual(ctx.seenRefreshTokens, ["old-refresh-token"]);
      assert.deepEqual(ctx.seenListAuth, ["Bearer fresh-user-token"]);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("createComputerApi.listWorkspaces keeps an unknown role visible but non-attachable", async () => {
  await withHome(async (home) => {
    const ctx = await startWorkspaceServer({ role: "observer" });
    try {
      await mkdir(join(home, "computer"), { recursive: true });
      await writeFile(
        join(home, "computer", "user-session.json"),
        JSON.stringify({
          kind: "user-session",
          userId: "user-1",
          accessToken: jwtExp(60),
          serverUrl: ctx.baseUrl,
        }),
      );
      const result = await createComputerApi(home).listWorkspaces();
      assert.equal(result.status, "success");
      if (result.status === "success") {
        assert.equal(result.workspaces[0]?.role, "observer");
        assert.equal(result.workspaces[0]?.attachable, false);
      }
    } finally {
      await stop(ctx.server);
    }
  });
});

test("createComputerApi.listWorkspaces shares concurrent user-session refresh", async () => {
  await withHome(async (home) => {
    const ctx = await startWorkspaceServer({ refreshDelayMs: 25, rejectRepeatedRefresh: true });
    try {
      await mkdir(join(home, "computer"), { recursive: true });
      await writeFile(
        join(home, "computer", "user-session.json"),
        JSON.stringify({
          kind: "user-session",
          userId: "user-1",
          accessToken: jwtExp(-60),
          refreshToken: "rotating-refresh-token",
          serverUrl: ctx.baseUrl,
          displayName: "Cindy",
        }),
      );

      const api = createComputerApi(home);
      const [first, second] = await Promise.all([
        api.listWorkspaces(),
        api.listWorkspaces(),
      ]);

      assert.equal(first.status, "success");
      assert.equal(second.status, "success");
      assert.deepEqual(ctx.seenRefreshTokens, ["rotating-refresh-token"]);
      assert.deepEqual(ctx.seenListAuth, ["Bearer fresh-user-token", "Bearer fresh-user-token"]);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("present maps a thrown ComputerError to the human four-part stderr contract + throws CliExit", async () => {
  const errLines: string[] = [];
  const oldWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let thrown: unknown;
  try {
    await present(async () => {
      throw new ComputerError("SOME_CODE", "actionable message; run `raft-computer doctor`.", 3);
    });
  } catch (e) {
    thrown = e;
  } finally {
    process.stderr.write = oldWrite;
  }
  assert.ok(thrown instanceof CliExit, "present should throw CliExit");
  assert.equal((thrown as CliExit).exitCode, 3);
  assert.equal((thrown as CliExit).code, "SOME_CODE");
  const out = errLines.join("");
  assert.match(out, /^What happened \(SOME_CODE\): actionable message; run `raft-computer doctor`\./);
  assert.match(out, /\nNext: raft-computer doctor\n/);
  assert.match(out, /\nState: No local Computer state change was confirmed by this command\.\n/);
  assert.match(out, /\nHelp: https:\/\/app\.raft\.build\/s\/community\/\n$/);
});

test("formatHumanError falls back to copyable next command + support link for terminal code families", () => {
  const cases = [
    ["UPGRADE_ALREADY_RUNNING", "raft-computer upgrade"],
    ["MIGRATION_LOCAL_EVIDENCE_UNMATCHED", "raft-computer doctor --migration-details"],
    ["LEGACY_DAEMON_STOP_FAILED", "raft-computer setup /<server>"],
    ["RUNNER_NOT_FOUND", "raft-computer runners list"],
    ["NO_DAEMON_LOG", "raft-computer logs --service"],
    ["CHANNEL_INVALID", "raft-computer channel set latest"],
    ["CONCURRENT_OPERATION", "raft-computer status"],
    ["MUTATION_LOCK_COMPROMISED", "raft-computer doctor"],
    ["SOME_UNKNOWN_CODE", "raft-computer doctor"],
  ] as const;

  for (const [code, command] of cases) {
    const out = formatHumanError(code, "terminal failure without embedded command");
    if (code.startsWith("MIGRATION_") || code.startsWith("LEGACY_")) {
      assert.match(out, /^Using state at .+\n/);
    }
    assert.match(out, new RegExp(`\\n?What happened \\(${code}\\): terminal failure without embedded command\\n`));
    assert.match(out, new RegExp(`\\nNext: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(out, /\nState: .+\n/);
    if (code === "MIGRATION_LOCAL_EVIDENCE_UNMATCHED") {
      assert.match(out, /\nHelp: https:\/\/app\.raft\.build\/s\/community\/\n/);
      assert.match(out, /\(If you are sure you want a brand-new computer: raft-computer setup \/<server> --fresh\)\n$/);
    } else {
      assert.match(out, /\nHelp: https:\/\/app\.raft\.build\/s\/community\/\n$/);
    }
    assert.doesNotMatch(out, /^\{.*"ok":false/m);
  }
});

test("present rethrows a non-ComputerError unchanged", async () => {
  const sentinel = new Error("not a computer error");
  let thrown: unknown;
  try {
    await present(async () => {
      throw sentinel;
    });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, sentinel);
});

// Regression pin for the `createComputerApi(slockHome)` BINDING contract
// (#wg-raft-computer:f2a02081 BUG 3, Yingjun review note msg=1ae57ef9). The
// services originally read `resolveRaftHome()` from process env, ignoring
// the bound `slockHome` constructor argument — making the binding dead code
// for mutations. Yingjun: "key: 加一条 regression 测试钉死绑定 — createComputerApi(tempHome)
// 调一个 mutation 真打 tempHome、不碰 ambient. 没这条，将来谁再手滑 resolveRaftHome() 回来、
// 测试不红、债又回来 (这次就是这么滑进来的)".

test("createComputerApi(tempHome).doctor honors the bound slockHome (regression — BUG 3 #wg-raft-computer:f2a02081)", async () => {
  await withHome(async (tempHome) => {
    // Sentinel: set ambient SLOCK_HOME to a DIFFERENT directory. If any
    // service still reads ambient instead of the bound argument, the test
    // will see the wrong home in the doctor report.
    const previousAmbient = process.env.SLOCK_HOME;
    await withHome(async (ambientHome) => {
      process.env.SLOCK_HOME = ambientHome;
      try {
        const api = createComputerApi(tempHome);
        const report = await api.doctor({});
        // The SLOCK_HOME check echoes the resolved home. Must equal the
        // bound `tempHome`, NOT the ambient `ambientHome` — otherwise some
        // service is still calling `resolveRaftHome()` instead of honoring
        // the bound argument.
        const slockHomeCheck = report.checks.find((c) => c.name === "SLOCK_HOME");
        assert.ok(slockHomeCheck, "doctor must include a SLOCK_HOME check");
        assert.equal(
          slockHomeCheck.detail,
          tempHome,
          "doctor must read the bound slockHome (BUG 3 regression — bound mutation must NOT fall back to ambient env)",
        );
        assert.notEqual(slockHomeCheck.detail, ambientHome,
          "doctor leaked into ambient SLOCK_HOME — binding is dead code again");
      } finally {
        if (previousAmbient === undefined) delete process.env.SLOCK_HOME;
        else process.env.SLOCK_HOME = previousAmbient;
      }
    });
  });
});

// task #134 rule 1: Sign out disconnects every workspace Computer (stop the
// service → runners exit → web offline), but KEEPS the local attachment so a
// later re-login resumes the SAME Computer.
test("createComputerApi.logout stops the service but keeps local attachments (rule 1)", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer"), { recursive: true });
    await writeFile(
      userSessionPath(home),
      JSON.stringify({ kind: "user-session", userId: "u-1", accessToken: "tok", serverUrl: "https://example.test" }),
    );
    const serverId = "894a8a1c-6e1c-43ee-bea8-6d5937edd7c8";
    await mkdir(dirname(serverAttachmentPath(home, serverId)), { recursive: true });
    await writeFile(
      serverAttachmentPath(home, serverId),
      JSON.stringify({
        kind: "computer-attachment",
        serverId,
        serverMachineId: "m-1",
        apiKey: "sk_computer_secret",
        serverUrl: LEGACY_PRODUCTION_SERVER_URL,
      }),
    );
    await writeFile(serverManagedFlagPath(home, serverId), "", { mode: 0o600 });

    const result = await createComputerApi(home).logout();

    // Session cleared; the service stop was wired/attempted (no service running
    // in this fixture → not_running; the actual SIGTERM is covered by stop's
    // own tests + live repro).
    assert.equal(result.status, "logged-out");
    assert.equal(result.runnersStopped, "not_running");
    assert.equal(existsSync(userSessionPath(home)), false);
    // The attachment MUST survive sign-out — this is what lets re-login resume
    // the SAME Computer.
    assert.equal(existsSync(serverAttachmentPath(home, serverId)), true);
    // But the live connection intent is cleared: sign-out must not let a future
    // service restart rehydrate the runner before the user signs in again.
    assert.equal(existsSync(serverManagedFlagPath(home, serverId)), false);
  });
});
