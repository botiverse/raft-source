import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ObjectInboxItem } from "@botiverse/raft-shared";
import {
  ARTIFACT_OBJECT_WINDOW_KIND,
  artifactWindowPayloadOf,
  isNewWindowClick,
  openActivityRowInAnotherWindow,
  openArtifactInWindow,
} from "../src/apps/artifacts/artifactWindowOpening";
import {
  openObjectWindowInMain,
  registerObjectWindowKind,
  resetObjectWindowsForTests,
  setObjectWindowTitle,
  useObjectWindowStore,
} from "../src/features/objectWindows/objectWindowStore";
import { noteObjectWindowNavigationIntent, takeObjectWindowNavigationIntent } from "../src/features/objectWindows/objectWindowLinkRouting";

// #337 PR3, the Artifact mini window: in Raft Desktop (a bridge with
// facts.objectWindows) with artifact_mini_window_v0 on, an Artifact opens in
// an object window of kind "artifact" (one reused, another on Cmd/Ctrl);
// anywhere else openArtifactInWindow answers false and the opener does what
// it did before. The opener passes the flag's answer its label was drawn
// with (useArtifactMiniWindows) as `enabled`.

type BridgeHost = { raftDesktop?: unknown };
type ChildWindow = Window & typeof globalThis;

const ID = asArtifactId("pt_11111111-1111-4111-8111-111111111111");
const created: ChildWindow[] = [];

function installBridge() {
  const raise = vi.fn(async (_target: string) => true);
  (window as unknown as BridgeHost).raftDesktop = { facts: { canOpenNewWindow: false, objectWindows: true }, objectWindows: { raise, setReusable: vi.fn() } };
  return { raise };
}

function stubWindowOpen() {
  const opened = vi.spyOn(window, "open").mockImplementation(() => {
    const child = new JSDOM("", { pretendToBeVisual: true }).window as unknown as ChildWindow;
    created.push(child);
    return child;
  });
  return opened;
}

afterEach(() => {
  resetObjectWindowsForTests();
  delete (window as unknown as BridgeHost).raftDesktop;
  vi.restoreAllMocks();
  for (const child of created.splice(0)) child.close();
});

const click = (over: Partial<Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

test("Cmd or Ctrl with the primary button asks for another window; Shift, Alt or another button doesn't", () => {
  assert.equal(isNewWindowClick(click({ metaKey: true })), true);
  assert.equal(isNewWindowClick(click({ ctrlKey: true })), true);
  assert.equal(isNewWindowClick(click()), false);
  assert.equal(isNewWindowClick(click({ metaKey: true, shiftKey: true })), false);
  assert.equal(isNewWindowClick(click({ ctrlKey: true, altKey: true })), false);
  assert.equal(isNewWindowClick(click({ metaKey: true, button: 1 })), false);
});

test("a browser, or Raft Desktop with the flag off as the label says: false, and no window opens", () => {
  const open = stubWindowOpen();
  assert.equal(openArtifactInWindow({ id: ID, version: null }, { enabled: true, source: "all" }), false, "no bridge");
  installBridge();
  assert.equal(openArtifactInWindow({ id: ID, version: null }, { enabled: false, source: "all" }), false, "the flag off");
  assert.equal(open.mock.calls.length, 0);
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
});

test("Raft Desktop with the flag on: an Artifact window, reused by a plain open, another on Cmd/Ctrl", () => {
  const { raise } = installBridge();
  const open = stubWindowOpen();
  const row = document.createElement("a");
  document.body.append(row);
  try {
    assert.equal(openArtifactInWindow({ id: ID, version: 3 }, { enabled: true, source: "message_card", from: row, title: "Weekly" }), true);
    const first = useObjectWindowStore.getState().windows.get("raft-object-window-1");
    assert.equal(first?.kind, ARTIFACT_OBJECT_WINDOW_KIND);
    assert.deepEqual(first?.payload, { target: { id: ID, version: 3 }, source: "message_card" });
    assert.equal(first?.doc.title, "Weekly");
    assert.ok(first?.openedFrom?.deref() === row, "focus goes back to the row when it closes");

    assert.equal(openArtifactInWindow({ id: ID, version: null }, { enabled: true, source: "all", title: "Roadmap" }), true);
    assert.equal(open.mock.calls.length, 1, "the reused window: no second window.open");
    assert.equal(first?.doc.title, "Roadmap", "the reused window is named for its new Artifact, not the old one");
    assert.deepEqual(useObjectWindowStore.getState().windows.get("raft-object-window-1")?.payload, { target: { id: ID, version: null }, source: "all" });
    assert.deepEqual(raise.mock.calls, [["raft-object-window-1"]]);

    assert.equal(openArtifactInWindow({ id: ID, version: null }, { enabled: true, source: "all", additional: true }), true);
    assert.equal(open.mock.calls.length, 2);
    assert.equal(useObjectWindowStore.getState().windows.size, 2);
  } finally {
    row.remove();
  }
});

test("an Activity row opens another window only on Cmd/Ctrl-click", () => {
  installBridge();
  stubWindowOpen();
  const row = document.createElement("div");
  const item = { kind: "object", objectKind: "artifact", objectId: ID, summary: null } as unknown as ObjectInboxItem<"artifact">;
  assert.equal(openActivityRowInAnotherWindow({ ...click(), currentTarget: row }, item, true), false);
  assert.equal(openActivityRowInAnotherWindow({ ...click({ metaKey: true }), currentTarget: row }, item, false), false, "the flag off as the row knows it");
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
  assert.equal(openActivityRowInAnotherWindow({ ...click({ metaKey: true }), currentTarget: row }, item, true), true);
  assert.deepEqual(useObjectWindowStore.getState().windows.get("raft-object-window-1")?.payload, { target: { id: ID, version: null }, source: "activity" });
});

test("an Artifact window's payload is read back only when it names an Artifact", () => {
  assert.deepEqual(artifactWindowPayloadOf({ target: { id: ID, version: 2 }, source: "all" }), { target: { id: ID, version: 2 }, source: "all" });
  assert.deepEqual(artifactWindowPayloadOf({ target: { id: ID, version: null } }), { target: { id: ID, version: null }, source: "other" });
  assert.equal(artifactWindowPayloadOf(null), null);
  assert.equal(artifactWindowPayloadOf({ target: { id: 7, version: null } }), null);
  assert.equal(artifactWindowPayloadOf({ target: { id: ID, version: "2" } }), null);
});

test("Open in main window: the kind is asked with the window still open, then it closes; the press's raise is used up", () => {
  installBridge();
  stubWindowOpen();
  const openWhenAsked: boolean[] = [];
  const openInMain = vi.fn((_payload: unknown) => {
    // What the kind reads of the window (the version its view shows) is read before the close (Kirby).
    openWhenAsked.push(useObjectWindowStore.getState().windows.has("raft-object-window-1"));
  });
  registerObjectWindowKind(ARTIFACT_OBJECT_WINDOW_KIND, () => null, { openInMain });
  openArtifactInWindow({ id: ID, version: 4 }, { enabled: true, source: "all" });
  noteObjectWindowNavigationIntent();
  openObjectWindowInMain("raft-object-window-1");
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
  assert.deepEqual(openInMain.mock.calls, [[{ target: { id: ID, version: 4 }, source: "all" }]]);
  assert.deepEqual(openWhenAsked, [true]);
  assert.equal(takeObjectWindowNavigationIntent(), false, "the kind raises the main window itself: the location change doesn't again");
});

test("a title for the window's object only while it is the window's: a replaced Artifact's view names nothing", () => {
  installBridge();
  stubWindowOpen();
  openArtifactInWindow({ id: ID, version: null }, { enabled: true, source: "all", title: "First" });
  const first = useObjectWindowStore.getState().windows.get("raft-object-window-1")!;
  const firstPayload = first.payload;
  setObjectWindowTitle(first.name, "First, loaded", firstPayload);
  assert.equal(first.doc.title, "First, loaded");
  openArtifactInWindow({ id: ID, version: 2 }, { enabled: true, source: "all", title: "Second" });
  setObjectWindowTitle(first.name, "Artifacts", firstPayload);
  assert.equal(first.doc.title, "Second", "the replaced view's late word changes nothing");
});

test("a kind that throws still has its window closed", () => {
  installBridge();
  stubWindowOpen();
  registerObjectWindowKind(ARTIFACT_OBJECT_WINDOW_KIND, () => null, { openInMain: () => { throw new Error("no main"); } });
  openArtifactInWindow({ id: ID, version: null }, { enabled: true, source: "all" });
  assert.throws(() => openObjectWindowInMain("raft-object-window-1"));
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
});
