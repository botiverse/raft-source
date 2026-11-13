import { createElement } from "react";
import type { Components } from "react-markdown";
import { AppLinkBlockHost } from "./AppLinkBlockCard";

// The Markdown parts of a message's own text that draw its version 3 block
// cards (AppLinkBlockHost): its paragraphs and list items. Kept per text, so
// a message's Markdown components keep their identity while its text does.

type BlockHosts = Pick<Components, "p" | "li">;
const hostsByText = new Map<string, BlockHosts>();
const MAX_KEPT = 500;

/** `p` and `li` for the Markdown of `source`: the shared ones, followed by the block cards of their links. */
export function appLinkBlockHosts(source: string): BlockHosts {
  const kept = hostsByText.get(source);
  if (kept) return kept;
  const hosts: BlockHosts = {
    p: (props) => createElement(AppLinkBlockHost, { ...props, tag: "p", source }),
    li: (props) => createElement(AppLinkBlockHost, { ...props, tag: "li", source }),
  };
  if (hostsByText.size >= MAX_KEPT) hostsByText.delete(hostsByText.keys().next().value!);
  hostsByText.set(source, hosts);
  return hosts;
}
