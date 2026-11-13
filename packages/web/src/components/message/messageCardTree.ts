// Card messages (RFC 082): how the web walks a card's tree to draw it
// (MessageCardElements.tsx, MessageCardBody.tsx). The shared schema already
// bounded it (16 elements, depth 4, one tree); these stay within the depth
// bound whatever they are given.

import type { MessageCard } from "@botiverse/raft-shared";

export type MessageCardNode = MessageCard["elements"][string];

export function messageCardNode(card: MessageCard, id: string): MessageCardNode | undefined {
  return Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
}

/** Whether an element draws anything in the card's body: not a Button (drawn in the card's own row), not a missing id, not a Stack of only those. */
export function messageCardDrawsSomething(card: MessageCard, id: string, depth: number): boolean {
  const node = messageCardNode(card, id);
  if (!node || depth > 4 || node.type === "Button") return false;
  if (node.type !== "Stack") return true;
  return (node.children ?? []).some((child) => messageCardDrawsSomething(card, child, depth + 1));
}

/** A Markdown, Fields or Divider, or a Stack holding one: a block, never part of a row's line (RFC 082 §4.8). */
export function messageCardIsBlock(card: MessageCard, id: string, depth: number): boolean {
  const node = messageCardNode(card, id);
  if (!node || depth > 4) return false;
  if (node.type === "Markdown" || node.type === "Fields" || node.type === "Divider") return true;
  return node.type === "Stack" && (node.children ?? []).some((child) => messageCardIsBlock(card, child, depth + 1));
}
