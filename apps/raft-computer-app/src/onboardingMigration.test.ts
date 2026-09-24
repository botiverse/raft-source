import assert from "node:assert/strict";
import test from "node:test";

import { getOnboardingLegacyMigrationBlock } from "./onboardingMigration.js";
import type {
  LegacyMachineRosterClient,
  MigrationDetection,
  UsableUserSession,
} from "@botiverse/raft-computer/lib";

const USABLE_SESSION: UsableUserSession = {
  status: "usable",
  accessToken: "session-token",
  serverUrl: "https://api.example.test",
  refreshed: false,
};

const DUMMY_CLIENT: LegacyMachineRosterClient = {
  list: async () => ({ status: "success", entries: [] }),
};

test("onboarding migration stopgap: usable session + legacy candidates blocks fresh attach", async () => {
  const calls: Array<{ home: string; slug: string; baseUrl: string; accessToken: string }> = [];
  const block = await getOnboardingLegacyMigrationBlock("/tmp/raft-home", " /alpha ", {
    ensureSession: async () => USABLE_SESSION,
    createRosterClient: (baseUrl, accessToken) => {
      calls.push({ home: "", slug: "", baseUrl, accessToken });
      return DUMMY_CLIENT;
    },
    detectMigration: async (home, slug, createRosterClient) => {
      await createRosterClient().list(slug);
      calls[0] = { ...calls[0]!, home, slug };
      return {
        kind: "matched",
        candidates: [{
          apiKeyFingerprint: "0123456789abcdef",
          daemonId: "daemon-1",
          localPath: "/tmp/raft-home/machines/machine-0123456789abcdef",
          machineName: "legacy",
        }],
        excluded: [],
      };
    },
  });

  assert.match(block ?? "", /legacy daemon candidate/);
  assert.match(block ?? "", /raft-computer setup \/alpha/);
  assert.deepEqual(calls, [{
    home: "/tmp/raft-home",
    slug: "alpha",
    baseUrl: "https://api.example.test",
    accessToken: "session-token",
  }]);
});

test("onboarding migration stopgap: empty candidates allow fresh attach", async () => {
  let createRosterClientCalls = 0;
  const block = await getOnboardingLegacyMigrationBlock("/tmp/raft-home", "alpha", {
    ensureSession: async () => USABLE_SESSION,
    createRosterClient: () => {
      createRosterClientCalls += 1;
      return DUMMY_CLIENT;
    },
    detectMigration: async (): Promise<MigrationDetection> => ({ kind: "no_local_evidence" }),
  });

  assert.equal(block, null);
  assert.equal(createRosterClientCalls, 0, "managed/no-local detection must not construct a roster client");
});

test("onboarding migration stopgap: roster_unavailable is not a hard block", async () => {
  const block = await getOnboardingLegacyMigrationBlock("/tmp/raft-home", "alpha", {
    ensureSession: async () => USABLE_SESSION,
    createRosterClient: () => DUMMY_CLIENT,
    detectMigration: async (): Promise<MigrationDetection> => ({ kind: "roster_unavailable", localCount: 1 }),
  });

  assert.equal(block, null);
});

test("onboarding migration stopgap: missing user session defers to attach login handling", async () => {
  const block = await getOnboardingLegacyMigrationBlock("/tmp/raft-home", "alpha", {
    ensureSession: async () => ({ status: "not_logged_in", reason: "missing" }),
    createRosterClient: () => {
      throw new Error("must not create roster client without a usable session");
    },
  });

  assert.equal(block, null);
});
