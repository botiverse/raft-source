import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

test("server boot keeps the legacy attachment cleaner dormant until inventory migration completes", async () => {
  const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");

  assert.doesNotMatch(
    serverSource,
    /\bstartOrphanCleanup\s*\(/,
    "legacy objectless projections are inventory provenance and must not be deleted at server boot",
  );
});
