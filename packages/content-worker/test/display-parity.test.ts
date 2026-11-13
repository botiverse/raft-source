import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { raftDisplays } from "../src/raftContentDisplays";

/**
 * The content Worker serves each page under src/raftContentDisplays.ts, and the web mounts its
 * frames with RAFT_ARTIFACT_DISPLAYS (packages/web/src/apps/artifacts/ArtifactFrame.tsx); the
 * web's local fake content server (packages/web/scripts/fake-artifact-content.ts) stands in for
 * the Worker. The shell runs only what the served config declares and the host offers only what
 * its own does, so the capability lists must be equal. The web's are read from its source (its
 * module pulls in React).
 */
const ROOT = new URL("../../", import.meta.url);

function declaredIn(path: string, after: string): string[] {
  const source = readFileSync(new URL(path, ROOT), "utf8");
  const start = source.indexOf(after);
  assert.ok(start >= 0, `${after} in ${path}`);
  const match = /capabilities:\s*\{((?:[^{}]|\{\})*)\}/.exec(source.slice(start));
  assert.ok(match, `the capabilities of ${after} in ${path}`);
  return [...match[1]!.matchAll(/([A-Za-z]+)\s*:/g)].map((m) => m[1]!).sort();
}

test("the Worker's display capabilities are the web's, and the fake content server's", () => {
  const worker = Object.keys(raftDisplays.guideConfig("artifact", "served").capabilities ?? {})
    .filter((name) => !["reportError", "resize"].includes(name))
    .sort();
  assert.deepEqual(worker, ["annotate", "comments", "copyText", "find", "openLink"]);
  assert.deepEqual(declaredIn("web/src/apps/artifacts/ArtifactFrame.tsx", "export const RAFT_ARTIFACT_DISPLAYS"), worker);
  assert.deepEqual(declaredIn("web/scripts/fake-artifact-content.ts", "const displays = defineDisplays"), worker);
  assert.deepEqual(declaredIn("content-worker/src/raftContentDisplays.ts", "export const raftDisplays"), worker);
});
