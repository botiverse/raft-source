import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("desktop chat sidebar has a compact max width to avoid empty right gutter", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/layout/MainLayout.tsx"), "utf8");

  assert.match(
    source,
    /useResizablePanel\(\{ storageKey: "slock:sidebarWidth", min: 180, max: 320, defaultWidth: 240 \}\)/,
  );
  assert.doesNotMatch(source, /storageKey: "slock:sidebarWidth"[^}]*max: 400/);
});

test("desktop chat sidebar uses shrink-0 so the resize handle changes visible width", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/layout/MainLayout.tsx"), "utf8");

  assert.match(
    source,
    // Master-detail adds `flex flex-col` alongside the right divider so
    // MessageSearchPage's `flex min-h-0 flex-1 flex-col` root gets a flex
    // parent (otherwise its `flex-1` doesn't constrain height and the
    // results list overflows the viewport, killing scroll). Reported by
    // stdrc #proj-uiux:c2313b1d msg=86b31b78 (2026-05-28).
    /className=\{`bg-brutal-cream relative min-w-0 \$\{mobileShowSidebarInline \? "flex-1" : "shrink-0"\} \$\{searchMasterDetail \? "flex flex-col border-r-2 border-black" : ""\}`\}/,
  );
  // task #311 master/detail: when /search has an open slot, col 2 hosts the
  // search panel. At lg+ (≥1024) it uses the search-specific persisted
  // width (`searchPanelWidth`, 400-720, default 560). At 768-1023 (md) and
  // when a third work pane is open at lg+, col 2 swaps to
  // `searchPanelCompactWidth` (320-480, default 320) — independent persisted
  // mid-width that's wider than chat sidebarWidth (240 felt too small for
  // search rows per stdrc msg=6fa799a7) but narrower than the lg master width
  // (560 squeezed col 3 at md per msg=6dd1dc38; or col-2+col-4 squeezed col 3
  // at lg per msg=ea3dd8b3). The same degradation applies when Activity/Search
  // shows List | Thread | Profile, where slot.kind === "thread" but the profile
  // panel still makes it a three-pane layout. Non-search routes always use
  // sidebarWidth.
  // Mobile drops the explicit width so the inline-as-content sidebar fills
  // the viewport. Policy per stdrc #proj-uiux:c2313b1d msg=1351abcf /
  // ea3dd8b3 / 6fa799a7 / 0ed291ab / 6dd1dc38 (2026-05-26 → 2026-05-28).
  assert.match(
    source,
    /const profileOpenForLayout = useProfileStore\(\(s\) => !!s\.profileId\);/,
  );
  assert.match(
    source,
    /const contentRouteThreadOverlayOpen =\s*searchMasterDetail && threadOpenForLayout && !!searchSlotKind && searchSlotKind !== "thread";/,
  );
  assert.match(
    source,
    /const contentRouteProfileOverlayOpen = searchMasterDetail && profileOpenForLayout;/,
  );
  assert.match(
    source,
    /const searchColTwoCompact = contentRouteThreadOverlayOpen \|\| contentRouteProfileOverlayOpen;/,
  );
  // Breakpoint selection and both resize/recovery paths are covered through
  // the production sizing seam in masterDetailPanelResize.behavior.test.tsx.
  assert.match(
    source,
    /workspaceEnabled\s*\?\s*\{[\s\S]*?minWidth:\s*MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,[\s\S]*?maxWidth:\s*`min\(\$\{MAX_WORKSPACE_GRID_SIDEBAR_WIDTH\}px, 40vw\)`,?[\s\S]*?\}\s*:\s*\{\}/,
    "Workspace mode should add its own responsive min/max width without changing classic sizing",
  );
  assert.doesNotMatch(source, /className="bg-brutal-cream relative min-w-0 flex-1"/);
  assert.doesNotMatch(source, /className="bg-brutal-cream relative min-w-0 shrink-0"/);
});

test("activity thread plus profile uses compact master width inside 1470px viewport budget", () => {
  const leftRailWidth = 64;
  const compactActivityWidth = 320;
  const profileWidth = 380;
  const minReadableThreadWidth = 640;
  const task88ViewportWidth = 1470;

  assert.ok(
    leftRailWidth + compactActivityWidth + minReadableThreadWidth + profileWidth <= task88ViewportWidth,
    "List | Thread | Profile should fit the reported 1470px viewport after compacting col 2",
  );

  const wideActivityDefaultWidth = 560;
  assert.ok(
    leftRailWidth + wideActivityDefaultWidth + minReadableThreadWidth + profileWidth > task88ViewportWidth,
    "the wide master default must not be used for the three-pane profile layout",
  );
});

test("thread side panel browser resize path stays CSS-only", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/layout/MainLayout.tsx"), "utf8");
  const threadPanelSource = readFileSync(resolve(repoRoot, "src/components/message/ThreadPanel.tsx"), "utf8");
  const styles = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");
  const sideThreadColumn = source.match(/function SideThreadColumn\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.ok(sideThreadColumn, "SideThreadColumn source should be discoverable");
  assert.doesNotMatch(
    sideThreadColumn,
    /window\.addEventListener\("resize"/,
    "SideThreadColumn must not update React state for every browser resize pixel",
  );
  assert.match(
    styles,
    /@media \(orientation: landscape\), \(min-width: 1280px\)[\s\S]*?@container thread-layout \(min-width: 680px\)[\s\S]*?\.thread-side-column[\s\S]*?max-width:\s*calc\(100% - 320px\)/,
    "dual-pane must require a landscape-or-xl shell and keep the parent-relative channel floor",
  );
  assert.doesNotMatch(
    sideThreadColumn,
    /maxWidth:\s*"60vw"/,
    "viewport-relative thread width ignores the rail/sidebar space and can squeeze the channel",
  );
  assert.match(
    sideThreadColumn,
    /setDynamicMax\(getThreadPanelDynamicMax\(\)\);\s*handleResizeStart\(e\);/,
    "drag bounds should refresh only when the user starts resizing the thread panel",
  );
  assert.match(
    source,
    /className="thread-layout-container flex min-h-0 min-w-0 flex-1"/,
    "the chat row must own the named responsive container",
  );
  assert.match(
    source,
    /className="thread-main-column flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"\s+data-testid="thread-main-column"/,
    "profile collapse must target an explicit channel main-column contract, not an incidental child position",
  );
  assert.match(
    styles,
    /\.thread-layout-container\s*\{[\s\S]*?container-type:\s*inline-size;[\s\S]*?container-name:\s*thread-layout;/,
    "thread mode must respond to the actual chat row width",
  );
  assert.match(
    styles,
    /\.thread-layout-container\s*\{[\s\S]*?overflow:\s*hidden;/,
    "thread/profile panes must clip intrinsic tab content inside the main content column",
  );
  assert.match(
    styles,
    /thread-profile-side-column\s*> \[data-testid="profile-panel"\][\s\S]*?min-width:\s*0[\s\S]*?max-width:\s*100%[\s\S]*?overflow:\s*hidden;/,
    "profile tab content must not grow the flex row and push shell columns out of view",
  );
  assert.match(
    styles,
    /\.thread-layout-container:has\(> \.thread-profile-side-column\[data-collapse-thread="true"\]\) > \.thread-side-column\s*\{[\s\S]*?display:\s*none;/,
    "a Channel-origin profile must fold only the retained Thread pane",
  );
  assert.doesNotMatch(
    styles,
    /thread-profile-side-column\[data-collapse-channel="true"\]\) > :first-child/,
    "profile collapse must never hide an incidental first child such as the rail or sidebar",
  );
  assert.match(
    styles,
    /\.thread-layout-container:has\(> \.thread-side-column\) > \.thread-main-column\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.thread-side-column\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?\.thread-side-column \[data-testid="thread-mobile-back"\][\s\S]*?display:\s*flex;[\s\S]*?\.thread-side-column \[data-testid="thread-close"\][\s\S]*?display:\s*none;/,
    "thread-only must be the safe default with a back affordance",
  );
  assert.match(
    styles,
    /@media \(orientation: landscape\), \(min-width: 1280px\)[\s\S]*?@container thread-layout \(min-width: 680px\)[\s\S]*?\.thread-layout-container:has\(> \.thread-side-column\) > \.thread-main-column\s*\{[\s\S]*?display:\s*flex;[\s\S]*?\.thread-side-column \[data-testid="thread-mobile-back"\][\s\S]*?display:\s*none;[\s\S]*?\.thread-side-column \[data-testid="thread-close"\][\s\S]*?display:\s*flex;/,
    "only the wide landscape-or-xl mode may restore channel + thread dual-pane chrome",
  );
  assert.match(threadPanelSource, /useMobileBack\(/);
  assert.match(threadPanelSource, /threadIsOnParentSurface \? parentPath : handleClose/);
  assert.match(threadPanelSource, /threadIsOnParentSurface \? closeThread : undefined/);
  assert.match(
    threadPanelSource,
    /presentation === "mobile-modal"[\s\S]*?\? handleClose[\s\S]*?: onMobileBack/,
    "regular thread back must restore its real origin while cold links and modal hosts keep deterministic fallbacks",
  );
});

test("sidebar section headers share row, toggle, and icon-button geometry", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/layout/Sidebar.tsx"), "utf8");

  assert.match(
    source,
    /const SIDEBAR_SECTION_ROW_CLASS = "mb-1 mt-3 flex h-6 items-center justify-between px-2"/,
  );
  assert.match(
    source,
    /const SIDEBAR_SECTION_ROW_FIRST_CLASS = "mb-1 flex h-6 items-center justify-between px-2"/,
  );
  assert.match(
    source,
    /const SIDEBAR_SECTION_TOGGLE_CLASS = "flex h-6 min-w-0 flex-1 items-center gap-1 text-xs font-bold uppercase text-black tracking-widest hover:text-black\/70 transition-colors"/,
  );
  assert.match(
    source,
    /const SIDEBAR_SECTION_ICON_BUTTON_CLASS = "btn-flat-sm flex size-6 items-center justify-center p-0"/,
  );

  assert.doesNotMatch(source, /className="mb-1 mt-3 flex items-center justify-between px-2"/);
  assert.doesNotMatch(source, /className="flex items-center gap-1 text-xs font-bold uppercase text-black tracking-widest/);
});
