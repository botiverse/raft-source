// The artifactList contract's search additions (S9): `query` on the request,
// `matches` on each listed Artifact. Additive: a list without query, and an
// answer without matches, parse exactly as before. Comment images (#146):
// `images` on a comment's request and answer, `imageCount` on an excerpt,
// all optional, so what older clients send and older Servers answer parses
// as before.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_API_ARTIFACT_SEARCH_MATCHES_MAX,
  AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS,
  agentApiArtifactCommentBodySchema,
  agentApiArtifactCommentExcerptSchema,
  agentApiArtifactCommentImageSchema,
  agentApiArtifactCommentSchema,
  agentApiArtifactListQuerySchema,
  agentApiArtifactListResponseSchema,
  agentApiArtifactReviewCommentSchema,
  agentApiAssistantOwnerArtifactResponseSchema,
} from "./agentApiArtifactsContract";

const summary = {
  id: "pt_abc",
  url: "https://app.raft.build/artifacts/pt_abc",
  name: "migration-plan",
  title: "🚀 迁移计划",
  description: null,
  kind: "html",
  home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } },
  currentVersion: 3,
  author: { type: "agent", name: "remy" },
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
};

test("query: optional, trimmed, non-empty, at most the limit in code points", () => {
  assert.deepEqual(agentApiArtifactListQuerySchema.parse({ target: "#proj-workspace", query: "  迁移 ", limit: "1" }), { target: "#proj-workspace", query: "迁移", limit: "1" });
  assert.deepEqual(agentApiArtifactListQuerySchema.parse({}), {});
  assert.equal(agentApiArtifactListQuerySchema.safeParse({ query: "   " }).success, false);
  // Emoji are two UTF-16 units each; the limit counts code points.
  assert.equal(agentApiArtifactListQuerySchema.safeParse({ query: "🚀".repeat(AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS) }).success, true);
  const tooLong = agentApiArtifactListQuerySchema.safeParse({ query: "🚀".repeat(AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS + 1) });
  assert.equal(tooLong.success, false);
  assert.deepEqual(tooLong.error?.issues.map((issue) => issue.message), ["query is longer than 200 characters: use fewer words"]);
});

test("matches: field, optional path, snippet and highlights; at most three; absent without query", () => {
  const matches = [
    { field: "title", snippet: "🚀 迁移计划", highlights: [{ start: 2, length: 2 }] },
    { field: "content", path: "docs/plan.md", snippet: "先备份，再迁移。", highlights: [{ start: 5, length: 2 }] },
    { field: "path", path: "docs/迁移.md", snippet: "docs/迁移.md", highlights: [{ start: 5, length: 2 }] },
  ];
  const parsed = agentApiArtifactListResponseSchema.parse({ artifacts: [{ ...summary, matches }], nextCursor: "abc", target: null });
  assert.deepEqual(parsed.artifacts[0]!.matches, matches);
  // The shape older clients read is unchanged.
  assert.deepEqual(agentApiArtifactListResponseSchema.parse({ artifacts: [summary], nextCursor: null, target: null }).artifacts[0], summary);

  assert.equal(AGENT_API_ARTIFACT_SEARCH_MATCHES_MAX, 3);
  const tooMany = [...matches, matches[0]];
  assert.equal(agentApiArtifactListResponseSchema.safeParse({ artifacts: [{ ...summary, matches: tooMany }], nextCursor: null, target: null }).success, false);
  for (const bad of [
    { field: "comment", snippet: "x", highlights: [] },
    { field: "title", snippet: "x", highlights: [{ start: -1, length: 1 }] },
    { field: "title", snippet: "x", highlights: [{ start: 0, length: 0 }] },
  ]) {
    assert.equal(agentApiArtifactListResponseSchema.safeParse({ artifacts: [{ ...summary, matches: [bad] }], nextCursor: null, target: null }).success, false, JSON.stringify(bad));
  }
});

const image = { fileId: "0b8f8a52-1c1e-4c1f-9d36-2f6a1b0c9e11", contentType: "image/png", sizeBytes: 48213, width: 1280, height: 720 };

test("comment images on the request: up to four ids, a comment of images alone has no body; older requests parse as before", () => {
  assert.deepEqual(agentApiArtifactCommentBodySchema.parse({ body: " text " }), { body: "text" }, "an older client's comment");
  assert.deepEqual(agentApiArtifactCommentBodySchema.parse({ images: [image.fileId] }), { images: [image.fileId] }, "images alone (the Server checks text-or-image)");
  assert.equal(agentApiArtifactCommentBodySchema.safeParse({ body: "x", images: ["a", "b", "c", "d", "e"] }).success, false, "more than four");
  assert.equal(agentApiArtifactCommentBodySchema.safeParse({ body: "x", images: [""] }).success, false);
  assert.deepEqual(agentApiArtifactReviewCommentSchema.parse({ path: "a.html", images: [image.fileId] }), { path: "a.html", images: [image.fileId] });
});

test("comment images on the answer: what the Server kept, optional on a comment and as a count on an excerpt; never SVG", () => {
  const comment = { id: "c_1", author: { type: "agent", name: "remy" }, version: 1, path: null, anchor: null, replyTo: null, body: "", createdAt: "2026-10-22T11:00:00.000Z", editedAt: null };
  assert.deepEqual(agentApiArtifactCommentSchema.parse(comment), comment, "an older Server's comment");
  assert.deepEqual(agentApiArtifactCommentSchema.parse({ ...comment, images: [image] }).images, [image]);
  assert.equal(agentApiArtifactCommentImageSchema.safeParse({ ...image, contentType: "image/svg+xml" }).success, false);
  assert.equal(agentApiArtifactCommentImageSchema.safeParse({ ...image, width: 0 }).success, false);
  const excerpt = { id: "c_1", author: { type: "user", name: "xxchan" }, version: 1, path: null, createdAt: "2026-10-22T11:00:00.000Z", excerpt: "", truncated: false, bodyChars: 0 };
  assert.equal(agentApiArtifactCommentExcerptSchema.parse(excerpt).imageCount, undefined);
  assert.equal(agentApiArtifactCommentExcerptSchema.parse({ ...excerpt, imageCount: 2 }).imageCount, 2);
  assert.equal(agentApiArtifactCommentExcerptSchema.safeParse({ ...excerpt, imageCount: 0 }).success, false);
});

test("owner-artifact read: a Server before comment paging (#14633) sends no olderCursor or newestPosition, and that still parses", () => {
  const issuesAt = (comments: Record<string, unknown>) => {
    const parsed = agentApiAssistantOwnerArtifactResponseSchema.safeParse({ comments });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")).filter((path) => path.startsWith("comments."));
  };
  assert.deepEqual(issuesAt({ items: [] }), []);
  assert.deepEqual(issuesAt({ items: [], olderCursor: null, newestPosition: 3 }), []);
  assert.deepEqual(issuesAt({ items: [], newestPosition: "3" }), ["comments.newestPosition"]);
});
