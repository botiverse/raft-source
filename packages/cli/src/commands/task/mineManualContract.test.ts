import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatMyTaskList } from "./_format.js";

// Task #108. The Manual's `--mine` paragraph now describes behaviour an agent relies on to find
// work assigned to it, so two of its claims are bound to the renderer that produces them:
// that the listing is scoped to one server, and that its completeness signal is `truncated=`
// rather than the `showing X of X` phrase, which cannot report a shortfall.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANUAL = path.resolve(HERE, "../../../../..", "manual/agent-knowledge/task.md");

async function manual(): Promise<string> {
  return readFile(MANUAL, "utf8");
}

test("the manual quotes the heading the renderer actually prints", async () => {
  const rendered = formatMyTaskList({ tasks: [], scope: "mine" } as never);
  const heading = "## My assigned tasks on this server";
  assert.ok(
    rendered.includes(heading),
    `renderer no longer prints ${heading}; the manual quotes it verbatim`,
  );
  assert.ok(
    (await manual()).includes(heading),
    "the manual must quote the heading, since that heading is the reader's evidence of server scope",
  );
});

test("the manual documents server scope, not just channel scope", async () => {
  // "across channels" alone reads as "everywhere you are assigned". The renderer says
  // "on this server", so an agent in two servers needs two runs.
  const text = await manual();
  assert.match(
    text,
    /scoped to one server/i,
    "the manual must state that --mine covers one server",
  );
});

test("an absent pagination block renders unknown, and the manual says unknown is not false", async () => {
  // `mode` and `truncated` come from the server; the renderer falls back to the string
  // "unknown". A reader who treats unknown as false believes a set is complete when this
  // run could not tell them. Deleting either `?? "unknown"` fallback turns this red.
  const rendered = formatMyTaskList({ tasks: [], scope: "mine" } as never);
  assert.match(rendered, /mode=unknown/, "missing pagination.mode must render as unknown");
  assert.match(rendered, /truncated=unknown/, "missing pagination.truncated must render as unknown");

  const text = await manual();
  assert.match(text, /`unknown` is not `false`/, "the manual must say unknown is not false");
});

test("showing X of X is the same count twice, and the manual says so", async () => {
  // The phrase looks like "shown of total" and is not: both sides are the length of what
  // arrived. Proven here rather than asserted — a renderer that ever printed a real total
  // would make these two numbers differ, and this test would tell the doc author to
  // rewrite the warning instead of leaving a stale one.
  const rendered = formatMyTaskList({
    tasks: [
      { taskNumber: 1, status: "todo", title: "a", channelRef: "#c" },
      { taskNumber: 2, status: "todo", title: "b", channelRef: "#c" },
    ],
    scope: "mine",
  } as never);
  assert.match(rendered, /showing 2 of 2 visible matches/);

  assert.match(
    await manual(),
    /do not read `showing X of X` as a receipt/i,
    "the manual must warn that the phrase cannot report a shortfall",
  );
});
