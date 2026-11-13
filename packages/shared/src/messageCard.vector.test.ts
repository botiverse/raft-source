// The shared contract vectors for card messages v2.0 (RFC 082 §4.8):
// messageCard.v1.vector.json, which the web and the mobile App also run. This
// checks the Server's side of every case (the verdict, the refusal's path,
// limit and node, the stored card, the agent text and the derived fallback)
// and, for Markdown, what a client must find outside the subset.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Nodes } from "mdast";
import {
  deriveMessageCardFallback, MESSAGE_CARD_HEADER_TAG_TONES, messageCardFallbackProblem, parseMessageCard, renderMessageCardMarkdown,
  type MessageCardLimit,
} from "./messageCard";
import { MESSAGE_CARD_MARKDOWN_NODE_TYPES, messageCardMarkdownViolations, parseMessageCardMarkdown } from "./messageCardMarkdown";
import { extractRaftMentionHandles } from "./raftRefs";

const here = dirname(fileURLToPath(import.meta.url));
const vectorBytes = readFileSync(join(here, "messageCard.v1.vector.json"));

interface Problem { path: string; limit: MessageCardLimit; node?: string }
interface CardVector {
  name: string;
  note: string;
  card: unknown;
  verdict: "accept" | "refuse";
  problem?: Problem;
  parsed?: unknown;
  agentText?: string;
  fallback?: string | null;
  fallbackProblem?: { path: string; limit: MessageCardLimit };
}
interface Found { node: string; source: string; line: number; column: number }
interface MarkdownVector {
  name: string;
  note: string;
  content: string;
  verdict: "accept" | "refuse";
  /** RFC 082 §4.8's allowed client differences: checked against the rule, not the exact rendering. */
  display?: "may_differ";
  problem?: Problem;
  found?: Found[];
  nodes?: string[];
  text?: string;
  agentText?: string;
}
const vectors = JSON.parse(vectorBytes.toString("utf8")) as { contract: string; schemaVersion: number; notes: string; cards: CardVector[]; markdown: MarkdownVector[] };

function markdownCard(content: string) {
  return { version: 1, root: "m", elements: { m: { type: "Markdown", props: { content } } } };
}

/** Each run of letters and digits: the content a reader must see. */
function contentWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether every word of `expected` is in `shown`, in order (other words, such as an entity as written, may come between). */
function showsAllOf(expected: string, shown: string): boolean {
  const words = contentWords(shown);
  let at = 0;
  for (const word of contentWords(expected)) {
    while (at < words.length && words[at] !== word) at++;
    if (at === words.length) return false;
    at++;
  }
  return true;
}

/**
 * RFC 082 §4.8's rule for the three constructs clients may display
 * differently: all of the content shown, no link (nor anything else outside
 * the allowlist) made from them. A mention chip is checked on the agent text.
 */
function holdsMayDifferRule(vector: MarkdownVector, seen: { nodes: string[]; text: string }): string | null {
  const outside = seen.nodes.filter((node) => !(MESSAGE_CARD_MARKDOWN_NODE_TYPES as readonly string[]).includes(node));
  if (outside.length > 0) return `outside the allowlist: ${outside.join(", ")}`;
  if (seen.nodes.includes("link")) return "a link";
  if (!showsAllOf(vector.text!, seen.text)) return `not all of ${JSON.stringify(vector.text)} in ${JSON.stringify(seen.text)}`;
  return null;
}

/** What the vector says a reader sees of an accepted Markdown: its node types and its text. */
function shown(tree: Nodes): { nodes: string[]; text: string } {
  const types = new Set<string>();
  let text = "";
  const visit = (node: Nodes) => {
    if (node.type !== "root") types.add(node.type);
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code") text += node.value;
    if (node.type === "break") text += "\n";
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(tree);
  return { nodes: [...types].sort(), text };
}

test("the vector file is the one the App was given (re-record its sha256 and tell Lagoon when it changes)", () => {
  assert.equal(vectors.contract, "message-card.v1");
  const recorded = readFileSync(join(here, "messageCard.v1.vector.sha256"), "utf8").trim().split(/\s+/);
  assert.equal(recorded[1], "messageCard.v1.vector.json");
  assert.equal(createHash("sha256").update(vectorBytes).digest("hex"), recorded[0],
    "messageCard.v1.vector.json changed: re-record with `shasum -a 256 messageCard.v1.vector.json > messageCard.v1.vector.sha256` in packages/shared/src and tell the App owner (Lagoon) to re-sync.");
  const names = [...vectors.cards, ...vectors.markdown].map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "case names are unique");
});

test("cards[]: each verdict, refusal, stored card, agent text and fallback is the Server's", () => {
  for (const vector of vectors.cards) {
    const result = parseMessageCard(vector.card);
    if (vector.verdict === "refuse") {
      assert.equal(result.ok, false, `${vector.name}: expected a refusal`);
      if (result.ok) continue;
      const { path, limit, node } = result.problem;
      assert.deepEqual(node === undefined ? { path, limit } : { path, limit, node }, vector.problem, vector.name);
      continue;
    }
    assert.ok(result.ok, `${vector.name}: ${result.ok ? "" : JSON.stringify(result.problem)}`);
    if (!result.ok) continue;
    assert.deepEqual(JSON.parse(JSON.stringify(result.card)), vector.parsed, `${vector.name}: parsed`);
    assert.equal(renderMessageCardMarkdown(result.card), vector.agentText, `${vector.name}: agentText`);
    const fallbackProblem = messageCardFallbackProblem(result.card, undefined);
    if (vector.fallback === null) {
      assert.deepEqual(fallbackProblem && { path: fallbackProblem.path, limit: fallbackProblem.limit }, vector.fallbackProblem, `${vector.name}: fallbackProblem`);
    } else {
      assert.equal(fallbackProblem, null, `${vector.name}: a fallback can be derived`);
      assert.equal(deriveMessageCardFallback(result.card), vector.fallback, `${vector.name}: fallback`);
    }
    for (const text of [vector.agentText ?? "", vector.fallback ?? ""]) {
      assert.deepEqual(extractRaftMentionHandles(text), [], `${vector.name}: card text mentions no one`);
    }
  }
});

test("markdown[]: each verdict, and every node a client must draw as its source", () => {
  for (const vector of vectors.markdown) {
    const result = parseMessageCard(markdownCard(vector.content));
    const tree = parseMessageCardMarkdown(vector.content);
    const found = messageCardMarkdownViolations(tree).map((violation) => ({
      node: violation.found,
      source: vector.content.slice(violation.node.position!.start.offset, violation.node.position!.end.offset),
      line: violation.node.position!.start.line,
      column: violation.node.position!.start.column,
    }));
    if (vector.verdict === "refuse") {
      assert.equal(result.ok, false, `${vector.name}: expected a refusal`);
      if (result.ok) continue;
      assert.deepEqual({ path: result.problem.path, limit: result.problem.limit, node: result.problem.node }, vector.problem, vector.name);
      assert.deepEqual(found, vector.found, `${vector.name}: found`);
      assert.equal(found[0]!.node, vector.problem!.node, `${vector.name}: the Server refuses with the first`);
      continue;
    }
    assert.ok(result.ok, `${vector.name}: ${result.ok ? "" : JSON.stringify(result.problem)}`);
    if (!result.ok) continue;
    assert.deepEqual(found, [], vector.name);
    if (vector.display === "may_differ") {
      // The Server's verdict and agent text stay exact; how a reader shows it is checked against the rule.
      assert.equal(holdsMayDifferRule(vector, shown(tree)), null, vector.name);
    } else {
      assert.deepEqual(shown(tree), { nodes: vector.nodes, text: vector.text }, vector.name);
    }
    assert.equal(renderMessageCardMarkdown(result.card), vector.agentText, `${vector.name}: agentText`);
    assert.deepEqual(extractRaftMentionHandles(vector.agentText!), [], `${vector.name}: mentions no one`);
  }
});

test("may_differ marks exactly RFC 082 §4.8's three allowed client differences, each covered, and the rule's check catches what it forbids", () => {
  for (const vector of [...vectors.cards, ...vectors.markdown]) {
    const display = (vector as { display?: unknown }).display;
    assert.ok(display === undefined || display === "may_differ", `${vector.name}: display is may_differ or absent`);
  }
  assert.ok(vectors.cards.every((vector) => (vector as { display?: unknown }).display === undefined), "only Markdown cases differ");
  const differing = vectors.markdown.filter((vector) => vector.display === "may_differ");
  assert.ok(differing.every((vector) => vector.verdict === "accept"), "the Server refuses none of them");
  const tree = (vector: MarkdownVector) => parseMessageCardMarkdown(vector.content);
  const has = (test: (vector: MarkdownVector) => boolean) => differing.some(test);
  assert.ok(has((vector) => /^ {4}/m.test(vector.content)), "4-space indentation");
  assert.ok(has((vector) => /\[[^\]]+\](?!\()/.test(vector.content) && !messageCardMarkdownViolations(tree(vector)).length), "an undefined reference");
  assert.ok(has((vector) => /&(?:amp|lt);/.test(vector.content)) && has((vector) => /&#x?[0-9a-fA-F]+;/.test(vector.content)), "named and numeric character entities");
  // Each may_differ case holds one of the three: without them it reads exactly as every other case.
  for (const vector of differing) {
    assert.ok(/^ {4}|\[[^\]]*\]|&#?[A-Za-z0-9]+;/m.test(vector.content), `${vector.name} holds one of the three constructs`);
  }
  // The rule's check: an entity shown as written passes; a lost word, a link or a node outside the allowlist fails.
  const entities = differing.find((vector) => vector.name === "entities_text")!;
  assert.equal(holdsMayDifferRule(entities, { nodes: ["paragraph", "text"], text: entities.content }), null);
  assert.match(holdsMayDifferRule(entities, { nodes: ["paragraph", "text"], text: "a & <div> © ©" }) ?? "", /not all of/);
  assert.equal(holdsMayDifferRule(entities, { nodes: ["paragraph", "link", "text"], text: entities.text! }), "a link");
  assert.match(holdsMayDifferRule(entities, { nodes: ["html", "text"], text: entities.text! }) ?? "", /outside the allowlist: html/);
  const indented = differing.find((vector) => vector.name === "indented_is_text")!;
  assert.equal(holdsMayDifferRule(indented, { nodes: ["code"], text: "not code\nstill text" }), null, "drawn as a code block, it is still in the allowlist");
});

test("the vectors cover every v2.0 rule: each new limit, each tag tone, each allowed node type, and each refused node RFC 082 §8 names", () => {
  const limits = new Set(vectors.cards.filter((vector) => vector.verdict === "refuse").map((vector) => vector.problem!.limit));
  for (const limit of ["tags", "fields", "markdown", "text", "prop", "shape", "size"] as const) assert.ok(limits.has(limit), limit);
  const tones = new Set(vectors.cards.filter((vector) => vector.verdict === "accept").flatMap((vector) => {
    const header = (vector.card as { header?: { tags?: Array<{ tone: string }> } }).header;
    return (header?.tags ?? []).map((tag) => tag.tone);
  }));
  assert.deepEqual([...tones].sort(), [...MESSAGE_CARD_HEADER_TAG_TONES].sort());
  const allowed = new Set(vectors.markdown.filter((vector) => vector.verdict === "accept").flatMap((vector) => vector.nodes!));
  assert.deepEqual([...allowed].sort(), [...MESSAGE_CARD_MARKDOWN_NODE_TYPES].sort());
  const refused = new Set(vectors.markdown.filter((vector) => vector.verdict === "refuse").map((vector) => vector.problem!.node));
  for (const node of ["heading", "image", "table", "thematicBreak", "html", "footnoteReference", "linkReference", "definition", "math", "inlineMath", "link", "list", "blockquote", "taskListItem"]) {
    assert.ok(refused.has(node), node);
  }
});
