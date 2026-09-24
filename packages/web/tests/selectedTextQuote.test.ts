import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTED_TEXT_QUOTE_EVENT,
  appendQuoteToComposer,
  emitSelectedTextQuote,
  formatSelectedTextQuote,
  hasQuotableSelection,
} from "../src/components/message/selectedTextQuote";
import type {
  SelectedTextQuoteDetail,
} from "../src/components/message/selectedTextQuote";

test("formatSelectedTextQuote prefixes every line with '> '", () => {
  assert.equal(formatSelectedTextQuote("hello"), "> hello");
  assert.equal(formatSelectedTextQuote("line one\nline two"), "> line one\n> line two");
});

test("formatSelectedTextQuote keeps blank interior lines as a bare '>' (single contiguous block)", () => {
  // A blank line that became "> " (trailing space) would terminate the
  // blockquote in CommonMark; a bare ">" keeps it one block.
  assert.equal(formatSelectedTextQuote("a\n\nb"), "> a\n>\n> b");
});

test("formatSelectedTextQuote normalizes CRLF/CR and trims trailing whitespace", () => {
  assert.equal(formatSelectedTextQuote("a\r\nb\r\n  "), "> a\n> b");
  assert.equal(formatSelectedTextQuote("a\rb"), "> a\n> b");
});

test("hasQuotableSelection rejects empty / whitespace-only selections", () => {
  assert.equal(hasQuotableSelection(""), false);
  assert.equal(hasQuotableSelection("   \n\t "), false);
  assert.equal(hasQuotableSelection("x"), true);
});

test("appendQuoteToComposer adds a blank line before when there is prior content", () => {
  assert.equal(appendQuoteToComposer("", "> q"), "> q\n\n");
  assert.equal(appendQuoteToComposer("draft", "> q"), "draft\n\n> q\n\n");
  // existing trailing whitespace is collapsed so spacing stays canonical
  assert.equal(appendQuoteToComposer("draft\n\n  ", "> q"), "draft\n\n> q\n\n");
});

test("emitSelectedTextQuote dispatches the event with routed channelId + formatted quote", () => {
  const target = new EventTarget();
  const received: SelectedTextQuoteDetail[] = [];
  const handler = (e: Event) => received.push((e as CustomEvent<SelectedTextQuoteDetail>).detail);
  target.addEventListener(SELECTED_TEXT_QUOTE_EVENT, handler);

  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (ev: Event) => target.dispatchEvent(ev),
  };
  try {
    const ok = emitSelectedTextQuote("chan-123", "hello\nworld");
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { channelId: "chan-123", quote: "> hello\n> world" });

    // Empty selection is a no-op (no event).
    const ok2 = emitSelectedTextQuote("chan-123", "   ");
    assert.equal(ok2, false);
    assert.equal(received.length, 1);
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});
