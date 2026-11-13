import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const daemonRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(daemonRoot, "package.json"), "utf8"));

test("the daemon has no release lane of its own: it ships only inside Computer", () => {
  // docs/operations/computer-release-version.md: one release number, one
  // publication (Computer SEA). A daemon-only version/tag/publish script would
  // reopen the split this test closes.
  assert.equal(packageJson.private, true, "the daemon must not be publishable to npm");
  assert.equal(packageJson.publishConfig, undefined);
  for (const name of Object.keys(packageJson.scripts)) {
    assert.doesNotMatch(name, /^release:(patch|minor|major|alpha)$/, `${name} reintroduces a daemon release lane`);
    assert.doesNotMatch(packageJson.scripts[name], /npm version|npm publish|git tag daemon-v/, `${name} versions, tags, or publishes the daemon on its own`);
  }
  assert.equal(
    packageJson.scripts["release:sdk-preflight"],
    "node scripts/release-runtime-sdk-preflight.mjs",
    "the runtime SDK preflight stays available for the Computer branch cut",
  );
});

test("the daemon version is the Computer version", () => {
  const computer = JSON.parse(readFileSync(join(daemonRoot, "../computer/package.json"), "utf8"));
  assert.equal(packageJson.version, computer.version);
});
