import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

const daemonRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(daemonRoot, "package.json"), "utf8"));
const preflightSource = readFileSync(join(daemonRoot, "scripts/release-runtime-sdk-preflight.mjs"), "utf8");

test("all daemon branch-cut release commands require the runtime SDK preflight", () => {
  for (const name of ["release:patch", "release:minor", "release:major", "release:alpha"]) {
    assert.match(
      packageJson.scripts[name],
      /^node scripts\/release-runtime-sdk-preflight\.mjs && /,
      `${name} must fail closed on the SDK decision before versioning or tagging`,
    );
    assert.match(
      packageJson.scripts[name],
      /git add .*packages\/daemon\/runtime-sdk-release-preflight\.json/,
      `${name} must commit the auditable SDK decision receipt`,
    );
  }
});

test("runtime SDK preflight covers both Pi packages and the Kimi botiverse dist-tag", () => {
  assert.match(preflightSource, /@earendil-works\/pi-ai.+distTag: "latest"/s);
  assert.match(preflightSource, /@earendil-works\/pi-coding-agent.+distTag: "latest"/s);
  assert.match(preflightSource, /@botiverse\/kimi-code-sdk.+distTag: "botiverse"/s);
  assert.match(preflightSource, /RAFT_RUNTIME_SDK_DECISION/);
  assert.match(preflightSource, /RAFT_RUNTIME_SDK_HOLD_REASON/);
  assert.match(preflightSource, /runtime-sdk-release-preflight\.json/);
  assert.match(preflightSource, /selectedVersions/);
  assert.match(preflightSource, /generate:pi-builtin-models/);
  assert.match(preflightSource, /generate:runtime-provider-display-names/);
});
