import assert from "node:assert/strict";
import { test } from "vitest";

import { kSlotBinaryPath } from "./kPaths.js";
import { resolveKResidentBinary } from "./kResidentBinary.js";

const HOME = "/test/home";

function accessible(...paths: string[]): (filePath: string) => Promise<void> {
  const allowed = new Set(paths);
  return async (filePath) => {
    if (!allowed.has(filePath)) throw new Error("ENOENT");
  };
}

function canonical(...paths: string[]): (filePath: string) => string {
  const allowed = new Set(paths);
  return (filePath) => {
    if (!allowed.has(filePath)) throw new Error("ENOENT");
    return filePath;
  };
}

test("non-SEA development keeps node as the resident command", async () => {
  assert.equal(
    await resolveKResidentBinary(HOME, "/usr/bin/node", false, accessible()),
    "/usr/bin/node",
  );
});

test("pre-K carrier uses itself until a stable slot exists", async () => {
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(),
      "linux",
      canonical("/opt/raft-computer"),
    ),
    "/opt/raft-computer",
  );
});

test("cold dispatcher selects K stable instead of its stale embedded core", async () => {
  const stable = kSlotBinaryPath(HOME, "stable");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(stable),
      "linux",
      canonical("/opt/raft-computer", stable),
    ),
    stable,
  );
});

test("cold dispatcher never mistakes an unpromoted experiment for stable", async () => {
  const experiment = kSlotBinaryPath(HOME, "experiment");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(experiment),
      "linux",
      canonical("/opt/raft-computer", experiment),
    ),
    "/opt/raft-computer",
  );
});

test("live experiment uses itself before promote, then stable after its path is renamed", async () => {
  const stable = kSlotBinaryPath(HOME, "stable");
  const experiment = kSlotBinaryPath(HOME, "experiment");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      experiment,
      true,
      accessible(stable, experiment),
      "linux",
      canonical(stable, experiment),
    ),
    experiment,
  );
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      experiment,
      true,
      accessible(stable),
      "linux",
      canonical(stable),
    ),
    stable,
  );
});

test("live macOS experiment recognizes its /private/var real file alias", async () => {
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const current = `/private${experiment}`;
  const canonicalExperiment = `/private${experiment}`;
  const resolveRealPath = (filePath: string): string => {
    if (filePath === experiment || filePath === current) return canonicalExperiment;
    if (filePath === stable) return stable;
    throw new Error("ENOENT");
  };

  assert.equal(
    await resolveKResidentBinary(
      home,
      current,
      true,
      accessible(stable, experiment),
      "darwin",
      resolveRealPath,
    ),
    current,
  );
});

test("an unresolvable slot alias stays on the current binary", async () => {
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const current = `/private${experiment}`;

  assert.equal(
    await resolveKResidentBinary(
      home,
      current,
      true,
      accessible(stable, experiment),
      "darwin",
      () => { throw new Error("EACCES"); },
    ),
    current,
  );
});

test("Windows path casing cannot make a running stable SEA dispatch to itself forever", async () => {
  const stable = kSlotBinaryPath("C:\\Users\\Raft", "stable");
  const current = stable.toUpperCase();
  const chosen = await resolveKResidentBinary(
    "C:\\Users\\Raft",
    current,
    true,
    accessible(stable),
    "win32",
    canonical(stable, current),
  );
  assert.equal(chosen, current);
});
