// Undo and redo of draft changes (artifactDraftHistory) with comment images (#proj-workspace:#146):
// a draft with images is never recorded (made, edited or deleted): deleting it lets its uploads go,
// so no step may undo or redo into a draft without them. Drafts without images keep their steps,
// as before the web could attach images.
import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { asArtifactCommentDraftId, asObjectFileId } from "@botiverse/raft-shared";
import type { ArtifactCommentDraft, ArtifactCommentImage } from "@botiverse/raft-shared";

import { useDraftHistory } from "../src/apps/artifacts/artifactDraftHistory";
import type { DraftWrites } from "../src/apps/artifacts/artifactDraftHistory";

const IMAGE: ArtifactCommentImage = { fileId: asObjectFileId("0b8f8a52-1c1e-4c1f-9d36-2f6a1b0c9e11"), contentType: "image/png", sizeBytes: 120, width: 64, height: 40 };

function draft(id: string, text: string, images?: ArtifactCommentImage[]): ArtifactCommentDraft {
  return {
    id: asArtifactCommentDraftId(id),
    version: 1,
    target: { scope: "artifact" },
    body: [{ type: "text", text }],
    replyTo: null,
    ...(images ? { images } : {}),
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    expiresAt: "2026-12-04T10:00:00.000Z",
  };
}

function setup() {
  const calls: string[] = [];
  const writes: DraftWrites = {
    create: async (made) => {
      calls.push(`create:${made.body.map((p) => (p.type === "text" ? p.text : "")).join("")}:${made.images?.length ?? 0}`);
      return draft("again", "again");
    },
    edit: async (id) => { calls.push(`edit:${id}`); },
    remove: async (id) => { calls.push(`remove:${id}`); },
  };
  const failed = vi.fn();
  const { result } = renderHook(() => useDraftHistory(writes, failed));
  return { result, calls, failed };
}

test("a draft with images: its making, edit and deletion are not recorded; nothing to undo", async () => {
  const { result, calls } = setup();
  const withImages = draft("d1", "look", [IMAGE]);
  act(() => result.current.created(withImages));
  act(() => result.current.edited(withImages, { ...withImages, body: [{ type: "text", text: "look here" }] }));
  act(() => result.current.deleted(withImages));
  assert.equal(result.current.canUndo, false);
  assert.equal(result.current.canRedo, false);
  let moved = true;
  await act(async () => { moved = await result.current.undo(); });
  assert.equal(moved, false);
  assert.deepEqual(calls, [], "no write replayed");
});

test("drafts without images keep their steps beside one with images (no regression)", async () => {
  const { result, calls } = setup();
  const plain = draft("d2", "plain");
  act(() => result.current.created(plain));
  act(() => result.current.created(draft("d3", "pic", [IMAGE])));
  assert.equal(result.current.canUndo, true);
  await act(async () => { await result.current.undo(); });
  assert.deepEqual(calls, ["remove:d2"], "the undo is the plain draft's, never the one with images");
  assert.equal(result.current.canUndo, false);
  await act(async () => { await result.current.redo(); });
  assert.deepEqual(calls, ["remove:d2", "create:plain:0"], "made again as it was, with no images");
});
