/**
 * Manifest capability teeth (task #204, per @XX + @庄天翼 19:47Z).
 *
 * The 01:00Z freeze RETAINS app identity, the closed config schema/default/range,
 * and notification-class identity — and DELETES every Server-side execution
 * capability. This file holds both directions:
 *
 *   POSITIVE — the config source still produces a pushable snapshot, so the
 *   deletion did not also remove the thing #204 exists to deliver.
 *   NEGATIVE — any of the removed Server execution capabilities reappearing in
 *   the manifest is RED.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { CLEANER_APP_ID } from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import {
  BUILT_IN_MEMORY_CLEANER_APP,
  BUILT_IN_SIZE_MONITOR_CONFIG_PROJECTOR,
} from "./definition.js";

/** Server execution capabilities the 01:00Z freeze removed outright. */
const DELETED_SERVER_SYSCALLS = ["notify", "readOwnState", "writeOwnState"] as const;

test("RETAIN: app identity and notification-class identity survive", () => {
  assert.equal(BUILT_IN_MEMORY_CLEANER_APP.appId, CLEANER_APP_ID);
  assert.equal(BUILT_IN_MEMORY_CLEANER_APP.manifest.app_id, CLEANER_APP_ID);
  assert.deepEqual(BUILT_IN_MEMORY_CLEANER_APP.manifest.notifications, ["memory_size_hint"]);
});

test("NEGATIVE: no Server execution syscall may be claimed", () => {
  const claimed: readonly string[] = BUILT_IN_MEMORY_CLEANER_APP.manifest.syscalls;
  for (const syscall of DELETED_SERVER_SYSCALLS) {
    assert.ok(
      !claimed.includes(syscall),
      `manifest re-claimed Server syscall "${syscall}" — deleted by the 01:00Z freeze. ` +
        `Cleaner notifications are minted Computer-local and transient by #203; own-state ` +
        `access is gone outright.`,
    );
  }
  assert.deepEqual(claimed, [], "Cleaner holds no Server delivery authority at all");
});

test("NEGATIVE: no hook is registered — no onDue, timer, or delivery", () => {
  assert.deepEqual(BUILT_IN_MEMORY_CLEANER_APP.manifest.hooks, []);
});

test("POSITIVE: config publication survives the capability deletion", () => {
  // Projection itself is covered in configProjector.test.ts; here we only assert
  // the deletion above did not remove what #204 exists to deliver.
  assert.equal(typeof BUILT_IN_SIZE_MONITOR_CONFIG_PROJECTOR.project, "function");
  assert.equal(BUILT_IN_MEMORY_CLEANER_APP.manifest.config.threshold_bytes.type, "integer");
});
