import assert from "node:assert/strict";
import { test } from "vitest";

import type {
  CreateUpgraderOptions,
  HostAdapter,
  ReleaseSource,
  Upgrader,
} from "@botiverse/k-carrier";

import { createComputerUpgrader } from "./kUpgrader.js";
import { kStateDir } from "./kPaths.js";

const host: HostAdapter = {
  quiesce: async () => {},
  stop: async () => {},
  start: async () => {},
  healthProbe: async () => ({ version: "1.0.0", pid: 1, startId: "one" }),
  resume: async () => {},
};

const source: ReleaseSource = {
  checkForUpdate: async () => null,
  fetchRelease: async () => ({ version: "1.0.0", url: "https://example.test/x", sha256: "a", size: 1 }),
};

test("createComputerUpgrader is the canonical K construction for Computer", () => {
  let captured: CreateUpgraderOptions | null = null;
  const sentinel = {} as Upgrader;
  const actual = createComputerUpgrader("/home/example/.slock", {
    host,
    source,
    createUpgraderFn: (opts) => {
      captured = opts;
      return sentinel;
    },
  });

  assert.equal(actual, sentinel);
  assert.ok(captured);
  const config = captured as unknown as CreateUpgraderOptions;
  assert.equal(config.stateDir, kStateDir("/home/example/.slock"));
  assert.equal(config.host, host);
  assert.equal(config.source, source);
  assert.equal(config.policy, "confirm");
  assert.deepEqual(config.provenanceIdentity, { who: "local", carrier: "computer" });
  assert.ok(config.provenance, "every Computer reconcile must write durable provenance");
  assert.deepEqual(
    config.lifecycleSurfaces?.map((surface) => surface.id),
    ["computer.machine-attestation.serviceExecutablePath"],
  );
});
