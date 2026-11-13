// A card message's `Markdown` element (RFC 082 §4.8), restricted on the web's
// own parse to the subset the Server checks (shared messageCardMarkdown.ts):
// paragraph, text, break, bold, italic, strikethrough, inline code, fenced
// code, lists and quotes (3 levels), and links to http:, https: or mailto:, the
// schemes a message's links take (email autolinks included). The Server refused
// anything else when the card was sent, but a stored card must not depend on
// that: a node outside the subset is drawn as its source text, never
// rendered (Tenny, #13213). The shared contract vectors
// (messageCard.v1.vector.json) pin which nodes those are.

import { messageCardMarkdownViolations } from "@botiverse/raft-shared";
import type { Break, Nodes, Paragraph, Parent, Root, Text } from "mdast";

// Where a node is inline: its source becomes text in the same line.
const PHRASING_PARENTS: ReadonlySet<string> = new Set([
  "paragraph", "heading", "strong", "emphasis", "delete", "link", "linkReference", "tableCell",
]);

/** `source` as text nodes, a line break between its lines. */
function sourceText(source: string): Array<Text | Break> {
  return source.split(/\r\n|\r|\n/).flatMap((line, index): Array<Text | Break> => [
    ...(index > 0 ? [{ type: "break" } as Break] : []),
    ...(line ? [{ type: "text", value: line } as Text] : []),
  ]);
}

/** What a node outside the subset is drawn as: its source, inline (text and line breaks) or as a paragraph of its own. */
function asSource(node: Nodes, parent: Parent, source: string): Nodes[] {
  // A GFM task list item stays a list item (a list holds only those), its box written out.
  if (node.type === "listItem") {
    const marker: Text = { type: "text", value: node.checked ? "[x] " : "[ ] " };
    const [first, ...rest] = node.children;
    const children = first?.type === "paragraph"
      ? [{ ...first, children: [marker, ...first.children] }, ...rest]
      : [{ type: "paragraph", children: [marker] } as Paragraph, ...node.children];
    return [{ ...node, checked: null, children }];
  }
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const text = start === undefined || end === undefined ? [] : sourceText(source.slice(start, end));
  return PHRASING_PARENTS.has(parent.type) ? text : [{ type: "paragraph", children: text } satisfies Paragraph];
}

/**
 * remark plugin: each node outside the card Markdown subset, outermost first,
 * replaced by its source text. Runs after the parse (and remark-breaks); the
 * rest of the tree is drawn by the message markdown renderer as usual. A
 * link's scheme is written in lower case (`HTTPS://` is an https link and
 * `MAILTO:` a mailto one, which the renderer's sanitizer would otherwise leave
 * without its address).
 */
export function remarkMessageCardMarkdownSubset() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    // A task item keeps its content, which is checked again on the next pass; anything else is text after one.
    for (let pass = 0; pass < 8; pass++) {
      const outside = new Set<Nodes>(messageCardMarkdownViolations(tree).map((violation) => violation.node));
      const visit = (parent: Parent) => {
        parent.children = parent.children.flatMap((child) => {
          if (outside.has(child as Nodes)) return asSource(child as Nodes, parent, source);
          if (child.type === "link") child.url = child.url.replace(/^(?:https?|mailto):/i, (scheme) => scheme.toLowerCase());
          if ("children" in child) visit(child as Parent);
          return [child];
        }) as Parent["children"];
      };
      visit(tree);
      if (outside.size === 0) return;
    }
  };
}
