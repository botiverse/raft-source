import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  recordCrash,
  readCrashHistory,
  isDegraded,
  resetHealth,
  markFatalConfig,
  readFatalConfig,
  markTerminalUnlinked,
  readTerminalUnlinked,
  classifyTerminalHandshakeRejection,
  CRASH_WINDOW_MS,
  DEGRADED_THRESHOLD,
} from "./health.js";
import { serverAttachmentPath, serverHealthPath } from "./paths.js";

// PR-H §3.3 regression guard — per-server crash history + degraded detection.

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_MACHINE_A = `cm-${SERVER_A}`;

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "slock-pr-h-health-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    // Need a per-server dir to anchor health.json into
    await mkdir(join(home, "computer", "servers", SERVER_A), { recursive: true });
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

test("recordCrash + readCrashHistory: appends entry; entries persist within window", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    await recordCrash(home, SERVER_A, 1, null, now);
    const recent = await readCrashHistory(home, SERVER_A, now + 1000);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].exitCode, 1);
  });
});

test("readCrashHistory: prunes entries older than crash-window", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    // 90s ago — outside the 60s window
    await recordCrash(home, SERVER_A, 1, null, now - 90_000);
    // Within window
    await recordCrash(home, SERVER_A, 2, null, now - 30_000);
    const recent = await readCrashHistory(home, SERVER_A, now);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].exitCode, 2);
  });
});

test("isDegraded: < threshold → false", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    await recordCrash(home, SERVER_A, 1, null, now);
    await recordCrash(home, SERVER_A, 1, null, now);
    assert.equal(await isDegraded(home, SERVER_A, now + 1000), false);
  });
});

test("isDegraded: at threshold → true", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    for (let i = 0; i < DEGRADED_THRESHOLD; i++) {
      await recordCrash(home, SERVER_A, 1, null, now);
    }
    assert.equal(await isDegraded(home, SERVER_A, now + 1000), true);
  });
});

test("isDegraded: above-threshold crashes but all older than window → false", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    for (let i = 0; i < DEGRADED_THRESHOLD + 2; i++) {
      await recordCrash(home, SERVER_A, 1, null, now - CRASH_WINDOW_MS - 1000);
    }
    assert.equal(await isDegraded(home, SERVER_A, now), false);
  });
});

test("resetHealth: deletes the health.json — degraded state cleared", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    for (let i = 0; i < DEGRADED_THRESHOLD; i++) {
      await recordCrash(home, SERVER_A, 1, null, now);
    }
    assert.equal(await isDegraded(home, SERVER_A, now + 1000), true);
    await resetHealth(home, SERVER_A);
    assert.equal(await isDegraded(home, SERVER_A, now + 1000), false);
    // Re-resetting is a no-op
    await resetHealth(home, SERVER_A);
  });
});

test("recordCrash: invalid serverId → no-op (does not write)", async () => {
  await withHome(async (home) => {
    await recordCrash(home, "not-a-uuid", 1, null);
    // No crash history readable for invalid id
    const recent = await readCrashHistory(home, "not-a-uuid");
    assert.deepEqual(recent, []);
  });
});

void serverAttachmentPath;
void serverHealthPath;

// ---------- markFatalConfig (task #48 #3 — config-error degraded path) ----------
//
// EX_CONFIG_EXIT_CODE from runResident (e.g. source-run without daemon
// dist build) must drive `degraded` immediately, bypassing the
// crash-count threshold. The service calls markFatalConfig instead
// of recordCrash for these exits so the crash budget stays semantically
// clean (no actual crash occurred) while doctor/status still surface
// the actionable cause.

test("markFatalConfig: writes a single fatalConfig marker", async () => {
  await withHome(async (home) => {
    await markFatalConfig(home, SERVER_A, 78, null);
    const marker = await readFatalConfig(home, SERVER_A);
    assert.equal(marker?.reason, "ex_config");
    assert.equal(marker?.exitCode, 78);
    assert.equal(marker?.signal, null);
    assert.ok(typeof marker?.at === "string");
  });
});

test("markFatalConfig: forces isDegraded=true with zero crashes recorded", async () => {
  await withHome(async (home) => {
    assert.equal(await isDegraded(home, SERVER_A), false);
    await markFatalConfig(home, SERVER_A, 78, null);
    assert.equal(await isDegraded(home, SERVER_A), true);
    // Crash count is still empty: fatalConfig is NOT recorded as a crash.
    const crashes = await readCrashHistory(home, SERVER_A);
    assert.deepEqual(crashes, []);
  });
});

test("markFatalConfig: overwrites prior fatalConfig (only newest cause shown)", async () => {
  await withHome(async (home) => {
    await markFatalConfig(home, SERVER_A, 78, null);
    const first = await readFatalConfig(home, SERVER_A);
    await new Promise((r) => setTimeout(r, 5));
    await markFatalConfig(home, SERVER_A, 78, null);
    const second = await readFatalConfig(home, SERVER_A);
    assert.ok(second);
    assert.ok(second.at >= (first?.at ?? ""));
  });
});

test("resetHealth: clears fatalConfig marker for explicit retry", async () => {
  await withHome(async (home) => {
    await markFatalConfig(home, SERVER_A, 78, null);
    assert.equal(await isDegraded(home, SERVER_A), true);
    await resetHealth(home, SERVER_A);
    assert.equal(await isDegraded(home, SERVER_A), false);
    assert.equal(await readFatalConfig(home, SERVER_A), null);
  });
});

test("markFatalConfig: invalid serverId → no-op", async () => {
  await withHome(async (home) => {
    await markFatalConfig(home, "not-a-uuid", 78, null);
    assert.equal(await readFatalConfig(home, "not-a-uuid"), null);
  });
});

test("markFatalConfig + recordCrash coexist: fatalConfig + 1 real crash → still degraded", async () => {
  await withHome(async (home) => {
    await recordCrash(home, SERVER_A, 1, null);
    assert.equal(await isDegraded(home, SERVER_A), false); // 1 crash < 3 threshold
    await markFatalConfig(home, SERVER_A, 78, null);
    assert.equal(await isDegraded(home, SERVER_A), true); // fatalConfig forces it
    // Crash budget unchanged
    const crashes = await readCrashHistory(home, SERVER_A);
    assert.equal(crashes.length, 1);
  });
});

test("markTerminalUnlinked: persists terminal unlink marker without marking crash-degraded", async () => {
  await withHome(async (home) => {
    await markTerminalUnlinked(home, SERVER_A, SERVER_MACHINE_A, 401, "computer_machine_unlinked", 1_234);
    const marker = await readTerminalUnlinked(home, SERVER_A);
    assert.equal(marker?.reason, "computer_machine_unlinked");
    assert.equal(marker?.serverMachineId, SERVER_MACHINE_A);
    assert.equal(marker?.statusCode, 401);
    assert.equal(marker?.at, new Date(1_234).toISOString());
    assert.equal(await isDegraded(home, SERVER_A), false);
    assert.deepEqual(await readCrashHistory(home, SERVER_A), []);
  });
});

// ---------- classifyTerminalHandshakeRejection (#4816 gate half b) ----------
// A revoked/unlinked credential can NEVER authenticate again (revokedAt is
// set-once; unlink deletes the row), so both reasons must be terminal.
// Every other rejection keeps the reconnect loop — a transiently wrong key
// must not kill a healthy runner.

test("classifyTerminalHandshakeRejection: 401 computer_machine_unlinked → terminal", () => {
  assert.equal(
    classifyTerminalHandshakeRejection(401, "computer_machine_unlinked"),
    "computer_machine_unlinked",
  );
});

test("classifyTerminalHandshakeRejection: 401 computer_revoked → terminal (setup-reset orphan runner must stop, not retry forever)", () => {
  assert.equal(classifyTerminalHandshakeRejection(401, "computer_revoked"), "computer_revoked");
});

test("classifyTerminalHandshakeRejection: non-member reasons and non-401 statuses keep reconnect", () => {
  assert.equal(classifyTerminalHandshakeRejection(401, "computer_key_invalid"), null);
  assert.equal(classifyTerminalHandshakeRejection(401, "legacy_machine_key_migrated"), null);
  assert.equal(classifyTerminalHandshakeRejection(401, null), null);
  assert.equal(classifyTerminalHandshakeRejection(403, "computer_revoked"), null);
  assert.equal(classifyTerminalHandshakeRejection(0, "computer_machine_unlinked"), null);
});

test("markTerminalUnlinked: records computer_revoked reason distinctly (setup-reset orphan attribution)", async () => {
  await withHome(async (home) => {
    await markTerminalUnlinked(home, SERVER_A, SERVER_MACHINE_A, 401, "computer_revoked", 5_678);
    const marker = await readTerminalUnlinked(home, SERVER_A);
    assert.equal(marker?.reason, "computer_revoked");
    assert.equal(marker?.serverMachineId, SERVER_MACHINE_A);
    assert.equal(marker?.statusCode, 401);
    assert.equal(marker?.at, new Date(5_678).toISOString());
    assert.equal(await isDegraded(home, SERVER_A), false);
  });
});

test("resetHealth: preserves terminal unlink marker while clearing retry recovery", async () => {
  await withHome(async (home) => {
    const now = Date.now();
    await markTerminalUnlinked(home, SERVER_A, SERVER_MACHINE_A, 401, "computer_machine_unlinked", now);
    await markFatalConfig(home, SERVER_A, 78, null, now);
    assert.equal(await isDegraded(home, SERVER_A), true);

    await resetHealth(home, SERVER_A);

    assert.equal(await isDegraded(home, SERVER_A), false);
    assert.equal(await readFatalConfig(home, SERVER_A), null);
    const marker = await readTerminalUnlinked(home, SERVER_A);
    assert.equal(marker?.reason, "computer_machine_unlinked");
    assert.equal(marker?.serverMachineId, SERVER_MACHINE_A);
    assert.equal(marker?.statusCode, 401);
  });
});

test("readTerminalUnlinked: clears marker when current attachment identity changed", async () => {
  await withHome(async (home) => {
    await markTerminalUnlinked(home, SERVER_A, "cm-stale", 401, "computer_machine_unlinked", 1_234);

    assert.equal(await readTerminalUnlinked(home, SERVER_A, "cm-fresh"), null);
    assert.equal(await readTerminalUnlinked(home, SERVER_A, "cm-fresh"), null);
  });
});

void CRASH_WINDOW_MS;
void DEGRADED_THRESHOLD;
