import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import type { Nodes } from "mdast";
import { raftMath } from "./markdownMath";
import { extractRaftMentionHandles } from "./raftRefs";

// Task #775: which text is math, by Obsidian's (Pandoc's) dollar rules.
function formulas(source: string): string[] {
  const tree = fromMarkdown(source, {
    extensions: [raftMath()],
    mdastExtensions: [mathFromMarkdown()],
  });
  const found: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "inlineMath") found.push(`inline:${node.value}`);
    if (node.type === "math") found.push(`block:${node.value}`);
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(tree);
  return found;
}

test("a single-dollar pair is math when it hugs its content", () => {
  assert.deepEqual(formulas("area $\\pi r^2$ here"), ["inline:\\pi r^2"]);
  assert.deepEqual(formulas("$x$, $y$."), ["inline:x", "inline:y"]);
  assert.deepEqual(formulas("$x^2$"), ["inline:x^2"]);
});

test("prices stay text", () => {
  // The closing `$` is preceded by a space (and followed by a digit).
  assert.deepEqual(formulas("从 $5 到 $10"), []);
  assert.deepEqual(formulas("$5 and $10 each"), []);
  // The opening `$` is followed by a space.
  assert.deepEqual(formulas("costs $ 5 and $6"), []);
  assert.deepEqual(formulas("a $ x$ b"), []);
  // The closing `$` is preceded by a space.
  assert.deepEqual(formulas("a $x $ b"), []);
  // The closing `$` is followed by a digit.
  assert.deepEqual(formulas("$5,$10"), []);
});

test("single-dollar math stays on one line; escaped dollars are text", () => {
  assert.deepEqual(formulas("$a\nb$"), []);
  assert.deepEqual(formulas("\\$x\\$"), []);
});

test("double dollars are math inline and as a block", () => {
  assert.deepEqual(formulas("then $$E = mc^2$$ holds"), ["inline:E = mc^2"]);
  assert.deepEqual(formulas("$$\n\\int_0^1 x\\,dx\n$$"), ["block:\\int_0^1 x\\,dx"]);
  // A space after `$$` is fine: the single-dollar rules don't apply.
  assert.deepEqual(formulas("$$ a + b $$"), ["inline:a + b"]);
});

test("an @ inside a formula is not a mention; outside it still is", () => {
  assert.deepEqual(extractRaftMentionHandles("see $a @alice$ and $$ @bob $$"), []);
  assert.deepEqual(extractRaftMentionHandles("$5 for @alice and $10"), ["alice"]);
  assert.deepEqual(extractRaftMentionHandles("$x$ @bob"), ["bob"]);
});
