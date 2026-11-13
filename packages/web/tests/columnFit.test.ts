import assert from "node:assert/strict";

import { COLUMN_BOUNDS, fitColumnWidths, fitLeadingColumnWidth, fittedColumnStyles, GROWS_TO_MAIN_MIN_SAFETY_MAX, growToMainMinMax, MAIN_COLUMN_MIN_WIDTH, shareCapWidth } from "../src/lib/panelBounds";

// Task #139: when the window is too narrow for the remembered widths, the rightmost column gives way first (down to
// its minimum), then the next; the conversation keeps 360px; a column never renders below its minimum.

const sidebar = { width: 320, min: COLUMN_BOUNDS.sidebar.min }; // 200
const thread = { width: 600, min: COLUMN_BOUNDS.thread.contentMin }; // 360: the window gives way down to the content's minimum

test("the agreed bounds table (design lead, 2026-10-21; right-hand maxima task #74, 2026-10-23)", () => {
  const table = Object.fromEntries(Object.entries(COLUMN_BOUNDS).map(([id, b]) => [id, [b.defaultWidth, b.min, b.max, b.storageKey, "contentMin" in b ? b.contentMin : null]]));
  // A right-hand column's real maximum is the room the conversation leaves above 360 (growToMainMinMax); `max` is
  // only the safety bound its stored width is clamped to.
  const toMainMin = GROWS_TO_MAIN_MIN_SAFETY_MAX;
  assert.deepEqual(table, {
    sidebar: [240, 200, 400, "slock:sidebarWidth", null],
    // Activity's list: 240 minimum so rail + list + conversation fit 768 (stdrc).
    list: [380, 240, 640, "slock:searchPanelWidth", null],
    // The layout row's columns go to 160; their content keeps its minimum and clips (#proj-raft-ui:#189, rule 2).
    thread: [400, 160, toMainMin, "slock:threadPanelWidth", 360],
    detail: [400, 160, toMainMin, "slock:profilePanelWidth", 320],
    workspaceTree: [256, 180, 480, "slock:workspaceTreeWidth", null],
    // Task v2 side sections: flat against the panel's edge, no gutter (task #165).
    sideCards: [360, 160, toMainMin, "slock:channelSideCardsWidth", 280],
  });
  const growing = Object.entries(COLUMN_BOUNDS).filter(([, b]) => "growsToMainMin" in b && b.growsToMainMin).map(([id]) => id);
  assert.deepEqual(growing, ["thread", "detail", "sideCards"]);
  assert.equal(MAIN_COLUMN_MIN_WIDTH, 360);
});

test("a right-hand column grows until the conversation beside it is down to 360 (task #74)", () => {
  // 1280 window, side sections at 360 beside a 680px conversation: 360 + (680 - 360) = 680, past the old fixed maximum.
  assert.equal(growToMainMinMax("sideCards", 360, 680), 680);
  // The detail column past the old 640 the same way.
  assert.equal(growToMainMinMax("detail", 400, 1000), 1040);
  assert.equal(growToMainMinMax("thread", 400, 1400), 1440);
  // The conversation already at (or squeezed below) its minimum: the column cannot grow, nor drop under its own.
  assert.equal(growToMainMinMax("detail", 500, 360), 500);
  assert.equal(growToMainMinMax("detail", 500, 300), 500);
  assert.equal(growToMainMinMax("sideCards", 200, 300), 200);
  assert.equal(growToMainMinMax("sideCards", 120, 300), 160, "never under the column's 160");
  // Never past the safety bound, and fractions of a pixel round down so the conversation keeps its full 360.
  assert.equal(growToMainMinMax("thread", 8000, 9000), GROWS_TO_MAIN_MIN_SAFETY_MAX);
  assert.equal(growToMainMinMax("thread", 400.6, 760.2), 800);
  assert.equal(growToMainMinMax("thread", 400, 900, 400), 900, "a custom minimum for the conversation");
});

test("a wide window renders every remembered width", () => {
  assert.deepEqual(fitColumnWidths(2000, [sidebar, thread]), [320, 600]);
});

test("the rightmost column gives way first, down to its minimum", () => {
  // 320 + 360 (main) + 600 = 1280 needed; 1100 leaves the thread 1100 - 320 - 360 = 420.
  assert.deepEqual(fitColumnWidths(1100, [sidebar, thread]), [320, 420]);
  // Exactly the thread's minimum.
  assert.deepEqual(fitColumnWidths(1040, [sidebar, thread]), [320, 360]);
});

test("then the column before it shrinks, while the right one stays at its minimum", () => {
  // 1000 - 360 (main) - 360 (thread min) = 280 for the sidebar.
  assert.deepEqual(fitColumnWidths(1000, [sidebar, thread]), [280, 360]);
  assert.deepEqual(fitColumnWidths(920, [sidebar, thread]), [200, 360]);
});

test("no column renders below its minimum when even the minimums do not fit", () => {
  assert.deepEqual(fitColumnWidths(700, [sidebar, thread]), [200, 360]);
  assert.deepEqual(fitColumnWidths(300, [sidebar]), [200]);
});

test("the rendered widths always leave the main column its minimum while the minimums fit", () => {
  for (let available = 920; available <= 1400; available += 7) {
    const [left, right] = fitColumnWidths(available, [sidebar, thread]);
    assert.ok(available - left! - right! >= MAIN_COLUMN_MIN_WIDTH, `main column squeezed at ${available}px`);
  }
});

test("remembered widths are inputs only", () => {
  const columns = [{ ...sidebar }, { ...thread }];
  fitColumnWidths(800, columns);
  assert.deepEqual(columns, [sidebar, thread]);
});

test("the CSS form carries the same allowance the closed form subtracts", () => {
  const [left, right] = fittedColumnStyles([sidebar, thread]) as Array<Record<string, string>>;
  // Sidebar gives way after the main column and the thread's minimum: 360 + 360.
  assert.deepEqual(left, { "--column-width": "320px", "--column-min": "200px", "--column-allowance": "720px" });
  // Thread gives way after the main column and the sidebar's remembered width: 360 + 320.
  assert.deepEqual(right, { "--column-width": "600px", "--column-min": "360px", "--column-allowance": "680px" });
  // max(min, min(width, room - allowance)) is fitColumnWidths for the same room.
  const room = 1000;
  const css = (style: Record<string, string>) => Math.max(
    parseFloat(style["--column-min"]!),
    Math.min(parseFloat(style["--column-width"]!), room - parseFloat(style["--column-allowance"]!)),
  );
  assert.deepEqual([css(left!), css(right!)], fitColumnWidths(room, [sidebar, thread]));
});

test("the sidebar gives way for a right panel only while the panel can still sit beside the conversation", () => {
  // 1043px of room (1100 window - 57 rail): 320 + 360 + 360 fits, nothing shrinks.
  assert.equal(fitLeadingColumnWidth(1043, sidebar, 360), 320);
  // 993px (1050 window): the sidebar shrinks to 273 so the conversation and the panel get 360 each.
  assert.equal(fitLeadingColumnWidth(993, sidebar, 360), 273);
  // 920px is the last room where the sidebar's 200 minimum still allows the split.
  assert.equal(fitLeadingColumnWidth(920, sidebar, 360), 200);
  // 843px (900 window): even at 200 the split cannot happen and the panel covers the conversation, so the sidebar
  // keeps its width instead of snapping to 200 and jumping back when the panel closes.
  assert.equal(fitLeadingColumnWidth(843, sidebar, 360), 320);
  assert.equal(fitLeadingColumnWidth(843, sidebar, 0), 320);
  // With nothing on the right it only protects the conversation.
  assert.equal(fitLeadingColumnWidth(600, sidebar, 0), 240);
  assert.equal(fitLeadingColumnWidth(500, sidebar, 0), 200);
});

test("Activity's list beside an open item never renders wider than the conversation", () => {
  const list = { width: 400, min: COLUMN_BOUNDS.list.min }; // remembered 400, min 240
  for (const window of [900, 1100]) {
    const room = window - 57; // right of the rail
    const rendered = Math.min(fitLeadingColumnWidth(room, list, 0), shareCapWidth(room, 0.5, list.min));
    assert.ok(rendered <= room - rendered, `${window}: list ${rendered} <= conversation ${room - rendered}`);
  }
  // 843px of room: half is 421, so the remembered 400 already fits under the cap...
  assert.equal(shareCapWidth(843, 0.5, 240), 421);
  // ...and at 768 (711 of room) the cap is 355; never below the 240 minimum.
  assert.equal(shareCapWidth(711, 0.5, 240), 355);
  assert.equal(shareCapWidth(400, 0.5, 240), 240);
});
