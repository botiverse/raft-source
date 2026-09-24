import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageTimeline from "../src/components/message/MessageTimeline";

// #proj-uiux task #271: toggling translation (or any in-place message
// height change) changed the inner content column's height without
// resizing the scroller box. The scroller-only ResizeObserver never
// fired, the live anchor was never restored, and everything above the
// viewport jumped. The fix observes the inner content column too and
// reuses the existing re-pin / restore-anchor policy.
//
// MessageTimeline scroll behavior depends on real layout + ResizeObserver,
// which jsdom does not provide, so this is a source-level contract test
// (same pattern as attachmentPreviewLayout / markdownPreviewTruncation):
// it pins the structural invariant so the content-anchor observer can't
// be silently dropped in a refactor.

const repoRoot = resolve(import.meta.dirname, "..");
const strykerBackupSrc = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((name) => name.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
};

const source = readFileSync(
  resolve(strykerBackupSrc() ?? resolve(repoRoot, "src"), "components/message/MessageTimeline.tsx"),
  "utf8",
);

test("a contentRef is attached to the inner content column", () => {
  assert.match(
    source,
    /<div ref=\{contentRef\} style=\{\{ display: "flex", flexDirection: "column", minHeight: "100%" \}\}>/,
    "inner content column must carry contentRef so its height changes are observable",
  );
  assert.match(
    source,
    /const contentRef = useRef<HTMLDivElement>\(null\);/,
    "contentRef must be declared",
  );
});

test("a ResizeObserver observes the content column, not only the scroller", () => {
  assert.match(
    source,
    /ro\.observe\(content\);/,
    "content-height changes must be observed (translate toggle / edit / expand)",
  );
  // Still keep the original scroller observation (width-change re-anchor).
  assert.match(
    source,
    /ro\.observe\(scroller\);/,
    "the scroller box ResizeObserver (width-change re-anchor) must remain",
  );
});

test("the content-resize handler reuses the re-pin / restore-anchor policy", () => {
  assert.match(
    source,
    /const restoreAfterLayoutChange = useCallback\(\(scroller: HTMLElement, forceAnchor: boolean\) => \{/,
    "layout-change restore policy must stay centralized",
  );
  assert.match(
    source,
    /if \(isFollowingBottomRef\.current\) \{\s*scrollToBottomImmediate\(false\);/s,
    "follow-bottom case must be handled (re-pin) synchronously inside the ResizeObserver callback — wrapping in requestAnimationFrame defers scroll compensation to the next paint frame, producing the visible 1-frame jitter (first-reaction push-down then bounce-back) reported in #proj-uiux:c0b821dd task #318",
  );
  assert.match(
    source,
    /beginProgrammaticScroll\(\);\s*restoreAnchor\(scroller, anchor\);/s,
    "anchor restore must be marked programmatic and restore the live anchor",
  );

  // task #318: pin the "no requestAnimationFrame" invariant for the
  // ResizeObserver-fed restore path. Reintroducing rAF here re-introduces
  // the cross-frame layout/scroll mismatch users see as bounce-back.
  const restoreFnStart = source.indexOf("const restoreAfterLayoutChange = useCallback(");
  assert.ok(restoreFnStart >= 0, "restoreAfterLayoutChange must be present");
  const restoreFnEnd = source.indexOf("}, [beginProgrammaticScroll, scrollToBottomImmediate]);", restoreFnStart);
  assert.ok(restoreFnEnd > restoreFnStart, "restoreAfterLayoutChange must close with its dep array");
  const restoreFnBody = source.slice(restoreFnStart, restoreFnEnd);
  assert.doesNotMatch(
    restoreFnBody,
    /requestAnimationFrame/,
    "restoreAfterLayoutChange must run scroll adjustment synchronously — rAF would push compensation to the next paint (#proj-uiux:c0b821dd task #318)",
  );

  const marker = "// ── Content-height re-anchor";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "content-height re-anchor effect must be present");
  const block = source.slice(start, start + 2400);

  assert.match(
    block,
    /restoreAfterLayoutChange\(scroller, preserveAnchorRequested\(\)\)/,
    "content-height observer must route through the shared layout-change policy",
  );
});

test("the scroller opts out of browser-native overflow anchoring", () => {
  assert.match(
    source,
    /overflowAnchor: "none"/,
    "MessageTimeline's JS anchor manager must be the only scroll compensation owner; native overflow anchoring can pre-adjust scrollTop on prepends, then restoreAnchor's content-coordinate delta applies the same height again and jumps history upward",
  );
  assert.doesNotMatch(
    source,
    /overflowAnchor: "auto"/,
    "do not re-enable browser-native overflow anchoring without changing restoreAnchor's compensation model",
  );
});

test("the rendered scroller style disables native overflow anchoring", () => {
  const markup = renderToStaticMarkup(
    createElement(MessageTimeline, {
      source: {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        loading: false,
        loadOlder: () => {},
        loadNewer: () => {},
      },
      renderItem: () => null,
    }),
  );

  assert.match(
    markup,
    /overflow-anchor:none/,
    "runtime markup must opt the scroller out of browser-native overflow anchoring",
  );
});

test("at-bottom parent notifications stay outside the child state updater", () => {
  assert.match(
    source,
    /atBottomStateRef\.current = atBottom;\s*setAtBottomState\(atBottom\);[\s\S]{0,500}onAtBottomChangeRef\.current\?\.\(atBottom\);/,
    "MessageTimeline must commit its own at-bottom state before notifying the parent; nesting the parent callback inside a functional state updater lets React invoke it while rendering the child",
  );
  assert.doesNotMatch(
    source,
    /setAtBottomState\(\([^)]*\) => \{[\s\S]{0,500}onAtBottomChangeRef\.current/,
    "parent onAtBottomChange must never run from inside MessageTimeline's state updater",
  );
});
