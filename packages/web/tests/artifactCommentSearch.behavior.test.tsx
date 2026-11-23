// The comment list's search (#proj-workspace:#341, xxchan), in the panel: typing shows only the threads
// it finds (text and author names), in the list's order and areas, resolved ones too (the Resolved
// section opens for them); a collapsed thread whose match is on a one-line comment opens, without
// reading its new comments; the words are marked; Esc clears and the list is as it was, the focus
// still in the field, and the next Esc is the panel's (also an Esc from a result card); the × does
// as the first Esc; nothing found says so in a live region. The reader's folds while searching go
// with the words; picking a result leaves the list's own Resolved fold alone; a thread picked that
// the search doesn't show (a marker in the page) ends the search.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { asArtifactCommentId } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactComment } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";

// The comments' state, as a store the panel reads (so the thread being read can change, as a press or a marker does).
const comments = vi.hoisted(() => ({ current: null as null | Record<string, unknown>, listeners: new Set<() => void>() }));
vi.mock("../src/apps/artifacts/ArtifactCommentsContext", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    comments.listeners.add(listener);
    return () => {
      comments.listeners.delete(listener);
    };
  };
  return {
    ...(await importOriginal<typeof import("../src/apps/artifacts/ArtifactCommentsContext")>()),
    useArtifactComments: () => useSyncExternalStore(subscribe, () => comments.current),
  };
});
vi.mock("../src/apps/artifacts/ArtifactReviewContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/apps/artifacts/ArtifactReviewContext")>()),
  useArtifactReview: () => null,
}));

const { default: ArtifactCommentsPanel } = await import("../src/apps/artifacts/ArtifactCommentsPanel");

const SORT_KEY = "raft:artifacts:comments:sort:v1";
const ANA: ArtifactActor = { type: "user", id: "ana", name: "ana", displayName: "Ana Lima", avatarUrl: null };
const BOHDAN: ArtifactActor = { type: "user", id: "bohdan", name: "bohdan", displayName: "Bohdan", avatarUrl: null };
const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

function comment(id: string, minute: number, by: ArtifactActor, text: string, extra: { replyTo?: string; resolved?: boolean } = {}): ArtifactComment {
  return {
    id: asArtifactCommentId(id),
    author: by,
    body: [{ type: "text", text }],
    createdAt: at(minute),
    editedAt: null,
    deletedAt: null,
    version: 1,
    target: { scope: "artifact" },
    replyTo: extra.replyTo ? asArtifactCommentId(extra.replyTo) : null,
    resolvedAt: extra.resolved ? at(minute) : null,
    resolvedBy: extra.resolved ? ANA : null,
  };
}

// r1: open, collapsed; its root seen (one line), its reply x1 new (after the divider, in full).
// r2: open, one comment. r3: resolved and seen, folded under "Resolved (1)", collapsed (both on one line).
// Last updated: r1 (x1 at :06), r2 (:03); then r3. Page order (oldest first, all on the whole Artifact): r2, r1; then r3.
const COMMENTS = [
  comment("r3", 1, ANA, "Fix the logo spacing", { resolved: true }),
  comment("x3", 2, BOHDAN, "done", { replyTo: "r3" }),
  comment("r2", 3, BOHDAN, "Colours look great"),
  comment("r1", 4, ANA, "The header is too tall"),
  comment("x1", 6, BOHDAN, "agreed, shrink it", { replyTo: "r1" }),
];

function setComments(patch: Record<string, unknown>) {
  comments.current = { ...comments.current, ...patch };
  for (const listener of comments.listeners) listener();
}

function renderPanel() {
  comments.current = {
    data: { card: { id: "artifact-1", version: 1 }, files: [], capabilities: { comment: false, delete: false } },
    viewer: { type: "user", id: "me" },
    comments: COMMENTS,
    failed: false,
    hasEarlier: false,
    loadingEarlier: false,
    earlierFailed: false,
    loadEarlier: () => {},
    reload: () => {},
    reviewShown: null,
    shownReview: null,
    reviewFilter: null,
    showAllComments: () => {},
    landedOn: null,
    activeThreadId: null,
    setActiveThreadId: (id: string | null) => setComments({ activeThreadId: id }),
    threadFromFrame: null,
    sentId: null,
    // Read through :05 when the list opened: x1 (:06, Bohdan's) is new.
    readMark: { through: at(5), from: null },
    markPlaces: () => null,
    placesKnown: false,
    replaced: () => {},
    added: () => {},
    removed: () => {},
  };
  render(
    <TestIntlProvider>
      <ArtifactCommentsPanel onClose={() => {}} />
    </TestIntlProvider>,
  );
}

const field = () => screen.getByTestId("artifact-comments-search-input") as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const shown = () => screen.queryAllByTestId("artifact-comment-thread").map((card) => card.getAttribute("data-thread-id"));
const card = (id: string) => {
  const found = screen.queryAllByTestId("artifact-comment-thread").find((el) => el.getAttribute("data-thread-id") === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};
const expanded = (id: string) => card(id).getAttribute("data-expanded") === "true";
const inFull = (id: string, commentId: string) => card(id).querySelector(`[data-testid='artifact-comment'][data-comment-id='${commentId}']`) !== null;
const marks = (id: string) => [...card(id).querySelectorAll("mark")].map((mark) => mark.textContent);
const resolvedToggle = () => screen.queryByTestId("artifact-comments-resolved-toggle");
const resolvedOpen = () => resolvedToggle()?.getAttribute("aria-expanded");

describe("the comment list's search", () => {
  beforeEach(() => {
    window.localStorage.removeItem(SORT_KEY);
  });
  afterEach(() => {
    cleanup();
    comments.current = null;
    window.localStorage.removeItem(SORT_KEY);
  });

  it("shows only the threads it finds, by their text or an author's name, words marked", () => {
    renderPanel();
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.equal(resolvedToggle()?.getAttribute("aria-expanded"), "false");

    type("COLOURS");
    assert.deepEqual(shown(), ["r2"]);
    assert.ok(resolvedToggle() === null, "no resolved thread matches: no Resolved section");
    assert.deepEqual(marks("r2"), ["Colours"]);

    // A name: Bohdan wrote r2, the reply x1 of r1 and the reply x3 of the resolved r3.
    type("bohdan");
    assert.deepEqual(shown(), ["r1", "r2", "r3"]);
    assert.ok(marks("r1").includes("Bohdan"), "the name is marked");
  });

  it("marks only the comments that match every word", () => {
    renderPanel();
    // x1 ("agreed, shrink it") has both words; r1's root ("The header is too tall") has a "t" but not "shrink".
    type("t shrink");
    assert.deepEqual(shown(), ["r1"]);
    assert.deepEqual(marks("r1"), ["shrink", "t"]);
  });

  it("opens the Resolved section for a resolved thread that matches, and a collapsed one to show a match on a one-line comment", () => {
    renderPanel();
    assert.ok(screen.queryByTestId("artifact-comments-resolved") !== null);
    type("logo");
    assert.deepEqual(shown(), ["r3"]);
    assert.equal(resolvedToggle()?.getAttribute("aria-expanded"), "true");
    assert.ok(expanded("r3"), "r3's root was on one line: the thread opens");
    assert.ok(inFull("r3", "r3"));
    assert.deepEqual(marks("r3"), ["logo"]);

    // The reader folds the section while searching; it opens again for other words.
    fireEvent.click(resolvedToggle()!);
    assert.equal(resolvedToggle()?.getAttribute("aria-expanded"), "false");
    type("done");
    assert.equal(resolvedToggle()?.getAttribute("aria-expanded"), "true");
  });

  it("opens a collapsed thread without reading it, and folds it back as it was when the words go", () => {
    renderPanel();
    // Collapsed: the root on one line, the new reply after the divider in full.
    assert.equal(expanded("r1"), false);
    assert.equal(inFull("r1", "r1"), false);
    assert.ok(inFull("r1", "x1"));
    assert.ok(within(card("r1")).queryByTestId("artifact-comment-new-divider") !== null);

    // A match already in full (the new reply) opens nothing.
    type("shrink");
    assert.equal(expanded("r1"), false);
    assert.deepEqual(marks("r1"), ["shrink"]);

    // A match on the one-line root opens it; the reply is still new, after its divider.
    type("header");
    assert.ok(expanded("r1"));
    assert.ok(inFull("r1", "r1"));
    assert.deepEqual(marks("r1"), ["header"]);
    assert.ok(within(card("r1")).queryByTestId("artifact-comment-new-divider") !== null, "still new: searching isn't reading");

    // Collapse folds it back for this search.
    fireEvent.click(within(card("r1")).getByTestId("artifact-comment-thread-collapse"));
    assert.equal(expanded("r1"), false);

    type("");
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.equal(expanded("r1"), false);
    assert.ok(within(card("r1")).queryByTestId("artifact-comment-new-divider") !== null, "the reply is still new");
    assert.deepEqual(marks("r1"), []);
  });

  it("clears on Esc, the list as it was and the focus still in the field; the next Esc is the panel's", () => {
    renderPanel();
    const input = field();
    act(() => input.focus());
    type("logo");
    assert.deepEqual(shown(), ["r3"]);

    const first = fireEvent.keyDown(input, { key: "Escape" });
    assert.equal(first, false, "the field took the first Esc");
    assert.equal(input.value, "");
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.equal(resolvedToggle()?.getAttribute("aria-expanded"), "false", "the Resolved section folded again, as it was");
    assert.ok(document.activeElement === input, "the focus stays in the field");

    const second = fireEvent.keyDown(input, { key: "Escape" });
    assert.equal(second, true, "with no words, Esc goes on to the panel");
  });

  it("clears on an Esc from a result card too, the focus to the field; the next Esc is the panel's", () => {
    renderPanel();
    type("colours");
    assert.deepEqual(shown(), ["r2"]);
    const first = fireEvent.keyDown(card("r2"), { key: "Escape" });
    assert.equal(first, false, "the list took it for the search");
    assert.equal(field().value, "");
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.ok(document.activeElement === field(), "the focus went to the field");
    assert.equal(fireEvent.keyDown(field(), { key: "Escape" }), true, "the next Esc is the panel's");
  });

  it("starts afresh when the words change, even back to the same ones", () => {
    renderPanel();
    type("logo");
    fireEvent.click(resolvedToggle()!);
    assert.equal(resolvedOpen(), "false");
    type("logox");
    type("logo");
    assert.equal(resolvedOpen(), "true", "the fold went with the words");

    fireEvent.click(resolvedToggle()!);
    assert.equal(resolvedOpen(), "false");
    fireEvent.keyDown(field(), { key: "Escape" });
    type("logo");
    assert.equal(resolvedOpen(), "true", "and after Esc");
  });

  it("leaves the list's own Resolved fold alone when a resolved result is picked", () => {
    renderPanel();
    type("logo");
    fireEvent.click(card("r3"));
    assert.equal(comments.current?.activeThreadId, "r3");
    act(() => field().focus());
    fireEvent.keyDown(field(), { key: "Escape" });
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.equal(resolvedOpen(), "false", "folded, as it was before the search");
  });

  it("ends the search when a thread it doesn't show is picked (a marker in the page)", () => {
    renderPanel();
    type("logo");
    assert.deepEqual(shown(), ["r3"]);
    act(() => setComments({ activeThreadId: asArtifactCommentId("r1") }));
    assert.equal(field().value, "");
    assert.deepEqual(shown(), ["r1", "r2"]);
  });

  it("clears with the ×, as the first Esc", () => {
    renderPanel();
    type("colours");
    assert.deepEqual(shown(), ["r2"]);
    fireEvent.click(screen.getByTestId("artifact-comments-search-clear"));
    assert.equal(field().value, "");
    assert.deepEqual(shown(), ["r1", "r2"]);
    assert.ok(document.activeElement === field(), "the focus is in the field");
    assert.ok(screen.queryByTestId("artifact-comments-search-clear") === null, "no × without words");
  });

  it("says when nothing matches, in a live region kept while the field is", () => {
    renderPanel();
    type("colours");
    const status = screen.getByTestId("artifact-comments-search-empty");
    assert.equal(status.getAttribute("role"), "status");
    assert.equal(status.textContent, "");
    type("nowhere");
    assert.deepEqual(shown(), []);
    assert.ok(screen.getByTestId("artifact-comments-search-empty") === status, "the same region, its words changed");
    assert.equal(status.textContent, "No comments match");
    assert.ok(screen.queryByTestId("artifact-comments-empty") === null, "not the list's own empty state");
  });

  it("lists what it finds in the current sort", () => {
    window.localStorage.setItem(SORT_KEY, "page");
    renderPanel();
    type("bohdan");
    assert.deepEqual(shown(), ["r2", "r1", "r3"]);
  });
});
