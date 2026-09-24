import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => {
  const text = readFileSync(resolve(repoRoot, path), "utf8");
  if (!text.startsWith("// @ts-nocheck\n") && !text.includes("function stryNS_")) return text;
  return execFileSync("git", ["show", `HEAD:packages/web/${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
};
const src = read("src/components/layout/Sidebar.tsx");
const appNavigateSrc = read("src/hooks/useAppNavigate.ts");

// broad-subscription sweep P0-B — Sidebar row re-render isolation.
//
// The Sidebar renders one row per channel/DM/agent — hundreds in a large server.
// Two independent stores churn a new reference on EVERY inbound `message:new`:
//   - messageStore.unreadCounts  (rebuilt: `{ ...unreadCounts, [id]: n }`)
//   - channelStore.channels / dmChannels  (rebuilt by `touchChannelActivity`
//     bumping `lastMessageAt`)
// The second one re-renders the Sidebar PARENT no matter how we narrow unread, so
// the only way to stop the per-row storm is to make the rows skip reconciliation
// when the parent re-renders. That requires BOTH:
//   (a) the row is a `memo`'d leaf that selects only its own unread/draft slice, and
//   (b) the parent passes it STABLE props — `useCallback` handlers + primitive
//       selected/menuOpen — so memo's shallow compare actually short-circuits.
//
// Profiling proved (a) without (b) is a no-op: with freshly-built inline handlers
// every parent re-render still walked all ~300 rows (~80ms of child reconcile).
// These assertions pin the whole invariant so a future refactor can't silently
// reintroduce the freeze by inlining a handler or dropping a memo.

test("high-fanout Sidebar rows are memo'd leaves", () => {
  for (const name of ["ChannelRow", "DmRow", "AgentDmRow"]) {
    assert.match(
      src,
      new RegExp(`const ${name} = memo\\(`),
      `${name} must be a memo()'d leaf so it can skip re-render when the parent re-renders on channels/unread churn`,
    );
  }
});

test("Sidebar row leaves self-subscribe to a single id's unread/draft slice", () => {
  // ChannelRow keys off the channel id directly.
  assert.match(src, /useMessageStore\(\s*\(s\)\s*=>\s*s\.unreadCounts\[channel\.id\]\s*\|\|\s*0\s*\)/);
  assert.match(src, /useMessageStore\(\s*\(s\)\s*=>\s*!!s\.drafts\[channel\.id\]\s*\)/);
});

test("Sidebar row select/contextmenu/longpress handlers are useCallback-stable", () => {
  // Stable identities are what make the memo'd rows skippable on parent re-render.
  for (const decl of [
    "const handleSelectChannel = useCallback(",
    "const handleSelectDm = useCallback(",
    "const handleSelectAgent = useCallback(",
    "const openCtxMenu = useCallback(",
    "const makeLongPressHandlers = useCallback(",
  ]) {
    assert.ok(
      src.includes(decl),
      `${decl}…) must be useCallback-stabilized — an inline handler defeats the row memo and reintroduces the all-rows re-render storm`,
    );
  }
});

test("classic sidebar toggle handlers keep route reads behind stable refs", () => {
  assert.match(
    src,
    /const navigateRef = useRef\(navigate\);[\s\S]*navigateRef\.current = navigate;/,
    "raw react-router navigate must be refreshed through a ref rather than captured in row-handler dependencies",
  );
  assert.match(
    src,
    /const pathnameRef = useRef\(location\.pathname\);[\s\S]*pathnameRef\.current = location\.pathname;/,
    "the current pathname must be read through a ref so route changes do not invalidate every row callback",
  );
  assert.match(
    src,
    /const serverSlugRef = useRef\(server\?\.slug\);[\s\S]*serverSlugRef\.current = server\?\.slug;/,
    "the current server slug must be refreshed through a ref so server changes do not invalidate every row callback",
  );
  assert.doesNotMatch(
    src,
    /\}, \[location\.pathname, longPressSuppressRef, markUnreadSidebarItemRead, navigate, nav,/,
    "handleSelectChannel must not capture route-churn values that defeat ChannelRow memoization",
  );
  assert.doesNotMatch(
    src,
    /\[location\.pathname, markUnreadSidebarItemRead, navigate, nav,/,
    "openDmSurface must not capture route-churn values that defeat DmRow memoization",
  );
  assert.doesNotMatch(
    src,
    /server\.slug, setSidebarOpen, workspaceEnabled\],/,
    "high-fanout row callbacks must not capture the route server slug directly",
  );
});

test("Sidebar passes STABLE handler references (not inline closures) into the row leaves", () => {
  // Reference form `onSelect={handleSelectChannel}` keeps memo effective; an inline
  // `onSelect={() => …}` would change identity every render and break it.
  assert.match(src, /onSelect=\{handleSelectChannel\}/);
  assert.match(src, /onSelect=\{handleSelectDm\}/);
  assert.match(src, /onSelect=\{handleSelectAgentDm\}/);
  assert.match(src, /onContextMenu=\{openCtxMenu\}/);
  assert.match(src, /makeLongPress=\{makeLongPressHandlers\}/);
  // The row must NOT receive a per-render-rebuilt className prop (that alone would
  // re-render every row each parent render); className is derived inside the leaf
  // from the primitive selected/menuOpen props instead.
  assert.doesNotMatch(
    src,
    /<ChannelRow[^>]*\sclassName=/s,
    "ChannelRow must derive its className internally from selected/menuOpen, not receive a rebuilt className prop",
  );
});

test("useAppNavigate identity is stable across route-change navigate churn", () => {
  assert.match(
    appNavigateSrc,
    /const navigateRef = useRef\(navigate\);/,
    "useAppNavigate must keep react-router's churny navigate function behind a ref",
  );
  assert.match(
    appNavigateSrc,
    /navigateRef\.current = navigate;/,
    "useAppNavigate must refresh the navigate ref each render so stable nav methods call the current router navigate",
  );
  assert.match(
    appNavigateSrc,
    /return useMemo\(\(\) => \{[\s\S]*\}, \[base\]\);/,
    "the nav object must only depend on server base; including raw navigate makes route changes invalidate every Sidebar row onSelect",
  );
  assert.doesNotMatch(
    appNavigateSrc,
    /return useMemo\(\(\) => \{[\s\S]*\}, \[navigate,\s*base\]\);/,
    "raw navigate must not be in the nav object deps because react-router returns a new navigate reference on location changes",
  );
});
