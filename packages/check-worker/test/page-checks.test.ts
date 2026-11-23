import assert from "node:assert/strict";
import test from "node:test";

import { BLANK_UNIFORM_SHARE, CANT_SCROLL_SLACK, cantScrollOf, elementLabel, isBlank, phoneOverflowOf, type ScrollMeasure } from "../src/pageChecks";
import { isPng, uniformShare } from "../src/png";
import { makePng, SPLIT_PNG, WHITE_PNG } from "./fakes";

/** The blank and sideways-scrolling findings, the can't-scroll hint (src/pageChecks.ts) and the PNG reader behind blank (src/png.ts). */

test("blank: no text and a uniform shot; text, a busy shot or an unknown share is not blank", () => {
  assert.equal(isBlank(0, 1), true);
  assert.equal(isBlank(0, BLANK_UNIFORM_SHARE), true);
  assert.equal(isBlank(0, 0.5), false, "a picture or a canvas, no text");
  assert.equal(isBlank(12, 1), false, "white-on-white text");
  assert.equal(isBlank(0, null), false);
});

test("phone overflow: content wider than the window by more than a pixel of rounding", () => {
  assert.deepEqual(phoneOverflowOf({ scrollWidth: 1280, innerWidth: 390 }, 390), { contentWidth: 1280, viewportWidth: 390 });
  assert.equal(phoneOverflowOf({ scrollWidth: 390, innerWidth: 390 }, 390), null);
  assert.equal(phoneOverflowOf({ scrollWidth: 391, innerWidth: 390 }, 390), null);
  assert.deepEqual(phoneOverflowOf({ scrollWidth: 392.4, innerWidth: 390 }, 390), { contentWidth: 392, viewportWidth: 390 });
  assert.equal(phoneOverflowOf({ scrollWidth: Number.NaN, innerWidth: 390 }, 390), null);
  assert.equal(phoneOverflowOf({ scrollWidth: 500, innerWidth: 0 }, 390), null);
  assert.equal(phoneOverflowOf({ scrollWidth: 500, innerWidth: 390 }, 0), null);
});

test("phone overflow: a page with no viewport tag is reported at the phone's width, not the zoomed-out window's", () => {
  // The phone zooms such a page out to fit (innerWidth up to 4x the phone: 1560 px on a 390 px phone).
  assert.deepEqual(phoneOverflowOf({ scrollWidth: 1600, innerWidth: 1560 }, 390), { contentWidth: 1600, viewportWidth: 390 });
  assert.equal(phoneOverflowOf({ scrollWidth: 1200, innerWidth: 1200 }, 390), null, "zoomed out to fit: no sideways scrolling");
});

test("png: a uniform shot is 1, two halves about one half", async () => {
  assert.equal(isPng(WHITE_PNG), true);
  assert.equal(isPng(new TextEncoder().encode("GIF89a....")), false);
  assert.equal(await uniformShare(WHITE_PNG), 1);
  const split = await uniformShare(SPLIT_PNG);
  assert.ok(split !== null && split > 0.4 && split < 0.6, String(split));
});

test("png: every row filter is undone (none, sub, up, average, paeth), RGB and RGBA", async () => {
  for (const channels of [3, 4] as const) {
    const gradient = makePng(50, 30, (x, y) => [x * 5, y * 8, (x + y) % 256, 255], { channels, filterOf: (y) => y % 5 });
    const share = await uniformShare(gradient);
    assert.ok(share !== null && share < 0.2, `a gradient is far from uniform (${share})`);
    const uniform = makePng(50, 30, () => [10, 20, 30, 255], { channels, filterOf: (y) => y % 5 });
    assert.equal(await uniformShare(uniform), 1, `uniform with filters, ${channels} channels`);
  }
  // Mostly one colour, a small mark: above the blank threshold only when tiny.
  const mark = makePng(200, 100, (x, y) => (x < 4 && y < 4 ? [0, 0, 0] : [255, 255, 255]), { filterOf: (y) => (y % 2 ? 4 : 1) });
  const share = await uniformShare(mark);
  assert.ok(share !== null && share >= BLANK_UNIFORM_SHARE, String(share));
});

test("png: what the reader doesn't read is null (never blank)", async () => {
  assert.equal(await uniformShare(new TextEncoder().encode("not a png at all")), null);
  assert.equal(await uniformShare(makePng(4, 4, () => [0, 0, 0], { colorType: 0 })), null, "greyscale");
  assert.equal(await uniformShare(makePng(4, 4, () => [0, 0, 0], { bitDepth: 16 })), null, "16-bit");
  assert.equal(await uniformShare(WHITE_PNG.subarray(0, 40)), null, "cut short");
  const corrupt = new Uint8Array(WHITE_PNG);
  corrupt.fill(0x41, 41, 60);
  assert.equal(await uniformShare(corrupt), null, "IDAT that doesn't inflate");
});

const DESKTOP = { shot: "desktop" as const, width: 1280, height: 800 };
const PHONE = { shot: "phone" as const, width: 390, height: 844 };
/** A Vite + raft-ui shell: html and body hold it to one screen, its content goes on to 2340 px. */
const held: ScrollMeasure = {
  innerHeight: 800,
  contentBottom: 2340,
  rootScrollHeight: 800,
  rootClientHeight: 800,
  htmlOverflowY: "hidden",
  bodyOverflowY: "hidden",
  bodyBottom: 800,
  innerScroller: false,
  holder: null,
};
const desktopOf = (scroll: Partial<ScrollMeasure>) => cantScrollOf({ innerWidth: 1280, scroll: { ...held, ...scroll } }, DESKTOP);

test("can't scroll: content past the window and html and body holding it, at the viewport's size", () => {
  assert.deepEqual(desktopOf({}), {
    shot: "desktop", viewportWidth: 1280, viewportHeight: 800, contentHeight: 2340, hiddenHeight: 1540,
    heldBy: [{ element: "html", style: "overflow: hidden" }, { element: "body", style: "overflow: hidden" }],
  });
  // body alone: its overflow is the window's (html's is visible), however tall body is.
  assert.deepEqual(desktopOf({ htmlOverflowY: "visible", bodyBottom: 2340, rootScrollHeight: 2340 })?.heldBy, [{ element: "body", style: "overflow: hidden" }]);
  assert.deepEqual(desktopOf({ htmlOverflowY: "clip", bodyOverflowY: "visible" })?.heldBy, [{ element: "html", style: "overflow: clip" }]);
  // html holds the window; body is its own box and, ending far below, cuts nothing at the window.
  assert.deepEqual(desktopOf({ bodyBottom: 2340 })?.heldBy, [{ element: "html", style: "overflow: hidden" }]);
  // What the page measured inside them: named by its tag and id (else its first class).
  assert.deepEqual(desktopOf({ htmlOverflowY: "visible", bodyOverflowY: "visible", holder: { tag: "DIV", id: "root", className: "app", style: "position: fixed" } })?.heldBy, [{ element: "div#root", style: "position: fixed" }]);
  assert.deepEqual(desktopOf({ holder: { tag: "main", id: "", className: " shell  wide", style: "overflow: hidden" } })?.heldBy.at(-1), { element: "main.shell", style: "overflow: hidden" });
  assert.deepEqual(desktopOf({ htmlOverflowY: "visible", bodyOverflowY: "visible", holder: { tag: "div", id: "", className: "", style: "overflow: scroll" } })?.heldBy, [], "a style that holds nothing isn't named");
});

test("can't scroll: not for a page that fits, scrolls, or scrolls inside a container that fills the window", () => {
  assert.equal(desktopOf({ contentBottom: 800 }), null, "fits");
  assert.equal(desktopOf({ contentBottom: 800 + CANT_SCROLL_SLACK }), null, "within the slack: a margin");
  assert.ok(desktopOf({ contentBottom: 800 + CANT_SCROLL_SLACK + 1 }) !== null);
  assert.equal(desktopOf({ htmlOverflowY: "visible", bodyOverflowY: "visible", rootScrollHeight: 2340 }), null, "a document that scrolls to all of it");
  assert.equal(desktopOf({ htmlOverflowY: "auto", bodyOverflowY: "hidden", bodyBottom: 2340, rootScrollHeight: 2340 }), null, "html's auto is the window's: body's own hidden cuts nothing");
  assert.equal(desktopOf({ innerScroller: true }), null, "a full-window app that scrolls inside its own containers");
  // The document scrolls, but not as far as the content goes (a fixed root holds the rest): reported, the part out of reach.
  assert.equal(desktopOf({ htmlOverflowY: "visible", bodyOverflowY: "visible", rootScrollHeight: 1000 })?.hiddenHeight, 1340);
  assert.equal(cantScrollOf({ innerWidth: 1280 }, DESKTOP), null, "nothing measured");
  assert.equal(desktopOf({ contentBottom: Number.NaN }), null);
  assert.equal(cantScrollOf({ innerWidth: 0, scroll: held }, DESKTOP), null);
});

test("can't scroll: a phone page zoomed out to fit is reported in the phone's px", () => {
  // No viewport tag: a 980 px window on a 390 px phone, 844 * 980 / 390 = 2121 px tall.
  const zoomed = cantScrollOf({ innerWidth: 980, scroll: { ...held, innerHeight: 2121, contentBottom: 4000, bodyBottom: 2121 } }, PHONE);
  assert.deepEqual(zoomed && [zoomed.shot, zoomed.viewportWidth, zoomed.viewportHeight, zoomed.contentHeight, zoomed.hiddenHeight], ["phone", 390, 844, 1592, 748]);
  assert.equal(cantScrollOf({ innerWidth: 980, scroll: { ...held, innerHeight: 2121, contentBottom: 2160, bodyBottom: 2121 } }, PHONE), null, "39 page px are 16 of the phone's: within the slack");
});

test("element label: tag and id, else the first class, of selector characters only, cut", () => {
  assert.equal(elementLabel({ tag: "DIV", id: "root", className: "a b" }), "div#root");
  assert.equal(elementLabel({ tag: "section", id: "", className: "  app-shell  x" }), "section.app-shell");
  assert.equal(elementLabel({ tag: "div", id: "", className: "" }), "div");
  assert.equal(elementLabel({ tag: "div", id: 'x" onload="', className: "" }), "div#xonload");
  assert.equal(elementLabel({ tag: "div", id: "https://evil.example/?ticket=abc", className: "" }), "div#httpsevilexampleticketabc");
  assert.equal(elementLabel({ tag: "div", id: "r".repeat(100), className: "" }).length, 60);
  assert.equal(elementLabel({ tag: "", id: "", className: "" }), "element");
});
