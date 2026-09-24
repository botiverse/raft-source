import { describe, it } from "node:test";
import assert from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Skeleton, { SkeletonRow, ConversationCardSkeleton } from "../src/components/ui/Skeleton";

// Contract for the shared brutal Skeleton primitive (task #31). Keeps the
// loading-placeholder idiom consistent: animate-pulse, bg-black/10 bars, sharp
// corners (only `circle` rounds), size via className, aria-hidden, and a
// row-composition helper that preserves the real row box (layout-shift guard).

describe("Skeleton primitive", () => {
  it("always animates and is decorative (aria-hidden)", () => {
    const html = renderToStaticMarkup(createElement(Skeleton));
    assert.match(html, /animate-pulse/);
    assert.match(html, /aria-hidden="true"/);
  });

  it("line variant is a square bg-black/10 bar with no rounding", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { variant: "line" }));
    assert.match(html, /h-3/);
    assert.match(html, /bg-black\/10/);
    assert.doesNotMatch(html, /rounded/);
  });

  it("block variant is a square fill with no rounding", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { variant: "block" }));
    assert.match(html, /bg-black\/10/);
    assert.doesNotMatch(html, /rounded/);
  });

  it("circle is the only rounded variant and reads as an avatar slot", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { variant: "circle" }));
    assert.match(html, /rounded-full/);
    assert.match(html, /border-2 border-black/);
  });

  it("size comes from className, not the primitive", () => {
    const html = renderToStaticMarkup(
      createElement(Skeleton, { variant: "line", className: "w-24 h-5" }),
    );
    assert.match(html, /w-24/);
    assert.match(html, /h-5/);
  });

  it("forwards arbitrary div props (e.g. data-testid)", () => {
    const html = renderToStaticMarkup(
      createElement(Skeleton, { "data-testid": "sk" } as Record<string, unknown>),
    );
    assert.match(html, /data-testid="sk"/);
  });
});

describe("SkeletonRow layout-shift composition", () => {
  it("applies the caller's row height/padding classes so the box matches the real row", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonRow, {
        className: "gap-1.5 px-2 py-2",
        avatar: true,
        avatarClassName: "size-[18px]",
        lineWidths: ["w-24"],
      }),
    );
    // Outer row carries the real-row sizing classes verbatim.
    assert.match(html, /px-2/);
    assert.match(html, /py-2/);
    // Avatar stand-in matches the real avatar box.
    assert.match(html, /size-\[18px\]/);
    // One text line as requested.
    assert.match(html, /w-24/);
  });

  it("omits the avatar stand-in when avatar is not requested", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonRow, { lineWidths: ["w-1/2"] }),
    );
    assert.doesNotMatch(html, /rounded-full/);
  });
});

describe("ConversationCardSkeleton (inbox/saved shared ~96px card)", () => {
  it("renders cards in the real ConversationPreviewCard box (border-2 border-black/30 bg-white p-3)", () => {
    const html = renderToStaticMarkup(createElement(ConversationCardSkeleton));
    assert.match(html, /border-2 border-black\/30 bg-white p-3/);
    assert.match(html, /aria-busy="true"/);
  });

  it("renders the requested number of cards", () => {
    const html = renderToStaticMarkup(createElement(ConversationCardSkeleton, { count: 3 }));
    // 3 cards, each carrying the card box class.
    const matches = html.match(/border-2 border-black\/30 bg-white p-3/g) ?? [];
    assert.equal(matches.length, 3);
  });
});
