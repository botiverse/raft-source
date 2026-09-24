import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSidebarChannelFocusState,
  buildSidebarDisclosureRestoreState,
  centeredSidebarScrollTop,
  isSidebarDisclosureRestoreState,
  readSidebarChannelFocusRequest,
} from "../src/components/layout/sidebarChannelFocus";

test("sidebar channel focus navigation state is exact and fail closed", () => {
  const state = buildSidebarChannelFocusState("channel-42");
  assert.deepEqual(readSidebarChannelFocusRequest(state), {
    kind: "channel",
    id: "channel-42",
    align: "center",
  });
  assert.equal(readSidebarChannelFocusRequest(null), null);
  assert.equal(readSidebarChannelFocusRequest({ sidebarChannelFocus: {} }), null);
  assert.equal(readSidebarChannelFocusRequest({
    sidebarChannelFocus: {
      kind: "dm",
      id: "channel-42",
      align: "center",
    },
  }), null);
  assert.equal(readSidebarChannelFocusRequest({
    sidebarChannelFocus: {
      kind: "channel",
      id: "channel-42",
      align: "nearest",
    },
  }), null);
});

test("default-route disclosure restore state is exact and fail closed", () => {
  assert.equal(isSidebarDisclosureRestoreState(buildSidebarDisclosureRestoreState()), true);
  assert.equal(isSidebarDisclosureRestoreState(null), false);
  assert.equal(isSidebarDisclosureRestoreState({ sidebarDisclosureRestore: false }), false);
  assert.equal(isSidebarDisclosureRestoreState({ sidebarDisclosureRestore: "true" }), false);
});

test("sidebar centering targets the requested row without scrolling above zero", () => {
  assert.equal(centeredSidebarScrollTop({
    currentScrollTop: 100,
    itemHeight: 40,
    itemTop: 250,
    viewportHeight: 400,
    viewportTop: 50,
  }), 120);
  assert.equal(centeredSidebarScrollTop({
    currentScrollTop: 0,
    itemHeight: 32,
    itemTop: 40,
    viewportHeight: 500,
    viewportTop: 20,
  }), 0);
});
