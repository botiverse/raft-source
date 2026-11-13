import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";

import { clearMarkedUnreadForRead, isScopeMarkedUnread, useMarkedUnreadStore } from "../src/store/markedUnreadStore";
import {
  consumeReadStateSnapshot,
  consumeReadStateUpdate,
  getAcceptedReadState,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
  resetReadStateSyncForTests,
} from "../src/store/readStateSync";
import { readSyncConversationState } from "../src/store/syncChangesClient";
import { useServerStore } from "../src/store/serverStore";

/**
 * "Manually marked unread" (#triage:#101): Mark as Unread with nothing
 * countable marks the conversation instead of moving its read point. The flag
 * rides every read-state carrier as an additive field, ordered by
 * readStateVersion like the read point, and one store holds what the sidebar
 * and Activity show.
 */

const SERVER = "srv-1";
const SCOPE = "thread-1";

beforeEach(() => {
  resetReadStateSyncForTests();
  useMarkedUnreadStore.setState({ marked: {} });
  useServerStore.setState({ current: { id: SERVER, slug: "s", name: "S", role: "member", plan: "free" } } as never);
});

afterEach(() => {
  resetReadStateSyncForTests();
  useMarkedUnreadStore.setState({ marked: {} });
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("the realtime and sync carriers parse the mark: true or absent, never the read fact's failure", () => {
  assert.deepEqual(
    normalizeReadStateUpdated({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true }),
    { serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true },
  );
  // An older server sends no mark; anything but true is no mark.
  assert.deepEqual(
    normalizeReadStateUpdated({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: "yes" }),
    { serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3 },
  );
  assert.deepEqual(
    normalizeReadStateUpdatedBulk({ serverId: SERVER, scopes: [{ scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true }] }),
    [{ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true }],
  );
  assert.deepEqual(
    readSyncConversationState({ read: { readSeq: 4, readStateVersion: 3, markedUnread: true } }),
    { read: { readSeq: 4, readStateVersion: 3, markedUnread: true } },
  );
  assert.deepEqual(
    readSyncConversationState({ read: { readSeq: 4, readStateVersion: 3 } }),
    { read: { readSeq: 4, readStateVersion: 3 } },
  );
});

test("an accepted read state sets and clears the shown mark; a stale one changes nothing", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true });
  assert.equal(isScopeMarkedUnread(SCOPE), true);
  assert.equal(getAcceptedReadState(SERVER, SCOPE)?.markedUnread, true);

  // An older snapshot (version 2) does not undo the mark.
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "present", readStateVersion: 2, maxReadSeq: "4", latestActivity: null });
  assert.equal(isScopeMarkedUnread(SCOPE), true);

  // The read that clears it is a newer version without the mark.
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 4 });
  assert.equal(isScopeMarkedUnread(SCOPE), false);

  // A served snapshot carries it too (sidebar summary, Activity rows).
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "present", readStateVersion: 5, maxReadSeq: "4", latestActivity: null, markedUnread: true });
  assert.equal(isScopeMarkedUnread(SCOPE), true);
  // No cursor row any more: not marked.
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "absent" });
  assert.equal(isScopeMarkedUnread(SCOPE), false);
});

test("at the version already held, a mark wins over a carrier without it (every flag change moves the version)", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3 });
  assert.equal(isScopeMarkedUnread(SCOPE), false);
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "present", readStateVersion: 3, maxReadSeq: "4", latestActivity: null, markedUnread: true });
  assert.equal(isScopeMarkedUnread(SCOPE), true, "true is the honest value at version 3");
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "present", readStateVersion: 3, maxReadSeq: "4", latestActivity: null });
  assert.equal(isScopeMarkedUnread(SCOPE), true, "a snapshot without the flag at the same version does not erase it");
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3 });
  assert.equal(isScopeMarkedUnread(SCOPE), true);
});

test("a read write from here clears the mark at once; another server's read state is not this one's", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 3, markedUnread: true });
  clearMarkedUnreadForRead(SCOPE);
  assert.equal(isScopeMarkedUnread(SCOPE), false, "opening or Mark as Read: the same write clears it on the server");

  consumeReadStateUpdate({ serverId: "srv-other", scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 9, markedUnread: true });
  assert.equal(isScopeMarkedUnread(SCOPE), false);
});
