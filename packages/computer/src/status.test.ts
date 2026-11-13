import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStatusReport, formatStatusReport, runStatus } from "./status";
import { servicePidPath, serverConnectedMarkerPath } from "./paths";
import { markFatalConfig, markTerminalUnlinked } from "./health";
import { DEFAULT_SLOCK_SERVER_URL, LEGACY_PRODUCTION_SERVER_URL } from "./serverUrl";
import { COMPUTER_VERSION } from "./version";

// task #30 PR-G regression guard — Computer-level aggregate `status`.
// Pins: fresh state, per-server aggregation, daemon liveness from
// per-server pidfile, service liveness, and the SECRET REDLINE
// (the report must never carry user access token or any sk_computer_*).

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";
const SECRET_TOKEN = "user-access-token-DO-NOT-LEAK-abc123";
const SECRET_KEY_A = "sk_computer_AAA-DO-NOT-LEAK-aaaaaaaaaaaa";
const SECRET_KEY_B = "sk_computer_BBB-DO-NOT-LEAK-bbbbbbbbbbbb";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-status-"));
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

async function writeUnder(home: string, rel: string, body: string): Promise<void> {
  const p = join(home, "computer", rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body);
}

async function writeAttach(home: string, serverId: string, apiKey: string, url = "https://api.example.test"): Promise<void> {
  await writeUnder(
    home,
    `servers/${serverId}/runner.state.json`,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverMachineId: `cm-${serverId}`,
      apiKey,
      serverUrl: url,
      attachedAt: "2026-05-20T00:00:00.000Z",
    }),
  );
}

test("status: fresh home → not logged in, service stopped, no attachments", async () => {
  await withHome(async (home) => {
    const r = await buildStatusReport(home);
    assert.equal(r.slockHome, home);
    assert.equal(r.cliVersion, COMPUTER_VERSION);
    assert.equal(r.loggedIn, false);
    assert.equal(r.userId, null);
    assert.equal(r.service.running, false);
    assert.equal(r.service.version.version, null);
    assert.equal(r.service.logPath, join(home, "computer", "run", "service.log"));
    assert.deepEqual(r.servers, []);
  });
});

test("status: user session present → loggedIn; tokens NEVER carried in report", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      refreshToken: "refresh-secret",
      serverUrl: "https://api.example.test",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.loggedIn, true);
    assert.equal(r.userId, "user-42");
    assert.equal(r.loginServerUrl, "https://api.example.test");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(SECRET_TOKEN), "leaked accessToken");
    assert.ok(!blob.includes("refresh-secret"), "leaked refreshToken");
  });
});

test("status: legacy production URLs are displayed as the canonical Raft API URL", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: LEGACY_PRODUCTION_SERVER_URL,
    }));
    await writeAttach(home, SERVER_A, SECRET_KEY_A, LEGACY_PRODUCTION_SERVER_URL);

    const r = await buildStatusReport(home);
    assert.equal(r.loginServerUrl, DEFAULT_SLOCK_SERVER_URL);
    assert.equal(r.servers[0]?.serverUrl, DEFAULT_SLOCK_SERVER_URL);
  });
});

test("status: surfaces the session's display identity (task #112: name/displayName/email)", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: "https://api.example.test",
      name: "cindy zhao",
      displayName: "Cindy",
      email: "cindy@example.io",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.userName, "cindy zhao");
    assert.equal(r.userDisplayName, "Cindy");
    assert.equal(r.userEmail, "cindy@example.io");
  });
});

test("status: older session without display identity → name/displayName/email null (fallback path)", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      serverUrl: "https://api.example.test",
    }));
    const r = await buildStatusReport(home);
    assert.equal(r.userName, null);
    assert.equal(r.userDisplayName, null);
    assert.equal(r.userEmail, null);
  });
});

test("status: corrupted user-session.json is explicit and secret-free", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", '{"kind":"user-session","userId":"abc","acce');
    const r = await buildStatusReport(home);
    assert.equal(r.loggedIn, false);
    assert.equal(r.userId, null);
    assert.equal(r.loginServerUrl, null);
    assert.match(r.userSessionError ?? "", /JSON/);

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }
    const out = lines.join("");
    assert.match(out, /user session file is invalid/);
    assert.match(out, /raft-computer attach/);
    assert.ok(!out.includes("abc"), "human output should not echo corrupted session content");
  });
});

test("status: multiple attachments → servers[] aggregates; sk_computer_* NEVER in report", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeAttach(home, SERVER_B, SECRET_KEY_B);
    const r = await buildStatusReport(home);
    assert.equal(r.servers.length, 2);
    const ids = r.servers.map((s) => s.serverId).sort();
    assert.deepEqual(ids, [SERVER_A, SERVER_B]);
    for (const s of r.servers) {
      assert.equal(s.daemon.running, false);
      assert.equal(s.serverRunnerLogPath, join(home, "computer", "servers", s.serverId, "runner.log"));
    }
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(SECRET_KEY_A), "leaked sk_computer_* (A)");
    assert.ok(!blob.includes(SECRET_KEY_B), "leaked sk_computer_* (B)");
  });
});

test("status: JSON report includes derived log paths", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    const r = JSON.parse(JSON.stringify(await buildStatusReport(home)));
    assert.equal(r.service.logPath, join(home, "computer", "run", "service.log"));
    assert.equal(
      r.servers[0].serverRunnerLogPath,
      join(home, "computer", "servers", SERVER_A, "runner.log"),
    );
  });
});

test("status: human output prints service and per-server server-runner log paths", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "user-session.json", JSON.stringify({
      kind: "user-session",
      userId: "user-42",
      accessToken: SECRET_TOKEN,
      refreshToken: "refresh-secret",
      serverUrl: "https://api.example.test",
    }));
    await writeUnder(
      home,
      `servers/${SERVER_A}/runner.state.json`,
      JSON.stringify({
        kind: "computer-attachment",
        serverId: SERVER_A,
        serverSlug: "alpha",
        serverMachineId: `cm-${SERVER_A}`,
        apiKey: SECRET_KEY_A,
        serverUrl: "https://api.example.test",
        attachedAt: "2026-05-20T00:00:00.000Z",
      }),
    );

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }

    const out = lines.join("");
    assert.match(out, new RegExp(`Service log: ${join(home, "computer", "run", "service\\.log")}`));
    assert.match(out, /\/alpha\s+offline\s+no\s+stopped/);
    assert.match(
      out,
      new RegExp(`Server runner log: ${join(home, "computer", "servers", SERVER_A, "runner\\.log")}`),
    );
    assert.ok(!out.includes(SECRET_TOKEN), "human output leaked accessToken");
    assert.ok(!out.includes(SECRET_KEY_A), "human output leaked sk_computer_*");
  });
});

test("status: live pidfiles → service + per-server server-runner report running", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    const r = await buildStatusReport(home);
    assert.equal(r.service.running, true);
    assert.equal(r.service.running === true && r.service.pid, process.pid);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, true);
  });
});

test("status: live service and runner version evidence are surfaced separately", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, "service-version.json", JSON.stringify({
      version: "0.0.73",
      installRoot: "/old/service",
      pid: process.pid,
      writtenAt: "2026-07-06T00:00:00.000Z",
    }));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner-version.json`, JSON.stringify({
      version: "0.0.74",
      installRoot: "/new/runner",
      pid: process.pid,
      writtenAt: "2026-07-06T00:00:01.000Z",
    }));

    // No service answers in this home; the service started before it wrote its evidence.
    const r = await buildStatusReport(home, { processStartTimeMs: async () => Date.parse("2026-07-06T00:00:00.000Z") });
    assert.equal(r.service.version.version, "0.0.73");
    assert.equal(r.service.version.evidencePid, process.pid);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.runnerVersion.version, "0.0.74");
    assert.equal(sa?.runnerVersion.evidencePid, process.pid);
  });
});

test("status: stale version evidence is not reported as live", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, "service-version.json", JSON.stringify({
      version: "0.0.1",
      installRoot: "/stale",
      pid: 999999999,
      writtenAt: "2026-07-06T00:00:00.000Z",
    }));
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner-version.json`, JSON.stringify({
      version: "0.0.1",
      installRoot: "/stale",
      pid: 999999999,
      writtenAt: "2026-07-06T00:00:01.000Z",
    }));

    const r = await buildStatusReport(home);
    assert.equal(r.service.version.version, null);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.runnerVersion.version, null);
  });
});

test("status: legacy server-runner pid/log remain visible during version-split window", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/server-runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/server-runner.log`, "legacy runner log\n");
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, true);
    assert.equal(
      sa?.serverRunnerLogPath,
      join(home, "computer", "servers", SERVER_A, "server-runner.log"),
    );
  });
});

test("status: malformed runner.state.json → that server is skipped; others OK", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_B}/runner.state.json`, "{ not json");
    const r = await buildStatusReport(home);
    assert.deepEqual(r.servers.map((s) => s.serverId), [SERVER_A]);
  });
});

// `deriveHealth` order regression. crash-budget-tripped runners are parked
// by the supervisor — they have NO live pid. Earlier the order checked
// liveness first, so a degraded-and-parked runner came back as `offline`,
// hiding the fact that it needs explicit retry to recover. Honest tray icons +
// glance-and-fix UX both depend on judging `degraded` first.
test("status: degraded runner with no live pid → health=degraded, NOT offline", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // Trip the degraded marker (fatalConfig forces isDegraded=true regardless
    // of crash budget). Don't write a runner.pid → daemon.running=false.
    await markFatalConfig(home, SERVER_A, 78, null);
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.health, "degraded", "degraded must win over no-pid-offline");
  });
});

test("status: terminal unlinked marker → health=unlinked, not generic disconnected", async () => {
  await withHome(async (home) => {
    await writeUnder(
      home,
      `servers/${SERVER_A}/runner.state.json`,
      JSON.stringify({
        kind: "computer-attachment",
        serverId: SERVER_A,
        serverSlug: "alpha",
        serverMachineId: `cm-${SERVER_A}`,
        apiKey: SECRET_KEY_A,
        serverUrl: "https://api.example.test",
        attachedAt: "2026-05-20T00:00:00.000Z",
      }),
    );
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(sa);
    assert.equal(sa.daemon.running, true);
    assert.equal(sa.serverConnected, false);
    assert.equal(sa.health, "unlinked");

    const lines: string[] = [];
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStatus();
    } finally {
      process.stdout.write = oldWrite;
    }
    const out = lines.join("");
    assert.match(out, /\/alpha\s+unlinked\s+no\s+running \(pid \d+\)/);
    assert.match(out, /server deleted\/unlinked this Computer or machine/);
    assert.match(out, /raft-computer setup \/<serverSlug>/);
    assert.match(out, /raft-computer status \/<serverSlug>/);
    assert.doesNotMatch(out, /back up|move the stale/i);
  });
});

test("status: not degraded + no live pid → health=offline (cold attachment)", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // No degraded marker, no runner.pid — the cold-attachment / service-
    // not-managing case stays `offline`.
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.health, "offline");
  });
});

test("status: no connected marker → serverConnected=false", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.serverConnected, false);
  });
});

test("status: connected marker + live pid → serverConnected=true", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    await writeUnder(home, `servers/${SERVER_A}/runner.pid`, String(process.pid));
    await writeUnder(home, `servers/${SERVER_A}/runner.connected`, String(Date.now()));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.serverConnected, true);
  });
});

test("status: stale connected marker + dead pid → serverConnected=false", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, SECRET_KEY_A);
    // Marker exists but no live runner.pid — runner crashed without cleanup.
    await writeUnder(home, `servers/${SERVER_A}/runner.connected`, String(Date.now()));
    const r = await buildStatusReport(home);
    const sa = r.servers.find((s) => s.serverId === SERVER_A);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.serverConnected, false, "stale marker with dead process must not report connected");
  });
});

// A runner that died without its service (Windows sign-out) leaves runner.pid,
// runner-version.json and runner.connected behind; Windows then gave the pid
// to an unrelated program and status reported `ok / yes / running`.
const RUNNER_RECORDED_AT = "2026-11-13T08:00:00.000Z";

async function writeRecordedRunner(home: string, serverId: string): Promise<void> {
  await writeUnder(
    home,
    `servers/${serverId}/runner.state.json`,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverSlug: "alpha",
      serverMachineId: `cm-${serverId}`,
      apiKey: SECRET_KEY_A,
      serverUrl: "https://api.example.test",
    }),
  );
  await writeUnder(home, `servers/${serverId}/runner.pid`, String(process.pid));
  await writeUnder(home, `servers/${serverId}/runner.connected`, JSON.stringify({ pid: process.pid, connectedAt: Date.parse(RUNNER_RECORDED_AT) }));
  await writeUnder(home, `servers/${serverId}/runner-version.json`, JSON.stringify({
    version: "1.22.0",
    installRoot: "/runner",
    pid: process.pid,
    writtenAt: RUNNER_RECORDED_AT,
  }));
}

function captureStatusLines(report: Awaited<ReturnType<typeof buildStatusReport>>): string {
  const lines: string[] = [];
  const oldWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    formatStatusReport(report);
  } finally {
    process.stdout.write = oldWrite;
  }
  return lines.join("");
}

test("status: service stopped, a live pid whose process started after the runner's record is another process → offline / no / stopped", async () => {
  await withHome(async (home) => {
    await writeRecordedRunner(home, SERVER_A);
    const r = await buildStatusReport(home, {
      processStartTimeMs: async () => Date.parse(RUNNER_RECORDED_AT) + 12 * 60_000,
    });
    const sa = r.servers[0];
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.serverConnected, false);
    assert.equal(sa?.health, "offline");
    assert.equal(sa?.runnerVersion.version, null, "the dead runner's version is not live evidence");
    assert.match(captureStatusLines(r), /\/alpha\s+offline\s+no\s+stopped/);
  });
});

// Raft Desktop asks for status every 5 s, and reading a start is a PowerShell
// start per server on Windows: never while the service runs.
test("status: service running, a recorded runner pid's start is not read and it stays running", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeRecordedRunner(home, SERVER_A);
    let read = 0;
    const r = await buildStatusReport(home, {
      processStartTimeMs: async () => { read += 1; return Date.parse(RUNNER_RECORDED_AT) + 12 * 60_000; },
    });
    assert.equal(read, 0);
    assert.equal(r.service.running, true);
    assert.deepEqual(r.servers[0]?.daemon, { running: true, pid: process.pid });
    assert.equal(r.servers[0]?.serverConnected, true);
    assert.equal(r.servers[0]?.health, "ok");
    assert.match(captureStatusLines(r), /\/alpha\s+ok\s+yes\s+running \(pid \d+\)/);
  });
});

test("status: service stopped, a live recorded pid stays the runner when it started before its record, or its start cannot be read", async () => {
  await withHome(async (home) => {
    await writeRecordedRunner(home, SERVER_A);
    for (const startedAtMs of [
      Date.parse(RUNNER_RECORDED_AT) - 2_000, // the runner itself
      Date.parse(RUNNER_RECORDED_AT) + 4_000, // within how a start is measured
      undefined, // unreadable: never "reused"
    ]) {
      const r = await buildStatusReport(home, { processStartTimeMs: async () => startedAtMs });
      const sa = r.servers[0];
      assert.deepEqual(sa?.daemon, { running: true, pid: process.pid }, String(startedAtMs));
      assert.equal(sa?.serverConnected, true);
      assert.equal(sa?.health, "ok");
      assert.equal(sa?.runnerVersion.version, "1.22.0");
      assert.match(captureStatusLines(r), /\/alpha\s+ok\s+yes\s+running \(pid \d+\)/);
    }
  });
});

test("status: service stopped, a live pid with no record of its own is not probed and stays running", async () => {
  await withHome(async (home) => {
    await writeRecordedRunner(home, SERVER_A);
    // Evidence left by an earlier runner: nothing says when this pid's runner started.
    await writeUnder(home, `servers/${SERVER_A}/runner-version.json`, JSON.stringify({
      version: "1.22.0",
      installRoot: "/runner",
      pid: 999999999,
      writtenAt: RUNNER_RECORDED_AT,
    }));
    let probed = 0;
    const r = await buildStatusReport(home, {
      processStartTimeMs: async () => { probed += 1; return Date.parse(RUNNER_RECORDED_AT) + 12 * 60_000; },
    });
    assert.equal(probed, 0);
    assert.equal(r.servers[0]?.daemon.running, true);
    assert.equal(r.servers[0]?.serverConnected, true);
  });
});

// The service, deferring to whoever holds the daemon machine lock, writes that
// holder's pid into runner.pid (runnerLockConflict.ts). On a real Windows
// machine the holder was explorer.exe and status printed `ok / yes / running
// (pid 7720)` from it and from the previous runner's connected marker.
// `extra`: fields a build that once recorded a verdict in the record left behind.
async function writeDeferredLockHolder(
  home: string,
  serverId: string,
  servicePid = process.pid,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeRecordedRunner(home, serverId);
  await writeUnder(home, `servers/${serverId}/runner.lock-conflict.json`, JSON.stringify({
    servicePid,
    ownerPid: process.pid,
    lockPath: "/raft/machines/machine-x/daemon.lock",
    recordedAt: Date.parse(RUNNER_RECORDED_AT),
    ...extra,
  }));
}

async function writeEarlierRunnerRecords(home: string, serverId: string): Promise<void> {
  await writeUnder(home, `servers/${serverId}/runner.connected`, JSON.stringify({ pid: 999999999, connectedAt: Date.parse(RUNNER_RECORDED_AT) }));
  await writeUnder(home, `servers/${serverId}/runner-version.json`, JSON.stringify({
    version: "1.22.0",
    installRoot: "/runner",
    pid: 999999999,
    writtenAt: RUNNER_RECORDED_AT,
  }));
}

test("status: the lock holder the service defers to is not its runner → offline / no / lock held (pid N)", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeDeferredLockHolder(home, SERVER_A);
    await writeEarlierRunnerRecords(home, SERVER_A);
    const r = await buildStatusReport(home);
    const sa = r.servers[0];
    assert.equal(r.service.running, true);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.lockHeldByPid, process.pid);
    assert.equal(sa?.serverConnected, false);
    assert.equal(sa?.health, "offline");
    const out = captureStatusLines(r);
    assert.match(out, new RegExp(`/alpha\\s+offline\\s+no\\s+lock held \\(pid ${process.pid}\\)`));
    assert.match(out, /a process the Computer service did not start holds this machine's daemon lock and could not be confirmed as that server's runner, so the service started no runner for them/);
    assert.match(out, /raft-computer doctor/);
  });
});

// After `raft-computer stop` the same machine still printed `ok / yes /
// running (pid 7720)`: the holder's pid stays in runner.pid.
test("status: with the service stopped, the lock holder it deferred to is still only the lock's holder", async () => {
  await withHome(async (home) => {
    await writeDeferredLockHolder(home, SERVER_A, 999999998);
    await writeEarlierRunnerRecords(home, SERVER_A);
    const r = await buildStatusReport(home);
    const sa = r.servers[0];
    assert.equal(r.service.running, false);
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.lockHeldByPid, process.pid);
    assert.equal(sa?.serverConnected, false);
    assert.equal(sa?.health, "offline");
    assert.match(captureStatusLines(r), new RegExp(`/alpha\\s+offline\\s+no\\s+lock held \\(pid ${process.pid}\\)`));
  });
});

test("status: a deferred-to lock holder that is this server's own runner is the runner, connected only by its own marker", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeDeferredLockHolder(home, SERVER_A);
    const deps = { processStartTimeMs: async () => Date.parse(RUNNER_RECORDED_AT) - 2_000 };

    const adopted = await buildStatusReport(home, deps);
    assert.deepEqual(adopted.servers[0]?.daemon, { running: true, pid: process.pid });
    assert.equal(adopted.servers[0]?.lockHeldByPid, undefined);
    assert.equal(adopted.servers[0]?.serverConnected, true);
    assert.match(captureStatusLines(adopted), /\/alpha\s+ok\s+yes\s+running \(pid \d+\)/);

    // An earlier runner's marker says nothing about this one: it is the runner, not connected.
    await writeUnder(home, `servers/${SERVER_A}/runner.connected`, JSON.stringify({ pid: 999999999, connectedAt: 1 }));
    const disconnected = await buildStatusReport(home, deps);
    assert.deepEqual(disconnected.servers[0]?.daemon, { running: true, pid: process.pid });
    assert.equal(disconnected.servers[0]?.lockHeldByPid, undefined);
    assert.equal(disconnected.servers[0]?.serverConnected, false);
    const out = captureStatusLines(disconnected);
    assert.match(out, /\/alpha\s+ok\s+no\s+running \(pid \d+\)/);
    assert.doesNotMatch(out, /lock held/);
  });
});

// "An unreadable start changes nothing" (always the case on Linux): a
// deferred-to pid that runner-version.json names is shown exactly as before
// starts were read, running, and connected only by its own marker.
test("status: a deferred-to lock holder whose start cannot be read is shown as before: running, connected by its own marker", async () => {
  for (const serviceRunning of [true, false]) {
    await withHome(async (home) => {
      if (serviceRunning) await writeUnder(home, "run/service.pid", String(process.pid));
      await writeDeferredLockHolder(home, SERVER_A);
      const unreadable = { processStartTimeMs: async () => undefined };

      const own = await buildStatusReport(home, unreadable);
      assert.deepEqual(own.servers[0]?.daemon, { running: true, pid: process.pid });
      assert.equal(own.servers[0]?.deferredOwner, "unread");
      assert.equal(own.servers[0]?.lockHeldByPid, undefined);
      assert.match(captureStatusLines(own), /\/alpha\s+ok\s+yes\s+running \(pid \d+\)/);

      await writeUnder(home, `servers/${SERVER_A}/runner.connected`, JSON.stringify({ pid: 999999999, connectedAt: 1 }));
      const other = captureStatusLines(await buildStatusReport(home, unreadable));
      assert.match(other, /\/alpha\s+ok\s+no\s+running \(pid \d+\)/);
      assert.doesNotMatch(other, /lock held/);
    });
  }
});

// A build that recorded a verdict in the conflict record may have left one
// there. The record outlives its service (a power loss) and the pid is another
// program's by now: nothing in the record vouches for it, the start is read.
test("status: a verdict left in the conflict record is ignored: the owner is judged by its start, with the service running or stopped", async () => {
  for (const serviceRunning of [true, false]) {
    for (const leftover of [
      { ownerVerdict: { owner: "own-runner", evidenceAt: RUNNER_RECORDED_AT } },
      { owner: "runner", ownerEvidenceAt: RUNNER_RECORDED_AT },
    ]) {
      await withHome(async (home) => {
        if (serviceRunning) await writeUnder(home, "run/service.pid", String(process.pid));
        await writeDeferredLockHolder(home, SERVER_A, process.pid, leftover);
        let reads = 0;
        const r = await buildStatusReport(home, {
          processStartTimeMs: async () => { reads += 1; return Date.parse(RUNNER_RECORDED_AT) + 60_000; },
        });
        assert.equal(reads, 1, JSON.stringify(leftover));
        assert.equal(r.servers[0]?.daemon.running, false);
        assert.equal(r.servers[0]?.deferredOwner, "another-program");
        assert.match(captureStatusLines(r), new RegExp(`/alpha\\s+offline\\s+no\\s+lock held \\(pid ${process.pid}\\)`));
      });
    }
  }
});

// A record that names another pid says nothing about the pid in runner.pid.
test("status: service stopped, a conflict record for another pid does not vouch for the recorded runner pid", async () => {
  await withHome(async (home) => {
    await writeRecordedRunner(home, SERVER_A);
    await writeUnder(home, `servers/${SERVER_A}/runner.lock-conflict.json`, JSON.stringify({
      servicePid: 999999998, ownerPid: process.ppid, lockPath: null, recordedAt: 1,
    }));
    let reads = 0;
    const r = await buildStatusReport(home, {
      processStartTimeMs: async () => { reads += 1; return Date.parse(RUNNER_RECORDED_AT) + 60_000; },
    });
    assert.equal(reads, 1);
    assert.equal(r.servers[0]?.daemon.running, false);
    assert.equal(r.servers[0]?.lockHeldByPid, undefined);
  });
});

// After an unclean runner death the lock, runner-version.json and
// runner.connected all name the dead runner's pid. The daemon keeps a lock it
// cannot disprove, the service defers and writes that pid into runner.pid:
// with the service running, status printed ok / yes / running for it.
test("status: service running, a deferred-to lock holder whose pid is the dead runner's is only the lock's holder: its start is read", async () => {
  await withHome(async (home) => {
    await writeUnder(home, "run/service.pid", String(process.pid));
    await writeDeferredLockHolder(home, SERVER_A);
    let reads = 0;
    const r = await buildStatusReport(home, {
      processStartTimeMs: async () => { reads += 1; return Date.parse(RUNNER_RECORDED_AT) + 60_000; },
    });
    const sa = r.servers[0];
    assert.equal(r.service.running, true);
    assert.equal(reads, 1, "one read for the pid, although the service is running");
    assert.equal(sa?.daemon.running, false);
    assert.equal(sa?.lockHeldByPid, process.pid);
    assert.equal(sa?.serverConnected, false);
    assert.equal(sa?.health, "offline");
    assert.match(captureStatusLines(r), new RegExp(`/alpha\\s+offline\\s+no\\s+lock held \\(pid ${process.pid}\\)`));
  });
});

// A service that ended with its Windows sign-in session leaves run/service.pid
// and service-version.json behind, and the pid goes to an unrelated program:
// status said `Service: running (pid N)`.
async function writeRecordedService(home: string): Promise<void> {
  await writeUnder(home, "run/service.pid", String(process.pid));
  await writeUnder(home, "service-version.json", JSON.stringify({
    version: "1.22.0",
    installRoot: "/service",
    pid: process.pid,
    writtenAt: RUNNER_RECORDED_AT,
  }));
}

test("status: a live recorded service pid that does not answer and started after the service's evidence is another program → service stopped", async () => {
  await withHome(async (home) => {
    await writeRecordedService(home);
    await writeRecordedRunner(home, SERVER_A);
    let reads = 0;
    const r = await buildStatusReport(home, {
      endpointAnswers: async () => false,
      processStartTimeMs: async () => { reads += 1; return Date.parse(RUNNER_RECORDED_AT) + 12 * 60_000; },
    });
    assert.equal(reads, 1, "the service record and the runner record name one pid: one read");
    assert.equal(r.service.running, false);
    assert.equal(r.service.version.version, null);
    // The runner record names the same reused pid: with the service stopped its start is read too.
    assert.equal(r.servers[0]?.daemon.running, false);
    const out = captureStatusLines(r);
    assert.match(out, /Service:\s+stopped — run `raft-computer start`/);
    assert.match(out, /\/alpha\s+offline\s+no\s+stopped/);
    assert.equal(await readFile(join(home, "computer", "run", "service.pid"), "utf8"), String(process.pid), "status changes nothing on disk");
  });
});

test("status: a live recorded service pid is running when the service answers (no start is read), started before its evidence, or cannot be read", async () => {
  await withHome(async (home) => {
    await writeRecordedService(home);
    for (const [serviceAnswers, startedAtMs, startReads] of [
      [true, Date.parse(RUNNER_RECORDED_AT) + 12 * 60_000, 0],
      [false, Date.parse(RUNNER_RECORDED_AT) - 2_000, 1],
      [false, undefined, 1],
    ] as const) {
      let reads = 0;
      const r = await buildStatusReport(home, {
        endpointAnswers: async () => serviceAnswers,
        processStartTimeMs: async () => { reads += 1; return startedAtMs; },
      });
      assert.deepEqual({ running: r.service.running, version: r.service.version.version }, { running: true, version: "1.22.0" });
      assert.equal(reads, startReads, "the common path (a service that answers) reads no start");
    }
  });
});
