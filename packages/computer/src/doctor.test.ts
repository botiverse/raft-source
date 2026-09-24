import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { persistOperation } from "@botiverse/k-carrier";

import { redactSecrets, runDoctorChecks } from "./doctor.js";
import { runDoctor, runDoctorMigrationDetails, renderMigrationDetailsBody } from "./doctorCli.js";
import type { LocalCandidateEvidence } from "./lib/types.js";
import {
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLogPath,
  serverRunnerPidPath,
  servicePidPath,
  userSessionPath,
} from "./paths.js";
import { writePidfileAt } from "./internal/process-primitives.js";
import { markTerminalUnlinked, recordCrash } from "./health.js";
import { kStateDir } from "./kPaths.js";
import type { MigrationDetection } from "./lib/types.js";

// task #30 PR-G regression guard — per-server `doctor` (v4 §7).
// Decisive: the SECRET REDLINE — inject sk_computer_* + JWT into the
// per-server state files and prove they never appear in the output.

const SECRET_KEY = "sk_computer_DOCTOR-MUST-NOT-PRINT-abcdef0123456789";
const SECRET_JWT = "eyJhbGciOiJIUzI1NiJ9.PAYLOADpayloadPAYLOADpayload.sigsigsig";
const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const MACHINE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MACHINE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FP_A = "1234567890abcdef";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-doctor-"));
  const old = process.env.SLOCK_HOME;
  const oldExit = process.exitCode;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    process.exitCode = oldExit;
    await rm(home, { recursive: true, force: true });
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => { buf += String(c); return true; });
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = oo; process.stderr.write = oe; }, text: () => buf };
}

async function writeUserSession(home: string, token: string): Promise<void> {
  const p = userSessionPath(home);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "user-session", userId: "u-1", accessToken: token, serverUrl: "http://127.0.0.1:1",
  }));
}

async function writeUserSessionForServer(home: string, token: string, serverUrl: string): Promise<void> {
  const p = userSessionPath(home);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "user-session", userId: "u-1", accessToken: token, serverUrl,
  }));
}

async function writeAttach(
  home: string,
  serverId: string,
  apiKey: string,
  partial: { serverSlug?: string; serverUrl?: string; machineId?: string } = {},
): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "computer-attachment",
    serverId,
    serverSlug: partial.serverSlug,
    serverMachineId: `cm-${serverId}`,
    ...(partial.machineId ? { machineId: partial.machineId } : {}),
    apiKey,
    serverUrl: partial.serverUrl ?? "http://127.0.0.1:1",
  }));
}

async function writeLegacyOwner(
  home: string,
  dirName: string,
  apiKeyFingerprint: string,
  serverUrl: string,
): Promise<string> {
  const ownerPath = join(home, "machines", dirName, "daemon.lock", "owner.json");
  await mkdir(join(ownerPath, ".."), { recursive: true });
  await writeFile(ownerPath, JSON.stringify({ apiKeyFingerprint, serverUrl }));
  return ownerPath;
}

async function writeConnectedRunner(home: string, serverId: string): Promise<void> {
  const pidPath = serverRunnerPidPath(home, serverId);
  const connectedPath = serverConnectedMarkerPath(home, serverId);
  await mkdir(join(pidPath, ".."), { recursive: true });
  await mkdir(join(connectedPath, ".."), { recursive: true });
  await writePidfileAt(pidPath, process.pid);
  await writeFile(connectedPath, "");
}

async function startPreflightServer(
  status: number,
  body: Record<string, unknown>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/internal/computer/preflight") {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404).end();
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no test server address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("redactSecrets: masks sk_* / JWT / long hex", () => {
  assert.equal(redactSecrets(`key=${SECRET_KEY} done`), "key=***REDACTED*** done");
  assert.equal(redactSecrets(`tok ${SECRET_JWT}`), "tok ***REDACTED***");
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
});

test("doctor exposes an unacknowledged local K terminal receipt without any Server attachment", async () => {
  await withHome(async (home) => {
    await persistOperation(kStateDir(home), {
      formatVersion: 1,
      id: "local-upgrade-failed",
      startedAtMs: 1,
      updatedAtMs: 2,
      fromVersion: "1.0.24",
      targetVersion: "1.0.25",
      previousStableVersion: "1.0.24",
      phase: "failed",
      outcome: "failed",
      reason: "replacement did not become ready",
      provenance: { who: "local", carrier: "cli" },
      metadata: {
        trigger: "cli",
        upgradeScopeVersion: "1",
        upgradeScope: "local",
      },
      acknowledgedAtMs: null,
    });

    const checks = await runDoctorChecks(home);
    assert.deepEqual(checks.find((check) => check.name === "K upgrade receipt"), {
      name: "K upgrade receipt",
      ok: false,
      detail:
        "local operation local-upgrade-failed is terminal failed and unacknowledged; "
        + "verify the running Computer, then run `raft-computer operation acknowledge local-upgrade-failed`",
    });
  });
});

test("doctor: fresh home → login + attachments checks fail (actionable)", async () => {
  await withHome(async (home) => {
    const checks = await runDoctorChecks(home);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(byName["user session"].ok, false);
    assert.match(byName["user session"].detail, /raft-computer login/);
    assert.equal(byName["attachments"].ok, false);
    assert.match(byName["attachments"].detail, /raft-computer attach/);
    assert.equal(byName["OS supervisor"], undefined);
  });
});

test("doctor --migration-details: prints human-readable local evidence without fingerprint", async () => {
  await withHome(async (home) => {
    await writeLegacyOwner(
      home,
      "machine-1234567890abcdef",
      FP_A,
      "https://api.raft.build",
    );
    const cap = captureOut();
    try {
      await runDoctorMigrationDetails({});
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.ok(out.includes(`Using state at ${home}`));
    assert.match(out, /Migration evidence for \(server not specified\) \(1 local trace\):/);
    // No-server mode never consulted a roster: per-trace verdicts must say
    // "not evaluated", NEVER "not known to this server" (the 0.71 case
    // false-verdict, #wg-raft-computer:13e4a209).
    assert.match(out, /machine-12345678…\s+— owner file ok — \(pass \/<server> to evaluate\)/);
    assert.doesNotMatch(out, /not known to this server/);
    assert.doesNotMatch(out, new RegExp(FP_A));
    assert.doesNotMatch(out, /owner_state=ok/);
    assert.doesNotMatch(out, /reasons=not_in_roster/);
    assert.match(out, /Next: rerun with your server for roster-relative reasons and server-side Computer counts:/);
    assert.match(out, /raft-computer doctor --migration-details \/<server>/);
    // No adoption/fresh arms without a real roster verdict.
    assert.doesNotMatch(out, /--fresh/);
    assert.doesNotMatch(out, /raft-computer switch/);
    assert.match(out, /Help: https:\/\/app\.raft\.build\/s\/community\//);
  });
});

test("migration-details render: unattached slug uses executable migrate command; conditional arms fire on evidence", () => {
  const local = (over: Partial<LocalCandidateEvidence>): LocalCandidateEvidence => ({
    dirName: "machine-60cfbf47c771984a",
    dirFingerprint: "60cfbf47c771984a",
    ownerState: "ok",
    ownerFingerprint: "60cfbf47c771984a",
    ownerServerUrl: "https://api.raft.build",
    effectiveFingerprint: "60cfbf47c771984a",
    localPath: "/home/u/.slock/machines/machine-60cfbf47c771984a/daemon.lock/owner.json",
    ...over,
  });
  const machines = (rows: Array<{ agentCount: number; isComputer?: boolean }>) =>
    rows.map((row, i) => ({
      id: `m-${i}`,
      name: `mach-${i}`,
      createdAt: null,
      isComputer: row.isComputer ?? false,
      computerAttachedByCurrentUser: false,
      agentCount: row.agentCount,
    }));

  // The 0.71 shape: fingerprinted trace, both server Computers populated →
  // hostname-claim arm + fresh arm ONLY (no misleading delete-empty arm, no
  // no-fingerprint arm).
  const populated = renderMigrationDetailsBody({
    label: "/nextteam",
    evidence: { localCandidates: [local({})], roster: { status: "success", entries: [] } },
    machines: machines([{ agentCount: 10, isComputer: true }, { agentCount: 6, isComputer: true }]),
    slockHomeDisplay: "~/.slock",
  }).join("\n");
  assert.match(
    populated,
    /Next: one of these should be this computer → find the legacy row by hostname at https:\/\/app\.raft\.build\/s\/nextteam\/computers, then use its “Migrate to Computer” setup command \(`raft-computer setup \/nextteam --machine <machineId>`\)/,
  );
  assert.match(populated, /none of them → raft-computer setup \/nextteam --fresh/);
  assert.doesNotMatch(populated, /delete it at/);
  assert.doesNotMatch(populated, /no fingerprint/);
  assert.match(populated, /fingerprint not known to this server/); // real roster verdict allowed in slugged mode

  // Empty COMPUTER exists → a non-destructive settle/confirm arm appears.
  // A raw 0-agent
  // legacy daemon row (isComputer=false) must NOT trigger it — deleting a
  // not-yet-migrated daemon row is exactly the wrong prescription
  // (HaoHao first-eye blocker, #wg-raft-computer:e710c0d2).
  const withEmptyComputer = renderMigrationDetailsBody({
    label: "/nextteam",
    evidence: { localCandidates: [local({})], roster: { status: "success", entries: [] } },
    machines: machines([{ agentCount: 10, isComputer: true }, { agentCount: 0, isComputer: true }]),
    slockHomeDisplay: "~/.slock",
  }).join("\n");
  assert.match(withEmptyComputer, /a 0-agent Computer is visible → do not delete it from this output alone/);
  assert.doesNotMatch(withEmptyComputer, /delete it at/);

  const withEmptyRawDaemon = renderMigrationDetailsBody({
    label: "/nextteam",
    evidence: { localCandidates: [local({})], roster: { status: "success", entries: [] } },
    machines: machines([{ agentCount: 10, isComputer: true }, { agentCount: 0 }]),
    slockHomeDisplay: "~/.slock",
  }).join("\n");
  assert.doesNotMatch(withEmptyRawDaemon, /created an empty Computer by mistake/);

  // Fingerprintless local trace → update-daemon-and-run-once arm appears.
  const noFp = renderMigrationDetailsBody({
    label: "/nextteam",
    evidence: {
      localCandidates: [local({ ownerState: "missing_fingerprint", ownerFingerprint: null, effectiveFingerprint: null })],
      roster: { status: "success", entries: [] },
    },
    machines: null,
    slockHomeDisplay: "~/.slock",
  }).join("\n");
  assert.match(
    noFp,
    /a trace shows "no fingerprint" → update that computer's daemon to the latest version and run it once, then rerun raft-computer setup \/nextteam/,
  );
});

test("migration-details render: attached server never prescribes the setup path that must hard-fail", () => {
  const body = renderMigrationDetailsBody({
    label: "/botiverse",
    evidence: {
      localCandidates: [{
        dirName: "machine-60cfbf47c771984a",
        dirFingerprint: "60cfbf47c771984a",
        ownerState: "ok",
        ownerFingerprint: "60cfbf47c771984a",
        ownerServerUrl: "https://api.raft.build",
        effectiveFingerprint: "60cfbf47c771984a",
        localPath: "/home/u/.slock/machines/machine-60cfbf47c771984a/daemon.lock/owner.json",
      }],
      roster: { status: "success", entries: [] },
    },
    machines: null,
    slockHomeDisplay: "~/.slock",
    attached: true,
  }).join("\n");

  assert.match(body, /\/botiverse is already attached/);
  assert.match(body, /historical setup evidence, not a repair instruction/);
  assert.match(body, /no local recovery action is required/);
  assert.match(body, /do not run a legacy connect command/);
  assert.doesNotMatch(body, /find the legacy row by hostname/);
  assert.doesNotMatch(body, /none of them →/);
});

test("migration-details render: no-server mode is verdict-free end to end", () => {
  const body = renderMigrationDetailsBody({
    label: "(server not specified)",
    evidence: {
      localCandidates: [
        {
          dirName: "machine-60cfbf47c771984a",
          dirFingerprint: "60cfbf47c771984a",
          ownerState: "ok",
          ownerFingerprint: "60cfbf47c771984a",
          ownerServerUrl: "https://api.slock.ai",
          effectiveFingerprint: "60cfbf47c771984a",
          localPath: "/home/u/.slock/machines/machine-60cfbf47c771984a/daemon.lock/owner.json",
        },
      ],
      roster: { status: "success", entries: [] },
    },
    machines: null,
    slockHomeDisplay: "~/.slock",
  }).join("\n");
  assert.doesNotMatch(body, /not known to this server/);
  assert.doesNotMatch(body, /belongs to/);
  assert.doesNotMatch(body, /--fresh/);
  assert.match(body, /\(pass \/<server> to evaluate\)/);
  assert.match(body, /raft-computer doctor --migration-details \/<server>/);
});

test("doctor: corrupted user-session.json fails fast with login guidance", async () => {
  await withHome(async (home) => {
    const p = userSessionPath(home);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, '{"kind":"user-session","userId":"abc","acce');

    const checks = await runDoctorChecks(home);
    const userSession = checks.find((c) => c.name === "user session");
    assert.ok(userSession);
    assert.equal(userSession.ok, false);
    assert.match(userSession.detail, /invalid user session file/);
    assert.match(userSession.detail, /raft-computer login/);

    const cap = captureOut();
    try {
      await runDoctor({});
      const out = cap.text();
      cap.restore();
      assert.match(out, /invalid user session file/);
      assert.match(out, /raft-computer login/);
      assert.ok(!out.includes("abc"), "doctor must not echo corrupted session content");
    } finally {
      cap.restore();
    }
  });
});

test("doctor: SECRET REDLINE — injected per-server key + user token never appear in output", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    await writeAttach(home, SERVER_A, SECRET_KEY);
    const cap = captureOut();
    try {
      await runDoctor({});
      const out = cap.text();
      cap.restore();
      assert.ok(!out.includes(SECRET_KEY), "leaked sk_computer_*");
      assert.ok(!out.includes(SECRET_JWT), "leaked user token");
    } finally {
      cap.restore();
    }
  });
});

test("doctor: auth preflight rejection explains id-vs-display-name recovery after #3862", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(401, { code: "computer_key_revoked" });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl });
      const checks = await runDoctorChecks(home);
      const preflight = checks.find((c) => c.name === "preflight /alpha");
      assert.ok(preflight);
      assert.equal(preflight.ok, false);
      assert.match(preflight.detail, /saved Computer credential is no longer accepted/);
      assert.match(preflight.detail, /identity is the server-issued id, not the display name/i);
      assert.match(preflight.detail, /COMPUTER_NAME_COLLISION/);
      assert.match(preflight.detail, /admin.*revoke/i);
      assert.doesNotMatch(preflight.detail, /re-attach/i);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: scoped server filter excludes other attachments from full report", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl });
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });

      const checks = await runDoctorChecks(home, { serverId: SERVER_A });
      assert.ok(checks.some((c) => c.kind === "section" && c.name === "server /alpha"));
      assert.ok(checks.some((c) => c.name === "attach /alpha"));
      assert.ok(checks.some((c) => c.name === "preflight /alpha"));
      assert.ok(!checks.some((c) => c.name.includes("/beta")), "scoped doctor leaked /beta checks");

      const cap = captureOut();
      try {
        await runDoctor({ serverId: SERVER_A, serverLabel: "/alpha" });
        const out = cap.text();
        cap.restore();
        assert.match(out, /Server \/alpha \(11111111-1111-4111-8111-111111111111\)/);
        assert.match(out, /attach \/alpha/);
        assert.doesNotMatch(out, /\/beta/);
      } finally {
        cap.restore();
      }
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: unscoped full report adds readable server separators", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl });
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });

      const cap = captureOut();
      try {
        await runDoctor({});
        const out = cap.text();
        cap.restore();
        assert.match(out, /Server \/alpha \(11111111-1111-4111-8111-111111111111\)\n-+/);
        assert.match(out, /Server \/beta \(22222222-2222-4222-8222-222222222222\)\n-+/);
        assert.match(out, /attach \/alpha/);
        assert.match(out, /attach \/beta/);
      } finally {
        cap.restore();
      }
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: attached server with stopped runner is a red runner check", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      const checks = await runDoctorChecks(home);
      const preflight = checks.find((c) => c.name === "preflight /beta");
      assert.ok(preflight);
      assert.equal(preflight.ok, true);
      assert.equal(preflight.detail, "server recognizes this computer's credentials");
      assert.doesNotMatch(preflight.detail, /surface aligned|§9/);
      const runner = checks.find((c) => c.name === "runner /beta");
      assert.ok(runner);
      assert.equal(runner.ok, false);
      assert.match(runner.detail, /stopped/);
      assert.match(runner.detail, /raft-computer start \/beta/);
      assert.match(runner.detail, /runner\.log/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: degraded runner guidance says fix cause then restart", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      const now = Date.now() - 10_000;
      await recordCrash(home, SERVER_B, 1, null, now);
      await recordCrash(home, SERVER_B, 1, null, now + 1_000);
      await recordCrash(home, SERVER_B, 1, null, now + 2_000);

      const checks = await runDoctorChecks(home);
      const runner = checks.find((c) => c.name === "runner /beta");
      assert.ok(runner);
      assert.equal(runner.ok, false);
      assert.match(runner.detail, /degraded after repeated crashes/);
      assert.match(runner.detail, /after fixing, run `raft-computer restart \/beta` to try again/);
      assert.doesNotMatch(runner.detail, /reset/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: runner log computer_machine_unlinked rejection gives stale-state recovery", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "android" });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "android", serverUrl: ctx.baseUrl });
      await mkdir(join(serverRunnerPidPath(home, SERVER_A), ".."), { recursive: true });
      await writePidfileAt(serverRunnerPidPath(home, SERVER_A), process.pid);
      await writeFile(
        serverRunnerLogPath(home, SERVER_A),
        [
          "[Daemon] Starting connection",
          "[Daemon] WebSocket handshake rejected (status=401, slock_reason=computer_machine_unlinked)",
        ].join("\n"),
      );

      const checks = await runDoctorChecks(home);
      const runner = checks.find((c) => c.name === "runner /android");
      assert.ok(runner);
      assert.equal(runner.ok, false);
      assert.match(runner.detail, /computer_machine_unlinked/);
      assert.match(runner.detail, /raft-computer setup \/android/);
      assert.match(runner.detail, /raft-computer status \/android/);
      assert.doesNotMatch(runner.detail, /back up|move the stale|runner\.state\.json aside/i);
      assert.doesNotMatch(runner.detail, /database|sql|machine_id/i);
      assert.doesNotMatch(runner.detail, /sk_computer/i);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: terminal unlink marker gives stale-state recovery even without log tail", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "android" });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "android", serverUrl: ctx.baseUrl });
      await mkdir(join(serverRunnerPidPath(home, SERVER_A), ".."), { recursive: true });
      await writePidfileAt(serverRunnerPidPath(home, SERVER_A), process.pid);
      await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);

      const checks = await runDoctorChecks(home);
      const runner = checks.find((c) => c.name === "runner /android");
      assert.ok(runner);
      assert.equal(runner.ok, false);
      assert.match(runner.detail, /computer_machine_unlinked/);
      assert.match(runner.detail, /raft-computer setup \/android/);
      assert.doesNotMatch(runner.detail, /back up|move the stale|runner\.state\.json aside/i);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: regret state detects empty fresh Computer without destructive delete advice", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    await writeAttach(home, SERVER_A, SECRET_KEY, {
      serverSlug: "botiverse",
      serverUrl: "https://api.example.test",
      machineId: MACHINE_B,
    });
    const migration: MigrationDetection = {
      kind: "matched",
      candidates: [{
        apiKeyFingerprint: FP_A,
        daemonId: MACHINE_A,
        localPath: `${home}/machines/machine-${FP_A}/daemon.lock/owner.json`,
        machineName: "wenyideMacBook-Air",
      }],
      excluded: [],
    };

    const checks = await runDoctorChecks(home, {
      detectMigration: async () => migration,
      listServerMachines: async () => ({
        status: "success",
        machines: [
          {
            id: MACHINE_B,
            name: "new-computer",
            createdAt: "2026-07-08T00:00:00.000Z",
            isComputer: true,
            computerAttachedByCurrentUser: true,
            agentCount: 0,
          },
          {
            id: MACHINE_A,
            name: "wenyideMacBook-Air",
            createdAt: "2026-07-07T00:00:00.000Z",
            isComputer: false,
            computerAttachedByCurrentUser: false,
            agentCount: 2,
          },
        ],
      }),
    });

    const identity = checks.find((check) => check.name === "identity /botiverse");
    assert.ok(identity);
    assert.equal(identity.ok, false);
    assert.match(identity.detail, /connected as "new-computer" \(0 agents\)/);
    assert.match(identity.detail, /agents currently appear on "wenyideMacBook-Air"/);
    assert.match(identity.detail, /Do not delete any Computer from this diagnosis alone/);
    assert.match(identity.detail, /raft-computer doctor \/botiverse --migration-details/);
    assert.doesNotMatch(identity.detail, /delete the empty new Computer on the web/);
    assert.doesNotMatch(identity.detail, /raft-computer switch/);
  });
});

test("doctor: missing attached Computer row is treated as reconcile window, not empty delete target", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    await writeAttach(home, SERVER_A, SECRET_KEY, {
      serverSlug: "botiverse",
      serverUrl: "https://api.example.test",
      machineId: MACHINE_B,
    });
    const migration: MigrationDetection = {
      kind: "matched",
      candidates: [{
        apiKeyFingerprint: FP_A,
        daemonId: MACHINE_A,
        localPath: `${home}/machines/machine-${FP_A}/daemon.lock/owner.json`,
        machineName: "CASE-Jr.local",
      }],
      excluded: [],
    };

    const checks = await runDoctorChecks(home, {
      detectMigration: async () => migration,
      listServerMachines: async () => ({
        status: "success",
        machines: [
          {
            id: MACHINE_A,
            name: "CASE-Jr.local",
            createdAt: "2026-07-07T00:00:00.000Z",
            isComputer: false,
            computerAttachedByCurrentUser: false,
            agentCount: 7,
          },
        ],
      }),
    });

    const identity = checks.find((check) => check.name === "identity /botiverse");
    assert.ok(identity);
    assert.equal(identity.ok, false);
    assert.match(identity.detail, new RegExp(`saved Computer identity ${MACHINE_B} is not visible`));
    assert.match(identity.detail, /agents currently appear on "CASE-Jr.local" \(7 agents\)/);
    assert.match(identity.detail, /setup or migration reconciliation window/);
    assert.match(identity.detail, /Do not delete any Computer from this diagnosis alone/);
    assert.match(identity.detail, /raft-computer doctor \/botiverse --migration-details/);
    assert.doesNotMatch(identity.detail, /connected as "this Computer"/);
    assert.doesNotMatch(identity.detail, /delete the empty new Computer on the web/);
  });
});

test("doctor: healthy connected attachment without legacy machineId does not become RED from old matched traces", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    const ctx = await startPreflightServer(200, { ok: true });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, {
        serverSlug: "botiverse",
        serverUrl: ctx.baseUrl,
      });
      await writeConnectedRunner(home, SERVER_A);
      const migration: MigrationDetection = {
        kind: "matched",
        candidates: [{
          apiKeyFingerprint: FP_A,
          daemonId: MACHINE_A,
          localPath: `${home}/machines/machine-${FP_A}/daemon.lock/owner.json`,
          machineName: "Jiachengs-MacBook-Pro",
        }],
        excluded: [],
      };

      const checks = await runDoctorChecks(home, {
        detectMigration: async () => migration,
        listServerMachines: async () => ({
          status: "success",
          machines: [{
            id: MACHINE_A,
            name: "Jiachengs-MacBook-Pro",
            createdAt: "2026-07-07T00:00:00.000Z",
            isComputer: false,
            computerAttachedByCurrentUser: false,
            agentCount: 18,
          }],
        }),
      });

      const runner = checks.find((check) => check.name === "runner /botiverse");
      assert.ok(runner);
      assert.equal(runner.ok, true);
      assert.equal(checks.find((check) => check.name === "identity /botiverse"), undefined);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: zero-match legacy evidence surfaces setup-blocking identity check", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    const ctx = await startPreflightServer(200, { ok: true });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, {
        serverSlug: "botiverse",
        serverUrl: ctx.baseUrl,
        machineId: MACHINE_A,
      });
      const ownerPath = `${home}/machines/machine-${FP_A}/daemon.lock/owner.json`;
      const migration: MigrationDetection = {
        kind: "zero_match",
        excluded: [{
          evidence: {
            dirName: `machine-${FP_A}`,
            dirFingerprint: FP_A,
            ownerState: "ok",
            ownerFingerprint: FP_A,
            ownerServerUrl: null,
            effectiveFingerprint: FP_A,
            localPath: ownerPath,
          },
          reasons: ["not_in_roster"],
        }],
      };

      const checks = await runDoctorChecks(home, {
        detectMigration: async () => migration,
        listServerMachines: async () => ({
          status: "success",
          machines: [
            {
              id: MACHINE_A,
              name: "current-computer",
              createdAt: "2026-07-08T00:00:00.000Z",
              isComputer: true,
              computerAttachedByCurrentUser: true,
              agentCount: 0,
            },
          ],
        }),
      });

      const preflight = checks.find((check) => check.name === "preflight /botiverse");
      assert.ok(preflight);
      assert.equal(preflight.ok, true);

      const identity = checks.find((check) => check.name === "identity /botiverse");
      assert.ok(identity);
      assert.equal(identity.ok, false);
      assert.match(identity.detail, /setup would stop/);
      assert.match(identity.detail, /local legacy evidence for \/botiverse/);
      assert.match(identity.detail, /none of it matches this server/);
      assert.match(identity.detail, /raft-computer doctor \/botiverse --migration-details/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: healthy connected attachment ignores zero-match traces from the shared legacy home", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    const ctx = await startPreflightServer(200, { ok: true });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, {
        serverSlug: "botiverse",
        serverUrl: ctx.baseUrl,
        machineId: MACHINE_A,
      });
      await writeConnectedRunner(home, SERVER_A);
      const migration: MigrationDetection = {
        kind: "zero_match",
        excluded: [{
          evidence: {
            dirName: `machine-${FP_A}`,
            dirFingerprint: FP_A,
            ownerState: "ok",
            ownerFingerprint: FP_A,
            ownerServerUrl: null,
            effectiveFingerprint: FP_A,
            localPath: `${home}/machines/machine-${FP_A}/daemon.lock/owner.json`,
          },
          reasons: ["not_in_roster"],
        }],
      };

      const checks = await runDoctorChecks(home, {
        detectMigration: async () => migration,
      });

      const runner = checks.find((check) => check.name === "runner /botiverse");
      assert.ok(runner);
      assert.equal(runner.ok, true);
      assert.equal(checks.find((check) => check.name === "identity /botiverse"), undefined);
    } finally {
      await stop(ctx.server);
    }
  });
});

// PR-H integration tests — doctor cleanup (`--fix`).
// (`--fix` remains stale-local-state cleanup only; retrying a degraded
// runner is now owned by explicit `start` / `restart`.)

test("doctor --fix: residue cleaned + per-category structured output", async () => {
  await withHome(async (home) => {
    // Set up two residue categories: stale pidfile + tmp file (>24h)
    await mkdir(join(home, "computer"), { recursive: true });
    await writePidfileAt(servicePidPath(home), 999999999); // dead pid
    const snap = join(home, "computer", "upgrade-snapshot.json");
    await writeFile(snap, "{}");
    const { utimes } = await import("node:fs/promises");
    await utimes(snap, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));

    const cap = captureOut();
    try {
      await runDoctor({ cleanup: true });
      const out = cap.text();
      cap.restore();
      assert.match(out, /Cleanup pass:/);
      assert.match(out, /Stale pidfiles cleared/);
      assert.match(out, /Tmp files cleared/);
    } finally {
      cap.restore();
    }
  });
});

test("doctor: clean baseline + --fix → 'No residue found' line", async () => {
  await withHome(async (home) => {
    const cap = captureOut();
    try {
      await runDoctor({ cleanup: true });
      const out = cap.text();
      cap.restore();
      assert.match(out, /No residue found/);
    } finally {
      cap.restore();
    }
  });
});
