import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactSecrets, runDoctorChecks } from "./doctor";
import { runDoctor, runDoctorJson, runDoctorMigrationDetails, renderMigrationDetailsBody } from "./doctorCli";
import type { LocalCandidateEvidence } from "./lib/types";
import {
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLockConflictPath,
  serverRunnerLogPath,
  serverRunnerMemoryPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  servicePidPath,
  userSessionPath,
} from "./paths";
import { writePidfileAt } from "./internal/process-primitives";
import { markTerminalUnlinked, recordCrash } from "./health";
import type { MigrationDetection } from "./lib/types";

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

test("doctor: fresh home → login + attachments checks fail (actionable)", async () => {
  await withHome(async (home) => {
    const checks = await runDoctorChecks(home);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(byName["user session"].ok, false);
    assert.match(byName["user session"].detail, /not attached to any server — run `raft-computer attach/);
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

test("doctor: corrupted user-session.json with nothing attached fails with attach guidance", async () => {
  await withHome(async (home) => {
    const p = userSessionPath(home);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, '{"kind":"user-session","userId":"abc","acce');

    const checks = await runDoctorChecks(home);
    const userSession = checks.find((c) => c.name === "user session");
    assert.ok(userSession);
    assert.equal(userSession.ok, false);
    assert.match(userSession.detail, /invalid user session file/);
    assert.match(userSession.detail, /raft-computer attach/);

    const cap = captureOut();
    try {
      await runDoctor({});
      const out = cap.text();
      cap.restore();
      assert.match(out, /invalid user session file/);
      assert.match(out, /raft-computer attach/);
      assert.ok(!out.includes("abc"), "doctor must not echo corrupted session content");
    } finally {
      cap.restore();
    }
  });
});

for (const [caseName, writeSession] of [
  ["no user session", async (_home: string) => {}],
  ["corrupted user session", async (home: string) => {
    const p = userSessionPath(home);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, '{"kind":"user-session","userId":"abc","acce');
  }],
] as const) {
  test(`doctor: attached machine with ${caseName} reports the session as not needed and skips session-only checks with one note`, async () => {
    await withHome(async (home) => {
      const { server, baseUrl } = await startPreflightServer(200, { ok: true });
      try {
        await writeSession(home);
        await writeAttach(home, SERVER_A, "sk_computer_doctorgrant123", { serverSlug: "alpha", serverUrl: baseUrl });
        const checks = await runDoctorChecks(home);
        const userSession = checks.find((c) => c.name === "user session");
        assert.ok(userSession);
        assert.equal(userSession.ok, true);
        assert.equal(userSession.detail, "not needed (attached with this machine's key)");
        const notes = checks.filter((c) => c.name === "legacy migration checks");
        assert.equal(notes.length, 1);
        assert.equal(notes[0]!.ok, true);
        assert.match(notes[0]!.detail, /^skipped \(they need a user session/);
        assert.equal(checks.find((c) => c.name === "preflight /alpha")?.ok, true);
      } finally {
        await stop(server);
      }
    });
  });
}

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

test("doctor: auth preflight rejection is a failed check that names COMPUTER_NAME_COLLISION", async () => {
  await withHome(async (home) => {
    await writeUserSession(home, SECRET_JWT);
    const ctx = await startPreflightServer(401, { code: "computer_key_revoked" });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl });
      const checks = await runDoctorChecks(home);
      const preflight = checks.find((c) => c.name === "preflight /alpha");
      assert.ok(preflight);
      assert.equal(preflight.ok, false);
      assert.match(preflight.detail, /COMPUTER_NAME_COLLISION/);
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

// The Windows sign-out case: the runner's pid, connected marker, version
// evidence and a 12-minute-old memory sample outlive it, and the pid now
// belongs to an unrelated program.
test("doctor: service stopped, a recorded runner pid held by a later process is a stopped runner; the runner itself, or an unreadable start, stays running", async () => {
  await withHome(async (home) => {
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      await writeConnectedRunner(home, SERVER_B);
      const recordedAt = Date.now() - 13 * 60_000;
      await writeFile(serverRunnerVersionPath(home, SERVER_B), JSON.stringify({
        version: "1.22.0", installRoot: "/runner", pid: process.pid, writtenAt: new Date(recordedAt).toISOString(),
      }));
      await writeFile(serverRunnerMemoryPath(home, SERVER_B), JSON.stringify({
        sampledAt: new Date(recordedAt + 60_000).toISOString(), pid: process.pid, uptimeMs: 60_000,
        rssBytes: 158 * 1024 * 1024, heapUsedBytes: 78 * 1024 * 1024, heapTotalBytes: 82 * 1024 * 1024,
      }));

      const reused = await runDoctorChecks(home, { processStartTimeMs: async () => recordedAt + 10 * 60_000 });
      const runner = reused.find((c) => c.name === "runner /beta");
      assert.equal(runner?.ok, false);
      assert.match(runner?.detail ?? "", /^stopped — run `raft-computer start \/beta` and inspect .*runner\.log$/);
      assert.equal(reused.find((c) => c.name === "memory /beta"), undefined, "a dead runner's sample is not its current state");

      for (const startedAtMs of [recordedAt - 2_000, undefined]) {
        const live = await runDoctorChecks(home, { processStartTimeMs: async () => startedAtMs });
        assert.deepEqual(
          live.find((c) => c.name === "runner /beta"),
          { name: "runner /beta", ok: true, detail: `running and connected (pid ${process.pid})` },
          String(startedAtMs),
        );
        assert.match(live.find((c) => c.name === "memory /beta")?.detail ?? "", /^rss 158 MB, .*sampled 12 min ago$/);
      }
    } finally {
      await stop(ctx.server);
    }
  });
});

// The service deferred to the daemon machine lock's holder and wrote its pid
// into runner.pid; on a real Windows machine that holder was explorer.exe.
test("doctor: a lock holder the service defers to is a red runner check with start's conflict message, never running and connected", async () => {
  await withHome(async (home) => {
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      await writeConnectedRunner(home, SERVER_B);
      await writePidfileAt(servicePidPath(home), process.pid);
      await writeFile(serverRunnerLockConflictPath(home, SERVER_B), JSON.stringify({
        servicePid: process.pid, ownerPid: process.pid, lockPath: "/raft/machines/machine-x/daemon.lock", recordedAt: Date.now(),
      }));

      const checks = await runDoctorChecks(home);
      const runner = checks.find((c) => c.name === "runner /beta");
      assert.equal(runner?.ok, false);
      assert.match(
        runner?.detail ?? "",
        new RegExp(`^Cannot start /beta: pid ${process.pid} holds this machine's daemon lock, so the Computer service is deferring to it instead of starting its own runner\\. Lock: /raft/machines/machine-x/daemon\\.lock\\.`),
      );
      assert.match(runner?.detail ?? "", new RegExp(`Check whether pid ${process.pid} is really a Raft daemon with \``));
      assert.match(runner?.detail ?? "", /run `raft-computer restart` to start this server's runner again/);
      assert.doesNotMatch(runner?.detail ?? "", /running and connected|another Slock daemon/);
      assert.equal(checks.find((c) => c.name === "memory /beta"), undefined);

      // After `raft-computer stop` no service defers to anything: the holder is all that is known.
      await rm(servicePidPath(home));
      const stopped = (await runDoctorChecks(home)).find((c) => c.name === "runner /beta");
      assert.equal(stopped?.ok, false);
      assert.match(
        stopped?.detail ?? "",
        new RegExp(`^The Computer service is not running, and pid ${process.pid} holds this machine's daemon lock: it could not be confirmed as /beta's runner\\. Lock: /raft/machines/machine-x/daemon\\.lock\\. Check whether pid ${process.pid} is really a Raft daemon with \``),
      );
      assert.match(stopped?.detail ?? "", /run `raft-computer restart` to start this server's runner again/);
      assert.doesNotMatch(stopped?.detail ?? "", /deferring|Cannot start|Nothing is running/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// A deferred-to lock owner that runner-version.json names. `start` and
// `restart` never touch it, so "restart with raft-computer start" is false
// advice for it when it is not connected.
test("doctor: a deferred-to runner is running and connected by its own marker; not connected, the advice is to end that pid, never to restart it", async () => {
  await withHome(async (home) => {
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      const evidenceAt = "2026-11-13T08:00:00.000Z";
      const pid = process.pid;
      await writePidfileAt(serverRunnerPidPath(home, SERVER_B), pid);
      await writeFile(serverRunnerVersionPath(home, SERVER_B), JSON.stringify({ version: "1.22.0", installRoot: "/runner", pid, writtenAt: evidenceAt }));
      await writeFile(serverRunnerLockConflictPath(home, SERVER_B), JSON.stringify({ servicePid: pid, ownerPid: pid, lockPath: null, recordedAt: 1 }));
      const runner = async (startedAtMs: number | undefined) =>
        (await runDoctorChecks(home, { processStartTimeMs: async () => startedAtMs })).find((c) => c.name === "runner /beta");
      const ownRunner = Date.parse(evidenceAt) - 2_000;

      // Connected by its own marker: this server's runner, or one whose start cannot be read (Linux).
      await writeFile(serverConnectedMarkerPath(home, SERVER_B), JSON.stringify({ pid, connectedAt: 1 }));
      for (const startedAtMs of [ownRunner, undefined]) {
        assert.deepEqual(await runner(startedAtMs), { name: "runner /beta", ok: true, detail: `running and connected (pid ${pid})` }, String(startedAtMs));
      }

      // Not connected, the service stopped (no service pid file here), then running.
      await rm(serverConnectedMarkerPath(home, SERVER_B));
      const stopped = await runner(ownRunner);
      assert.equal(stopped?.ok, false);
      assert.match(stopped?.detail ?? "", new RegExp(`^process running \\(pid ${pid}\\) but not connected to the server — inspect .*runner\\.log; this runner was started by an earlier Computer service and cannot be restarted from here: end pid ${pid}, then run \`raft-computer start /beta\`$`));

      await writePidfileAt(servicePidPath(home), pid);
      const running = await runner(ownRunner);
      assert.match(running?.detail ?? "", new RegExp(`; this runner was started by an earlier Computer service and cannot be restarted from here: ending pid ${pid} lets the Computer service start a new one$`));

      // Its start cannot be read: nothing says what it is, and still nothing restarts it from here.
      const unread = await runner(undefined);
      assert.equal(unread?.ok, false);
      assert.match(unread?.detail ?? "", new RegExp(`; pid ${pid} holds this machine's daemon lock and was not started by this Computer service, so it cannot be restarted from here: check it with \`[^\`]+\`; if it is this server's runner, ending pid ${pid} lets the Computer service start a new one$`));
      for (const detail of [stopped?.detail, running?.detail, unread?.detail]) assert.doesNotMatch(detail ?? "", /restart with/);
    } finally {
      await stop(ctx.server);
    }
  });
});

// A runner the service started itself keeps the advice that is true for it.
test("doctor: a runner the service started that is not connected is restarted with start", async () => {
  await withHome(async (home) => {
    const ctx = await startPreflightServer(200, { ok: true, serverSlug: "beta" });
    try {
      await writeAttach(home, SERVER_B, SECRET_KEY, { serverSlug: "beta", serverUrl: ctx.baseUrl });
      await writePidfileAt(serverRunnerPidPath(home, SERVER_B), process.pid);
      const runner = (await runDoctorChecks(home)).find((c) => c.name === "runner /beta");
      assert.match(runner?.detail ?? "", /but not connected to the server — inspect .*runner\.log; restart with `raft-computer start \/beta`$/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: a recorded service pid that is another program is a stopped service", async () => {
  await withHome(async (home) => {
    await writePidfileAt(servicePidPath(home), process.pid);
    await writeFile(join(home, "computer", "service-version.json"), JSON.stringify({
      version: "1.22.0", installRoot: "/service", pid: process.pid, writtenAt: "2026-11-13T08:00:00.000Z",
    }));
    const service = (startedAtMs: number | undefined, serviceAnswers: boolean) =>
      runDoctorChecks(home, { endpointAnswers: async () => serviceAnswers, processStartTimeMs: async () => startedAtMs })
        .then((checks) => checks.find((c) => c.name === "service"));
    const later = Date.parse("2026-11-13T08:10:00.000Z");
    assert.deepEqual(await service(later, false), { name: "service", ok: true, detail: "stopped (run `raft-computer start` when you want background)" });
    assert.deepEqual(await service(later, true), { name: "service", ok: true, detail: `running (pid ${process.pid})` });
    assert.deepEqual(await service(undefined, false), { name: "service", ok: true, detail: `running (pid ${process.pid})` });
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
      assert.match(runner.detail, /after fixing, run `raft-computer restart \/beta` to try again/);
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

test("doctor: a running service under a unit with OOMPolicy=stop or kill fails with the fix; continue adds nothing", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer"), { recursive: true });
    await writePidfileAt(servicePidPath(home), process.pid);
    const record = { kind: "systemd" as const, scope: "user" as const, unit: "raft-computer.service", invocationId: "x", pid: process.pid, recordedAt: "t" };
    for (const oomPolicy of ["stop", "kill"]) {
      const checks = await runDoctorChecks(home, { readSupervisorOomPolicy: async () => ({ record, oomPolicy, transient: false }) });
      const oom = checks.find((c) => c.name === "service OOM policy");
      assert.equal(oom?.ok, false, oomPolicy);
      assert.match(oom?.detail ?? "", new RegExp(`OOMPolicy=${oomPolicy}: .*systemctl --user edit raft-computer\\.service`));
    }
    // continue, no answer, a reader that throws, or a record left by another process: no line.
    const quiet = [
      async () => ({ record, oomPolicy: "continue", transient: false }),
      async () => null,
      async () => { throw new Error("bus gone"); },
      async () => ({ record: { ...record, pid: process.pid + 1 }, oomPolicy: "stop", transient: false }),
    ];
    for (const readSupervisorOomPolicy of quiet) {
      const checks = await runDoctorChecks(home, { readSupervisorOomPolicy });
      assert.equal(checks.find((c) => c.name === "service OOM policy"), undefined);
    }
  });
});

test("doctor: a stopped service never reads the unit's OOM policy", async () => {
  await withHome(async (home) => {
    let read = false;
    await runDoctorChecks(home, { readSupervisorOomPolicy: async () => { read = true; return null; } });
    assert.equal(read, false);
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
    const staged = join(home, "computer", "upgrade-staging", "1.0.0");
    await mkdir(staged, { recursive: true });
    const { utimes } = await import("node:fs/promises");
    await utimes(staged, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));

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

test("task #914: doctor names another live service holding this machine key, and says so when there is none", async () => {
  await withHome(async (home) => {
    const holder = {
      root: "/Users/someone/.slock",
      servicePid: 777,
      computerVersion: "1.0.25",
      serverIds: ["server-a"],
      fingerprints: ["0123456789abcdef"],
    };
    const withHolder = await runDoctorChecks(home, { findDuplicateKeyHolder: async () => holder });
    const found = withHolder.find((c) => c.name === "machine key holders");
    assert.ok(found);
    assert.equal(found.ok, false);
    assert.match(found.detail, /pid 777 \(Computer version 1\.0\.25\) under \/Users\/someone\/\.slock, server server-a \(key fingerprint 0123456789abcdef\)/);
    assert.doesNotMatch(JSON.stringify(withHolder), /sk_machine/);

    const clean = await runDoctorChecks(home, { findDuplicateKeyHolder: async () => null });
    const none = clean.find((c) => c.name === "machine key holders");
    assert.ok(none);
    assert.equal(none.ok, true);
  });
});

test("task #915: doctor reports both default homes holding Raft data, and stays silent otherwise", async () => {
  await withHome(async (home) => {
    const conflict = {
      homes: [
        { path: "/Users/alice/.slock", agentCount: 1 },
        { path: "/Users/alice/.raft", agentCount: 2 },
      ],
    };
    const withConflict = await runDoctorChecks(home, { findDuplicateKeyHolder: async () => null, findRaftHomeConflict: () => conflict });
    const found = withConflict.find((c) => c.name === "Raft home");
    assert.ok(found);
    assert.equal(found.ok, false);
    assert.match(found.detail, /RAFT_HOME=/);

    const clean = await runDoctorChecks(home, { findDuplicateKeyHolder: async () => null, findRaftHomeConflict: () => null });
    assert.equal(clean.find((c) => c.name === "Raft home"), undefined);
  });
});

// Device-auth PR 3c: the "this Computer on the server" line is read with the
// attachment's own key (GET /internal/computer/self), with no user session.
async function startSelfServer(
  self: { status: number; body: Record<string, unknown> },
): Promise<{ server: Server; baseUrl: string; selfAuth: Array<string | undefined> }> {
  const selfAuth: Array<string | undefined> = [];
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/internal/computer/preflight") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/internal/computer/self") {
        selfAuth.push(req.headers.authorization);
        res.writeHead(self.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(self.body));
        return;
      }
      res.writeHead(404).end();
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no test server address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, selfAuth };
}

test("doctor: the server's view of this Computer is read with its own key, without a user session", async () => {
  await withHome(async (home) => {
    const ctx = await startSelfServer({
      status: 200,
      body: { computer: { computerId: "cm-1", computerName: "laptop", serverId: SERVER_A, machineId: MACHINE_A, machineName: "laptop", agentCount: 3 } },
    });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl, machineId: MACHINE_A });
      const checks = await runDoctorChecks(home);
      const self = checks.find((c) => c.name === "computer /alpha");
      assert.deepEqual(self, { name: "computer /alpha", ok: true, detail: 'the server knows this Computer as "laptop" (3 agents)' });
      assert.deepEqual(ctx.selfAuth, [`Bearer ${SECRET_KEY}`]);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: a server tying the key to another machine is red; an older server is a note", async () => {
  await withHome(async (home) => {
    const ctx = await startSelfServer({
      status: 200,
      body: { computer: { computerId: "cm-1", computerName: "laptop", serverId: SERVER_A, machineId: MACHINE_B, machineName: "other", agentCount: 0 } },
    });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl, machineId: MACHINE_A });
      const self = (await runDoctorChecks(home)).find((c) => c.name === "computer /alpha");
      assert.equal(self?.ok, false);
      assert.match(self?.detail ?? "", /ties this key to machine bbbbbbbb/);
      assert.match(self?.detail ?? "", /raft-computer doctor \/alpha --migration-details/);
    } finally {
      await stop(ctx.server);
    }
  });
  await withHome(async (home) => {
    // An older server: the internal prefix refuses the unknown route.
    const ctx = await startSelfServer({ status: 401, body: { code: "auth_policy_unregistered_path" } });
    try {
      await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "alpha", serverUrl: ctx.baseUrl, machineId: MACHINE_A });
      const self = (await runDoctorChecks(home)).find((c) => c.name === "computer /alpha");
      assert.equal(self?.ok, true);
      assert.match(self?.detail ?? "", /skipped \(this server is older/);
    } finally {
      await stop(ctx.server);
    }
  });
});

test("doctor: the regret check takes this Computer's own row from its key", async () => {
  await withHome(async (home) => {
    await writeUserSessionForServer(home, "tok", "https://api.example.test");
    await writeAttach(home, SERVER_A, SECRET_KEY, { serverSlug: "botiverse", serverUrl: "https://api.example.test", machineId: MACHINE_B });
    const checks = await runDoctorChecks(home, {
      detectMigration: async () => ({
        kind: "matched",
        candidates: [{ apiKeyFingerprint: FP_A, daemonId: MACHINE_A, localPath: "owner.json", machineName: "old-daemon" }],
        excluded: [],
      }),
      readComputerSelf: async () => ({
        status: "success",
        computer: { computerId: "cm-1", computerName: "fresh", serverId: SERVER_A, machineId: MACHINE_B, machineName: "fresh-computer", agentCount: 0 },
      }),
      // The person's list no longer shows this Computer; its own key still does.
      listServerMachines: async () => ({
        status: "success",
        machines: [{ id: MACHINE_A, name: "old-daemon", createdAt: null, isComputer: false, computerAttachedByCurrentUser: false, agentCount: 2 }],
      }),
    });
    const identity = checks.find((c) => c.name === "identity /botiverse");
    assert.match(identity?.detail ?? "", /connected as "fresh-computer" \(0 agents\)/);
  });
});

test("doctor --json: one JSON line with redacted details; it ran, so the outcome is allOk, not the exit", async () => {
  await withHome(async (home) => {
    const p = userSessionPath(home);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, '{"kind":"user-session","userId":"abc","acce');
    const cap = captureOut();
    try {
      await runDoctorJson({});
    } finally {
      cap.restore();
    }
    const report = JSON.parse(cap.text().trim()) as { checks: Array<{ name: string; ok: boolean; detail: string }>; allOk: boolean; cleaned: unknown; cliVersion: string; ranAt: string };
    assert.equal(report.allOk, false);
    assert.equal(report.cleaned, null);
    assert.equal(typeof report.cliVersion, "string");
    assert.ok(!Number.isNaN(Date.parse(report.ranAt)));
    const userSession = report.checks.find((c) => c.name === "user session");
    assert.equal(userSession?.ok, false);
    assert.ok(!cap.text().includes("abc"), "never echoes the corrupted session");
  });
});
