import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSidebarPinnedRef,
  normalizeSidebarPinnedRefs,
  parseSidebarPinnedRefKey,
  removeSidebarPinnedRef,
  sidebarPinnedRefKey,
  upsertSidebarPinnedRef,
} from "../src/utils/sidebarPinnedRefs";
import type {
  SidebarPinnedRef,
} from "../src/utils/sidebarPinnedRefs";

test("sidebar pinned refs normalize typed refs and dedupe by kind plus id", () => {
  assert.deepEqual(normalizeSidebarPinnedRefs([
    { kind: "channel", id: "channel-1" },
    { kind: "channel", id: "channel-1" },
    { kind: "agent", id: "agent-1" },
    { kind: "human", id: "human-1" },
    { kind: "dm", id: "legacy-dm" },
    { kind: "agent", id: "" },
    "channel-1",
  ]), [
    { kind: "channel", id: "channel-1" },
    { kind: "agent", id: "agent-1" },
    { kind: "human", id: "human-1" },
  ]);
});

test("sidebar pinned ref keys round-trip and reject malformed keys", () => {
  const ref: SidebarPinnedRef = { kind: "agent", id: "agent:with:colon" };
  const key = sidebarPinnedRefKey(ref);

  assert.equal(key, "agent:agent:with:colon");
  assert.deepEqual(parseSidebarPinnedRefKey(key), ref);
  assert.equal(parseSidebarPinnedRefKey("agent:"), null);
  assert.equal(parseSidebarPinnedRefKey("dm:legacy-dm"), null);
  assert.equal(parseSidebarPinnedRefKey("bad"), null);
});

test("sidebar pinned ref helpers preserve existing order", () => {
  const refs: SidebarPinnedRef[] = [
    { kind: "channel", id: "channel-1" },
    { kind: "human", id: "human-1" },
  ];
  const agentRef: SidebarPinnedRef = { kind: "agent", id: "agent-1" };

  assert.equal(hasSidebarPinnedRef(refs, agentRef), false);
  assert.deepEqual(upsertSidebarPinnedRef(refs, agentRef), [...refs, agentRef]);
  assert.equal(upsertSidebarPinnedRef(refs, refs[0]), refs);
  assert.deepEqual(removeSidebarPinnedRef([...refs, agentRef], refs[0]), [refs[1], agentRef]);
});
