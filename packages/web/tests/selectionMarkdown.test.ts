import { describe, it } from "node:test";
import assert from "node:assert";
import {
  selectionToMarkdown,
} from "../src/utils/selectMarkdown";
import type {
  SelectableMessage,
} from "../src/utils/selectMarkdown";

const baseMsg = (id: string, seq: number, sender: string, content: string): SelectableMessage => ({
  id,
  seq,
  channelId: "ch-1",
  senderType: "user",
  senderId: "u",
  senderName: sender,
  content,
  createdAt: new Date(seq * 1000).toISOString(),
});

describe("selectionToMarkdown", () => {
  it("renders messages in seq order with sender prefix", () => {
    const msgs: SelectableMessage[] = [
      baseMsg("b", 2, "Bob", "second"),
      baseMsg("a", 1, "Alice", "first"),
    ];
    assert.equal(
      selectionToMarkdown(msgs),
      "**Alice**: first\n\n**Bob**: second",
    );
  });

  it("indents thread children with `↳` prefix and two-space lead", () => {
    const msgs: SelectableMessage[] = [
      { ...baseMsg("p", 1, "Alice", "parent"), isThreadChild: false },
      { ...baseMsg("c1", 2, "Bob", "child one"), isThreadChild: true },
      { ...baseMsg("c2", 3, "Carol", "child two"), isThreadChild: true },
    ];
    assert.equal(
      selectionToMarkdown(msgs),
      "**Alice**: parent\n\n  ↳ **Bob**: child one\n\n  ↳ **Carol**: child two",
    );
  });

  it("trims content but preserves inline markdown", () => {
    const msgs: SelectableMessage[] = [
      baseMsg("a", 1, "Alice", "  hi `code` and **bold**  "),
    ];
    assert.equal(
      selectionToMarkdown(msgs),
      "**Alice**: hi `code` and **bold**",
    );
  });

  it("falls back to Unknown when senderName missing", () => {
    const m = baseMsg("a", 1, "", "x");
    delete (m as { senderName?: string }).senderName;
    assert.equal(selectionToMarkdown([m]), "**Unknown**: x");
  });
});
