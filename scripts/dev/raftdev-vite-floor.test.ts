import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { versionBelow, webViteFloorProblem } from "./raftdev-vite-floor";

test("versionBelow compares x.y.z and treats a pre-release as before its release", () => {
  assert.equal(versionBelow("8.3.4", "8.3.7"), true);
  assert.equal(versionBelow("8.3.6", "8.3.7"), true);
  assert.equal(versionBelow("8.3.7", "8.3.7"), false);
  assert.equal(versionBelow("8.3.8", "8.3.7"), false);
  assert.equal(versionBelow("8.4.0", "8.3.7"), false);
  assert.equal(versionBelow("9.0.0", "8.3.7"), false);
  assert.equal(versionBelow("7.9.9", "8.3.7"), true);
  assert.equal(versionBelow("8.3.7-beta.1", "8.3.7"), true);
  assert.equal(versionBelow("not-a-version", "8.3.7"), true);
});

describe("webViteFloorProblem", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raftdev-vite-floor-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const install = (version: string) => {
    const vite = join(dir, "packages", "web", "node_modules", "vite");
    mkdirSync(vite, { recursive: true });
    writeFileSync(join(vite, "package.json"), JSON.stringify({ name: "vite", version }));
  };

  test("refuses an installed Vite older than the floor, naming it and pnpm install", () => {
    install("8.3.4");
    const problem = webViteFloorProblem(dir);
    assert.ok(problem);
    assert.match(problem, /Vite 8\.3\.4/);
    assert.match(problem, /pnpm install/);
  });

  test("lets a patched Vite start", () => {
    install("8.3.8");
    assert.equal(webViteFloorProblem(dir), null);
  });

  test("refuses when no Vite is installed", () => {
    assert.match(webViteFloorProblem(dir) ?? "", /no readable installed Vite/);
  });
});
