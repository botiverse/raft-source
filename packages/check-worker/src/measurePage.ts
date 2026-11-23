// What the page says about itself once settled, at each viewport, in one call: browser.ts
// `page.evaluate(measurePage)`. pageChecks.ts decides from it (blank, sideways scrolling on a
// phone, a page that may not scroll).
//
// It runs in the page, so it is self-contained: no imports, no closures, and no named function
// inside it (wrangler's bundle keeps names by wrapping each in a `__name` helper the page doesn't
// have; puppeteer sends only this function's own text). One walk of the body's elements, at most
// MAX_ELEMENTS (a constant inside it: the page sees no module scope), reading each one's computed
// style and box once: what the reader can't scroll to.
//
// The walk (pageChecks.ts cantScrollOf decides from its numbers):
// - `contentBottom`: the lowest bottom, in the document's px, of the page's content, its visible
//   elements with text of their own or that are themselves content (an image, a canvas, an svg, a
//   video, a frame, a form control), so an empty wrapper's padding or a decorative box isn't. Not
//   counted: what is inside a container that scrolls (overflow-y auto or scroll, with more to
//   scroll): the reader reaches it there; what is hidden (display none, visibility, opacity 0,
//   content-visibility hidden); a fixed box that starts below the window (a sheet waiting to slide
//   in). A box that clips (overflow-y not visible) and ends clearly above or below the window's
//   bottom is a component that cuts its own content on purpose (a card, a collapsed panel): what is
//   in it counts only down to its bottom. One that ends at the window's bottom (within 24 px) is
//   the page's own frame (an app shell's `#root { height: 100vh; overflow: hidden }`): what it
//   cuts counts.
// - `innerScroller`: a container that scrolls, more than 24 px of it, and covers at least half the
//   window: a full-window app that scrolls inside its own containers, which is never reported.
// - `holder`: what cuts the lowest content, inside html and body: from the content up, the nearest
//   box that is fixed, or that clips and ends at the window's bottom; null when none.
// - html's and body's overflow-y, body's bottom, and the document's scrolling element's sizes:
//   whether the document itself scrolls, and how far.
import type { PageMeasure, ScrollMeasure } from "./pageChecks";

export function measurePage(): PageMeasure {
  const MAX_ELEMENTS = 8000;
  const SLACK = 24;
  const CONTENT_TAGS = ["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "PICTURE"];
  const html = document.documentElement;
  const body = document.body;
  const scroller = document.scrollingElement ?? html;
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  const scrollY = window.scrollY;
  const htmlOverflowY = getComputedStyle(html).overflowY;
  const bodyStyle = body ? getComputedStyle(body) : null;
  // body's own overflow is body's only when html's isn't visible; else it is the window's.
  const bodyClipsItself = htmlOverflowY !== "visible";
  let contentBottom = 0;
  let lowest: Element | null = null;
  let innerScroller = false;
  let visited = 0;
  // Each element with the bottom its clipping ancestors leave it (viewport px).
  const stack: Array<[Element, number]> = body ? [[body, Number.POSITIVE_INFINITY]] : [];
  while (stack.length > 0 && visited < MAX_ELEMENTS) {
    const [element, clip] = stack.pop()!;
    visited += 1;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.opacity === "0" || style.getPropertyValue("content-visibility") === "hidden") continue;
    const box = element.getBoundingClientRect();
    if (style.position === "fixed" && box.top >= innerHeight) continue;
    const tag = element.tagName.toUpperCase();
    let content = CONTENT_TAGS.includes(tag);
    for (let node = element.firstChild; node !== null && !content; node = node.nextSibling) {
      if (node.nodeType === 3 && (node.nodeValue ?? "").trim() !== "") content = true;
    }
    if (content && style.visibility === "visible" && box.width > 0 && box.height > 0) {
      const bottom = Math.min(box.bottom, clip) + scrollY;
      if (bottom > contentBottom) {
        contentBottom = bottom;
        lowest = element;
      }
    }
    if (tag === "SVG") continue;
    let childClip = clip;
    const overflowY = style.overflowY;
    if (overflowY !== "visible" && (element !== body || bodyClipsItself)) {
      if ((overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1) {
        const across = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
        const down = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
        if (element.scrollHeight > element.clientHeight + SLACK && across * down >= (innerWidth * innerHeight) / 2) innerScroller = true;
        // The reader scrolls to all of it there.
        continue;
      }
      if (Math.abs(box.bottom - innerHeight) > SLACK) childClip = Math.min(clip, box.bottom);
    }
    for (let child = element.lastElementChild; child !== null; child = child.previousElementSibling) stack.push([child, childClip]);
  }
  let holder: ScrollMeasure["holder"] = null;
  for (let at: Element | null = lowest; at !== null && at !== body && at !== html && holder === null; at = at.parentElement) {
    const style = getComputedStyle(at);
    const clips = at !== lowest && (style.overflowY === "hidden" || style.overflowY === "clip") && Math.abs(at.getBoundingClientRect().bottom - innerHeight) <= SLACK;
    if (style.position === "fixed" || clips) {
      holder = { tag: at.tagName.toLowerCase(), id: at.id, className: at.getAttribute("class") ?? "", style: style.position === "fixed" ? "position: fixed" : `overflow: ${style.overflowY}` };
    }
  }
  return {
    textLength: body ? body.innerText.trim().length : 0,
    scrollWidth: scroller.scrollWidth,
    innerWidth,
    scroll: {
      innerHeight,
      contentBottom,
      rootScrollHeight: scroller.scrollHeight,
      rootClientHeight: scroller.clientHeight,
      htmlOverflowY,
      bodyOverflowY: bodyStyle ? bodyStyle.overflowY : "visible",
      bodyBottom: body ? body.getBoundingClientRect().bottom + scrollY : null,
      innerScroller,
      holder,
    },
  };
}
