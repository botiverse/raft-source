// An annotation anchor's section (Porthole 0.17.0 P152 `context`): kept
// within Porthole's limits and cleaned as Porthole cleans it, and, over the
// anchor's 4 KiB, given up before the comment is refused: the region first,
// then the headings from the top.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ARTIFACT_ANCHOR_CONTEXT_LIMITS,
  artifactAnchorContextSchema,
  artifactAnchorJsonBytes,
  cleanArtifactAnchorContextText,
  fitArtifactAnchorContext,
  keepArtifactAnchorContext,
} from "./artifactAnchorContext";
import { AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES } from "./agentApiArtifactsContract";
import type { ArtifactCommentAnchor } from "./workspaceArtifacts";

const element = (context?: unknown, css = "#p-fulldata > div > ins:nth-of-type(4)") => ({
  type: "annotation",
  data: { kind: "element", label: "ins 新增", selectors: [{ type: "CssSelector", value: css }], ...(context === undefined ? {} : { context }) },
});

test("the limits are Porthole 0.17.0's ANNOTATION_LIMITS heading, headings and region", () => {
  assert.deepEqual(ARTIFACT_ANCHOR_CONTEXT_LIMITS, { heading: 80, headings: 6, region: 80 });
});

test("a context's text is cleaned as Porthole cleans it (withoutUnseen, then spaces squashed and trimmed): what can't be seen deleted", () => {
  assert.equal(cleanArtifactAnchorContextText("  Agent   收件箱\n现状\t "), "Agent 收件箱 现状");
  // Format characters (zero-width, bidi controls), the joiners among them: deleted, not spaced.
  assert.equal(cleanArtifactAnchorContextText("Pri\u200Bcing \u202Eslp\u202C"), "Pricing slp");
  assert.equal(cleanArtifactAnchorContextText("👩\u200D💻 team"), "👩💻 team");
  assert.equal(cleanArtifactAnchorContextText("می\u200Cخواهم"), "میخواهم");
  // Controls but a new line and a tab: deleted, not spaced.
  assert.equal(cleanArtifactAnchorContextText("a\u0000b\u007Fc\u0085d"), "abcd");
  // Default-ignorables, variation selectors, private use, lone surrogates.
  assert.equal(cleanArtifactAnchorContextText("a\u034Fb\u115Fc\u3164d\u180Be"), "abcde");
  assert.equal(cleanArtifactAnchorContextText("x\uFE0Fy\u{E0100}z"), "xyz");
  assert.equal(cleanArtifactAnchorContextText("p\uE000q"), "pq");
  assert.equal(cleanArtifactAnchorContextText("lone \uD800 surrogate"), "lone surrogate");
  // Nothing visible left: empty.
  assert.equal(cleanArtifactAnchorContextText("\u3164"), "");
  assert.equal(cleanArtifactAnchorContextText(" \u200B\n"), "");
});

test("the schema: headings and region kept cleaned, empty ones left out, nothing left reads as none; too many or too long fails", () => {
  assert.deepEqual(artifactAnchorContextSchema.parse({ headings: [" Agent 收件箱现状 ", "P5 · 读取页"], region: "设计" }), { headings: ["Agent 收件箱现状", "P5 · 读取页"], region: "设计" });
  assert.deepEqual(artifactAnchorContextSchema.parse({ headings: ["", "  ", "Plans"] }), { headings: ["Plans"] });
  assert.deepEqual(artifactAnchorContextSchema.parse({ region: "Design", extra: true }), { region: "Design" });
  assert.equal(artifactAnchorContextSchema.parse({}), undefined);
  assert.equal(artifactAnchorContextSchema.parse({ headings: [" "], region: "\u200B" }), undefined);
  // A Hangul filler is no text: not shown as a blank heading or region.
  assert.equal(artifactAnchorContextSchema.parse({ headings: ["\u3164"], region: "\u3164" }), undefined);
  assert.deepEqual(artifactAnchorContextSchema.parse({ headings: ["\u3164", "Plans"], region: "\u3164" }), { headings: ["Plans"] });
  // At the limits: 6 headings of 80, a region of 80.
  const full = { headings: Array.from({ length: 6 }, () => "节".repeat(80)), region: "区".repeat(80) };
  assert.deepEqual(artifactAnchorContextSchema.parse(full), full);
  for (const bad of [
    { headings: Array.from({ length: 7 }, () => "h") },
    { headings: ["h".repeat(81)] },
    { region: "r".repeat(81) },
    { headings: "Plans" },
    { headings: [1] },
    { region: ["Design"] },
    "Plans",
    null,
  ]) {
    assert.equal(artifactAnchorContextSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("keepArtifactAnchorContext (an agent's anchor): a well-formed context cleaned, a malformed one or one with nothing left out, never refused; other anchors as they are", () => {
  assert.deepEqual(keepArtifactAnchorContext(element({ headings: [" Plans "], region: "" })), element({ headings: ["Plans"] }));
  assert.deepEqual(keepArtifactAnchorContext(element({ headings: [] })), element());
  assert.deepEqual(keepArtifactAnchorContext(element()), element());
  for (const malformed of [{ headings: ["h".repeat(81)] }, { headings: Array.from({ length: 7 }, () => "h") }, { region: "r".repeat(81) }, { headings: "Plans" }, "Plans", null]) {
    assert.deepEqual(keepArtifactAnchorContext(element(malformed)), element(), JSON.stringify(malformed));
  }
  const region = { type: "html-region", data: { selector: "#x", context: "anything" } };
  assert.equal(keepArtifactAnchorContext(region), region, "an agent's own format: stored as given");
});

test("a worst-case CJK context with a long selector and quote still fits 4 KiB as it is", () => {
  const context = { headings: Array.from({ length: 6 }, () => "节".repeat(80)), region: "区".repeat(80) };
  const anchor = { type: "annotation", data: {
    kind: "text",
    label: "引".repeat(120),
    selectors: [{ type: "CssSelector", value: `#p-fulldata > ${"div > ".repeat(60)}ins:nth-of-type(4)` }, { type: "TextQuoteSelector", exact: "引".repeat(300), prefix: "前".repeat(32), suffix: "后".repeat(32) }],
    context,
  } };
  assert.ok(artifactAnchorJsonBytes({ context }) < 1_800, `${artifactAnchorJsonBytes({ context })} bytes`);
  assert.ok(artifactAnchorJsonBytes(anchor) <= AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES, `${artifactAnchorJsonBytes(anchor)} bytes`);
  assert.equal(fitArtifactAnchorContext(anchor, AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES), anchor, "within the limit: untouched");
});

test("over the limit the context gives way: the region, then the headings from the top, then all of it; never the place", () => {
  const headings = ["一".repeat(80), "二".repeat(80), "三".repeat(80)];
  const anchor = element({ headings, region: "区".repeat(80) }) as ArtifactCommentAnchor;
  const bytes = (context?: unknown) => artifactAnchorJsonBytes(element(context));
  // Room for everything but the region.
  assert.deepEqual(fitArtifactAnchorContext(anchor, bytes({ headings })), element({ headings }));
  // Room for the two innermost headings, not three: the outermost goes first.
  assert.deepEqual(fitArtifactAnchorContext(anchor, bytes({ headings: headings.slice(1) })), element({ headings: headings.slice(1) }));
  assert.deepEqual(fitArtifactAnchorContext(anchor, bytes({ headings: headings.slice(1) }) - 1), element({ headings: headings.slice(2) }));
  // Room for no context at all: the place alone.
  assert.deepEqual(fitArtifactAnchorContext(anchor, bytes()), element());
  // Not even that: the place alone, for the caller to refuse as before.
  assert.deepEqual(fitArtifactAnchorContext(anchor, bytes() - 1), element());
  // A region alone.
  assert.deepEqual(fitArtifactAnchorContext(element({ region: "Design" }), bytes()), element());
  // Other anchors and an anchor without context: as they are.
  const lines = { type: "lines", data: { start: 1, end: 2, quote: "x".repeat(5000) } };
  assert.equal(fitArtifactAnchorContext(lines, 4096), lines);
  const bare = element(undefined, "x".repeat(5000));
  assert.equal(fitArtifactAnchorContext(bare, 4096), bare);
});
