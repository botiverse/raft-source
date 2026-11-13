import assert from "node:assert/strict";
import { test } from "vitest";
import { asChannelId } from "./brandedIds";
import { ARTIFACT_FRAMED_KINDS, ARTIFACT_INLINE_IMAGE_TYPES, asArtifactCommentDraftId, asArtifactCommentId, asArtifactId, asArtifactReviewId, isArtifactFramedKind } from "./workspaceArtifacts";
import { AGENT_API_ARTIFACT_MAX_COMMENT_IMAGE_BYTES, AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES } from "./agentApiArtifactsContract";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_COMMENT_IMAGE_TYPES,
  ARTIFACT_COMMENT_MAX_IMAGES,
  ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS,
  ARTIFACT_DASHBOARD_ALL_DIRS,
  ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT,
  ARTIFACT_DASHBOARD_ALL_SORTS,
  ARTIFACT_DASHBOARD_AUTHORS_LIMIT,
  ARTIFACT_DASHBOARD_AUTHORS_MAX,
  ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT,
  ARTIFACT_DASHBOARD_HOMES,
  ARTIFACT_DASHBOARD_SECTIONS,
  ARTIFACT_FRAME_SANDBOX,
  ARTIFACT_WEB_ERROR_CODES,
  artifactWebPaths,
  type ArtifactReviewRejected,
  type ArtifactReviewSubmitted,
} from "./webArtifactsContract";

const id = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");

test("web Artifact paths encode the path as one segment and add the version only when given", () => {
  assert.equal(artifactWebPaths.viewer(id), `/api/artifacts/${id}`);
  assert.equal(artifactWebPaths.viewer(id, 3), `/api/artifacts/${id}?version=3`);
  assert.equal(artifactWebPaths.details(id), `/api/artifacts/${id}/details`);
  assert.equal(artifactWebPaths.details(id, 3), `/api/artifacts/${id}/details?version=3`);
  assert.equal(artifactWebPaths.file(id, "assets/logo.png", 2), `/api/artifacts/${id}/files/assets%2Flogo.png?version=2`);
  assert.equal(artifactWebPaths.fileContent(id, "data.csv"), `/api/artifacts/${id}/files/data.csv/content`);
  assert.equal(artifactWebPaths.comment(id, asArtifactCommentId("c_1")), `/api/artifacts/${id}/comments/c_1`);
});

test("query options are encoded and left out when absent", () => {
  assert.equal(artifactWebPaths.comments(id), `/api/artifacts/${id}/comments`);
  assert.equal(artifactWebPaths.comments(id, { path: "a b/c.html", before: "12" }), `/api/artifacts/${id}/comments?path=a%20b%2Fc.html&before=12`);
  assert.equal(artifactWebPaths.willNotify(id, { replyTo: asArtifactCommentId("c_9") }), `/api/artifacts/${id}/will-notify?replyTo=c_9`);
  assert.equal(artifactWebPaths.mentionCandidates(id, { q: "ki&rby" }), `/api/artifacts/${id}/mention-candidates?q=ki%26rby`);
  assert.equal(artifactWebPaths.mentionCandidates(id, {}), `/api/artifacts/${id}/mention-candidates`);
});

test("S5 paths: save an attachment, the share audience for a conversation, share; the home route and its narrowing preview", () => {
  assert.equal(artifactWebPaths.saveAttachment(), "/api/artifacts/save-attachment");
  assert.equal(artifactWebPaths.shareAudience(id, { conversationId: asChannelId("c-1") }), `/api/artifacts/${id}/share-audience?conversationId=c-1`);
  assert.equal(artifactWebPaths.share(id), `/api/artifacts/${id}/share`);
  assert.equal(artifactWebPaths.home(id), `/api/artifacts/${id}/home`);
  assert.equal(artifactWebPaths.homeChange(id, { to: "server" }), `/api/artifacts/${id}/home-change?to=server`);
  assert.equal(artifactWebPaths.homeChange(id, { to: "conversation", conversationId: asChannelId("c-1") }), `/api/artifacts/${id}/home-change?to=conversation&conversationId=c-1`);
  assert.equal(
    artifactWebPaths.attachmentSaves(["3c10b4ed-d947-49df-9031-91ae837f010a", "a1"]),
    "/api/artifacts/attachment-saves?attachmentIds=3c10b4ed-d947-49df-9031-91ae837f010a%2Ca1",
  );
});

test("locate: where the canonical link opens, one segment", () => {
  assert.equal(artifactWebPaths.locate(id), `/api/artifacts/${id}/locate`);
  assert.equal(artifactWebPaths.locate(asArtifactId("pt_a/b")), "/api/artifacts/pt_a%2Fb/locate");
});

test("S2: the frame path, and which kinds are framed", () => {
  assert.equal(artifactWebPaths.frame(id), `/api/artifacts/${id}/frame`);
  assert.deepEqual([...ARTIFACT_FRAMED_KINDS], ["html", "markdown", "pdf"]);
  assert.ok(isArtifactFramedKind("markdown"));
  for (const kind of ["text", "csv", "image", "video", "other"] as const) assert.ok(!isArtifactFramedKind(kind), kind);
});

test("dashboard (S7): the first pages, and one section's next page; `home` and `cursor` only when given", () => {
  assert.equal(artifactWebPaths.dashboard(), "/api/artifacts/dashboard");
  assert.equal(artifactWebPaths.dashboard({ home: "dm" }), "/api/artifacts/dashboard?home=dm");
  assert.equal(artifactWebPaths.dashboardSection("waiting"), "/api/artifacts/dashboard/waiting");
  assert.equal(artifactWebPaths.dashboardSection("recent", { home: "channel", cursor: "a+b" }), "/api/artifacts/dashboard/recent?home=channel&cursor=a%2Bb");
  assert.deepEqual([...ARTIFACT_DASHBOARD_SECTIONS], ["waiting", "following", "recent"]);
  assert.deepEqual([...ARTIFACT_DASHBOARD_HOMES], ["channel", "dm", "server", "public"]);
});

test("the All tab: one path beside the sections' (no section is named all); `home`, `q` and `cursor` only when given", () => {
  assert.equal(artifactWebPaths.dashboardAll(), "/api/artifacts/dashboard/all");
  assert.equal(artifactWebPaths.dashboardAll({ home: "public", q: "Q3 plan & more", cursor: "a+b" }), "/api/artifacts/dashboard/all?home=public&q=Q3%20plan%20%26%20more&cursor=a%2Bb");
  assert.ok(!(ARTIFACT_DASHBOARD_SECTIONS as readonly string[]).includes("all"));
  assert.equal(ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT, 50);
});

test("the All tab's order: `sort` and `dir` only when given, beside the filters and the cursor; the sorts, directions and each sort's default direction", () => {
  assert.equal(artifactWebPaths.dashboardAll({ sort: "title" }), "/api/artifacts/dashboard/all?sort=title");
  assert.equal(artifactWebPaths.dashboardAll({ sort: "comments", dir: "asc" }), "/api/artifacts/dashboard/all?sort=comments&dir=asc");
  assert.equal(artifactWebPaths.dashboardAll({ dir: "asc" }), "/api/artifacts/dashboard/all?dir=asc");
  assert.equal(
    artifactWebPaths.dashboardAll({ home: "dm", author: ["me"], q: "plan", sort: "updated", dir: "desc", cursor: "a+b" }),
    "/api/artifacts/dashboard/all?home=dm&author=me&q=plan&sort=updated&dir=desc&cursor=a%2Bb",
  );
  assert.equal(artifactWebPaths.dashboardAll({ sort: "opened" }), "/api/artifacts/dashboard/all?sort=opened");
  assert.equal(artifactWebPaths.dashboardAll({ sort: "opened", relevant: true, cursor: "a+b" }), "/api/artifacts/dashboard/all?sort=opened&cursor=a%2Bb&relevant=1");
  assert.equal(artifactWebPaths.dashboardAll({ relevant: false }), "/api/artifacts/dashboard/all");
  assert.deepEqual([...ARTIFACT_DASHBOARD_ALL_SORTS], ["updated", "title", "comments", "opened"]);
  assert.deepEqual([...ARTIFACT_DASHBOARD_ALL_DIRS], ["asc", "desc"]);
  assert.deepEqual(ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS, { updated: "desc", title: "asc", comments: "desc", opened: "desc" });
});

test("the `author` filter: its key once per value on the sections, the first pages and the All tab, none when empty; the authors' path beside them (no section is named authors)", () => {
  const user = "user:3c10b4ed-d947-49df-9031-91ae837f010a";
  assert.equal(artifactWebPaths.dashboard({ author: ["me", "my-agents"] }), "/api/artifacts/dashboard?author=me&author=my-agents");
  assert.equal(artifactWebPaths.dashboard({ author: [] }), "/api/artifacts/dashboard");
  assert.equal(
    artifactWebPaths.dashboardSection("following", { home: "dm", author: [user], cursor: "a+b" }),
    `/api/artifacts/dashboard/following?home=dm&author=${encodeURIComponent(user)}&cursor=a%2Bb`,
  );
  assert.equal(artifactWebPaths.dashboardAll({ author: ["me"], q: "plan" }), "/api/artifacts/dashboard/all?author=me&q=plan");
  assert.equal(artifactWebPaths.dashboardAuthors(), "/api/artifacts/dashboard/authors");
  assert.equal(artifactWebPaths.dashboardAuthors({ q: "Ann & co" }), "/api/artifacts/dashboard/authors?q=Ann%20%26%20co");
  assert.ok(!(ARTIFACT_DASHBOARD_SECTIONS as readonly string[]).includes("authors"));
  assert.ok(!(ARTIFACT_DASHBOARD_SECTIONS as readonly string[]).includes("conversations"));
  assert.equal(ARTIFACT_DASHBOARD_AUTHORS_MAX, 20);
  assert.equal(ARTIFACT_DASHBOARD_AUTHORS_LIMIT, 50);
});

test("the `conversation` filter: one id on the All tab, with `home` left as it was; the conversations' path beside the authors'", () => {
  const conversation = "3c10b4ed-d947-49df-9031-91ae837f010a";
  assert.equal(artifactWebPaths.dashboardAll({ conversation }), `/api/artifacts/dashboard/all?conversation=${conversation}`);
  assert.equal(artifactWebPaths.dashboardAll({ home: "public" }), "/api/artifacts/dashboard/all?home=public");
  assert.equal(artifactWebPaths.dashboardConversations(), "/api/artifacts/dashboard/conversations");
  assert.equal(artifactWebPaths.dashboardConversations({ q: "#proj x" }), "/api/artifacts/dashboard/conversations?q=%23proj%20x");
  assert.equal(ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT, 50);
});

test("a conversation's Artifacts: the conversation one segment, `cursor` only when given", () => {
  assert.equal(artifactWebPaths.conversationArtifacts(asChannelId("c-1")), "/api/artifacts/conversations/c-1");
  assert.equal(artifactWebPaths.conversationArtifacts(asChannelId("a/b"), { cursor: "a+b" }), "/api/artifacts/conversations/a%2Fb?cursor=a%2Bb");
});

// The frame and every content page's CSP `sandbox` header carry exactly these
// tokens (the Worker pins the same string). Adding allow-popups or
// allow-top-navigation would let a page carry what a reader typed past its
// connect-src; dropping allow-same-origin leaves pages without storage.
test("the content frame's sandbox tokens are pinned", () => {
  assert.equal(ARTIFACT_FRAME_SANDBOX, "allow-scripts allow-same-origin");
});

// SVG is drawn in the shell like png (Tenny, Remy, Kirby; #proj-workspace:4fb9afce):
// bytes from the file route as an `<img src=blob:>`, never inline, never an
// `<object>` or `<embed>`. html, markdown and pdf are the framed kinds.
test("the shell's image types include svg; nothing else active", () => {
  assert.deepEqual([...ARTIFACT_INLINE_IMAGE_TYPES], ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
});

test("batch comments (S8): one review's comments by its branded id; a rejection's details typed by its code", () => {
  const review = asArtifactReviewId("6f1c2d3e-0000-4000-8000-000000000001");
  assert.equal(artifactWebPaths.comments(id, { review }), `/api/artifacts/${id}/comments?review=${review}`);
  // @ts-expect-error: a bare string is not a review id.
  artifactWebPaths.comments(id, { review: "6f1c2d3e-0000-4000-8000-000000000001" });

  // The summary refused: no draft named.
  const summary: ArtifactReviewSubmitted = { status: "rejected", draftId: null, code: "FIELD_TOO_LONG", error: "comment too long", details: { field: "body", limit: 8000 } };
  const draft: ArtifactReviewRejected = { status: "rejected", draftId: asArtifactCommentDraftId("d-1"), code: "FILE_NOT_FOUND", error: "no such file", details: { path: "a.html", version: 2 } };
  const describe = (rejected: ArtifactReviewRejected): string => {
    switch (rejected.code) {
      case "MENTION_NOT_VISIBLE": return rejected.details.actors.map((actor) => actor.id).join(",");
      case "FILE_NOT_FOUND": return `${rejected.details.path}@${rejected.details.version}`;
      case "FIELD_TOO_LONG": return `${rejected.details.field}<=${rejected.details.limit}`;
      case "VERSION_NOT_FOUND": return rejected.details ? `${rejected.details.version}->${rejected.details.currentVersion}` : "no version";
      default: return rejected.code;
    }
  };
  assert.equal(summary.status === "rejected" ? describe(summary) : "", "body<=8000");
  assert.equal(describe(draft), "a.html@2");
  // @ts-expect-error: MENTION_NOT_VISIBLE carries its actors, not any record.
  const loose: ArtifactReviewRejected = { status: "rejected", draftId: null, code: "MENTION_NOT_VISIBLE", error: "x", details: { anything: 1 } };
  // A reply draft whose comment was deleted: no details.
  const reply: ArtifactReviewRejected = { status: "rejected", draftId: asArtifactCommentDraftId("d-2"), code: "COMMENT_NOT_FOUND", error: "no such comment" };
  assert.equal(describe(reply), "COMMENT_NOT_FOUND");
  // @ts-expect-error: COMMENT_NOT_FOUND carries no details.
  const replyDetails: ArtifactReviewRejected = { status: "rejected", draftId: null, code: "COMMENT_NOT_FOUND", error: "x", details: { replyTo: "c_1" } };
  // @ts-expect-error: FORBIDDEN is the route's own 403, never a rejection.
  const forbidden: ArtifactReviewRejected = { status: "rejected", draftId: null, code: "FORBIDDEN", error: "x" };
  void loose;
  void replyDetails;
  void forbidden;
});

test("comment images: the upload path, one segment; the limits shared with the agent API; raster types only, never SVG", () => {
  assert.equal(artifactWebPaths.commentImages(id), `/api/artifacts/${id}/comment-images`);
  assert.equal(ARTIFACT_COMMENT_MAX_IMAGES, 4);
  assert.equal(ARTIFACT_COMMENT_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES, ARTIFACT_COMMENT_MAX_IMAGES);
  assert.equal(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGE_BYTES, ARTIFACT_COMMENT_IMAGE_MAX_BYTES);
  assert.deepEqual([...ARTIFACT_COMMENT_IMAGE_TYPES], ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.ok(ARTIFACT_WEB_ERROR_CODES.includes("IMAGE_NOT_FOUND") && ARTIFACT_WEB_ERROR_CODES.includes("IMAGE_REFUSED"));
});
