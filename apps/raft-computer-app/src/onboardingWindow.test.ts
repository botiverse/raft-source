import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { needsOnboarding } from "./onboardingState.js";
import type { ComputerStatusReport } from "@botiverse/raft-computer/lib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const VERSION_MISSING = {
  version: null,
  evidencePath: "/tmp/version.json",
  evidencePid: null,
  evidenceWrittenAt: null,
    shellEnvironment: null,
};

type ReportOverride = Omit<Partial<ComputerStatusReport>, "service" | "servers"> & {
  service?: Partial<ComputerStatusReport["service"]>;
  servers?: ComputerStatusReport["servers"];
};

function makeService(partial: Partial<ComputerStatusReport["service"]> | undefined): ComputerStatusReport["service"] {
  const base = {
    logPath: partial?.logPath ?? "/tmp/test/service.log",
    version: partial?.version ?? VERSION_MISSING,
  };
  return partial?.running ? { ...base, running: true, pid: partial.pid ?? 1 } : { ...base, running: false };
}

function makeReport(overrides: ReportOverride = {}): ComputerStatusReport {
  return {
    slockHome: overrides.slockHome ?? "/tmp/test",
    loggedIn: overrides.loggedIn ?? true,
    userId: overrides.userId ?? "user-42",
    userName: overrides.userName ?? null,
    userDisplayName: overrides.userDisplayName ?? null,
    userEmail: overrides.userEmail ?? null,
    loginServerUrl: overrides.loginServerUrl ?? "https://api.test",
    userSessionError: overrides.userSessionError ?? null,
    cliVersion: overrides.cliVersion ?? "0.0.59",
    service: makeService(overrides.service),
    upgrade: overrides.upgrade ?? null,
    hostLifecycle: overrides.hostLifecycle ?? null,
    servers: overrides.servers ?? [{
      serverId: "11111111-1111-4111-8111-111111111111",
      serverSlug: "test",
      serverMachineId: "cm-test",
      machineId: null,
      serverUrl: "https://api.test",
      attachedAt: null,
      serverRunnerLogPath: "/tmp/test/runner.log",
      runnerVersion: VERSION_MISSING,
      daemon: { running: false },
      health: "offline" as const,
      serverConnected: false,
    }],
  };
}

test("needsOnboarding: null status → true", () => {
  assert.equal(needsOnboarding(null), true);
});

test("needsOnboarding: not logged in → true", () => {
  assert.equal(needsOnboarding(makeReport({ loggedIn: false, servers: [] })), true);
});

test("needsOnboarding: logged in but no servers → true", () => {
  assert.equal(needsOnboarding(makeReport({ servers: [] })), true);
});

test("needsOnboarding: logged in with servers → false", () => {
  assert.equal(needsOnboarding(makeReport()), false);
});

test("onboarding build output: preload.cjs + onboarding.html + renderer exist in dist/", async (t) => {
  const files = ["preload.cjs", "onboarding.html", "renderer.global.js"];
  for (const file of files) {
    try {
      await access(join(DIST, file));
    } catch {
      t.skip(`${file} missing in dist/ — run \`pnpm run build\` first`);
      return;
    }
  }
  assert.ok(true, "all onboarding renderer assets present in dist/");
});

test("preload.cjs is self-contained CJS (no ESM imports or external chunks)", async (t) => {
  const path = join(DIST, "preload.cjs");
  let src: string;
  try {
    src = await readFile(path, "utf8");
  } catch {
    t.skip("preload.cjs missing in dist/ — run `pnpm run build` first");
    return;
  }
  assert.doesNotMatch(src, /\bimport\s+.*\s+from\s+["']\.\/chunk-/, "preload must not import external chunks");
  assert.doesNotMatch(src, /\bimport\s*\(/, "preload must not use dynamic import()");
});
