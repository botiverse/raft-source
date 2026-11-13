import { raftMath } from "@botiverse/raft-shared";
import { mathFromMarkdown } from "mdast-util-math";
type RemarkProcessor = {
  data(key: "micromarkExtensions" | "fromMarkdownExtensions"): unknown[] | undefined;
  data(key: "micromarkExtensions" | "fromMarkdownExtensions", value: unknown[]): unknown;
};

/**
 * Task #775: math in markdown, with the same syntax the server reads when it
 * decides who a message notifies (`markdownStructure` in raft-shared):
 * `$$…$$` and Obsidian-style `$…$`. A formula becomes
 * `<code class="language-math">` (inside `<pre>` when it is a block);
 * `MathFormula` renders it with KaTeX, loaded only when one is on screen.
 */
export function remarkRaftMath(this: RemarkProcessor): void {
  this.data("micromarkExtensions", [...(this.data("micromarkExtensions") ?? []), raftMath()]);
  this.data("fromMarkdownExtensions", [
    ...(this.data("fromMarkdownExtensions") ?? []),
    mathFromMarkdown(),
  ]);
}
