import assert from "node:assert/strict";
import { linkCardV2Schema } from "./appLinkPreview";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";
import { formatAgentMessageCardBlock, formatAgentMessageCardHeaderFields, formatAgentMessageLine } from "./agentMessageText";
import { raftMath } from "./markdownMath";
import { createRaftUserRefRegex, extractRaftMentionHandles } from "./raftRefs";
import {
  agentMessageCardMarker, deriveMessageCardFallback, formatMessageCardProblem, formatMessageCardUpdateNotice, isMessageCardMetadata, MESSAGE_CARD_HEADER_TAG_TONES,
  MESSAGE_CARD_LIMITS, messageCardFallbackProblem, messageCardMetadataAfterUpdate, messageCardMetadataAtSend, messageCardsEqual, messageCardSchema,
  messageCardStoredContent, parseMessageCard, renderMessageCardMarkdown, type MessageCard, type MessageCardInput, type MessageCardLimit,
} from "./messageCard";
import { MESSAGE_CARD_MARKDOWN_MAX_NESTING, messageCardMarkdownViolations, parseMessageCardMarkdown } from "./messageCardMarkdown";
import { formatAgentMessageCardUpdated } from "./agentText/messageCards";

// Hands' TestFlight build card (RFC 082 §1).
const buildCard: MessageCardInput = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "meta", "links"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    meta: { type: "Stack", props: { direction: "row", wrap: true }, children: ["state", "groups", "since", "took"] },
    state: { type: "Badge", props: { text: "In review", tone: "review" } },
    groups: { type: "Text", props: { text: "Internal, Botiverse", tone: "muted" } },
    since: { type: "RelativeTime", props: { at: "2026-11-03T12:03:00Z" } },
    took: { type: "Duration", props: { start: "2026-11-03T11:40:00Z", end: "2026-11-03T12:03:00Z" } },
    links: { type: "Button", props: { label: "Open in App Store Connect", action: { kind: "navigate", url: "https://appstoreconnect.apple.com/apps/1" } } },
  },
};

function parsed(raw: unknown): MessageCard {
  const result = parseMessageCard(raw);
  assert.ok(result.ok, result.ok ? "" : formatMessageCardProblem(result.problem));
  return result.card;
}

function refusal(raw: unknown): { path: string; limit: MessageCardLimit; message: string; node?: string } {
  const result = parseMessageCard(raw);
  assert.equal(result.ok, false, "expected the card to be refused");
  return (result as { ok: false; problem: { path: string; limit: MessageCardLimit; message: string; node?: string } }).problem;
}

function withElements(elements: Record<string, unknown>, root = "root"): unknown {
  return { version: 1, root, elements };
}

function textElements(count: number, text = "x"): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, { type: "Text", props: { text } }]));
}

test("a valid card parses with its defaults filled in, and a card of the v1 elements is also a valid link card v2", () => {
  const card = parsed(buildCard);
  assert.deepEqual(card.elements.title, { type: "Text", props: { text: "Raft App 1.19.0 (11900001)", tone: "default", mono: false } });
  assert.deepEqual(card.elements.root, { type: "Stack", props: { direction: "column", wrap: false }, children: ["title", "meta", "links"] });
  assert.equal(messageCardSchema.safeParse(card).success, true);
  // The web and the mobile App draw a message card with the link card v2 renderer.
  const { version: _version, ...tree } = card;
  assert.equal(linkCardV2Schema.safeParse(tree).success, true);
});

test("a Button's open is tab or beside (web_preview_v0), optional, and nothing else", () => {
  const withOpen = (open: unknown) => withElements({
    root: { type: "Stack", props: {}, children: ["go"] },
    go: { type: "Button", props: { label: "Open preview", action: { kind: "navigate", url: "https://preview.example.com/" }, open } },
  });
  const beside = parsed(withOpen("beside"));
  assert.equal((beside.elements.go!.props as { open?: string }).open, "beside");
  assert.equal((parsed(withOpen("tab")).elements.go!.props as { open?: string }).open, "tab");
  assert.equal("open" in parsed(buildCard).elements.links!.props, false, "absent stays absent: a new tab");
  const wrong = refusal(withOpen("window"));
  assert.deepEqual([wrong.path, wrong.limit], ["card.elements.go.props.open", "prop"]);
  assert.match(wrong.message, /tab or beside/);
  // What agents read is the same link either way.
  assert.match(renderMessageCardMarkdown(beside), /\[Open preview\]\(https:\/\/preview\.example\.com\/\)/);
});

test("each bound refuses with the element's path and the limit it breaks", () => {
  // Elements: at most 16 (a Stack holds at most 12 children, so two Stacks here).
  const texts = Object.keys(textElements(14));
  assert.equal(parseMessageCard(withElements({
    root: { type: "Stack", props: {}, children: ["more", ...texts.slice(0, 11)] },
    more: { type: "Stack", props: {}, children: texts.slice(11) },
    ...textElements(14),
  })).ok, true, "16 elements are allowed");
  const tooMany = refusal(withElements({ root: { type: "Stack", props: {}, children: Object.keys(textElements(12)) }, ...textElements(16) }));
  assert.deepEqual([tooMany.path, tooMany.limit], ["card.elements", "elements"]);
  assert.match(tooMany.message, /17 elements; at most 16/);

  // Depth: the root is 0, at most 4.
  const chain = (levels: number) => Object.fromEntries(Array.from({ length: levels }, (_, i) => [`s${i}`, i === levels - 1
    ? { type: "Text", props: { text: "leaf" } }
    : { type: "Stack", props: {}, children: [`s${i + 1}`] }]));
  assert.equal(parseMessageCard(withElements(chain(5), "s0")).ok, true, "depth 4 is allowed");
  const deep = refusal(withElements(chain(6), "s0"));
  assert.deepEqual([deep.path, deep.limit], ["card.elements.s5", "depth"]);

  // Buttons: at most 4; the path names the first one over.
  const buttons = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, { type: "Button", props: { label: `B${i}`, action: { kind: "navigate", url: `https://example.com/${i}` } } }]));
  assert.equal(parseMessageCard(withElements({ root: { type: "Stack", props: {}, children: Object.keys(buttons(4)) }, ...buttons(4) })).ok, true);
  const tooManyButtons = refusal(withElements({ root: { type: "Stack", props: {}, children: Object.keys(buttons(5)) }, ...buttons(5) }));
  assert.deepEqual([tooManyButtons.path, tooManyButtons.limit], ["card.elements.b4", "buttons"]);

  // Size: 8 KiB of the sender's JSON.
  // Measured in UTF-8 bytes: 12 texts of 200 four-byte code points are 9600 bytes of text alone.
  const big = withElements({ root: { type: "Stack", props: {}, children: Object.keys(textElements(12)) }, ...textElements(12, "\u{1F680}".repeat(200)) });
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length > MESSAGE_CARD_LIMITS.maxBytes);
  const size = refusal(big);
  assert.deepEqual([size.path, size.limit], ["card", "size"]);
  assert.match(size.message, /at most 8192/);
  const under = withElements({ root: { type: "Stack", props: {}, children: Object.keys(textElements(12)) }, ...textElements(12, "y".repeat(500)) });
  assert.ok(new TextEncoder().encode(JSON.stringify(under)).length < MESSAGE_CARD_LIMITS.maxBytes);
  assert.equal(parseMessageCard(under).ok, true);

  // Navigate URLs: public https only.
  for (const url of ["http://example.com/x", "javascript:alert(1)", "https://10.0.0.1/x", "https://user:pw@example.com/", "ftp://example.com/"]) {
    const bad = refusal(withElements({ root: { type: "Button", props: { label: "Go", action: { kind: "navigate", url } } } }));
    assert.deepEqual([bad.path, bad.limit], ["card.elements.root.props.action.url", "url"], url);
  }
  // Buttons only navigate (no execute or read in v1).
  const execute = refusal(withElements({ root: { type: "Button", props: { label: "Do", action: { kind: "execute", action_id: "go", confirm: "prepare" } } } }));
  assert.equal(execute.limit, "action");
  assert.match(execute.path, /^card\.elements\.root\.props\.action/);

  // Unknown element type.
  const unknown = refusal(withElements({ root: { type: "Stack", props: {}, children: ["img"] }, img: { type: "Image", props: { src: "https://example.com/a.png" } } }));
  assert.deepEqual([unknown.path, unknown.limit], ["card.elements.img.type", "element_type"]);
  assert.match(unknown.message, /"Image"/);
});

test("text is measured in code points, not UTF-16 units or bytes", () => {
  const emoji = "\u{1F680}"; // two UTF-16 units, four UTF-8 bytes
  assert.equal(parseMessageCard(withElements({ root: { type: "Badge", props: { text: emoji.repeat(60) } } })).ok, true);
  const long = refusal(withElements({ root: { type: "Badge", props: { text: emoji.repeat(61) } } }));
  assert.deepEqual([long.path, long.limit], ["card.elements.root.props.text", "text"]);
  assert.match(long.message, /Badge text is 1-60 characters .*this one has 61/);
  const label = refusal(withElements({ root: { type: "Button", props: { label: "l".repeat(41), action: { kind: "navigate", url: "https://example.com" } } } }));
  assert.deepEqual([label.path, label.limit], ["card.elements.root.props.label", "text"]);
});

test("the tree, ids, shape and times are checked with precise paths", () => {
  const cases: Array<[unknown, string, MessageCardLimit]> = [
    ["not an object", "card", "shape"],
    [{ ...buildCard, version: 2 }, "card.version", "shape"],
    [{ ...buildCard, title: "extra" }, "card.title", "shape"],
    [withElements({ root: { type: "Text", props: { text: "x" } } }, "missing"), "card.root", "tree"],
    [withElements({ root: { type: "Stack", props: {}, children: ["nope"] } }), "card.elements.root.children[0]", "tree"],
    [withElements({ root: { type: "Stack", props: {}, children: ["a", "a"] }, a: { type: "Text", props: { text: "x" } } }), "card.elements.root.children[1]", "tree"],
    [withElements({ root: { type: "Text", props: { text: "x" } }, orphan: { type: "Text", props: { text: "y" } } }), "card.elements.orphan", "tree"],
    [withElements({ root: { type: "Stack", props: {}, children: ["__proto__"] }, ["__proto__"]: { type: "Text", props: { text: "x" } } }), "card.elements.__proto__", "element_id"],
    [withElements({ root: { type: "Stack", props: {}, children: Object.keys(textElements(13)) }, ...textElements(13) }), "card.elements.root.children", "children"],
    [withElements({ root: { type: "RelativeTime", props: { at: "yesterday" } } }), "card.elements.root.props.at", "time"],
    [withElements({ root: { type: "Duration", props: { start: "2026-11-03T12:00:00Z", end: "2026-11-03T11:00:00Z" } } }), "card.elements.root.props", "time"],
    [withElements({ root: { type: "Text", props: { text: "x", html: "<b>x</b>" } } }), "card.elements.root.props", "prop"],
    [withElements({ root: { type: "Text", props: { text: "x" }, children: [] } }), "card.elements.root", "prop"],
  ];
  for (const [raw, path, limit] of cases) {
    const problem = refusal(raw);
    assert.deepEqual([problem.path, problem.limit], [path, limit], JSON.stringify(raw).slice(0, 120));
  }
  assert.equal(
    formatMessageCardProblem({ path: "card.elements.b4", limit: "buttons", message: "The card has 5 buttons; at most 4" }),
    "Card invalid at card.elements.b4 (buttons): The card has 5 buttons; at most 4; fix it and run the same command again.",
  );
});

// The markdown as the web reads it (remark-gfm and Raft math, as messageMarkdownSecurity.ts).
function parseMarkdown(markdown: string): Nodes {
  return fromMarkdown(markdown, { extensions: [gfm(), raftMath()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
}

/**
 * Every node type in the tree, the text of its `text` nodes outside code and
 * links (where a mention chip could be drawn), and each link's URL with the
 * words it shows.
 */
function markdownShape(markdown: string): { types: Set<string>; prose: string[]; text: string; links: Array<{ url: string; shown: string }> } {
  const types = new Set<string>();
  const prose: string[] = [];
  const links: Array<{ url: string; shown: string }> = [];
  let text = "";
  const visit = (node: Nodes, inLink: boolean) => {
    types.add(node.type);
    if (node.type === "link") links.push({ url: node.url, shown: node.children.map((child) => ("value" in child ? child.value : "")).join("") });
    if (node.type === "text") {
      text += node.value;
      if (!inLink) prose.push(node.value);
    } else if (node.type === "inlineCode") {
      text += node.value;
    }
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child, inLink || node.type === "link");
  };
  visit(parseMarkdown(markdown), false);
  return { types, prose, text, links };
}

function textCard(text: string, props: Record<string, unknown> = {}): MessageCard {
  return parsed(withElements({ root: { type: "Text", props: { text, ...props } } }));
}

test("the card as markdown: every element in tree order, a column's children as blocks, a row's on one line", () => {
  assert.equal(
    renderMessageCardMarkdown(parsed(buildCard)),
    "Raft App 1.19.0 (11900001)\n\n"
      + "[In review] · Internal, Botiverse · 2026-11-03 12:03:00Z · 2026-11-03 11:40:00Z – 2026-11-03 12:03:00Z\n\n"
      + "[Open in App Store Connect](https://appstoreconnect.apple.com/apps/1)",
  );
  // A failed build (the case that asked for it): the reason, the version and the button are all there.
  const failed = parsed(withElements({
    root: { type: "Stack", props: {}, children: ["head", "reason", "meta", "actions"] },
    head: { type: "Stack", props: { direction: "row" }, children: ["title", "state"] },
    title: { type: "Text", props: { text: "排版预览 build failed" } },
    state: { type: "Badge", props: { text: "Failed", tone: "warning" } },
    reason: { type: "Text", props: { text: "Font file missing: NotoSans_CJK.ttf", tone: "warning" } },
    meta: { type: "Stack", props: { direction: "row", wrap: true }, children: ["version", "running"] },
    version: { type: "Text", props: { text: "v1.19.0+11900001", mono: true } },
    running: { type: "Duration", props: { start: "2026-11-05T09:10:00Z" } },
    actions: { type: "Stack", props: { direction: "row" }, children: ["log", "retry"] },
    log: { type: "Button", props: { label: "Open build log", action: { kind: "navigate", url: "https://ci.example.com/builds/42" } } },
    retry: { type: "Button", props: { label: "Retry", action: { kind: "navigate", url: "https://ci.example.com/builds/42/retry" }, disabledReason: "Builds are paused" } },
  }));
  assert.equal(
    renderMessageCardMarkdown(failed),
    "排版预览 build failed · [Failed]\n\n"
      + "⚠️ Font file missing: NotoSans_CJK.ttf\n\n"
      + "`v1.19.0+11900001` · 2026-11-05 09:10:00Z –\n\n"
      + "[Open build log](https://ci.example.com/builds/42) · Retry (disabled: Builds are paused)",
  );
  // A Stack in a row joins the row's line, whatever its own direction; a column in a column adds blocks.
  assert.equal(renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Stack", props: {}, children: ["row", "col"] },
    row: { type: "Stack", props: { direction: "row" }, children: ["a", "inner"] },
    inner: { type: "Stack", props: {}, children: ["b", "c"] },
    col: { type: "Stack", props: {}, children: ["d", "e"] },
    a: { type: "Text", props: { text: "a" } }, b: { type: "Text", props: { text: "b" } }, c: { type: "Badge", props: { text: "c" } },
    d: { type: "Text", props: { text: "d" } }, e: { type: "RelativeTime", props: { at: "2026-11-03T12:03:00Z" } },
  }))), "a · b · [c]\n\nd\n\n2026-11-03 12:03:00Z");
  // A Text keeps its lines in a column (blank lines around and runs of them dropped) and is one line in a row.
  assert.equal(renderMessageCardMarkdown(textCard("\n  first  \n\n\n second\n")), "first\n\nsecond");
  assert.equal(renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Stack", props: { direction: "row" }, children: ["t", "m"] },
    t: { type: "Text", props: { text: "one\ntwo" } },
    m: { type: "Text", props: { text: "x\ny", mono: true } },
  }))), "one two · `x y`");
  // Mono over several lines in a column: a fenced block, its fence longer than any backtick run inside.
  assert.equal(renderMessageCardMarkdown(textCard("line `1`\n  line 2", { mono: true })), "```\nline `1`\n  line 2\n```");
  assert.equal(renderMessageCardMarkdown(textCard("a ```` b\nc", { mono: true, tone: "warning" })), "⚠️\n`````\na ```` b\nc\n`````");
  assert.equal(renderMessageCardMarkdown(textCard("`tick`", { mono: true })), "`` `tick` ``");
  // Muted text is plain text; a URL Raft can't open is no button; nothing to show is empty.
  assert.equal(renderMessageCardMarkdown(textCard("quiet", { tone: "muted" })), "quiet");
  assert.equal(renderMessageCardMarkdown(parsed(withElements({ root: { type: "Stack", props: {}, children: [] } }))), "");
  // A button's URL is the parsed URL (spaces encoded), its parentheses escaped for the link's destination.
  assert.equal(renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Button", props: { label: "Wiki [page]", action: { kind: "navigate", url: "https://example.com/a b/(c)" } } },
  }))), "[Wiki \\[page\\]](https://example.com/a%20b/\\(c\\))");
  const wiki = parseMarkdown("[Wiki \\[page\\]](https://example.com/a%20b/\\(c\\))");
  assert.deepEqual(JSON.parse(JSON.stringify(wiki, (key, value) => (key === "position" ? undefined : value))).children[0].children[0].url, "https://example.com/a%20b/(c)");
});

test("the card as markdown: text stays plain text, never formatting, links, blocks or mentions", () => {
  const hostile = [
    "**bold** _em_ ~~gone~~ ~one~ `code` [a](https://evil.example) ![i](https://evil.example/i.png) <b>x</b> <https://evil.example>",
    "# heading",
    "> quote",
    "- item",
    "+ item",
    "1. one",
    "2) two",
    "---",
    "===",
    "| a | b |",
    "| - | - |",
    "    indented",
    "```",
    "~~~",
    "$x^2$ and $$y$$ &amp; &#64; \\* C:\\Users\\x snake_case_name",
    "[ref]: https://evil.example",
    "ping @artin, (@sage) and @a@b; mail ci@example.com; https://example.com/@user stays",
  ].join("\n");
  const markdown = renderMessageCardMarkdown(textCard(hostile));
  const shape = markdownShape(markdown);
  // Paragraph text and the inline code that holds each @handle; links only where a bare URL or address
  // is written out (a markdown reader's autolink: it shows where it goes), never words over a hidden URL.
  assert.deepEqual([...shape.types].sort(), ["inlineCode", "link", "paragraph", "root", "text"].sort(), markdown);
  for (const link of shape.links) assert.ok(link.url === link.shown || link.url === `mailto:${link.shown}`, JSON.stringify(link));
  // What a reader shows is exactly the text (its leading spaces aside).
  assert.equal(shape.text, hostile.replace("    indented", "indented"));
  // No reader takes an @handle in it for a mention: not the Server's parser, not the web's chips (text outside code and links).
  assert.deepEqual(extractRaftMentionHandles(markdown), []);
  for (const prose of shape.prose) assert.equal(prose.match(createRaftUserRefRegex()), null, `a mention chip in ${JSON.stringify(prose)}`);
  assert.ok(markdown.includes("ping `@artin`, (`@sage`) and `@a@b`; mail ci@example.com; https://example.com/@user stays"), markdown);

  // As the spec's examples: `**x**`, `[a](b)`, `@artin`.
  assert.equal(renderMessageCardMarkdown(textCard("**x**")), "\\*\\*x\\*\\*");
  assert.equal(renderMessageCardMarkdown(textCard("[a](b)")), "\\[a\\](b)");
  assert.equal(renderMessageCardMarkdown(textCard("@artin")), "`@artin`");
  // In a Badge, a disabled button's label and reason too; a link's label is no mention place, so it stays as written.
  const elsewhere = renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Stack", props: { direction: "row" }, children: ["badge", "off", "on"] },
    badge: { type: "Badge", props: { text: "@artin *" } },
    off: { type: "Button", props: { label: "Ask @sage", action: { kind: "navigate", url: "https://example.com/x" }, disabledReason: "@artin is away" } },
    on: { type: "Button", props: { label: "Ping @sage", action: { kind: "navigate", url: "https://example.com/y" } } },
  })));
  assert.equal(elsewhere, "[`@artin` \\*] · Ask `@sage` (disabled: `@artin` is away) · [Ping @sage](https://example.com/y)");
  assert.deepEqual(extractRaftMentionHandles(elsewhere), []);
  // Multi-line text that would make a table or a heading underline.
  const table = renderMessageCardMarkdown(textCard("a | b\n- | -\nTitle\n---"));
  assert.equal(table, "a \\| b\n\\- \\| -\nTitle\n\\---");
  assert.deepEqual([...markdownShape(table).types].sort(), ["paragraph", "root", "text"]);
});

test("the card as markdown: cut at its cap with \"…\", never inside an escape, a code span left closed", () => {
  const long = parsed(withElements({
    root: { type: "Stack", props: {}, children: ["a", "b"] },
    a: { type: "Text", props: { text: "x".repeat(300) } },
    b: { type: "Text", props: { text: "*".repeat(300) } },
  }));
  const cut = renderMessageCardMarkdown(long, { maxCodePoints: 400 });
  assert.ok(Array.from(cut).length <= 400);
  assert.ok(cut.endsWith("\\*…"), cut.slice(-10));
  assert.equal(renderMessageCardMarkdown(long).length, 300 + 2 + 600, "the default cap (4000) leaves an 8 KiB card whole");
  // A cut inside a code span or a Badge still ends it.
  assert.equal(renderMessageCardMarkdown(textCard("y".repeat(20), { mono: true }), { maxCodePoints: 10 }), "`yyyyyyy…`");
  assert.equal(renderMessageCardMarkdown(parsed(withElements({ root: { type: "Badge", props: { text: "z".repeat(20) } } })), { maxCodePoints: 10 }), "[zzzzzzz…]");
  // An @handle is kept whole or left out.
  assert.equal(renderMessageCardMarkdown(textCard("hi @artin"), { maxCodePoints: 8 }), "hi…");
  // The agent text's cap: 4000 code points.
  assert.equal(MESSAGE_CARD_LIMITS.agentTextMaxCodePoints, 4000);
});

test("the derived fallback: the card as markdown, at most 500 code points; it never mentions anyone", () => {
  assert.equal(deriveMessageCardFallback(parsed(buildCard)), renderMessageCardMarkdown(parsed(buildCard)));
  // A running Duration (no end).
  assert.equal(deriveMessageCardFallback(parsed(withElements({
    root: { type: "Stack", props: {}, children: ["go", "run"] },
    go: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://example.com" } } },
    run: { type: "Duration", props: { start: "2026-11-03T11:40:00Z" } },
  }))), "[Open](https://example.com/)\n\n2026-11-03 11:40:00Z –");
  // Nothing to derive from.
  assert.equal(deriveMessageCardFallback(parsed(withElements({ root: { type: "Stack", props: {}, children: [] } }))), "");
  // Capped at 500 code points, counted as code points.
  const emoji = "\u{1F680}";
  const long = deriveMessageCardFallback(parsed(withElements({ root: { type: "Stack", props: {}, children: ["a", "b"] }, a: { type: "Text", props: { text: emoji.repeat(400) } }, b: { type: "Text", props: { text: emoji.repeat(400) } } })));
  assert.equal(Array.from(long).length, 500);
  assert.ok(long.endsWith("…"));
  assert.ok(long.startsWith(`${emoji.repeat(400)}\n\n`));
  // An @handle the sender wrote on the card is code, so no reader takes it for a mention (and the send resolves none from a derived fallback).
  const pinged = deriveMessageCardFallback(parsed(withElements({ root: { type: "Text", props: { text: "ping @alice" } } })));
  assert.equal(pinged, "ping `@alice`");
  assert.deepEqual(extractRaftMentionHandles(pinged), []);
});

test("the agent header carries card=r<revision>, and updated= with a full UTC time after the first; the body never does", () => {
  const card = parsed(buildCard);
  const first = messageCardMetadataAtSend(card, new Date("2026-11-03T12:00:00.000Z"));
  assert.ok(isMessageCardMetadata(first));
  assert.deepEqual(agentMessageCardMarker(first), { revision: 1, updated_at: "2026-11-03T12:00:00.000Z", text: renderMessageCardMarkdown(card) });
  // A stored card the schema can't read gets no text, never a guess; a card that shows nothing has none either.
  assert.deepEqual(agentMessageCardMarker({ ...first, card: { version: 9 } }), { revision: 1, updated_at: "2026-11-03T12:00:00.000Z" });
  assert.equal("text" in agentMessageCardMarker(messageCardMetadataAtSend(parsed(withElements({ root: { type: "Stack", props: {}, children: [] } })), new Date()))!, false);
  assert.equal(agentMessageCardMarker({ kind: "action-card", state: "prepared" }), null);
  assert.equal(agentMessageCardMarker(null), null);

  assert.equal(formatAgentMessageCardHeaderFields({ revision: 1, updated_at: "2026-11-03T12:00:00.000Z" }), " card=r1");
  assert.equal(formatAgentMessageCardHeaderFields({ revision: 3, updated_at: "2026-11-03T12:03:00.000Z" }), " card=r3 updated=2026-11-03 12:03:00Z");
  // Only Raft's own values reach the header line.
  assert.equal(formatAgentMessageCardHeaderFields({ revision: 3, updated_at: "]\n[target=#x" }), " card=r3");
  assert.equal(formatAgentMessageCardHeaderFields({ revision: 0, updated_at: "2026-11-03T12:03:00.000Z" }), "");

  const base = {
    channel_type: "channel", channel_name: "builds", message_id: "11112222-3333-4444-5555-666677778888",
    timestamp: "2026-11-03T12:00:00.000Z", sender_type: "agent", sender_name: "hands", content: "Raft App 1.19.0 · In review",
  };
  // The card's own text follows the body: Raft's `card:` line, then every line of it quoted like a body.
  assert.equal(
    formatAgentMessageLine({ ...base, message_card: agentMessageCardMarker(first) }),
    "[target=#builds msg=11112222 time=2026-11-03 12:00:00Z type=agent card=r1] @hands: Raft App 1.19.0 · In review\n"
      + "card:\n"
      + "  │ Raft App 1.19.0 (11900001)\n"
      + "  │ \n"
      + "  │ [In review] · Internal, Botiverse · 2026-11-03 12:03:00Z · 2026-11-03 11:40:00Z – 2026-11-03 12:03:00Z\n"
      + "  │ \n"
      + "  │ [Open in App Store Connect](https://appstoreconnect.apple.com/apps/1)",
  );
  // From a Server older than the card's text: the header alone, as before.
  assert.equal(
    formatAgentMessageLine({ ...base, message_card: { revision: 3, updated_at: "2026-11-03T12:03:00.000Z" } }),
    "[target=#builds msg=11112222 time=2026-11-03 12:00:00Z type=agent card=r3 updated=2026-11-03 12:03:00Z] @hands: Raft App 1.19.0 · In review",
  );
  // A body that already is the card's text (a fallback Raft derived, not cut) is not repeated.
  const derived = { ...base, content: deriveMessageCardFallback(card), message_card: agentMessageCardMarker(first) };
  assert.equal(formatAgentMessageLine(derived).includes("\ncard:"), false);
  assert.equal(formatAgentMessageCardBlock({ revision: 1, updated_at: "x", text: "a\nb" }, "a\nb"), "");
  assert.equal(formatAgentMessageCardBlock({ revision: 1, updated_at: "x", text: "a\nb" }, "other"), "\ncard:\n  │ a\n  │ b");
  assert.equal(formatAgentMessageCardBlock({ revision: 1, updated_at: "x", text: "  " }, "other"), "");
  assert.equal(formatAgentMessageCardBlock(null, "other"), "");
  // Every other message keeps its bytes.
  assert.equal(formatAgentMessageLine(base), "[target=#builds msg=11112222 time=2026-11-03 12:00:00Z type=agent] @hands: Raft App 1.19.0 · In review");
});

test("an update's metadata is the next revision, and its answer names every mention nobody told (RFC 082 §4.2)", () => {
  const parsed = parseMessageCard(buildCard);
  assert.ok(parsed.ok);
  const first = messageCardMetadataAtSend(parsed.card, new Date("2026-11-03T12:00:00.000Z"));
  const second = messageCardMetadataAfterUpdate(first, parsed.card, new Date("2026-11-03T12:03:00.000Z"));
  assert.deepEqual(second, { kind: "message-card", card: parsed.card, revision: 2, updatedAt: "2026-11-03T12:03:00.000Z" });
  assert.equal(messageCardMetadataAfterUpdate(second, parsed.card, new Date("2026-11-03T12:04:00.000Z")).revision, 3);

  assert.equal(formatMessageCardUpdateNotice([]), "Updating notifies no one. To tell someone, send a new message.");
  assert.equal(formatMessageCardUpdateNotice(["@hands"]), "Updating notifies no one. @hands in the new text was not notified; to tell them, send a new message.");
  assert.equal(
    formatMessageCardUpdateNotice(["@hands", "@sage", "@artin"]),
    "Updating notifies no one. @hands, @sage and @artin in the new text were not notified; to tell them, send a new message.",
  );
  assert.equal(MESSAGE_CARD_LIMITS.revisionRetentionDays, MESSAGE_CARD_LIMITS.updateWindowDays + 30);
});

test("a card as written equals its stored copy whatever the key order; another card or a non-card does not (the CLI's retry rule)", () => {
  const stored = JSON.parse(JSON.stringify(parsed(buildCard))) as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(stored).reverse());
  assert.equal(messageCardsEqual(buildCard, reordered), true);
  assert.equal(messageCardsEqual(reordered, buildCard), true);
  const other = { ...buildCard, elements: { ...buildCard.elements, state: { type: "Badge", props: { text: "Ready for testing", tone: "done" } } } } as MessageCardInput;
  assert.equal(messageCardsEqual(buildCard, other), false);
  assert.equal(messageCardsEqual(buildCard, null), false);
  assert.equal(messageCardsEqual({ version: 2 }, { version: 2 }), false, "two non-cards are not the same card");
});

test("the fallback check and the stored content: the sender's text when written, else the derived one", () => {
  const card = parsed(buildCard);
  assert.equal(messageCardFallbackProblem(card, undefined), null);
  assert.equal(messageCardStoredContent(card, "Written"), "Written");
  assert.equal(messageCardStoredContent(card, ""), deriveMessageCardFallback(card));
  const onlyButton = parsed({ version: 1, root: "b", elements: { b: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://example.com/x" } } } } });
  assert.equal(messageCardFallbackProblem(onlyButton, "Written"), null);
  assert.deepEqual(messageCardFallbackProblem(onlyButton, ""), {
    path: "card",
    limit: "fallback",
    message: "No content was sent and the card has no header, Text, Badge, RelativeTime, Duration, Markdown or Fields to derive it from; add content or one of them",
  });
});

test("an update's answer for agents: the new revision and that nobody was told, or that an earlier run already made it", () => {
  const notice = formatMessageCardUpdateNotice(["@alice"]);
  assert.equal(
    formatAgentMessageCardUpdated({ messageId: "1a2b3c4d-1111-4222-8333-444455556666", revision: 2, notice }),
    "Card updated: message 1a2b3c4d is now at revision 2 (next update: --expected-revision 2).\nUpdating notifies no one. @alice in the new text was not notified; to tell them, send a new message.",
  );
  assert.equal(
    formatAgentMessageCardUpdated({ messageId: "1a2b3c4d", revision: 3, notice: "a\nb", alreadyApplied: true }),
    "Card already updated: message 1a2b3c4d is at revision 3 with this card and text. An earlier run made the change; nothing changed now (next update: --expected-revision 3).\na b",
  );
});

// ---------------------------------------------------------------------------
// v2.0 (RFC 082 §4.8): the header, Markdown, Fields and Divider. The shared
// contract vectors (messageCard.vector.test.ts) hold every case for the web
// and the App; these are the rules one by one.

// Hands' status card once it moves to the header and Fields (RFC 082 §4.8).
const statusCard: MessageCardInput = {
  version: 1,
  header: {
    title: "Play rejected this submission: 1.20.0",
    subtitle: "Raft Android · Google Play · production",
    tags: [{ text: "Failed", tone: "danger" }, { text: "Policy", tone: "warning" }, { text: "Android", tone: "neutral" }],
  },
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["facts", "rule", "notes"] },
    facts: { type: "Fields", props: { items: [{ label: "Version", value: "1.20.0 (12000003)", mono: true }, { label: "Track", value: "production" }] } },
    rule: { type: "Divider", props: {} },
    notes: { type: "Markdown", props: { content: "Google says the **target API level** is too low.\n\n- raise `targetSdk` to 35\n- ask @artin" } },
  },
};

function markdownCard(content: string): unknown {
  return withElements({ root: { type: "Markdown", props: { content } } });
}

test("v2.0: a header (title, subtitle, three tags), Markdown, Fields and Divider parse, with defaults filled in, and the card stays version 1", () => {
  const card = parsed(statusCard);
  assert.equal(card.version, 1);
  assert.deepEqual(card.header, statusCard.header);
  assert.deepEqual(card.elements.facts, { type: "Fields", props: { items: [
    { label: "Version", value: "1.20.0 (12000003)", mono: true },
    { label: "Track", value: "production", mono: false },
  ] } });
  assert.deepEqual(card.elements.rule, { type: "Divider", props: {} });
  assert.equal(messageCardsEqual(statusCard, JSON.parse(JSON.stringify(card))), true, "the stored copy is the same card");
  // Each of the five tones.
  for (const tone of MESSAGE_CARD_HEADER_TAG_TONES) {
    assert.equal(parseMessageCard({ ...statusCard, header: { title: "T", tags: [{ text: tone, tone }] } }).ok, true, tone);
  }
  // A card with v2.0 parts is no link card v2: link cards keep their own catalog.
  const { version: _version, header: _header, ...tree } = card;
  assert.equal(linkCardV2Schema.safeParse(tree).success, false);
  assert.deepEqual(refusal({ ...statusCard, version: 2 }).limit, "shape");
});

test("v2.0: the header is no element (16 elements and a header are fine) but counts towards the 8 KiB", () => {
  const texts = Object.keys(textElements(14));
  const sixteen = { root: { type: "Stack", props: {}, children: ["more", ...texts.slice(0, 11)] }, more: { type: "Stack", props: {}, children: texts.slice(11) }, ...textElements(14) };
  assert.equal(parseMessageCard({ ...(withElements(sixteen) as object), header: { title: "Sixteen elements" } }).ok, true);
  const big = withElements({ root: { type: "Stack", props: {}, children: Object.keys(textElements(12)) }, ...textElements(12, "\u00e9".repeat(300)) }) as object;
  assert.equal(parseMessageCard(big).ok, true);
  const rocket = "\u{1F680}";
  const withHeader = { ...big, header: { title: rocket.repeat(100), subtitle: rocket.repeat(100), tags: [{ text: rocket.repeat(24), tone: "info" }] } };
  assert.deepEqual([refusal(withHeader).path, refusal(withHeader).limit], ["card", "size"]);
});

test("v2.0: each header and Fields rule refuses with its path and limit, nothing else", () => {
  const header = (value: unknown) => ({ ...withElements({ root: { type: "Text", props: { text: "x" } } }) as object, header: value });
  const fields = (items: unknown) => withElements({ root: { type: "Fields", props: { items } } });
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
  const cases: Array<[unknown, string, MessageCardLimit, RegExp?]> = [
    [header({ title: "T", tags: [...Array(4)].map((_, i) => ({ text: `t${i}`, tone: "info" })) }), "card.header.tags[3]", "tags", /4 tags; at most 3/],
    [header({ title: "T", tags: [{ text: "t", tone: "pink" }] }), "card.header.tags[0].tone", "prop", /neutral, info, success, warning, danger/],
    [header({ title: "T", tags: [{ text: "t", tone: "review" }] }), "card.header.tags[0].tone", "prop"],
    [header({ title: "T", tags: [{ text: "t" }] }), "card.header.tags[0].tone", "prop"],
    [header({ title: "T", tone: "danger" }), "card.header", "prop"],
    [header({ title: "t".repeat(101) }), "card.header.title", "text", /Header title is 1-100 characters .*this one has 101/],
    [header({ title: "" }), "card.header.title", "text"],
    [header({ subtitle: "S" }), "card.header.title", "prop"],
    [header({ title: "T", subtitle: "one\ntwo" }), "card.header.subtitle", "text", /one line/],
    [header({ title: "T", subtitle: "one\u2028two" }), "card.header.subtitle", "text", /one line/],
    [header({ title: "T", subtitle: "s".repeat(101) }), "card.header.subtitle", "text"],
    [header({ title: "T", tags: [{ text: "x".repeat(25), tone: "info" }] }), "card.header.tags[0].text", "text", /tag text is 1-24/],
    [header("Title"), "card.header", "shape"],
    [header(null), "card.header", "shape"],
    [fields(rows(9)), "card.elements.root.props.items", "fields", /1-8 rows; this one has 9/],
    [fields([]), "card.elements.root.props.items", "fields", /this one has 0/],
    // The row count is named first, whatever else is wrong in the rows.
    [fields([...rows(8), { label: "l".repeat(41), value: "v" }]), "card.elements.root.props.items", "fields"],
    [fields([{ label: "l".repeat(41), value: "v" }]), "card.elements.root.props.items[0].label", "text", /Fields label is 1-40/],
    [fields([{ label: "l", value: "v".repeat(201) }]), "card.elements.root.props.items[0].value", "text", /Fields value is 1-200/],
    [fields([{ label: "l", value: "v", mono: "yes" }]), "card.elements.root.props.items[0].mono", "prop"],
    [fields([{ label: "l", value: "v", tone: "danger" }]), "card.elements.root.props.items[0]", "prop"],
    [withElements({ root: { type: "Divider", props: { style: "dashed" } } }), "card.elements.root.props", "prop"],
    [withElements({ root: { type: "Divider" } }), "card.elements.root.props", "prop"],
    [withElements({ root: { type: "Divider", props: {}, children: [] } }), "card.elements.root", "prop"],
    [markdownCard("m".repeat(2001)), "card.elements.root.props.content", "text", /Markdown content is 1-2000/],
    [markdownCard(""), "card.elements.root.props.content", "text"],
    [withElements({ root: { type: "Markdown", props: { content: "x", html: true } } }), "card.elements.root.props", "prop"],
  ];
  for (const [raw, path, limit, message] of cases) {
    const problem = refusal(raw);
    assert.deepEqual([problem.path, problem.limit], [path, limit], JSON.stringify(raw).slice(0, 160));
    if (message) assert.match(problem.message, message);
    assert.equal(problem.node, undefined, "only a markdown refusal names a node");
  }
  assert.equal(parseMessageCard(fields(rows(8))).ok, true);
  assert.equal(parseMessageCard(markdownCard("m".repeat(2000))).ok, true);
  assert.equal(parseMessageCard(markdownCard("\u{1F680}".repeat(2000))).ok, true, "2000 code points, not UTF-16 units");
});

test("v2.0: every node outside the Markdown subset refuses with limit markdown, its path and the node it found; nothing is stripped", () => {
  const refused: Array<[string, string]> = [
    ["# Release notes", "heading"],
    ["Title\n=====", "heading"],
    ["![logo](https://example.com/logo.png)", "image"],
    ["| a | b |\n| - | - |\n| 1 | 2 |", "table"],
    ["a\n\n***\n\nb", "thematicBreak"],
    ["x <b>bold</b> y", "html"],
    ["<div>\nhi\n</div>", "html"],
    ["a <!-- note --> b", "html"],
    ["List<String>", "html"],
    ["Text[^1]\n\n[^1]: note", "footnoteReference"],
    ["[docs][1]\n\n[1]: https://example.com", "linkReference"],
    ["[1]: https://example.com", "definition"],
    ["Area is $x^2$.", "inlineMath"],
    ["$$\nx^2\n$$", "math"],
    ["- [ ] write tests", "taskListItem"],
    ["[x](javascript:alert(1))", "link"],
    ["[x](/settings)", "link"],
    ["[call](tel:+15551234567)", "link"],
    ["<tel:+15551234567>", "link"],
    ["[text](sms:+15551234567)", "link"],
    ["- a\n  - b\n    - c\n      - d", "list"],
    ["> a\n> > b\n> > > c\n> > > > d", "blockquote"],
    ["> - a\n>   > - b", "list"],
  ];
  for (const [content, node] of refused) {
    const problem = refusal(markdownCard(content));
    assert.deepEqual([problem.path, problem.limit, problem.node], ["card.elements.root.props.content", "markdown", node], content);
    assert.match(problem.message, /^Markdown has .+ at line \d+, column \d+, which card Markdown doesn't allow; card Markdown has paragraphs/, content);
  }
  assert.match(refusal(markdownCard("ok\n\n## Notes")).message, /a heading at line 3, column 1/);
  assert.match(refusal(markdownCard("[x](javascript:alert(1))")).message, /a link to javascript: \(not http:, https: or mailto:\)/);
  assert.match(refusal(markdownCard("- a\n  - b\n    - c\n      - d")).message, /a list nested 4 levels deep \(lists and quotes nest at most 3\)/);
  assert.equal(MESSAGE_CARD_LIMITS.markdownMaxNesting, MESSAGE_CARD_MARKDOWN_MAX_NESTING);
  // The 400 text carries the path, the limit and the next step, as for every card refusal.
  assert.match(formatMessageCardProblem(refusal(markdownCard("# h"))), /^Card invalid at card\.elements\.root\.props\.content \(markdown\): Markdown has a heading .*; fix it and run the same command again\.$/);

  const allowed = [
    "**bold**, _italic_, ~~gone~~, `code` and [a link](https://example.com/a)",
    "one  \ntwo\\\nthree\nfour",
    "```ts\nconst x = 1;\n```",
    "```math\nx^2\n```",
    "1. one\n2. two\n\n- a\n  - b\n    - c",
    "> a\n> > b\n> > > c",
    "> - a\n>   > b",
    "<https://example.com> www.example.com HTTPS://EXAMPLE.COM/x",
    // A message's link schemes: mailto too, GFM's email autolinks included.
    "mail ci@example.com, <foo@example.com>, <mailto:a@example.com> or [Lagoon](mailto:lagoon@example.com)",
    "a &amp; b &lt;div&gt; <3 a<b x&y $5 to $10",
    "    four spaces are text in chat",
  ];
  for (const content of allowed) assert.equal(parseMessageCard(markdownCard(content)).ok, true, content);
});

test("v2.0: a stored card is read without the Markdown check, so a client draws what is outside the subset as its source text", () => {
  // The Server refuses it at send; a client reading a stored copy (the strict schema) still reads the card.
  const card = { version: 1, root: "m", elements: { m: { type: "Markdown", props: { content: "# Title\n\nx <b>y</b> **ok**" } } } };
  assert.equal(parseMessageCard(card).ok, false);
  assert.equal(messageCardSchema.safeParse(card).success, true);
  // What a client draws as source: each node outside the subset, outermost first.
  const tree = parseMessageCardMarkdown(card.elements.m.props.content);
  assert.deepEqual(messageCardMarkdownViolations(tree).map((violation) => [violation.found, violation.node.position?.start.offset]), [["heading", 0], ["html", 11], ["html", 15]]);
  // A table is one violation, nothing inside it looked at.
  assert.deepEqual(messageCardMarkdownViolations(parseMessageCardMarkdown("| [a](javascript:x) |\n| - |")).map((violation) => violation.found), ["table"]);
});

test("v2.0: the agent text and the derived fallback start with the header and carry the fields, the rule and the Markdown", () => {
  const card = parsed(statusCard);
  const expected = "**Play rejected this submission: 1.20.0**\n"
    + "Raft Android · Google Play · production\n"
    + "[Failed] [Policy] [Android]\n\n"
    + "**Version:** `1.20.0 (12000003)`\n"
    + "**Track:** production\n\n"
    + "---\n\n"
    + "Google says the **target API level** is too low.\n\n"
    + "- raise `targetSdk` to 35\n"
    + "- ask `@artin`";
  assert.equal(renderMessageCardMarkdown(card), expected);
  assert.equal(deriveMessageCardFallback(card), expected);
  // As markdown it is what it says: bold, a list, a rule, code; no mention anywhere.
  const shape = markdownShape(expected);
  for (const type of ["strong", "inlineCode", "thematicBreak", "list", "listItem"]) assert.ok(shape.types.has(type), type);
  assert.deepEqual(extractRaftMentionHandles(expected), []);
  for (const prose of shape.prose) assert.equal(prose.match(createRaftUserRefRegex()), null, prose);

  // Header text is plain text: escaped; tags as [text] on one line; no subtitle, no line for it.
  assert.equal(renderMessageCardMarkdown(parsed({ ...statusCard, header: { title: "**x** @artin", tags: [{ text: "[a]", tone: "info" }, { text: "b", tone: "danger" }] }, root: "rule" , elements: { rule: { type: "Divider", props: {} } } })),
    "**\\*\\*x\\*\\* `@artin`**\n[\\[a\\]] [b]\n\n---");
  assert.equal(renderMessageCardMarkdown(parsed({ ...statusCard, header: { title: "T", subtitle: "- not a list" }, root: "rule", elements: { rule: { type: "Divider", props: {} } } })),
    "**T**\n\\- not a list\n\n---");
  // Fields: labels and values escaped, one line each; mono as code.
  assert.equal(renderMessageCardMarkdown(parsed(withElements({ root: { type: "Fields", props: { items: [
    { label: "Steps*", value: "build\ntest | ship [x](y)" }, { label: "Cmd", value: "a `b` c", mono: true }, { label: "Who", value: "@lagoon" },
  ] } } }))), "**Steps\\*:** build test | ship \\[x\\](y)\n**Cmd:** ``a `b` c``\n**Who:** `@lagoon`");
});

test("v2.0: a Markdown, Fields or Divider in a row is a block of its own; the row's line ends before it", () => {
  assert.equal(renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Stack", props: { direction: "row" }, children: ["a", "m", "b", "inner", "c"] },
    a: { type: "Badge", props: { text: "x" } }, m: { type: "Markdown", props: { content: "*md*" } }, b: { type: "Text", props: { text: "y" } },
    inner: { type: "Stack", props: {}, children: ["d", "f"] }, d: { type: "Divider", props: {} },
    f: { type: "Fields", props: { items: [{ label: "L", value: "V" }] } }, c: { type: "Text", props: { text: "z" } },
  }))), "[x]\n\n*md*\n\ny\n\n---\n\n**L:** V\n\nz");
});

test("v2.0: Markdown reads as it stands, each @name outside code and links as inline code, so no reader takes it for a mention", () => {
  const read = (content: string) => renderMessageCardMarkdown(parsed(markdownCard(content)));
  assert.equal(read("Ping @artin in #builds; `@code` stays; [ask @x](https://e.example/@y) https://e.example/@z"),
    "Ping `@artin` in #builds; `@code` stays; [ask @x](https://e.example/@y) https://e.example/@z");
  // Chains, escapes and character references: each shows the same, as code.
  assert.equal(read("@sage@lagoon \\@artin &#64;eric &#x40;kirby &commat;volta"), "`@sage@lagoon` `@artin` `@eric` `@kirby` `@volta`");
  // The Server's parser reads `a\@b` as a mention of b; the web's chips read `&#64;b` as one: both are code.
  assert.equal(read("a\\@b"), "a`@b`");
  // The fence pairs with nothing the sender wrote, and stands apart from a backtick next to it.
  assert.equal(read("`x`@artin and a ` b @sage"), "`x` ``@artin`` and a ` b ``@sage``");
  const hostile = [
    "@a", "x@a", "(@a)", "**@a**", "_@a_", "~~@a~~", "> @a", "- @a", "1. @a", "@_a_", "@a\\@b", "\\\\@a", "`@a`@b",
    "a ` @b", "a `` @b ` @c", "@a`", "`@a", "&#64;a", "&#0064;a", "&#X40;a", "a&#64;b", "[l](https://e.example) @a", "@a [@b](https://e.example)",
    "\\<@a> <@b>", "@a\n@b\n> @c\n- @d", "@a:b", "@a.b", "@中文",
  ];
  for (const content of hostile) {
    const text = read(content);
    assert.deepEqual(extractRaftMentionHandles(text), [], `${JSON.stringify(content)} -> ${JSON.stringify(text)}`);
    for (const prose of markdownShape(text).prose) assert.equal(prose.match(createRaftUserRefRegex()), null, `${JSON.stringify(content)}: a chip in ${JSON.stringify(prose)}`);
  }
  // Leading blank lines and trailing whitespace go; an unclosed fence is closed, so the next element is not taken into it.
  assert.equal(renderMessageCardMarkdown(parsed(withElements({
    root: { type: "Stack", props: {}, children: ["m", "t"] },
    m: { type: "Markdown", props: { content: "\n\n> - ```\n>   npm run build   \n" } }, t: { type: "Text", props: { text: "after" } },
  }))), "> - ```\n>   npm run build\n>   ```\n\nafter");
});

test("v2.0: a cut ends every span it is in: bold, a link's label, a code block, nested ones too", () => {
  const card = parsed(markdownCard("See [the **build log** for 42](https://ci.example.com/42) now.\n\n```\nline one\nline two\n```"));
  assert.equal(renderMessageCardMarkdown(card, { maxCodePoints: 47 }), "See [the **build…**](https://ci.example.com/42)");
  assert.equal(renderMessageCardMarkdown(card, { maxCodePoints: 44 }), "See [the **bu…**](https://ci.example.com/42)");
  assert.equal(renderMessageCardMarkdown(card, { maxCodePoints: 41 }), "See [the …](https://ci.example.com/42)");
  assert.equal(renderMessageCardMarkdown(card, { maxCodePoints: 80 }), "See [the **build log** for 42](https://ci.example.com/42) now.\n\n```\nline on…\n```");
  // A code span or an autolink is never cut.
  assert.equal(renderMessageCardMarkdown(parsed(markdownCard("ab `npm run build` <https://example.com/long>")), { maxCodePoints: 12 }), "ab…");
  // The fallback: 500 code points at most.
  const long = deriveMessageCardFallback(parsed(markdownCard(`${"word ".repeat(80)}**${"bold ".repeat(40).trim()}**`)));
  assert.equal(Array.from(long).length, 500);
  assert.ok(long.endsWith("…**"), long.slice(-10));
});

test("v2.0: a header, Markdown or Fields is something to derive the fallback from; dividers and buttons are not", () => {
  const empty = { root: { type: "Stack", props: {}, children: [] } };
  assert.equal(messageCardFallbackProblem(parsed({ ...withElements(empty) as object, header: { title: "Nightly build 42 passed" } }), undefined), null);
  assert.equal(deriveMessageCardFallback(parsed({ ...withElements(empty) as object, header: { title: "Nightly build 42 passed" } })), "**Nightly build 42 passed**");
  assert.equal(messageCardFallbackProblem(parsed(markdownCard("Build **42** passed.")), undefined), null);
  assert.equal(messageCardFallbackProblem(parsed(withElements({ root: { type: "Fields", props: { items: [{ label: "L", value: "V" }] } } })), undefined), null);
  const nothing = [
    withElements({ root: { type: "Divider", props: {} } }),
    withElements({ root: { type: "Stack", props: {}, children: ["d", "b"] }, d: { type: "Divider", props: {} }, b: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://example.com" } } } }),
    markdownCard(" \n "),
    { ...withElements({ root: { type: "Divider", props: {} } }) as object, header: { title: "   " } },
  ];
  for (const raw of nothing) {
    assert.equal(messageCardFallbackProblem(parsed(raw), undefined)?.limit, "fallback", JSON.stringify(raw));
    assert.equal(messageCardFallbackProblem(parsed(raw), "Written"), null);
  }
  assert.match(messageCardFallbackProblem(parsed(nothing[0]), "")!.message, /no header, Text, Badge, RelativeTime, Duration, Markdown or Fields/);
});
