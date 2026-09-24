import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import ReactionGlyph from "../src/components/message/ReactionGlyph";

afterEach(cleanup);

test("ReactionGlyph renders known reactions from the generated sprite", () => {
  render(<ReactionGlyph emoji="👍" size={18} className="block" />);

  const glyph = document.querySelector("[data-reaction-glyph='thumbs_up']") as HTMLElement | null;
  assert.ok(glyph, "expected thumbs-up to render as a sprite-backed glyph");
  assert.equal(glyph.className, "block");
  assert.equal(glyph.getAttribute("data-reaction-sprite-path"), "/reactions/reaction-sprite.svg");
  assert.match(glyph.style.backgroundImage, /\/reactions\/reaction-sprite\.svg/);
  assert.equal(glyph.style.backgroundPosition, "0px 0px");
  assert.equal(glyph.style.backgroundRepeat, "no-repeat");
  assert.equal(glyph.style.backgroundSize, "126px 18px");
  assert.equal(glyph.style.display, "inline-block");
  assert.equal(glyph.style.width, "18px");
  assert.equal(glyph.style.height, "18px");
  assert.equal(glyph.style.lineHeight, "1");
});

test("ReactionGlyph positions later sprite items using scaled offsets", () => {
  render(<ReactionGlyph emoji="🎉" size={18} />);

  const glyph = document.querySelector("[data-reaction-glyph='party_popper']") as HTMLElement | null;
  assert.ok(glyph, "expected party popper to render as a sprite-backed glyph");
  assert.equal(glyph.className, "");
  assert.equal(glyph.style.backgroundPosition, "-36px 0px");
  assert.equal(glyph.style.backgroundSize, "126px 18px");
});

test("ReactionGlyph keeps unsupported emoji visible as text fallback", () => {
  render(<ReactionGlyph emoji="🤝" size={18} className="fallback" />);

  const fallback = screen.getByText("🤝");
  assert.equal(fallback.tagName, "SPAN");
  assert.equal(fallback.className, "fallback");
  assert.equal(fallback.style.fontSize, "18px");
  assert.equal(fallback.style.lineHeight, "1");
});

test("ReactionGlyph leaves the fallback class empty by default", () => {
  render(<ReactionGlyph emoji="🤝" size={16} />);

  assert.equal(screen.getByText("🤝").className, "");
});
