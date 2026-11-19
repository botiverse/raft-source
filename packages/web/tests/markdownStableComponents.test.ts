import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import type { Components } from "react-markdown";

import MarkdownContent from "../src/components/markdown/MarkdownContent";
import { useStableMarkdownComponents } from "../src/components/markdown/stableMarkdownComponents";
import { MessageMarkdownBody } from "../src/components/message/MessageMarkdownBody";
import type { MentionEntry } from "../src/components/message/messageMarkdownRefs";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

// A chat-like component table rebuilt from its inputs, as MessageMarkdownBody's is when members or channels load.
function tableFor(label: string): Components {
  return {
    a: ({ href, children }) => createElement("a", { href, "data-label": label }, children),
    code: ({ children }) => createElement("code", { "data-label": label }, children as ReactNode),
  };
}

const source = "See [the doc](https://raft.build/doc) and `code`.";

function Stable({ label }: { label: string }) {
  const components = useStableMarkdownComponents(tableFor(label));
  return createElement(MarkdownContent, { source, components });
}

test("a rebuilt component table re-renders links with the latest renderer without remounting them", () => {
  const view = render(createElement(Stable, { label: "first" }));
  const link = view.container.querySelector("a");
  const guard = link?.parentElement;
  const code = view.container.querySelector("code");
  assert.ok(link && guard && code);
  assert.equal(link.getAttribute("data-label"), "first");

  view.rerender(createElement(Stable, { label: "second" }));
  const linkAfter = view.container.querySelector("a");
  assert.ok(linkAfter === link, "the link's element is the same one: not torn down and rebuilt");
  assert.ok(linkAfter?.parentElement === guard, "the translation guard around it is the same one");
  assert.ok(view.container.querySelector("code") === code, "the inline code element is the same one");
  assert.equal(linkAfter?.getAttribute("data-label"), "second", "it draws the latest renderer's output");
  assert.equal(view.container.querySelector("code")?.getAttribute("data-label"), "second");
});

// The chat path that had the bug: MessageMarkdownBody's table is rebuilt when a mention map, channels or members load.
const noop = () => {};
function messageBody(mentionMap: Map<string, MentionEntry>) {
  return createElement(TestIntlProvider, null, createElement(MessageMarkdownBody, {
    content: "Hi @alice, see `code`.",
    channels: [],
    mentionMap,
    structuredMentionMap: new Map(),
    onNavigateChannel: noop,
    onNavigateDm: noop,
    onNavigateAgent: noop,
    onNavigateHuman: noop,
    onNavigateExternal: noop,
    timeFormatOptions: {} as never,
    readReceiptChannelId: "c1",
    readReceiptMessageSeq: undefined,
    readReceiptEnabled: false,
    mentionsDisplayOnly: true,
  }));
}

test("a message's mention and inline code survive a rebuilt chat component table", () => {
  const alice: MentionEntry = { displayName: "Alice", type: "user", id: "u1" };
  const view = render(messageBody(new Map([["alice", alice]])));
  const mention = view.container.querySelector("[data-message-mention]");
  const code = view.container.querySelector("code");
  assert.ok(mention && code, "the mention and the inline code render");
  // A new mention map (members loading again) rebuilds MessageMarkdownBody's component table.
  view.rerender(messageBody(new Map([["alice", { ...alice }]])));
  assert.ok(view.container.querySelector("[data-message-mention]") === mention, "the mention element is the same one");
  assert.ok(view.container.querySelector("code") === code, "the inline code element is the same one");
});

test("the translation guard keeps its identity while the anchor override does", () => {
  const a: Components["a"] = ({ href, children }) => createElement("a", { href }, children);
  const view = render(createElement(MarkdownContent, { source, components: { a } }));
  const link = view.container.querySelector("a");
  assert.ok(link);
  // Same override, a different map around it (as a message's block hosts change with its text).
  view.rerender(createElement(MarkdownContent, { source, components: { a, em: "em" } }));
  assert.ok(view.container.querySelector("a") === link, "same element");
});
