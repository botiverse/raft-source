import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

// Scanner-works gate for the AX surfaces manifest generator (print-seam S4).
// The manifest itself is NOT checked in (@xxchan ruling: it is an
// intermediate — consumers generate it on demand; the AX HTML is CI-published
// from it). What must not rot is the SCANNER: if the definition shape drifts
// away from what the generator parses, the manifest would silently shrink, so
// this gate pins a floor and shape instead of a committed diff.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(ROOT, "RELEASE_SOURCE"));

test("manifest covers both sides and the standing prompt", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, async () => {
  const { buildManifest } = await import(
    new URL("../../../scripts/generate-ax-manifest.mjs", import.meta.url).href
  );
  const entries = buildManifest(ROOT).entries;
  assert.ok(entries.length >= 60, `suspiciously few surfaces (${entries.length}) — scanner broken?`);
  assert.ok(entries.some((e: { side: string }) => e.side === "cli"));
  assert.ok(entries.some((e: { side: string }) => e.side === "daemon"));
  assert.ok(entries.some((e: { family: string }) => e.family === "standing_prompt"));
});

test("branded mint-site gate is clean (raw `as Brand` casts only in declared utils)", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, async () => {
  const { checkBrandedMintSites } = await import(
    new URL("../../../scripts/ci/check-branded-mint-sites.mjs", import.meta.url).href
  );
  assert.deepEqual(checkBrandedMintSites(ROOT), []);
});
