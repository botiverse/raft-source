import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LinkCardV2 } from "@botiverse/raft-shared/src/appLinkPreview";
import { LinkCardElements } from "../src/components/message/LinkCardElements";
import { LINK_CARD_READ_CAPABILITIES } from "../src/components/message/linkCardRead";

// An App's colour on its state badge (RFC 076 §15, DS AppLinkCard › The app's
// color): the block card and the hover card both draw it. The hover card did
// not until 2026-11-14, and Stamp, which sends hover cards only, showed no
// colour on production (#proj-apps:#51).
const card = {
  root: "root",
  elements: {
    root: { type: "Stack", props: { direction: "row" }, children: ["state"] },
    state: { type: "Badge", props: { text: "Merged", tone: "success", color: "#218358" } },
  },
} as unknown as LinkCardV2;

describe("link card badge colour", () => {
  it("the web declares badge.color.v1, so Raft sends it the colour", () => {
    expect(LINK_CARD_READ_CAPABILITIES).toContain("badge.color.v1");
  });

  it("the block card draws the Badge in the App's colour", () => {
    const html = renderToStaticMarkup(createElement(LinkCardElements, { card, surface: "card" }));
    expect(html).toContain("data-card-badge-fill");
    expect(html).toContain("--badge-fill:#218358");
    expect(html).toContain("Merged");
  });

  it("the hover card draws the same colour: an App that sends hover cards only still shows it", () => {
    const html = renderToStaticMarkup(createElement(LinkCardElements, { card, surface: "popover" }));
    expect(html).toContain("data-card-badge-fill");
    expect(html).toContain("--badge-fill:#218358");
    expect(html).toContain("Merged");
  });

  it("the ring is decided against the card the badge is on: a gray that parts from the block card in dark mode needs a ring on the lighter hover card", () => {
    const gray = { ...card, elements: { ...card.elements, state: { type: "Badge", props: { text: "Closed", tone: "neutral", color: "#424242" } } } } as unknown as LinkCardV2;
    const ring = (surface: "card" | "popover") => /--badge-ring-dark:([^;"]+)/.exec(renderToStaticMarkup(createElement(LinkCardElements, { card: gray, surface })))?.[1];
    expect(ring("card")).toBe("transparent");
    expect(ring("popover")).toBe("var(--line-hairline)");
  });

  it("a Badge with no colour, or one that is not #RRGGBB, stays the neutral Badge on both", () => {
    for (const color of [undefined, "green"]) {
      const plain = { ...card, elements: { ...card.elements, state: { type: "Badge", props: { text: "Merged", tone: "success", ...(color ? { color } : null) } } } } as unknown as LinkCardV2;
      for (const surface of ["card", "popover"] as const) {
        const html = renderToStaticMarkup(createElement(LinkCardElements, { card: plain, surface }));
        expect(html).not.toContain("--badge-fill");
        expect(html).toContain("Merged");
      }
    }
  });
});
