import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { normalizeVersion, readCliVersion } from "./version.js";

test("readCliVersion reads the source package version and ignores runtime version env", () => {
  const previous = process.env.RAFT_CLI_VERSION;
  process.env.RAFT_CLI_VERSION = "9.9.9-env-must-not-win";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(readCliVersion(), pkg.version);
  } finally {
    if (previous === undefined) delete process.env.RAFT_CLI_VERSION;
    else process.env.RAFT_CLI_VERSION = previous;
  }
});

test("readCliVersion prefers the bundled dist package metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slock-cli-version-"));
  try {
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "package.json"), JSON.stringify({ version: "9.8.7" }));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));

    assert.equal(readCliVersion(pathToFileURL(path.join(dir, "dist", "index.js")).href), "9.8.7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCliVersion accepts an injected SEA build constant without package metadata", () => {
  assert.equal(
    readCliVersion(
      pathToFileURL(path.join(tmpdir(), "missing-sea", "index.js")).href,
      "7.8.9-sea",
    ),
    "7.8.9-sea",
  );
});

test("readCliVersion never returns placeholder metadata", () => {
  const previous = process.env.RAFT_CLI_VERSION;
  process.env.RAFT_CLI_VERSION = "7.8.9-env-must-not-win";
  try {
    assert.equal(
      readCliVersion(
        pathToFileURL(path.join(tmpdir(), "missing-cli-version", "index.js")).href,
        "0.0.0",
      ),
      "unknown",
    );
  } finally {
    if (previous === undefined) delete process.env.RAFT_CLI_VERSION;
    else process.env.RAFT_CLI_VERSION = previous;
  }
  assert.equal(normalizeVersion("0.0.0-dev"), null);
  assert.equal(normalizeVersion("unknown"), null);
  assert.equal(normalizeVersion("sk_agent_secret"), null);
});
