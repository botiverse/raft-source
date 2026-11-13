import type { ReactNode } from "react";
import type { Nodes, Root } from "mdast";
import { messageTokenNode } from "./remarkMessageTokens";
import type { TextTokenMatcher } from "./remarkMessageTokens";

/**
 * Structured inline parts in a text drawn by the message renderer (an
 * Artifact comment's mentions): each part stands in the Markdown source as a
 * placeholder, `<index>` (Private Use characters, which Markdown
 * reads as letters: never syntax, so `**@Ann**` stays bold), and the renderer
 * draws the caller's node in its place. The part's identity never comes from
 * the text: a placeholder only names an index into the caller's own parts,
 * and the characters are taken out of the text parts themselves
 * (withoutMessageMarkdownSlotMarks), so typed text can't make one.
 */
export interface MessageMarkdownSlots {
  /** What part `index` draws as. */
  render: (index: number) => ReactNode;
  /** Its words where Markdown shows text as written (code, a link's address). */
  text: (index: number) => string;
}

const SLOT_OPEN = "";
const SLOT_CLOSE = "";
const SLOT_MARKS = /[]/g;
const slotPattern = () => /(\d+)/g;

/** Part `index`'s placeholder in the Markdown source. */
export function messageMarkdownSlot(index: number): string {
  return `${SLOT_OPEN}${index}${SLOT_CLOSE}`;
}

/** Text with the placeholder characters replaced (U+FFFD), so it can't name a part. */
export function withoutMessageMarkdownSlotMarks(text: string): string {
  return text.replace(SLOT_MARKS, "�");
}

/** The first matcher of the message refs: a placeholder in running text is its part, claimed before any ref can be. */
export function messageMarkdownSlotMatcher(slots: MessageMarkdownSlots): TextTokenMatcher {
  return {
    pattern: slotPattern(),
    replace: (match) => messageTokenNode("span", slots.text(Number(match[1])), { dataMessageSlot: match[1] }),
  };
}

const LITERAL_FIELDS = ["value", "url", "title", "alt"] as const;

/** Parents whose text the ref matchers leave alone (remarkMessageTokens): a part there is its words, as a mention in a message's link label is. */
const TEXT_ONLY_PARENTS: ReadonlySet<string> = new Set(["link", "linkReference"]);

/**
 * A placeholder that Markdown shows as written (in code, a math source, a
 * link's address, title or label, an image's alt) becomes its part's words:
 * there it draws text, never a chip (a chip in a link would be a link in a
 * link). Other text is left to messageMarkdownSlotMatcher.
 */
export function writeMessageMarkdownSlotsAsText(tree: Root, slots: MessageMarkdownSlots): void {
  const visit = (node: Nodes, textOnly: boolean) => {
    if (node.type !== "text" || textOnly) {
      const fields = node as unknown as Record<string, unknown>;
      for (const field of LITERAL_FIELDS) {
        const value = fields[field];
        if (typeof value === "string" && value.includes(SLOT_OPEN)) {
          fields[field] = value.replace(slotPattern(), (_, index: string) => slots.text(Number(index)));
        }
      }
    }
    if ("children" in node) {
      const childrenTextOnly = textOnly || TEXT_ONLY_PARENTS.has(node.type);
      for (const child of node.children) visit(child, childrenTextOnly);
    }
  };
  visit(tree, false);
}
