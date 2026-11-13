import assert from "node:assert/strict";
import { claudeRuntime, codexRuntime, defineRuntime, kimiRuntime, grokRuntime } from "@botiverse/oar";
import { runtimeAccountUsageSnapshotSchema } from "@botiverse/raft-shared";
import { createRuntimeAccountUsageCollector } from "./collector";
import type { KimiCodeAuth } from "./kimiAuth";
import type { KimiFreshness } from "./kimiTokenRefresh";

import type { AvailableInstallation, InstallationSnapshot, Runtime } from "@botiverse/oar";

import { readOarAccountUsage } from "./collector";
import { loadOarRuntime } from "../oarLoader";

const BASE = {
  provider: "codex",
  localAccountSlot: "/home/agent/.slock",
  collectorVersion: "test",
  observedAtMs: Date.parse("2026-08-26T09:00:00.000Z"),
} as const;

/**
 * Builds a runtime that records how its probe and reader were used, so the
 * composition itself can be asserted rather than assumed.
 */
function recordingRuntime(installation: InstallationSnapshot) {
  const seen: { probeCalls: number; readerGot: unknown[] } = { probeCalls: 0, readerGot: [] };
  const runtime = defineRuntime({
    id: "recording",
    session: (() => {
      throw new Error("session must not be started by an account-usage read");
    }) as unknown as Runtime["session"],
    installation: async () => {
      seen.probeCalls += 1;
      return installation;
    },
    accountUsage: async (given: AvailableInstallation) => {
      seen.readerGot.push(given);
      return { kind: "unsupported" } as const;
    },
  });
  return { runtime, seen };
}

test("a usage read asks for the count of limit resets only, with no env", async () => {
  const given: unknown[] = [];
  const runtime = defineRuntime({
    id: "recording",
    session: (() => {
      throw new Error("session must not be started by an account-usage read");
    }) as unknown as Runtime["session"],
    installation: async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/codex", version: "0.130.0" }),
    accountUsage: async (_installation: AvailableInstallation, options) => {
      given.push(options);
      return { kind: "available", rateLimited: false, windows: [], limitResets: { available: 3 } } as const;
    },
  });
  const snapshot = await readOarAccountUsage({ ...BASE, deps: { runtime, timeoutMs: 1234 } });
  assert.deepEqual(given, [{ timeoutMs: 1234, limitResetDetails: false }]);
  assert.equal(snapshot.accounts[0]?.limitResetsAvailable, 3);
});

test("Antigravity's usage is read without the SSH variables, so agy reads the sign-in its agents run on", async () => {
  const given: unknown[] = [];
  const runtime = defineRuntime({
    id: "recording",
    session: (() => {
      throw new Error("session must not be started by an account-usage read");
    }) as unknown as Runtime["session"],
    installation: async () => ({ kind: "available", via: "executable", command: "/usr/local/bin/agy", version: "1.5.7" }),
    accountUsage: async (_installation: AvailableInstallation, options) => {
      given.push(options);
      return { kind: "reauth_required", reason: "not_authenticated" } as const;
    },
  });
  const snapshot = await readOarAccountUsage({ ...BASE, provider: "antigravity", deps: { runtime, timeoutMs: 1234 } });
  assert.deepEqual(given, [{ env: { SSH_CLIENT: null, SSH_CONNECTION: null, SSH_TTY: null }, timeoutMs: 1234, limitResetDetails: false }]);
  assert.equal(snapshot.accounts[0]?.health, "reauth_required", "not signed in to agy");
});

test("installation is probed exactly once per read", async () => {
  const available: InstallationSnapshot = { kind: "available", via: "bundled" };
  const { runtime, seen } = recordingRuntime(available);

  await readOarAccountUsage({ ...BASE, deps: { runtime } });

  assert.equal(seen.probeCalls, 1, "OAR's installation() must be the sole probe, called once");
});

test("the exact object from installation() is handed to accountUsage()", async () => {
  // A distinguishable instance: identity, not structural equality, is the point.
  const available: InstallationSnapshot = {
    kind: "available",
    via: "executable",
    command: "/usr/local/bin/codex",
    version: "1.2.3",
  };
  const { runtime, seen } = recordingRuntime(available);

  await readOarAccountUsage({ ...BASE, deps: { runtime } });

  assert.equal(seen.readerGot.length, 1, "accountUsage must be called once");
  assert.equal(
    seen.readerGot[0],
    available,
    "accountUsage must receive the SAME object installation() returned, not a copy or a re-probe",
  );
});

test("an unavailable installation short-circuits without calling accountUsage", async () => {
  for (const snapshot of [
    { kind: "not_found" } as const,
    { kind: "unsupported", reason: "no parity" } as const,
  ]) {
    const { runtime, seen } = recordingRuntime(snapshot);
    const result = await readOarAccountUsage({ ...BASE, deps: { runtime } });

    assert.equal(seen.probeCalls, 1);
    assert.equal(seen.readerGot.length, 0, "a non-available installation must not be read from");
    assert.equal(result.accounts[0]?.health, "unsupported");
    assert.deepEqual(result.accounts[0]?.windows, [], "no window may be invented for an unavailable runtime");
  }
});

test("a runtime without a probe or reader is unsupported, not an error", async () => {
  const bare = defineRuntime({
    id: "bare",
    session: (() => {
      throw new Error("unused");
    }) as unknown as Runtime["session"],
  });

  const result = await readOarAccountUsage({ ...BASE, deps: { runtime: bare } });
  assert.equal(result.accounts[0]?.health, "unsupported");
  assert.deepEqual(result.accounts[0]?.windows, []);
});

test("a thrown read becomes an explicit error account, never a zero reading", async () => {
  const throwing = defineRuntime({
    id: "throwing",
    session: (() => {
      throw new Error("unused");
    }) as unknown as Runtime["session"],
    installation: async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "bundled" }),
    accountUsage: async () => {
      throw new Error("app-server unreachable");
    },
  });

  const result = await readOarAccountUsage({ ...BASE, deps: { runtime: throwing } });
  assert.equal(result.accounts[0]?.health, "error");
  assert.deepEqual(result.accounts[0]?.windows, []);
  assert.ok(!JSON.stringify(result).includes("usedRatio"));
});


test("every usage provider routes to its OAR runtime and publishes the complete current format", async () => {
  const cases = [
    { provider: "claude", runtime: claudeRuntime, usedRatio: 0.17 },
    { provider: "codex", runtime: codexRuntime, usedRatio: 0.72 },
    { provider: "kimi", runtime: kimiRuntime, usedRatio: 0.4 },
    { provider: "grok", runtime: grokRuntime, usedRatio: 0.35 },
  ] as const;
  try {
    for (const { runtime, usedRatio } of cases) {
      vi.spyOn(runtime, "installation").mockResolvedValue({ kind: "available", via: "executable", command: "/fixture/runtime" });
      vi.spyOn(runtime, "accountUsage").mockResolvedValue({
        kind: "available",
        email: "alpha@example.com",
        plan: "Pro",
        rateLimited: false,
        windows: [{ label: "Current session", usedRatio }],
      });
    }
    const collect = createRuntimeAccountUsageCollector({ ...BASE, now: () => BASE.observedAtMs });
    for (const { provider, usedRatio } of cases) {
      const result = await collect(provider);
      assert.equal(runtimeAccountUsageSnapshotSchema.safeParse(result).success, true);
      assert.equal(result.provider, provider);


      assert.equal(result.accounts[0]?.planLabel, "Pro");
      assert.equal(result.accounts[0]?.maskedLabel, "a****@example.com");
      assert.equal(result.accounts[0]?.windows[0]?.usedRatio, usedRatio);
      assert.equal(result.accounts[0]?.windows[0]?.status, "ok");
      assert.equal(result.accounts[0]?.windows[0]?.resetsAt, undefined);
    }
  } finally {
    vi.restoreAllMocks();
  }
});

// ── task #1282 (review on #9802): the gate-on outcome table, end to end through the collector ──

const KIMI_AUTH: KimiCodeAuth = {
  baseUrl: "https://api.kimi.test/coding/v1",
  oauthHost: "https://auth.kimi.test",
  storage: "file",
  storageName: "kimi-code",
  home: "/tmp/kimi-home",
  credentialPath: "/tmp/kimi-home/credentials/kimi-code.json",
  lockTarget: "/tmp/kimi-home/oauth/kimi-code",
};

type OarSnapshot = Awaited<ReturnType<NonNullable<Runtime["accountUsage"]>>>;

function kimiLikeRuntime(readerResult: OarSnapshot) {
  const seen = { readerCalls: 0 };
  const runtime = defineRuntime({
    id: "kimi-like",
    session: (() => {
      throw new Error("unused");
    }) as unknown as Runtime["session"],
    installation: async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "path", command: "kimi" } as unknown as InstallationSnapshot),
    accountUsage: async () => {
      seen.readerCalls += 1;
      return readerResult;
    },
  });
  return { runtime, seen };
}

async function readWithFreshness(freshness: KimiFreshness, readerResult: OarSnapshot, enabled = true) {
  const { runtime, seen } = kimiLikeRuntime(readerResult);
  let ensureFreshCalls = 0;
  const result = await readOarAccountUsage({
    ...BASE,
    provider: "kimi",
    deps: { runtime, kimi: { enabled, resolveAuth: async () => KIMI_AUTH, ensureFresh: async () => { ensureFreshCalls += 1; return freshness; } } },
  });
  return { health: result.accounts[0]?.health, readerCalls: seen.readerCalls, ensureFreshCalls };
}

const OK_READING: OarSnapshot = { kind: "ok", email: "a@b.test", plan: "pro", windows: [{ label: "Daily", usedRatio: 0.2 }] } as unknown as OarSnapshot;
const OAR_CREDENTIALS_MISSING: OarSnapshot = { kind: "reauth_required", reason: "credentials_missing" } as OarSnapshot;
const OAR_CREDENTIALS_REJECTED: OarSnapshot = { kind: "reauth_required", reason: "credentials_rejected" } as OarSnapshot;

test("task #1282 (gate on): only the pre-step's own verdicts short-circuit — rejected / revoked → reauth_required and a transient failure on an expired token → error, without reading", async () => {
  for (const freshness of [{ kind: "rejected", reason: "refresh_rejected" }, { kind: "revoked" }] as const) {
    const r = await readWithFreshness(freshness, OK_READING);
    assert.deepEqual(r, { health: "reauth_required", readerCalls: 0, ensureFreshCalls: 1 }, freshness.kind);
  }
  const expired = await readWithFreshness({ kind: "transient", reason: "malformed_response", expired: true }, OK_READING);
  assert.deepEqual(expired, { health: "error", readerCalls: 0, ensureFreshCalls: 1 });
});

test("task #1282 (gate on): every other freshness hands the read to OAR and the panel shows OAR's result unchanged — including OAR's own reauth_required for a missing/unusable file and for an expired token the pre-step could not refresh", async () => {
  const handedOver: KimiFreshness[] = [
    { kind: "fresh", expiresAt: 1 }, { kind: "refreshed", expiresAt: 1 }, { kind: "adopted", expiresAt: 1 },
    { kind: "transient", reason: "network", expired: false },
    { kind: "missing", reason: "no_file" }, { kind: "missing", reason: "unreadable" }, { kind: "missing", reason: "malformed" }, { kind: "missing", reason: "no_refresh_token" },
    { kind: "platform_unsupported", reason: "win32" }, { kind: "platform_unsupported", reason: "lock_disabled" }, { kind: "platform_unsupported", reason: "storage_not_file" },
  ];
  for (const freshness of handedOver) {
    const label = `${freshness.kind}/${"reason" in freshness ? freshness.reason : ""}`;
    assert.deepEqual(await readWithFreshness(freshness, OK_READING), { health: "ok", readerCalls: 1, ensureFreshCalls: 1 }, label);
  }
  // Inherited, not introduced: OAR reads an absent file (never logged in) and `{}` (a damaged file) alike as
  // credentials_missing (oauth-token.js) — same prompt, different facts — and an
  // expired token that reached the endpoint as credentials_rejected. The wire carries `reauth_required` for both.
  for (const freshness of [{ kind: "missing", reason: "malformed" }, { kind: "missing", reason: "no_file" }] as const) {
    assert.deepEqual(await readWithFreshness(freshness, OAR_CREDENTIALS_MISSING), { health: "reauth_required", readerCalls: 1, ensureFreshCalls: 1 }, freshness.reason);
  }
  for (const freshness of [{ kind: "platform_unsupported", reason: "win32" }, { kind: "missing", reason: "no_refresh_token" }] as const) {
    assert.deepEqual(await readWithFreshness(freshness, OAR_CREDENTIALS_REJECTED), { health: "reauth_required", readerCalls: 1, ensureFreshCalls: 1 }, freshness.reason);
  }
  // Non-file storage: OAR returns unsupported_auth_storage before reading any token or calling the endpoint.
  assert.deepEqual(await readWithFreshness({ kind: "platform_unsupported", reason: "storage_not_file" }, { kind: "unsupported", reason: "unsupported_auth_storage" } as OarSnapshot), { health: "unsupported", readerCalls: 1, ensureFreshCalls: 1 });
});

test("task #1282 (gate off, the default): the pre-step never runs and OAR's result is projected as before", async () => {
  assert.deepEqual(await readWithFreshness({ kind: "revoked" }, OK_READING, false), { health: "ok", readerCalls: 1, ensureFreshCalls: 0 });
  assert.deepEqual(await readWithFreshness({ kind: "fresh", expiresAt: 1 }, OAR_CREDENTIALS_REJECTED, false), { health: "reauth_required", readerCalls: 1, ensureFreshCalls: 0 });
});

test("the bundled OAR reads Antigravity's usage, which the daemon advertises (DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY)", async () => {
  const runtime = await loadOarRuntime("antigravity");
  assert.equal(typeof runtime.accountUsage, "function", "an OAR without it: stop advertising the capability in core.ts");
});
