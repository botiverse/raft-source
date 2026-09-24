import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  clearPendingRestartMarker,
  readPendingRestartMarker,
  shouldReconcilePendingRestart,
  writePendingRestartMarker,
} from "./restartMarker.js";

test("pending restart marker survives the service blip and is origin-gated", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-restart-marker-"));
  try {
    const marker = {
      requestId: "restart-1",
      originServerId: "server-a",
      startedAt: "2026-07-11T04:24:51.000Z",
    };
    await writePendingRestartMarker(home, marker);

    assert.deepEqual(await readPendingRestartMarker(home), marker);
    assert.equal(shouldReconcilePendingRestart(marker, "server-a"), true);
    assert.equal(shouldReconcilePendingRestart(marker, "server-b"), false);

    await clearPendingRestartMarker(home);
    assert.equal(await readPendingRestartMarker(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
