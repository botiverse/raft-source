// A block quote repeats someone else's words: an `@name` in it is drawn as
// the text it is, not a mention chip, the same places the server does not
// notify (extractRaftMentionHandles skips quotes). Mentions outside the quote
// and non-mention refs inside it are unchanged.
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { extractRaftMentionHandles } from "@botiverse/raft-shared";
import {
  MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  messageMarkdownRemarkPlugins,
} from "../src/components/message/messageMarkdownSecurity";
import { createMessageRefsPlugin } from "../src/components/message/messageMarkdownRefs";
import type { MentionEntry } from "../src/components/message/messageMarkdownRefs";
import type { Channel } from "../src/store/channelStore";

const jasper: MentionEntry = { displayName: "Jasper", type: "user", id: "user-jasper" };
const mona: MentionEntry = { displayName: "Mona", type: "agent", id: "agent-mona" };

function mentionsIn(source: string, structured: Map<string, MentionEntry> = new Map()): string[] {
  const refs = createMessageRefsPlugin({
    channels: [{ id: "channel-general", name: "general", type: "channel" } as Channel],
    mentionMap: new Map([["Jasper", jasper], ["Mona", mona]]),
    structuredMentionMap: structured,
    resolveTaskRefChannelId: () => null,
    localTaskRefLabel: (target) => `#${target.taskNumber}`,
    threadRefAuthorityUnavailable: false,
  });
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: messageMarkdownRemarkPlugins(refs),
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
  return [
    ...[...html.matchAll(/data-mention="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/data-raft-ref-target="@([^"]+)"/g)].map((match) => `<@${match[1]}>`),
  ];
}

test("an @name inside a block quote is text, a mention after it is a chip", () => {
  assert.deepEqual(mentionsIn("> @Jasper said so\n\n@Mona agreed"), ["Mona"]);
});

test("nested quotes are quoted; an unquoted line after a quote is drawn outside it", () => {
  assert.deepEqual(mentionsIn("> outer\n> > @Jasper inner\n\n@Mona"), ["Mona"]);
  assert.deepEqual(mentionsIn("> outer\n> > inner\n@Jasper lazy"), []);
  // The web ends the quote at an unquoted line (splitLazyBlockquoteContinuation).
  assert.deepEqual(mentionsIn("> first line @Jasper\n@Mona continues"), ["Mona"]);
});

test("angle and linked user refs and picked mentions inside a quote are text", () => {
  assert.deepEqual(mentionsIn("> <@Jasper> and [him](<@Jasper>)\n\n<@Mona>"), ["<@Mona>"]);
  assert.deepEqual(mentionsIn("> @Mona wrote\n\n@Mona see above", new Map([["Mona", mona]])), ["Mona"]);
});

test("a channel ref inside a quote still links", () => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    children: "> see #general",
    remarkPlugins: messageMarkdownRemarkPlugins(createMessageRefsPlugin({
      channels: [{ id: "channel-general", name: "general", type: "channel" } as Channel],
      mentionMap: new Map(),
      structuredMentionMap: new Map(),
      resolveTaskRefChannelId: () => null,
      localTaskRefLabel: (target) => `#${target.taskNumber}`,
      threadRefAuthorityUnavailable: false,
    })),
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
  assert.match(html, /data-channel="general"/);
});

// Every row: the handles drawn as chips are the handles the Server extracts
// (bare handles on both sides). The lazy-continuation rows pin the one quote
// end (raft-shared drawnQuoteEnd) across hard breaks, emphasis, code spans
// and links.
const PARITY_ROWS = [
  "> @Jasper said so\n\n@Mona agreed",
  "> outer\n> > @Jasper inner\n@Mona lazy",
  "> > b\n@Jasper",
  "> first @Jasper\n> second\nthen @Mona\n> @Jasper",
  "> a\nb @Mona\n> @Jasper",
  "- > @Jasper in a list\n- @Mona",
  "> `@Jasper` and <@Jasper>\n\n`@Mona` @Mona",
  "<@Mona> unquoted",
  "> a  \n@Jasper",
  "> a\\\n@Jasper",
  "> **note\n@Jasper check**",
  "> *a\n> b*\n@Jasper",
  "> `x\n> y`\n@Jasper",
  "> [a\nb](<@Jasper>)",
  "> `x\ny` @Mona\n> @Jasper",
  "> **[a\nb](https://e.com) @Mona**",
  "> a\nb \\<@Jasper>",
  "> a&#10;@Jasper\n@Mona",
  "> a\n> b&#10;@Jasper\n@Mona",
  "> *a&#10;@Jasper\nb* @Mona",
];

test.each(PARITY_ROWS)("the chips drawn are the handles the server notifies: %j", (source) => {
  const drawn = mentionsIn(source).map((handle) => handle.replace(/^<@(.*)>$/, "$1"));
  assert.deepEqual([...new Set(drawn)].sort(), extractRaftMentionHandles(source).sort());
});

test("the paragraph moved out of a quote does not start with a line break", () => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    children: "> [a\nb](https://e.com)\nc",
    remarkPlugins: messageMarkdownRemarkPlugins(createMessageRefsPlugin({
      channels: [],
      mentionMap: new Map(),
      structuredMentionMap: new Map(),
      resolveTaskRefChannelId: () => null,
      localTaskRefLabel: (target) => `#${target.taskNumber}`,
      threadRefAuthorityUnavailable: false,
    })),
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
  assert.match(html, /<\/blockquote>\s*<p>c<\/p>/);
});
