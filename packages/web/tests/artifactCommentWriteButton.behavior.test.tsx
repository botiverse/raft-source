// artin (#proj-workspace:#323): on a Markdown Artifact the header's Comment button only changed colour.
// Comment mode adds nothing where the page has no block to pick (Markdown, a PDF, a file Raft draws: their
// text is selected to comment either way), so there the button opens the comment list's box for a comment
// on the whole Artifact (artifactListCompose `writeInList`, via `useCommentWritesOnArtifact`).
// On an HTML page, and while comment mode or a refused send's review is on, it stays the comment-mode toggle.
// The one-line head (M3): on such a page it is one Comments button (the comment icon, the count, no ▾: Show All
// would be the same press), pressed while the list is open; on an HTML page the split button, its main half drawn
// with the drafts bar's Pick Element icon, its ▾ (the count, Show All, Doesn't display well here) as before.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { ArtifactListComposeContext } from "../src/apps/artifacts/artifactListCompose";
import type { ArtifactListComposeState } from "../src/apps/artifacts/artifactListCompose";
import { ArtifactShownFileContext, useShownPicksElements } from "../src/apps/artifacts/artifactShownFile";
import type { ArtifactReviewStatus } from "../src/apps/artifacts/ArtifactReviewContext";

const review = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const comments = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("../src/apps/artifacts/ArtifactReviewContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/apps/artifacts/ArtifactReviewContext")>()),
  useArtifactReview: () => review.current,
}));
vi.mock("../src/apps/artifacts/ArtifactCommentsContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/apps/artifacts/ArtifactCommentsContext")>()),
  useArtifactComments: () => comments.current,
}));

const { ArtifactReviewHeaderActions } = await import("../src/apps/artifacts/ArtifactReviewParts");

function reviewIn(status: ArtifactReviewStatus, calls: string[]) {
  return {
    canComment: true,
    status,
    toggleFocus: 0,
    draftsFailed: false,
    reloadDrafts: () => {},
    enterCommenting: () => calls.push("enter"),
    done: () => calls.push("done"),
  };
}

function renderHeader(status: ArtifactReviewStatus, kind: "html" | "markdown", { panelOpen = false } = {}) {
  const calls: string[] = [];
  review.current = reviewIn(status, calls);
  const path = kind === "html" ? "index.html" : "doc.md";
  comments.current = {
    data: { card: { kind, commentCount: 0 }, files: [{ path, kind, entry: true }] },
    comments: [],
    hasEarlier: false,
    panelOpen,
    setPanelOpen: (open: boolean) => calls.push(`setPanelOpen:${open}`),
  };
  const compose: ArtifactListComposeState = {
    compose: null,
    composeInList: () => calls.push("composeInList"),
    writeInList: () => calls.push("writeInList"),
  };
  render(
    <TestIntlProvider>
      <ArtifactListComposeContext.Provider value={compose}>
        <ArtifactReviewHeaderActions />
      </ArtifactListComposeContext.Provider>
    </TestIntlProvider>,
  );
  return calls;
}

describe("the header's Comment button", () => {
  afterEach(() => {
    cleanup();
    review.current = null;
    comments.current = null;
  });

  it("opens the comment list's box on a Markdown page, which has no block to pick", () => {
    const calls = renderHeader("browsing", "markdown");
    assert.ok(screen.queryByTestId("artifact-review-toggle") === null, "no comment-mode toggle");
    assert.ok(screen.queryByTestId("artifact-review-comment-menu") === null, "one Comments button: no ▾");
    const button = screen.getByTestId("artifact-review-write");
    assert.equal(button.getAttribute("aria-pressed"), "false", "pressed only while the list is open");
    fireEvent.click(button);
    assert.deepEqual(calls, ["writeInList"]);
  });

  it("closes the list again on a Markdown page, pressed while it is open", () => {
    const calls = renderHeader("browsing", "markdown", { panelOpen: true });
    const button = screen.getByTestId("artifact-review-write");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    fireEvent.click(button);
    assert.deepEqual(calls, ["setPanelOpen:false"]);
  });

  it("stays the comment-mode split button on an HTML page, its ▾ beside it", () => {
    const calls = renderHeader("browsing", "html");
    assert.ok(screen.queryByTestId("artifact-review-write") === null, "no write button");
    assert.ok(screen.queryByTestId("artifact-review-comment-menu") !== null, "the ▾ with the count and Show All");
    fireEvent.click(screen.getByTestId("artifact-review-toggle"));
    assert.deepEqual(calls, ["enter"]);
  });

  it("stays the toggle while comment mode is on, so it can be left", () => {
    const calls = renderHeader("commenting", "markdown");
    const toggle = screen.getByTestId("artifact-review-toggle");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    fireEvent.click(toggle);
    assert.deepEqual(calls, ["done"]);
  });
});

describe("useShownPicksElements", () => {
  type Data = Pick<ArtifactViewerData, "card" | "files">;
  const data = (kind: string, files: { path: string; kind: string; entry?: boolean }[]) =>
    ({ card: { kind }, files }) as unknown as Data;
  const picks = (d: Data, path: string | null) => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ArtifactShownFileContext.Provider value={{ path, show: () => {} }}>{children}</ArtifactShownFileContext.Provider>
    );
    return renderHook(() => useShownPicksElements(d), { wrapper }).result.current;
  };

  it("is true for an HTML Artifact's entry page and another HTML page of it", () => {
    const set = data("html", [{ path: "index.html", kind: "html", entry: true }, { path: "b.html", kind: "html" }, { path: "notes.md", kind: "markdown" }]);
    assert.equal(picks(set, null), true);
    assert.equal(picks(set, "b.html"), true);
  });

  it("is false for Markdown and PDF, also a Markdown file of an HTML set", () => {
    const set = data("html", [{ path: "index.html", kind: "html", entry: true }, { path: "notes.md", kind: "markdown" }]);
    assert.equal(picks(set, "notes.md"), false);
    assert.equal(picks(data("markdown", [{ path: "a.md", kind: "markdown", entry: true }]), null), false);
    assert.equal(picks(data("pdf", [{ path: "a.pdf", kind: "pdf", entry: true }]), null), false);
  });
});
