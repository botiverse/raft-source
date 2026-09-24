import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  AWS_STAGING_SERVER_URL,
  STALE_STAGING_FLY_SERVER_URL,
  migrateKnownServerUrl,
  readServerAttachment,
} from "./serverState.js";
import { DEFAULT_SLOCK_SERVER_URL, LEGACY_PRODUCTION_SERVER_URL } from "./serverUrl.js";
import { serverAttachmentPath, legacyServerAttachmentPath, CURRENT_SCHEMA_VERSION } from "./paths.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

// Regression for the prod 401 incident (2026-06-18): #3074 (③a) dropped the
// legacy `attachment.json` dual-read + the adopted-machine precedence merge on
// a wrong "no deployed legacy installs" assumption. A deployed computer with
// the working credential in attachment.json (and a stale/fresh one in
// runner.state.json) then read the stale one → no valid sk_computer_* → all
// 401 after upgrade. These tests pin the restored dual-read precedence so it
// cannot regress again.

const SERVER = "11111111-1111-4111-8111-111111111111";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-serverstate-"));
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

async function writeJson(path: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ kind: "computer-attachment", serverId: SERVER, ...body }));
}

const base = { serverUrl: "https://api.example.test" };

test("readServerAttachment: only runner.state.json → that one (unchanged, no legacy file)", async () => {
  await withHome(async (home) => {
    await writeJson(serverAttachmentPath(home, SERVER), { ...base, serverMachineId: "cur", apiKey: "sk_computer_cur" });
    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverMachineId, "cur");
    // No legacy file ever existed → nothing to migrate / delete.
    assert.equal(await exists(legacyServerAttachmentPath(home, SERVER)), false);
  });
});

test("readServerAttachment: only legacy attachment.json → migrated to canonical, legacy deleted", async () => {
  await withHome(async (home) => {
    await writeJson(legacyServerAttachmentPath(home, SERVER), { ...base, serverMachineId: "leg", apiKey: "sk_computer_leg" });
    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverMachineId, "leg", "must read the legacy attachment when runner.state.json is absent");
    assert.equal(a?.apiKey, "sk_computer_leg");
    // Migrate-on-read: canonical now holds the creds, legacy is gone.
    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverMachineId, "leg");
    assert.equal(canonical.apiKey, "sk_computer_leg");
    assert.equal(canonical.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(await exists(legacyServerAttachmentPath(home, SERVER)), false);
  });
});

test("readServerAttachment: both present, legacy is the adopted working machine → legacy creds + migrated to canonical + legacy deleted (THE 401 regression)", async () => {
  await withHome(async (home) => {
    // runner.state.json = a fresh, different, NOT-adopted machine (the one the
    // server 401s); attachment.json = the adopted, working machine.
    await writeJson(serverAttachmentPath(home, SERVER), { ...base, serverMachineId: "fresh-401", apiKey: "sk_computer_fresh" });
    await writeJson(legacyServerAttachmentPath(home, SERVER), {
      ...base,
      serverMachineId: "adopted-working",
      apiKey: "sk_computer_working",
      adoptedFromLegacy: true,
    });
    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverMachineId, "adopted-working", "must prefer the adopted legacy credential, not the stale current one");
    assert.equal(a?.apiKey, "sk_computer_working");
    // After the call: runner.state.json now holds the legacy (working) creds…
    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverMachineId, "adopted-working");
    assert.equal(canonical.apiKey, "sk_computer_working");
    // …and attachment.json is deleted.
    assert.equal(await exists(legacyServerAttachmentPath(home, SERVER)), false);
  });
});

test("readServerAttachment: both present, current is normal → current wins, legacy left untouched (not chosen)", async () => {
  await withHome(async (home) => {
    await writeJson(serverAttachmentPath(home, SERVER), { ...base, serverMachineId: "cur", apiKey: "sk_computer_cur" });
    await writeJson(legacyServerAttachmentPath(home, SERVER), { ...base, serverMachineId: "leg", apiKey: "sk_computer_leg" });
    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverMachineId, "cur", "without the adopted-legacy precedence condition, current wins");
    // Canonical unchanged; current won, so legacy was NOT the deciding source.
    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverMachineId, "cur");
  });
});

test("migrateKnownServerUrl: only the old staging Fly endpoint maps to AWS staging", () => {
  assert.equal(migrateKnownServerUrl(STALE_STAGING_FLY_SERVER_URL), AWS_STAGING_SERVER_URL);
  assert.equal(migrateKnownServerUrl(`${STALE_STAGING_FLY_SERVER_URL}/`), AWS_STAGING_SERVER_URL);
  assert.equal(migrateKnownServerUrl(LEGACY_PRODUCTION_SERVER_URL), DEFAULT_SLOCK_SERVER_URL);
  assert.equal(migrateKnownServerUrl(`${LEGACY_PRODUCTION_SERVER_URL}/`), DEFAULT_SLOCK_SERVER_URL);
  assert.equal(migrateKnownServerUrl("https://example.fly.dev"), "https://example.fly.dev");
  assert.equal(
    migrateKnownServerUrl(`${STALE_STAGING_FLY_SERVER_URL}/custom-path`),
    `${STALE_STAGING_FLY_SERVER_URL}/custom-path`,
  );
});

test("readServerAttachment: stale staging Fly runner.state.json is returned and rewritten as AWS staging", async () => {
  await withHome(async (home) => {
    await writeJson(serverAttachmentPath(home, SERVER), {
      ...base,
      serverMachineId: "cur",
      apiKey: "sk_computer_cur",
      serverUrl: STALE_STAGING_FLY_SERVER_URL,
    });

    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverUrl, AWS_STAGING_SERVER_URL);

    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverUrl, AWS_STAGING_SERVER_URL);
    assert.equal(canonical.serverMachineId, "cur");
    assert.equal(canonical.apiKey, "sk_computer_cur");
    assert.equal(canonical.schemaVersion, CURRENT_SCHEMA_VERSION);
  });
});

test("readServerAttachment: legacy production runner.state.json is returned and rewritten as canonical Raft API", async () => {
  await withHome(async (home) => {
    await writeJson(serverAttachmentPath(home, SERVER), {
      ...base,
      serverMachineId: "cur",
      apiKey: "sk_computer_cur",
      serverUrl: LEGACY_PRODUCTION_SERVER_URL,
    });

    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverUrl, DEFAULT_SLOCK_SERVER_URL);

    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverUrl, DEFAULT_SLOCK_SERVER_URL);
  });
});

test("readServerAttachment: unrelated serverUrl is not rewritten", async () => {
  await withHome(async (home) => {
    await writeJson(serverAttachmentPath(home, SERVER), {
      ...base,
      serverMachineId: "cur",
      apiKey: "sk_computer_cur",
      serverUrl: "https://api.custom.example.test",
    });

    const a = await readServerAttachment(home, SERVER);
    assert.equal(a?.serverUrl, "https://api.custom.example.test");

    const canonical = await readJson(serverAttachmentPath(home, SERVER));
    assert.equal(canonical.serverUrl, "https://api.custom.example.test");
  });
});
