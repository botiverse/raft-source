import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DISPLAY_LOCALES } from "@botiverse/raft-shared";

// sw.js is plain JS outside the build, so it keeps its own copy of the display
// locales (#13083 added ru to shared but not here). Keep the two equal.
test("service worker's DISPLAY_LOCALES equals the shared list", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const literal = /^const DISPLAY_LOCALES = (\[[^\]]*\]);$/m.exec(source)?.[1];
  assert.ok(literal, "sw.js: DISPLAY_LOCALES literal not found");
  assert.deepEqual([...JSON.parse(literal)].sort(), [...DISPLAY_LOCALES].sort());
});
