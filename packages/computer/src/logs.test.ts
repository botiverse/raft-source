import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { runLogs } from "./logs.js";
import {
  legacyServerRunnerLogPath,
  serverAttachmentPath,
  serverRunnerLogPath,
  serviceLogPath,
} from "./paths.js";
import { CliExit } from "./output.js";

// task #30 PR-G regression — per-server `logs` (v4 §7). Pins:
// fail-closed when no log, --lines tail, SECRET REDLINE, --service
// mode, and the per-server selection rule (≥2 attached + no --server
// → AMBIGUOUS_SERVER).

const SECRET_KEY = "sk_computer_LOGS-MUST-NOT-PRINT-0123456789abcdef";
const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-logs-"));
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

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => { buf += String(c); return true; });
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = oo; process.stderr.write = oe; }, text: () => buf };
}

async function writeAttach(home: string, serverId: string): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "computer-attachment", serverId, serverMachineId: `cm-${serverId}`,
    apiKey: `sk_computer_${serverId}`, serverUrl: "http://127.0.0.1:1",
  }));
}

async function writeServerLog(home: string, serverId: string, body: string): Promise<void> {
  const p = serverRunnerLogPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body);
}

async function writeLegacyServerLog(home: string, serverId: string, body: string): Promise<void> {
  const p = legacyServerRunnerLogPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body);
}

test("logs: no attached servers → fail-closed NO_ATTACHMENT", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(() => runLogs({}), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NO_ATTACHMENT/);
  });
});

test("logs: 1 attached + no log file yet → fail-closed NO_DAEMON_LOG", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const cap = captureOut();
    try {
      await assert.rejects(() => runLogs({}), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NO_DAEMON_LOG/);
  });
});

test("logs: --lines tails the last N lines of the per-server daemon log", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeServerLog(home, SERVER_A, ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n");
    const cap = captureOut();
    try {
      await runLogs({ lines: 2 });
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.ok(out.includes("l4") && out.includes("l5"));
    assert.ok(!out.includes("l1"));
  });
});

test("logs: falls back to legacy server-runner.log during version-split window", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeLegacyServerLog(home, SERVER_A, "legacy-only-line\n");
    const cap = captureOut();
    try {
      await runLogs({});
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /legacy-only-line/);
  });
});

test("logs: SECRET REDLINE — sk_* in a log line is redacted in-place", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeServerLog(home, SERVER_A, `2026-05-20 connecting key=${SECRET_KEY} ok\n`);
    const cap = captureOut();
    try {
      await runLogs({});
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.ok(!out.includes(SECRET_KEY), "leaked sk_computer_* from the log");
    assert.ok(out.includes("***REDACTED***"));
  });
});

test("logs: ≥2 attached without --server → AMBIGUOUS_SERVER", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    const cap = captureOut();
    try {
      await assert.rejects(() => runLogs({}), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /AMBIGUOUS_SERVER/);
  });
});

test("logs --service: reads service.log, redacted, missing → NO_DAEMON_LOG", async () => {
  await withHome(async (home) => {
    // No service.log yet → fail-closed.
    const cap1 = captureOut();
    try {
      await assert.rejects(() => runLogs({ service: true }), (e) => e instanceof CliExit);
    } finally {
      cap1.restore();
    }
    assert.match(cap1.text(), /NO_DAEMON_LOG/);

    // Now write service.log with a secret → redacted.
    const sp = serviceLogPath(home);
    await mkdir(join(sp, ".."), { recursive: true });
    await writeFile(sp, `service up; key=${SECRET_KEY}\n`);
    const cap2 = captureOut();
    try {
      await runLogs({ service: true });
    } finally {
      cap2.restore();
    }
    const out = cap2.text();
    assert.ok(!out.includes(SECRET_KEY));
    assert.ok(out.includes("***REDACTED***"));
  });
});
