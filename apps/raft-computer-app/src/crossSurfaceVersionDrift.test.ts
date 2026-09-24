import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { semverGreater } from "./menuModel.js";
import { resolveRaftHome } from "@botiverse/raft-computer/lib";
import { isComputerOutdated } from "@botiverse/raft-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = join(__dirname, "main.ts");

// REAL cross-surface drift guard — imports BOTH live implementations:
//   - menu-bar's `semverGreater(a, b)` from this package's menuModel
//   - web/server's `isComputerOutdated(current, latest)` from @botiverse/raft-shared
//
// Yingjun gap (#wg-raft-computer:9a531004 msg=e80bb798): inlining a copy of
// the menu-bar regex into the shared test only pinned shared's own
// regression — the inlined copy is frozen, so a real change to
// `menuModel.semverGreater` would NOT trip the assertion. The cheap correct
// fix is to assert in `apps/raft-computer-app` (which depends on shared)
// where both real implementations are reachable. Now if either side drifts,
// THIS test fails — and the menu-bar version comparison is exactly what
// Yingjun's "don't fork what counts as newer" guardian note (msg=cefcdffc)
// was protecting.
//
// Full comparator unification (one helper in shared, both surfaces import
// it) is the better long-term shape and stays a fast-follow.

test("CROSS-SURFACE DRIFT GUARD: web `isComputerOutdated(current, latest)` and menu-bar `semverGreater(latest, current)` agree on every (current, latest) — including malformed/pre-release/empty", () => {
  const cases: Array<[string, string]> = [
    // happy path
    ["0.0.61", "0.0.62"],
    ["0.0.62", "0.0.62"],
    ["0.0.63", "0.0.62"],
    ["1.0.0", "0.99.99"],
    ["0.99.99", "1.0.0"],
    // boundary cases that bit Yingjun's read of #3239 v1
    ["abc", "0.0.62"],
    ["0.0.62", "abc"],
    ["abc", "def"],
    ["0.0.62-rc1", "0.0.62"],
    ["0.0.62", "0.0.62-rc1"],
    ["", "0.0.62"],
    ["0.0.62", ""],
  ];
  for (const [current, latest] of cases) {
    const web = isComputerOutdated(current, latest);
    // Menu-bar's signature: `semverGreater(a, b)` returns true iff a > b.
    // "current is outdated" = "latest > current" = `semverGreater(latest, current)`.
    const menubar = semverGreater(latest, current);
    assert.equal(
      web,
      menubar,
      `cross-surface drift on (current=${JSON.stringify(current)}, latest=${JSON.stringify(latest)}): web=${web}, menu-bar=${menubar}`,
    );
  }
});

test("CROSS-SURFACE DRIFT GUARD: menu-bar imports canonical resolveRaftHome from raft-computer lib", async () => {
  const src = await readFile(MAIN_SRC, "utf8");
  assert.match(
    src,
    /import\s*{[\s\S]*\bresolveRaftHome\b[\s\S]*}\s*from\s*["']@botiverse\/raft-computer\/lib["']/,
    "main.ts must import resolveRaftHome from @botiverse/raft-computer/lib so CLI/app share env precedence, empty-env handling, and ~ expansion",
  );
  assert.doesNotMatch(
    src,
    /function\s+resolveRaftHome\s*\(/,
    "main.ts must not define a local resolver that can drift from the CLI/lib resolver",
  );
});

test("CROSS-SURFACE DRIFT GUARD: menu-bar home resolver import keeps canonical env semantics", () => {
  const homeDir = "/Users/alice";
  const cases: Array<[NodeJS.ProcessEnv, string]> = [
    [{ SLOCK_HOME: "/tmp/slock-home", RAFT_HOME: "/tmp/raft-home" }, "/tmp/raft-home"],
    [{ SLOCK_HOME: "", RAFT_HOME: "/tmp/raft-home" }, "/tmp/raft-home"],
    [{ SLOCK_HOME: "   ", RAFT_HOME: "/tmp/raft-home" }, "/tmp/raft-home"],
    [{ SLOCK_HOME: "~/custom-home" }, "/Users/alice/custom-home"],
    [{ RAFT_HOME: "~/raft-state" }, "/Users/alice/raft-state"],
    [{}, "/Users/alice/.slock"],
  ];

  for (const [env, expected] of cases) {
    assert.equal(
      resolveRaftHome(env, homeDir),
      resolvePath(expected),
      `canonical app/lib home resolution drifted for env=${JSON.stringify(env)}`,
    );
  }
});
