import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import type { DesktopWebPreviewTabList, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { PanelHeadChromeContext } from "../../src/components/layout/panelHeadChrome";
import type { PanelHeadChrome } from "../../src/components/layout/panelHeadChrome";
import { BrowserPanel } from "../../src/features/webPreview/BrowserPanel";
import { mirrorBrowserTabsList } from "../../src/features/webPreview/browserTabsStore";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { VisualTestingRoot } from "../VisualTestingRoot";
import "../../src/index.css";

// Raft Desktop's built-in browser panel head with pinned tabs (#proj-workspace:#297), drawn with the real
// BrowserPanel over a shell that only answers with a fixed tab list, for local screenshots
// (desktop-browser-tabs.shot.mjs): ?mode=light|dark&width=<panel px>&pinned=<n>&own=<n>&front=<tab id>&grip=0|1.
// Tabs are p1… (pinned) and t1… (the conversation's own). `own=0` is a conversation with no tabs of its own.
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const width = Number(params.get("width")) || 720;
const pinnedCount = Number(params.get("pinned") ?? 2);
const ownCount = Number(params.get("own") ?? 3);
const front = params.get("front") ?? "t1";
const withGrip = params.get("grip") !== "0";

const PAGES = [
  ["https://mail.example.com/inbox", "Inbox (3) - Mail"],
  ["http://localhost:5173/", "Vite dev server"],
  ["https://docs.example.com/guide/getting-started", "Getting started - Docs"],
  ["https://github.com/botiverse/raft-ui/pulls", "Pull requests - botiverse/raft-ui"],
  ["https://news.example.org/today", "Today's headlines"],
  ["https://status.example.net/", "All systems operational"],
  ["https://calendar.example.com/week", "Week - Calendar"],
  ["https://en.wikipedia.org/wiki/Otter", "Otter - Wikipedia"],
] as const;
const tab = (id: string, index: number) => ({ id, url: PAGES[index % PAGES.length]![0], title: PAGES[index % PAGES.length]![1], loading: false });
const pinned = Array.from({ length: pinnedCount }, (_, index) => tab(`p${index + 1}`, index));
const own = Array.from({ length: ownCount }, (_, index) => tab(`t${index + 1}`, pinnedCount + index));
const frontPinned = pinned.some((each) => each.id === front);
const list: DesktopWebPreviewTabList = {
  revision: 1,
  browsers: own.length > 0 ? [{ owner: "c1", tabs: own, activeId: own.find((each) => each.id === front)?.id ?? own[0]!.id, ...(frontPinned ? { pinnedFront: true } : null) }] : [],
  ...(pinned.length > 0 ? { pinned: { tabs: pinned, activeId: frontPinned ? front : pinned[0]!.id, open: true } } : null),
};

const nothing = () => {};
const bridge: DesktopWebPreviewTabsBridge = {
  open: nothing, activate: nothing, close: nothing, closeAll: nothing, back: nothing, forward: nothing, reload: nothing, setBounds: nothing,
  setVisible: async () => null,
  onState: () => nothing,
  list: { get: async () => list, dispatch: async () => list, present: nothing, onChange: () => nothing, pins: true },
};
mirrorBrowserTabsList(bridge.list!, "fixture-user");

// The head as a side section's: the grip that moves the panel, its bar drawn as under the pointer.
const chrome: PanelHeadChrome = {
  props: { className: "group/head relative" },
  grip: (
    <div
      data-side-grip=""
      data-testid="fixture-grip"
      className="absolute top-1.5 left-1/2 z-float h-6 w-24 -translate-x-1/2 cursor-grab before:pointer-events-none before:absolute before:top-[2px] before:left-1/2 before:h-1 before:w-14 before:-translate-x-1/2 before:rounded-full before:bg-line-seam before:content-['']"
    />
  ),
  tabs: null,
  headOnly: false,
};

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <div className="flex h-screen bg-layer-sidebar p-4">
        <div className="h-[220px] overflow-hidden rounded-card border border-line-seam bg-layer-canvas" style={{ width }} data-testid="fixture-panel">
          <PanelHeadChromeContext.Provider value={withGrip ? chrome : null}>
            <BrowserPanel bridge={bridge} conversationId="c1" covering={false} artifactBehind={false} />
          </PanelHeadChromeContext.Provider>
        </div>
      </div>
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
