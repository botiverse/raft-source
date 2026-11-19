import { describe, expect, it } from "vitest";
import { parseThreadPreviewChars, THREAD_REPLY_PREVIEW_MAX_CHARS, truncateThreadReplyPreview } from "./threadReplyPreview";

const MAX = THREAD_REPLY_PREVIEW_MAX_CHARS;

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

describe("truncateThreadReplyPreview", () => {
  it("keeps a reply at or under the limit unchanged", () => {
    expect(truncateThreadReplyPreview("short reply", MAX)).toBe("short reply");
    const exact = "a".repeat(THREAD_REPLY_PREVIEW_MAX_CHARS);
    expect(truncateThreadReplyPreview(exact, MAX)).toBe(exact);
    const exactEmoji = "👍".repeat(THREAD_REPLY_PREVIEW_MAX_CHARS); // 400 code units, 200 characters
    expect(truncateThreadReplyPreview(exactEmoji, MAX)).toBe(exactEmoji);
  });

  it("cuts a longer reply to the limit, ellipsis included", () => {
    const out = truncateThreadReplyPreview("a".repeat(500), MAX);
    expect(out).toBe(`${"a".repeat(THREAD_REPLY_PREVIEW_MAX_CHARS - 1)}…`);
    expect(graphemes(out)).toBe(THREAD_REPLY_PREVIEW_MAX_CHARS);
  });

  it("counts characters, not bytes: CJK text keeps 199 characters", () => {
    const out = truncateThreadReplyPreview("字".repeat(300), MAX);
    expect(out).toBe(`${"字".repeat(THREAD_REPLY_PREVIEW_MAX_CHARS - 1)}…`);
  });

  it("never splits a surrogate pair, a ZWJ sequence or a flag", () => {
    for (const unit of ["😀", "👨‍👩‍👧‍👦", "🇨🇳", "é"]) {
      const out = truncateThreadReplyPreview(`x${unit.repeat(300)}`, MAX);
      expect(out.endsWith("…")).toBe(true);
      const body = out.slice(0, -1);
      // Whole clusters only: the body is "x" plus some number of complete units.
      const kept = (body.length - 1) / unit.length;
      expect(Number.isInteger(kept)).toBe(true);
      expect(body).toBe(`x${unit.repeat(kept)}`);
      expect(graphemes(out)).toBeLessThanOrEqual(THREAD_REPLY_PREVIEW_MAX_CHARS);
      // Short clusters reach the character limit; the 11-unit family emoji
      // reaches the code-unit bound first.
      if (unit.length * THREAD_REPLY_PREVIEW_MAX_CHARS <= THREAD_REPLY_PREVIEW_MAX_CHARS * 4) {
        expect(kept).toBe(THREAD_REPLY_PREVIEW_MAX_CHARS - 2);
      }
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)).toBe(false);
    }
  });

  it("drops trailing whitespace before the ellipsis", () => {
    const out = truncateThreadReplyPreview(`${"a".repeat(198)} ${"b".repeat(50)}`, MAX);
    expect(out).toBe(`${"a".repeat(198)}…`);
  });

  it("bounds a reply whose characters are huge combining clusters", () => {
    const zalgo = `a${"́".repeat(100)}`;
    const out = truncateThreadReplyPreview(zalgo.repeat(50), MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(THREAD_REPLY_PREVIEW_MAX_CHARS * 4 + 1);
    expect(out.slice(0, -1)).toBe(zalgo.repeat(7));
  });

  it("honours a smaller requested length", () => {
    expect(truncateThreadReplyPreview("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("parseThreadPreviewChars", () => {
  it("accepts integers, capped at the server maximum", () => {
    expect(parseThreadPreviewChars("200")).toBe(200);
    expect(parseThreadPreviewChars("80")).toBe(80);
    expect(parseThreadPreviewChars("5000")).toBe(MAX);
    expect(parseThreadPreviewChars("999999999")).toBeUndefined();
  });

  it("treats anything else as not asked", () => {
    for (const raw of [undefined, "", "0", "-5", "1.5", "abc", "20px", ["200", "100"], { a: "1" }]) {
      expect(parseThreadPreviewChars(raw)).toBeUndefined();
    }
  });
});
