import { describe, expect, it } from "vitest";

import { renderThreadWindow, THREAD_WINDOW_PREVIEW_CHARS } from "./passiveResources";

describe("renderThreadWindow", () => {
  it("anchors the skipped line on the lowest shown seq and names the command for older messages", () => {
    expect(renderThreadWindow({
      target: "#ops:1a2b3c4d",
      start: { seq: 5, sender: "richard", content: "root" },
      omittedCount: 2,
      messages: [
        { seq: 9, sender: "scout", timestamp: "2026-10-15T09:01:00.000Z", content: "b" },
        { seq: 8, sender: "scout", timestamp: "2026-10-15T09:00:00.000Z", content: "a" },
      ],
    })).toEqual([
      `  ┌ Thread start ${"─".repeat(28)}`,
      "  │ @richard  root",
      "  ├ ⋯ 2 earlier messages skipped in this notice. Older: raft message read --target \"#ops:1a2b3c4d\" --before 8 ⋯",
      `  ├ Latest 2 ${"─".repeat(28)}`,
      "  │ @scout 09:01  b",
      "  │ @scout 09:00  a",
      `  └ ${"─".repeat(40)}`,
    ]);
  });

  it("prints no skipped line when no shown message has a seq to anchor on", () => {
    const lines = renderThreadWindow({
      target: "#general",
      omittedCount: 3,
      messages: [{ sender: "scout", content: "no seq" }],
    });
    expect(lines.join("\n")).not.toContain("skipped");
    expect(lines.join("\n")).not.toContain("Infinity");
    // No "Older:" line for the 3 skipped: the footer is the way to them.
    expect(lines.at(-1)).toBe("  └ Not all of it is shown here. Read it: raft message read --target \"#general\"");
  });

  it("names a message's attachments and points to the read, even when every preview is whole", () => {
    const lines = renderThreadWindow({
      target: "#ops",
      omittedCount: 0,
      messages: [{ seq: 1, sender: "richard", content: "", attachmentCount: 1 }, { seq: 2, sender: "richard", content: "see the screenshot", attachmentCount: 2 }],
    });
    expect(lines).toContain("  │ @richard  ⟨1 attachment⟩");
    expect(lines).toContain("  │ @richard  see the screenshot ⟨2 attachments⟩");
    expect(lines.at(-1)).toBe("  └ Not all of it is shown here. Read it: raft message read --target \"#ops\"");
  });

  it("points to the read when it names more latest messages than it shows", () => {
    expect(renderThreadWindow({ target: "#ops", omittedCount: 0, shownCount: 3, messages: [{ seq: 1, content: "a" }, { seq: 2, content: "b" }] }).at(-1))
      .toBe("  └ Not all of it is shown here. Read it: raft message read --target \"#ops\"");
  });

  it("truncates previews by code point and says how much is hidden", () => {
    const [, preview] = renderThreadWindow({
      target: "#general",
      omittedCount: 0,
      messages: [{ seq: 1, content: "字".repeat(THREAD_WINDOW_PREVIEW_CHARS + 7) }],
    });
    expect(preview).toBe(`  │ ${"字".repeat(THREAD_WINDOW_PREVIEW_CHARS)}…⟨7 more chars⟩`);
  });

  it("with no message shown, ends with the command to read them", () => {
    expect(renderThreadWindow({ target: "#ops", omittedCount: 0, messages: [] }).at(-1)).toBe("  └ Not shown here. Read them: raft message read --target \"#ops\"");
  });

  it("names the full-text command only when a shown preview was cut (thread start included)", () => {
    const full = (content: string) => renderThreadWindow({ target: "#ops", omittedCount: 0, messages: [{ seq: 2, content: "short" }], start: { seq: 1, content } }).at(-1);
    expect(full("x".repeat(THREAD_WINDOW_PREVIEW_CHARS))).toBe(`  └ ${"─".repeat(40)}`);
    expect(full("x".repeat(THREAD_WINDOW_PREVIEW_CHARS + 1))).toBe("  └ Previews are truncated. Full text: raft message read --target \"#ops\"");
  });
});
