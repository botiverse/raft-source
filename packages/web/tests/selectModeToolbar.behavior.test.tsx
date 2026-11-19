import "./helpers/domSetup";

import assert from "node:assert/strict";
import { useState } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import SelectModeToolbar from "../src/components/message/SelectModeToolbar";
import { selectionEnded } from "../src/components/message/useSelectionShareHandlers";
import { useSelectionStore } from "../src/store/selectionStore";
import { renderWithIntl } from "./helpers/intl";

// The select-mode toolbar (raft-ui SelectionToolbar, #proj-raft-ui:#256):
// Generate image stops a rendering image (not a double click), ending the
// selection any way stops it (useSelectionShareHandlers), and only Copy
// Markdown says Copied on itself.

const CHANNEL = "channel-1";

function select(ids: string[]) {
  act(() => {
    useSelectionStore.setState({ isActive: true, channelId: CHANNEL, selectedIds: new Set(ids) } as never);
  });
}

function show(props: Partial<Parameters<typeof SelectModeToolbar>[0]> = {}) {
  const calls = { savePic: 0, cancel: 0 };
  const view = renderWithIntl(
    <SelectModeToolbar
      channelId={CHANNEL}
      onSavePic={() => { calls.savePic += 1; }}
      onCopyMd={() => {}}
      onCopyLinks={() => Promise.resolve(true)}
      onCancelCapture={() => { calls.cancel += 1; }}
      {...props}
    />,
  );
  return { calls, view };
}

afterEach(() => {
  cleanup();
  useSelectionStore.setState({ isActive: false, channelId: null, selectedIds: new Set() } as never);
});

test("Generate image starts the image; while it renders the same action stops it, but not on a double click", () => {
  select(["m1", "m2"]);
  const calls = { savePic: 0, cancel: 0 };
  function Host() {
    const [capturing, setCapturing] = useState(false);
    return (
      <SelectModeToolbar
        channelId={CHANNEL}
        onSavePic={() => { calls.savePic += 1; setCapturing(true); }}
        onCopyMd={() => {}}
        onCancelCapture={() => { calls.cancel += 1; setCapturing(false); }}
        capturing={capturing}
      />
    );
  }
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    renderWithIntl(<Host />);
    const action = () => screen.getByTestId("select-mode-share-open");
    fireEvent.click(action());
    assert.equal(calls.savePic, 1);
    assert.match(action().textContent ?? "", /Stop rendering/);
    // The second click of a double click: the image keeps rendering.
    now += 100;
    fireEvent.click(action());
    assert.equal(calls.cancel, 0);
    now += 1000;
    fireEvent.click(action());
    assert.equal(calls.cancel, 1);
    assert.equal(useSelectionStore.getState().isActive, true, "stopping the image keeps the selection");
  } finally {
    Date.now = realNow;
  }
});

test("× ends the selection, rendering or not", () => {
  select(["m1"]);
  show({ capturing: true });
  fireEvent.click(screen.getByTestId("select-mode-cancel"));
  assert.equal(useSelectionStore.getState().isActive, false);
});

test("an image stops when its selection ends, however it ends (×, Esc, another conversation)", () => {
  const on = { isActive: true, channelId: CHANNEL };
  assert.equal(selectionEnded({ isActive: false, channelId: null }, on), true, "× or Esc");
  assert.equal(selectionEnded({ isActive: true, channelId: "other" }, on), true, "selecting in another conversation");
  assert.equal(selectionEnded({ isActive: true, channelId: CHANNEL }, on), false, "ticking another message");
  assert.equal(selectionEnded({ isActive: true, channelId: CHANNEL }, { isActive: false, channelId: null }), false, "starting a selection");
});

test("each copy says Copied on itself: Copy Markdown from its flag, Copy link once its copy succeeded", async () => {
  select(["m1"]);
  let resolveCopy: (ok: boolean) => void = () => {};
  show({ copied: true, onCopyLinks: () => new Promise<boolean>((resolve) => { resolveCopy = resolve; }) });
  assert.match(screen.getByTestId("select-mode-copy-md").textContent ?? "", /Copied/);
  const copyLink = () => screen.getByTestId("select-mode-copy-link");
  assert.doesNotMatch(copyLink().textContent ?? "", /Copied/, "Copy Markdown's Copied is not Copy link's");
  fireEvent.click(copyLink());
  assert.doesNotMatch(copyLink().textContent ?? "", /Copied/, "not before the clipboard took it");
  await act(async () => { resolveCopy(true); });
  assert.match(copyLink().textContent ?? "", /Copied/);
});

test("a copy of links that failed does not say Copied", async () => {
  select(["m1"]);
  show({ onCopyLinks: () => Promise.resolve(false) });
  await act(async () => { fireEvent.click(screen.getByTestId("select-mode-copy-link")); });
  assert.doesNotMatch(screen.getByTestId("select-mode-copy-link").textContent ?? "", /Copied/);
});

test("Copy link's Copied goes when the selection changes: it no longer describes it", async () => {
  select(["m1"]);
  show({ onCopyLinks: () => Promise.resolve(true) });
  await act(async () => { fireEvent.click(screen.getByTestId("select-mode-copy-link")); });
  assert.match(screen.getByTestId("select-mode-copy-link").textContent ?? "", /Copied/);
  select(["m1", "m2"]);
  assert.doesNotMatch(screen.getByTestId("select-mode-copy-link").textContent ?? "", /Copied/);
});
