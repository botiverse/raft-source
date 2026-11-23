// "Linked from" (#proj-workspace:#336 step 2, Kirby's design): what links to an Artifact, as the viewer
// says it. The count ("999+" past 999 or past the server's cap), whether anything is said at all, where
// it goes for the file shown (a strip outside a frame, or a block under content Raft draws), the first
// rows and "Show all N", and the discussions the reader's own channel list can name.
import assert from "node:assert/strict";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactBacklinkMessage, ArtifactCard, ArtifactWebBacklinks, ChannelId, MessageId } from "@botiverse/raft-shared";

import {
  BACKLINKS_FIRST_ROWS,
  backlinksCountText,
  backlinksPlace,
  backlinksRows,
  backlinksShown,
  backlinksTotal,
  namedBacklinkMessages,
} from "../src/apps/artifacts/artifactBacklinksModel";
import type { ArtifactHostConversation } from "../src/apps/artifacts/artifactShareHost";

const card = { id: asArtifactId("pt_00000000-0000-4000-8000-000000000001"), title: "Q3 plan" } as ArtifactCard;

function message(n: number, conversationId: string): ArtifactBacklinkMessage {
  return {
    messageId: `m${n}` as MessageId,
    conversationId: conversationId as ChannelId,
    author: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    excerpt: `see the plan ${n}`,
  };
}

function backlinks(documents: { items: ArtifactCard[]; total: number; capped?: boolean }, discussions: { items: ArtifactBacklinkMessage[]; total: number; capped?: boolean }): ArtifactWebBacklinks {
  return {
    documents: { capped: false, ...documents },
    discussions: { capped: false, ...discussions },
  };
}

test("the count is the number up to 999, then 999+; and 999+ wherever the server stopped counting", () => {
  assert.equal(backlinksCountText(1, false), "1");
  assert.equal(backlinksCountText(999, false), "999");
  assert.equal(backlinksCountText(1000, false), "999+");
  assert.equal(backlinksCountText(1000, true), "999+");
  assert.equal(backlinksCountText(12, true), "999+");
});

test("the total is both groups together, capped when either group is", () => {
  // Every discussion on the page named (`named` = its items): the server's counts as they are.
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 3 }, { items: [], total: 4 }), 0), { count: 7, capped: false });
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 1000, capped: true }, { items: [], total: 0 }), 0), { count: 1000, capped: true });
  assert.deepEqual(backlinksTotal(backlinks({ items: [], total: 0 }, { items: [message(1, "c1")], total: 1000, capped: true }), 1), { count: 1000, capped: true });
});

test("the count leaves out the discussions the reader's list can't name, so it says what the list lists", () => {
  const items = [message(1, "c1"), message(2, "c2"), message(3, "c3"), message(4, "c4")];
  // 9 discussions counted, 4 on the page, 1 of them unnamed: 8 discussions, plus 2 documents.
  assert.deepEqual(backlinksTotal(backlinks({ items: [card, card], total: 2 }, { items, total: 9 }), 3), { count: 10, capped: false });
  // Past the cap, still "999+" on the adjusted total.
  const capped = backlinksTotal(backlinks({ items: [], total: 0 }, { items, total: 1000, capped: true }), 1);
  assert.deepEqual(capped, { count: 997, capped: true });
  assert.equal(backlinksCountText(capped.count, capped.capped), "999+");
  // Without the cap, a large adjusted total keeps the number rule.
  assert.equal(backlinksCountText(backlinksTotal(backlinks({ items: [card], total: 600 }, { items, total: 500 }), 2).count, false), "999+");
});

test("nothing is said while loading or failed (null), for an empty answer, or when the page lists nothing", () => {
  assert.equal(backlinksShown(null, 0), false);
  assert.equal(backlinksShown(backlinks({ items: [], total: 0 }, { items: [], total: 0 }), 0), false);
  // Counted, but every item stopped linking it since: nothing to open onto.
  assert.equal(backlinksShown(backlinks({ items: [], total: 2 }, { items: [], total: 1 }), 0), false);
  assert.equal(backlinksShown(backlinks({ items: [card], total: 1 }, { items: [], total: 0 }), 0), true);
  assert.equal(backlinksShown(backlinks({ items: [], total: 0 }, { items: [message(1, "c1")], total: 1 }), 1), true);
});

test("every discussion in a conversation the reader's list can't name, and no documents: nothing is said", () => {
  const answer = backlinks({ items: [], total: 0 }, { items: [message(1, "c1"), message(2, "c2")], total: 5 });
  const named = namedBacklinkMessages(answer.discussions.items, () => null);
  assert.equal(named.length, 0);
  assert.equal(backlinksShown(answer, named.length), false);
  // With a document beside them, the document alone is said and counted: none on the page named,
  // so the 3 past the page are not counted either.
  const withDocument = backlinks({ items: [card], total: 1 }, answer.discussions);
  assert.equal(backlinksShown(withDocument, 0), true);
  assert.deepEqual(backlinksTotal(withDocument, 0), { count: 1, capped: false });
});

test("discussions past the page count only when the reader can name at least one on it", () => {
  const items = [message(1, "c1"), message(2, "c2")];
  // None of the 2 on the page named: the 48 past it are left out too.
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 1 }, { items, total: 50 }), 0), { count: 1, capped: false });
  // One of them named: the one, plus the 48 past the page.
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 1 }, { items, total: 50 }), 1), { count: 50, capped: false });
  // The discussions' cap says "999+" only while they are counted.
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 1 }, { items, total: 1000, capped: true }), 0), { count: 1, capped: false });
  assert.deepEqual(backlinksTotal(backlinks({ items: [card], total: 1 }, { items, total: 1000, capped: true }), 1), { count: 1000, capped: true });
});

test("a framed page (HTML, Markdown, a PDF) gets the strip; content Raft draws (csv, text, an image) the block under it", () => {
  for (const kind of ["html", "markdown", "pdf"] as const) assert.equal(backlinksPlace(kind, kind, true), "strip", kind);
  for (const kind of ["csv", "text", "image"] as const) assert.equal(backlinksPlace(kind, kind, true), "below", kind);
  // No file to draw (No preview): the strip.
  assert.equal(backlinksPlace("csv", null, true), "strip");
  assert.equal(backlinksPlace("other", "other", true), "strip");
  // Another file than the entry is drawn by its own kind: an image beside an HTML entry is Raft's, a page of it the frame's.
  assert.equal(backlinksPlace("html", "image", false), "below");
  assert.equal(backlinksPlace("html", "markdown", false), "strip");
  assert.equal(backlinksPlace("csv", "pdf", false), "strip");
});

test("a group lists its first rows, then Show all N shows the rest of the page", () => {
  const items = Array.from({ length: 12 }, (_, n) => n);
  assert.deepEqual(backlinksRows(items, false), { rows: items.slice(0, BACKLINKS_FIRST_ROWS), more: 12 });
  assert.deepEqual(backlinksRows(items, true), { rows: items, more: 0 });
  const few = items.slice(0, BACKLINKS_FIRST_ROWS);
  assert.deepEqual(backlinksRows(few, false), { rows: few, more: 0 }, "no Show all when nothing is folded");
});

test("a discussion is listed only where the reader's own channel list names its conversation, in order", () => {
  const general: ArtifactHostConversation = { id: "c1", name: "general", type: "channel" };
  const dm: ArtifactHostConversation = { id: "c3", name: "Niko", type: "dm" };
  const lists = new Map([["c1", general], ["c3", dm]]);
  const named = namedBacklinkMessages([message(1, "c1"), message(2, "c2"), message(3, "c3")], (id) => lists.get(id) ?? null);
  assert.deepEqual(named.map((item) => [item.message.messageId, item.conversation.name]), [["m1", "general"], ["m3", "Niko"]]);
  assert.deepEqual(namedBacklinkMessages([message(1, "c1")], () => null), []);
});
