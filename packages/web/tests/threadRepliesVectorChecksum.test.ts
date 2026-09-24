/**
 * Task #47 — cross-REPO drift guard for the shared conformance vectors.
 *
 * @HanXin's catch, and he is right: mobile lives in a SEPARATE repo
 * (botiverse/mobile), so "web and KMP read the same file" is true inside this
 * monorepo and false across repos. Without a checksum, "one shared file"
 * silently degrades into "two files that can drift" — which is precisely the
 * failure the equal-verdict gate exists to catch, so it must not be the gate's
 * own blind spot.
 *
 * The mechanism:
 *   - `threadRepliesReadModel.vectors.json` is CANONICAL, and lives here.
 *   - `threadRepliesReadModel.vectors.sha256` records its hash.
 *   - BOTH repos assert their copy hashes to that value. If mobile's copy drifts
 *     (or ours is edited without an intentional re-hash), the hashes diverge and
 *     the build fails on both sides.
 *
 * So editing the vectors is a deliberate, visible act: change the JSON, re-hash,
 * and the mobile sync must pick up the new hash. An accidental edit cannot pass.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const vectorsDir = resolve(import.meta.dirname, "../../shared/src/testVectors");
const vectorsPath = resolve(vectorsDir, "threadRepliesReadModel.vectors.json");
const checksumPath = resolve(vectorsDir, "threadRepliesReadModel.vectors.sha256");

test("the shared conformance vectors match their recorded checksum", () => {
  const bytes = readFileSync(vectorsPath);
  const actual = createHash("sha256").update(bytes).digest("hex");

  const recorded = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];

  assert.equal(
    actual,
    recorded,
    "the vectors changed without re-recording the checksum. That is exactly how the "
    + "cross-repo 'one shared file' guarantee rots: our copy moves, mobile's does not, "
    + "and both suites keep passing against different data. If the change is intentional, "
    + "re-run: shasum -a 256 threadRepliesReadModel.vectors.json > threadRepliesReadModel.vectors.sha256 "
    + "and tell @HanXin to re-sync the mobile copy to the new hash.",
  );
});
