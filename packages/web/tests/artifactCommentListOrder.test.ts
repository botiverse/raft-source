// The comment list's order, areas and "new" (comment list v2, the approved prototype's RULES):
// Last updated and Page order, the read mark from the opener's card, and a thread's place while
// the list is open (only the reader's own Resolve and Reopen move it; new threads take their place).
import assert from "node:assert/strict";
import { asArtifactCommentId } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactComment, ArtifactCommentAnchor, ArtifactFile } from "@botiverse/raft-shared";

import { buildThreads } from "../src/apps/artifacts/artifactComments";
import {
  commentFirstLine,
  isUnseenComment,
  layoutAtOpen,
  markPlaceOf,
  moveThread,
  neighbourAfterResolve,
  readCommentSort,
  readMarkAfterLook,
  readMarkAtLoad,
  resorted,
  sortThreads,
  withThreadsNow,
} from "../src/apps/artifacts/artifactCommentListOrder";
import type { ArtifactMarkPlaces } from "../src/apps/artifacts/artifactCommentListOrder";

const actor = (id: string): ArtifactActor => ({ type: "user", id, name: id, displayName: id, avatarUrl: null });
const ME = { type: "user" as const, id: "me" };
const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

function comment(id: string, minute: number, extra: {
  by?: string;
  replyTo?: string;
  path?: string;
  anchor?: ArtifactCommentAnchor | null;
  resolved?: boolean;
  deleted?: boolean;
  text?: string;
} = {}): ArtifactComment {
  return {
    id: asArtifactCommentId(id),
    author: actor(extra.by ?? "ana"),
    body: [{ type: "text", text: extra.text ?? `comment ${id}` }],
    createdAt: at(minute),
    editedAt: null,
    deletedAt: extra.deleted ? at(minute) : null,
    version: 1,
    target: extra.path ? { scope: "file", path: extra.path, anchor: extra.anchor ?? null } : { scope: "artifact" },
    replyTo: extra.replyTo ? asArtifactCommentId(extra.replyTo) : null,
    resolvedAt: extra.resolved ? at(minute) : null,
    resolvedBy: extra.resolved ? actor("ana") : null,
  };
}

const annotation = (start: number): ArtifactCommentAnchor => ({
  type: "annotation",
  data: { kind: "text", label: "p", selectors: [{ type: "TextQuoteSelector", exact: "x" }, { type: "TextPositionSelector", start, end: start + 1 }] },
});
const lines = (start: number): ArtifactCommentAnchor => ({ type: "lines", data: { start, end: start } });
const file = (path: string): ArtifactFile => ({ path, kind: "html", sizeBytes: 1, entry: false });
const ids = (threads: readonly { id: string }[]) => threads.map((t) => t.id);

test("Last updated: by each thread's last comment, newest first", () => {
  const threads = buildThreads([
    comment("a", 1),
    comment("b", 2),
    comment("a1", 9, { replyTo: "a" }),
    comment("c", 5),
  ]);
  assert.deepEqual(ids(sortThreads(threads, "updated", { files: [], frame: null })), ["a", "c", "b"]);
});

test("Page order: the whole Artifact first, files in the version's order, a file's whole-file comments, then places found by the frame, anchors not found last", () => {
  const files = [file("index.html"), file("notes.txt")];
  const threads = buildThreads([
    comment("lost", 1, { path: "index.html", anchor: annotation(50) }),
    comment("late", 2, { path: "index.html", anchor: annotation(900) }),
    comment("early", 3, { path: "index.html", anchor: annotation(10) }),
    comment("whole-file", 4, { path: "index.html" }),
    comment("txt-9", 5, { path: "notes.txt", anchor: lines(9) }),
    comment("txt-2", 6, { path: "notes.txt", anchor: lines(2) }),
    comment("on-artifact", 7),
    comment("resolved", 8, { path: "index.html", anchor: annotation(5), resolved: true }),
  ]);
  const frame: ArtifactMarkPlaces = {
    path: "index.html",
    places: new Map([
      ["late", markPlaceOf({ id: "late", state: "attached", order: 1 })],
      ["early", markPlaceOf({ id: "early", state: "attached", order: 0 })],
      ["lost", markPlaceOf({ id: "lost", state: "orphaned" })],
    ]),
  };
  // Not placed by the frame (lost, resolved and so not marked): after the found ones, by where their text was.
  assert.deepEqual(ids(sortThreads(threads, "page", { files, frame })), ["on-artifact", "whole-file", "early", "late", "resolved", "lost", "txt-2", "txt-9"]);
  // Before the frame said anything: by where the text was when written.
  assert.deepEqual(ids(sortThreads(threads, "page", { files, frame: null })), ["on-artifact", "whole-file", "resolved", "early", "lost", "late", "txt-2", "txt-9"]);
});

test("a stored sort is read back; anything else is Last updated", () => {
  assert.equal(readCommentSort("page"), "page");
  assert.equal(readCommentSort("updated"), "updated");
  assert.equal(readCommentSort("oldest"), "updated");
  assert.equal(readCommentSort(null), "updated");
});

test("new to the reader: others' comments from the opener's first new one, or after the list last looked; never one's own or a deleted one", () => {
  const list = [comment("a", 1), comment("b", 2, { by: "me" }), comment("c", 3), comment("d", 4, { deleted: true }), comment("e", 5)];
  const mark = readMarkAtLoad(list, ME, { newComments: 2, firstNewComment: asArtifactCommentId("c") });
  const isNew = (id: string) => isUnseenComment(list.find((c) => c.id === id)!, mark, ME, new Set());
  assert.deepEqual(["a", "b", "c", "d", "e"].filter(isNew), ["c", "e"]);
  // Seen since the list opened (expanded): no longer new.
  assert.equal(isUnseenComment(list[2]!, mark, ME, new Set([asArtifactCommentId("c")])), false);
  // A reply that came while the viewer was open: new.
  assert.equal(isUnseenComment(comment("f", 6), mark, ME, new Set()), true);
  // The first new comment isn't loaded (an earlier page, deleted since): the newest `newComments` by others.
  const byCount = readMarkAtLoad(list, ME, { newComments: 2, firstNewComment: asArtifactCommentId("gone") });
  assert.deepEqual(list.filter((c) => isUnseenComment(c, byCount, ME, new Set())).map((c) => c.id), ["c", "e"]);
  // No card, or one with nothing new: only what comes after the first load.
  assert.deepEqual(list.filter((c) => isUnseenComment(c, readMarkAtLoad(list, ME, null), ME, new Set())), []);
  // Once the list closed, all it had is read.
  const after = readMarkAfterLook(list);
  assert.deepEqual(list.filter((c) => isUnseenComment(c, after, ME, new Set())), []);
  assert.equal(isUnseenComment(comment("g", 7), after, ME, new Set()), true);
});

test("areas as the list opens: unresolved threads, and resolved ones with new comments, open; the rest folded", () => {
  const list = [
    comment("open", 1),
    comment("done", 2, { resolved: true }),
    comment("done-new", 3, { resolved: true }),
    comment("reply", 9, { replyTo: "done-new" }),
  ];
  const mark = { through: at(5), from: null };
  const threads = sortThreads(buildThreads(list), "updated", { files: [], frame: null });
  const layout = layoutAtOpen(threads, (c) => isUnseenComment(c, mark, ME, new Set()));
  assert.deepEqual(layout, { open: ["done-new", "open"], rest: ["done"] });
});

test("only the reader's own Resolve and Reopen move a thread, into its place by the sort; focus goes to the card after it", () => {
  const order = ["a", "b", "c", "d"].map(asArtifactCommentId);
  const layout = { open: [order[0]!, order[1]!, order[2]!], rest: [order[3]!] };
  assert.equal(neighbourAfterResolve(layout, order[1]!), "c");
  assert.equal(neighbourAfterResolve(layout, order[2]!), "b");
  assert.equal(neighbourAfterResolve({ open: [order[0]!], rest: [] }, order[0]!), null);
  const resolved = moveThread(layout, order, order[1]!, false);
  assert.deepEqual(resolved, { open: ["a", "c"], rest: ["b", "d"] });
  assert.deepEqual(moveThread(resolved, order, order[1]!, true), layout);
  // A sort picked: the same areas, in the new order.
  assert.deepEqual(resorted(layout, [...order].reverse()), { open: ["c", "b", "a"], rest: ["d"] });
});

test("threads the list didn't have take their place by the sort without moving the others; deleted ones leave", () => {
  const before = buildThreads([comment("a", 1), comment("b", 2), comment("c", 3)]);
  const layout = { open: ids(before).reverse().map(asArtifactCommentId), rest: [] };
  assert.equal(withThreadsNow(layout, sortThreads(before, "updated", { files: [], frame: null }), () => false), layout);
  const now = buildThreads([comment("a", 1), comment("c", 3), comment("new", 8), comment("b1", 9, { replyTo: "b" }), comment("b", 2)]);
  // "b" has a new reply and would sort first now: it stays where it was; the new thread goes by the sort.
  const next = withThreadsNow({ open: layout.open.filter((id) => id !== "b"), rest: [asArtifactCommentId("b")] }, sortThreads(now, "updated", { files: [], frame: null }), () => false);
  assert.deepEqual(next, { open: ["new", "c", "a"], rest: ["b"] });
  const gone = withThreadsNow(layout, sortThreads(buildThreads([comment("a", 1), comment("c", 3)]), "updated", { files: [], frame: null }), () => false);
  assert.deepEqual(gone, { open: ["c", "a"], rest: [] });
});

test("a seen comment's one line: the first line with words, mentions as written, no list marker or inline marks", () => {
  assert.equal(commentFirstLine({ body: [{ type: "text", text: "\n  - **Bold** start `code`\nsecond line" }] }), "Bold start code");
  assert.equal(commentFirstLine({ body: [{ type: "text", text: "cc " }, { type: "mention", actor: actor("Remy") }, { type: "text", text: " please" }] }), "cc @Remy please");
  assert.equal(commentFirstLine({ body: [] }), "");
});
