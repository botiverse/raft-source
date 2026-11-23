/**
 * A message's Artifact card keeps its picture's place from the start (#proj-uiux:#1311):
 * a publisher cover holds a box while it is read and when it can't be read,
 * so the conversation doesn't move when it arrives or fails.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, test } from "vitest";
import { ArtifactFileReaderContext } from "../src/apps/artifacts/artifactSource";
import type { ArtifactFileReader } from "../src/apps/artifacts/artifactSource";
import { useArtifactCardPicture } from "../src/apps/artifacts/artifactCardPicture";

afterEach(cleanup);

let urlSeq = 0;
URL.createObjectURL = () => `blob:test-${++urlSeq}`;
URL.revokeObjectURL = () => {};

function coverCard(id: string, path = "cover.png") {
  return { id, version: 1, title: "T", preview: { kind: "image", path } } as never;
}

function withReader(readBytes: ArtifactFileReader["readBytes"]) {
  const reader = { readBytes, readText: async () => "" } as ArtifactFileReader;
  return ({ children }: { children: ReactNode }) => <ArtifactFileReaderContext value={reader}>{children}</ArtifactFileReaderContext>;
}

test("a cover holds its place while it is read, then shows", async () => {
  let resolve!: (b: Blob) => void;
  const wrapper = withReader(() => new Promise<Blob>((r) => { resolve = r; }));
  const { result } = renderHook(() => useArtifactCardPicture(coverCard("a-loading"))[0], { wrapper });
  assert.deepEqual(result.current, { src: null, screenshot: false, loading: true });
  await act(async () => { resolve(new Blob(["x"], { type: "image/png" })); });
  assert.equal(result.current?.screenshot, false);
  assert.match(result.current?.src ?? "", /^blob:test-/);
});

test("a cover that can't be read keeps its place", async () => {
  const wrapper = withReader(() => Promise.reject(new Error("404")));
  const { result } = renderHook(() => useArtifactCardPicture(coverCard("a-failed"))[0], { wrapper });
  await act(async () => {});
  assert.deepEqual(result.current, { src: null, screenshot: false, unreadable: true });
});

test("a cover of a type never shown inline keeps its place too", () => {
  const wrapper = withReader(() => Promise.reject(new Error("unused")));
  const { result } = renderHook(() => useArtifactCardPicture(coverCard("a-pdf", "cover.pdf"))[0], { wrapper });
  assert.deepEqual(result.current, { src: null, screenshot: false, unreadable: true });
});

test("a card with no picture holds no place", () => {
  const wrapper = withReader(() => Promise.reject(new Error("unused")));
  const card = { id: "a-none", version: 1, title: "T", preview: { kind: "none" } } as never;
  const { result } = renderHook(() => useArtifactCardPicture(card)[0], { wrapper });
  assert.equal(result.current, null);
});
