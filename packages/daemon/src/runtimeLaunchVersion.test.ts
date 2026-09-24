import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { RuntimeDriver, RuntimeProbeResult } from "./drivers/types.js";
import {
  evaluateRuntimeLaunchVersion,
  RuntimeVersionTooOldError,
} from "./runtimeLaunchVersion.js";

const config = { runtime: "claude" } as AgentConfig;
const context = { workingDirectory: "/tmp/agent-workspace" };

function driverWithVersion(version: RuntimeProbeResult): RuntimeDriver {
  return {
    id: "claude",
    launchVersionPolicy: {
      displayName: "Claude Code",
      knownBadVersions: ["2.1.59"],
      testedGoodVersion: "2.1.220",
      probe: () => version,
    },
  } as unknown as RuntimeDriver;
}

test("runtime launch version blocks only the exact proven-bad Claude Code version", () => {
  const decision = evaluateRuntimeLaunchVersion(
    driverWithVersion({ available: true, version: "2.1.59 (Claude Code)" }),
    config,
    context,
  );

  assert.equal(decision.outcome, "block");
  assert.ok(decision.outcome === "block" && decision.error instanceof RuntimeVersionTooOldError);
  assert.match(decision.outcome === "block" ? decision.error.message : "", /2\.1\.59/);
  assert.match(decision.outcome === "block" ? decision.error.message : "", /2\.1\.220 is known to work/);
});

test("runtime launch version warns but allows unproven versions below the field-tested working version", () => {
  const decision = evaluateRuntimeLaunchVersion(
    driverWithVersion({ available: true, version: "Claude Code 2.1.60" }),
    config,
    context,
  );

  assert.deepEqual(decision, {
    outcome: "warn",
    reason: "below_tested_good",
    warning: "Claude Code CLI 2.1.60 is older than a field-tested working version, 2.1.220. Update Claude Code to the latest version if messages fail; starting anyway because this version is not known incompatible.",
  });
});

test("runtime launch version does not invent a hard floor below the one exact proven-bad version", () => {
  const decision = evaluateRuntimeLaunchVersion(
    driverWithVersion({ available: true, version: "2.1.58 (Claude Code)" }),
    config,
    context,
  );
  assert.equal(decision.outcome, "warn");
  assert.equal(decision.outcome === "warn" ? decision.reason : null, "below_tested_good");
});

test("runtime launch version warns but allows missing and unparseable versions", () => {
  for (const probe of [
    { available: false },
    { available: true },
    { available: true, version: "Claude Code development build" },
    { available: true, version: "2.1.220-beta.1" },
  ] satisfies RuntimeProbeResult[]) {
    const decision = evaluateRuntimeLaunchVersion(driverWithVersion(probe), config, context);
    assert.equal(decision.outcome, "warn");
  }
});

test("runtime launch version allows the tested recommendation and newer versions", () => {
  for (const version of ["2.1.220 (Claude Code)", "2.2.0", "3.0.0"]) {
    const decision = evaluateRuntimeLaunchVersion(
      driverWithVersion({ available: true, version }),
      config,
      context,
    );
    assert.equal(decision.outcome, "compatible");
  }
});

test("runtime launch version is a byte-compatible no-op for runtimes without a policy", () => {
  const driver = { id: "builtin" } as unknown as RuntimeDriver;
  assert.deepEqual(evaluateRuntimeLaunchVersion(driver, config, context), { outcome: "not_configured" });
});

test("runtime launch version re-probes every creation so an in-place CLI upgrade unlocks without daemon restart", () => {
  let probeCount = 0;
  const driver = {
    id: "claude",
    launchVersionPolicy: {
      displayName: "Claude Code",
      knownBadVersions: ["2.1.59"],
      testedGoodVersion: "2.1.220",
      probe: () => ({
        available: true,
        version: ++probeCount === 1 ? "2.1.59" : "2.1.220",
      }),
    },
  } as unknown as RuntimeDriver;

  assert.equal(evaluateRuntimeLaunchVersion(driver, config, context).outcome, "block");
  assert.equal(evaluateRuntimeLaunchVersion(driver, config, context).outcome, "compatible");
  assert.equal(probeCount, 2);
});
