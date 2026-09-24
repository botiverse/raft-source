import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDevSeedArgs,
  parseSeedCommandArgs,
} from "./raftdev.js";

test("raftdev seed defaults to the validation-ready fixture", () => {
  assert.deepEqual(parseSeedCommandArgs([], "slock"), {
    name: "slock",
    withOnboarding: false,
  });
  assert.deepEqual(buildDevSeedArgs("/tmp/seed.json", false), [
    "tsx",
    "scripts/seed.ts",
    "--output",
    "/tmp/seed.json",
  ]);
});

test("raftdev seed accepts --with-onboarding before or after the environment name", () => {
  assert.deepEqual(parseSeedCommandArgs(["preview", "--with-onboarding"], "slock"), {
    name: "preview",
    withOnboarding: true,
  });
  assert.deepEqual(parseSeedCommandArgs(["--with-onboarding", "preview"], "slock"), {
    name: "preview",
    withOnboarding: true,
  });
  assert.deepEqual(buildDevSeedArgs("/tmp/seed.json", true), [
    "tsx",
    "scripts/seed.ts",
    "--output",
    "/tmp/seed.json",
    "--with-onboarding",
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
