import assert from "node:assert/strict";
import {
  buildDevSeedArgs,
  parseSeedCommandArgs,
} from "./raftdev";

test("raftdev seed defaults to the validation-ready fixture", () => {
  assert.deepEqual(parseSeedCommandArgs([], "slock"), {
    name: "slock",
    withOnboarding: false,
    withAgentRuns: false,
  });
  assert.deepEqual(buildDevSeedArgs("/tmp/seed.json", false), [
    "exec",
    "node",
    "--import",
    "@oxc-node/core/register",
    "scripts/seed.ts",
    "--output",
    "/tmp/seed.json",
  ]);
});

test("raftdev seed accepts --with-onboarding before or after the environment name", () => {
  assert.deepEqual(parseSeedCommandArgs(["preview", "--with-onboarding"], "slock"), {
    name: "preview",
    withOnboarding: true,
    withAgentRuns: false,
  });
  assert.deepEqual(parseSeedCommandArgs(["--with-onboarding", "preview"], "slock"), {
    name: "preview",
    withOnboarding: true,
    withAgentRuns: false,
  });
  assert.deepEqual(buildDevSeedArgs("/tmp/seed.json", true), [
    "exec",
    "node",
    "--import",
    "@oxc-node/core/register",
    "scripts/seed.ts",
    "--output",
    "/tmp/seed.json",
    "--with-onboarding",
  ]);
});

test("raftdev seed lets seeded agents run only with --with-agent-runs", () => {
  assert.deepEqual(parseSeedCommandArgs(["preview", "--with-agent-runs", "--with-onboarding"], "slock"), {
    name: "preview",
    withOnboarding: true,
    withAgentRuns: true,
  });
  assert.deepEqual(buildDevSeedArgs("/tmp/seed.json", false, true), [
    "exec",
    "node",
    "--import",
    "@oxc-node/core/register",
    "scripts/seed.ts",
    "--output",
    "/tmp/seed.json",
    "--with-agent-runs",
  ]);
});

test("raftdev seed rejects unknown options and extra names", () => {
  assert.throws(
    () => parseSeedCommandArgs(["--skip-onboarding"], "slock"),
    /Unknown seed option/,
  );
  assert.throws(
    () => parseSeedCommandArgs(["one", "two"], "slock"),
    /Unexpected extra argument/,
  );
});
