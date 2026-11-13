// The API-backed Artifacts source (apiArtifactSource): each method is one
// route of the web API, addressed under the client's `/api` base, and every
// HTTP error comes back as the contract's {status, code, details}.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { afterEach, beforeEach, test } from "vitest";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { asArtifactCommentDraftId, asArtifactId, asChannelId } from "@botiverse/raft-shared";
import type { ArtifactCommentId } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { apiArtifactSource } from "../src/apps/artifacts/apiArtifactSource";

const ID = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");
type Answer = { status: number; data?: unknown; headers?: Record<string, string> };
let requests: Array<{ method: string; url: string; data: unknown; responseType?: string }> = [];
let answer: (config: InternalAxiosRequestConfig) => Answer = () => ({ status: 200, data: {} });
const originalAdapter = api.defaults.adapter;

beforeEach(() => {
  requests = [];
  api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    requests.push({ method: (config.method ?? "get").toUpperCase(), url: config.url ?? "", data: config.data ? JSON.parse(config.data as string) : undefined, responseType: config.responseType });
    const { status, data, headers } = answer(config);
    const response = { status, statusText: String(status), data, headers: headers ?? {}, config, request: {} };
    if (status >= 400) {
      const error = Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response, config });
      throw error;
    }
    return response;
  }) as AxiosAdapter;
});

afterEach(() => {
  api.defaults.adapter = originalAdapter;
});

const card = { id: ID, title: "Report", kind: "html" };

test("the viewer reads its route under the client's /api base; 404 NOT_VISIBLE is the one 'can't open' state", async () => {
  answer = () => ({ status: 200, data: { card } });
  const ok = await apiArtifactSource.viewer({ id: ID, version: 2 });
  assert.equal(ok.status, "ok");
  assert.equal(requests[0].method, "GET");
  assert.ok(requests[0].url.startsWith(`/artifacts/${ID}`) && requests[0].url.includes("version=2"), requests[0].url);
  assert.ok(!requests[0].url.startsWith("/api/"), "no doubled /api");

  answer = () => ({ status: 404, data: { error: "not visible", code: "NOT_VISIBLE" } });
  assert.deepEqual(await apiArtifactSource.viewer({ id: ID, version: null }), { status: "unavailable" });
});

test("a version's summary (its note and changed files) reads the details route, never the viewer's (no ticket, no read position moved)", async () => {
  const versions = [
    { number: 3, note: "Fixed the chart", changedPaths: ["index.html"] },
    { number: 2, note: null, changedPaths: ["data.json"] },
  ];
  answer = () => ({ status: 200, data: { card, versions } });
  assert.deepEqual(await apiArtifactSource.versionSummary!({ id: ID, version: 3 }), versions[0]);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, `/artifacts/${ID}/details?version=3`);
  assert.equal(await apiArtifactSource.versionSummary!({ id: ID, version: 9 }), null, "a version the answer doesn't list");

  answer = () => ({ status: 404, data: { error: "no such version", code: "VERSION_NOT_FOUND" } });
  await assert.rejects(apiArtifactSource.versionSummary!({ id: ID, version: 3 }), (error: unknown) => {
    assert.deepEqual(error, { status: 404, code: "VERSION_NOT_FOUND" });
    return true;
  });
});

test("an HTTP error is the contract's {status, code, details}; anything else is thrown as is", async () => {
  answer = () => ({ status: 400, data: { error: "too long", code: "FIELD_TOO_LONG", details: { field: "body", limit: 8000 } } });
  await assert.rejects(
    apiArtifactSource.postComment(ID, { body: [{ type: "text", text: "x" }] } as never),
    (error: unknown) => {
      assert.deepEqual(error, { status: 400, code: "FIELD_TOO_LONG", details: { field: "body", limit: 8000 } });
      return true;
    },
  );
  assert.deepEqual(requests.at(-1), { method: "POST", url: `/artifacts/${ID}/comments`, data: { body: [{ type: "text", text: "x" }] }, responseType: undefined });

  answer = () => { throw new Error("offline"); };
  await assert.rejects(apiArtifactSource.presence(ID), /offline/);
});

test("a file's text comes from the content route; a binary file there is NOT_TEXT, not a missing file", async () => {
  answer = () => ({ status: 200, data: { kind: "text", path: "a.csv", version: 1, size: 3, contentType: "text/csv", content: "a,b", truncated: false } });
  assert.equal(await apiArtifactSource.readText({ id: ID, version: 1, path: "a.csv" }), "a,b");
  assert.ok(requests[0].url.startsWith(`/artifacts/${ID}/files/a.csv/content`), requests[0].url);

  answer = () => ({ status: 200, data: { kind: "binary", path: "a.png", version: 1, size: 3, contentType: "image/png" } });
  await assert.rejects(apiArtifactSource.readText({ id: ID, version: 1, path: "a.png" }), (error: unknown) => {
    assert.deepEqual(error, { status: 415, code: "NOT_TEXT" });
    return true;
  });
});

test("a file's bytes come from the file route, typed by its Content-Type", async () => {
  answer = () => ({ status: 200, data: new Blob(["<svg/>"]), headers: { "content-type": "image/svg+xml" } });
  const blob = await apiArtifactSource.readBytes({ id: ID, version: 3, path: "d.svg" });
  assert.equal(blob.type, "image/svg+xml");
  assert.equal(requests[0].responseType, "blob");
  assert.ok(requests[0].url.startsWith(`/artifacts/${ID}/files/d.svg`) && !requests[0].url.includes("/content"), requests[0].url);
});

// A message's Artifact links are not this source's: core's per-message link-card
// hook reads them through core's summaries loader (useArtifactLinkSummaries;
// messageLinkCards.behavior.test.tsx, artifactMessageCard.behavior.test.tsx).
test("no message refs on the API source: the summaries loader is the one path for message links", () => {
  assert.equal("getMessageArtifactRefs" in apiArtifactSource, false);
});

test("following, editing and deleting use their methods on their routes", async () => {
  answer = () => ({ status: 200, data: { following: true } });
  await apiArtifactSource.setFollowing(ID, true);
  answer = () => ({ status: 200, data: { following: false } });
  await apiArtifactSource.setFollowing(ID, false);
  answer = () => ({ status: 200, data: {} });
  const commentId = "c_1" as ArtifactCommentId;
  await apiArtifactSource.editComment(ID, commentId, [{ type: "text", text: "y" }] as never);
  answer = () => ({ status: 204 });
  await apiArtifactSource.deleteComment(ID, commentId);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    `PUT /artifacts/${ID}/subscription`,
    `DELETE /artifacts/${ID}/subscription`,
    `PATCH /artifacts/${ID}/comments/c_1`,
    `DELETE /artifacts/${ID}/comments/c_1`,
  ]);
  assert.deepEqual(requests[2].data, { body: [{ type: "text", text: "y" }] });
});

test("resolve and reopen POST to their routes, by the thread's root (#249)", async () => {
  answer = () => ({ status: 200, data: { comment: {}, note: null, changed: true } });
  const commentId = "c_1" as ArtifactCommentId;
  await apiArtifactSource.resolveComment(ID, commentId);
  await apiArtifactSource.reopenComment(ID, commentId);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    `POST /artifacts/${ID}/comments/c_1/resolve`,
    `POST /artifacts/${ID}/comments/c_1/reopen`,
  ]);
  assert.deepEqual(requests[0].data, {}, "no note from the web");
});

test("a failed file read keeps the server's code: the blob error body is read as JSON", async () => {
  answer = () => ({ status: 404, data: new Blob([JSON.stringify({ error: "gone", code: "FILE_NOT_FOUND" })], { type: "application/json" }) });
  await assert.rejects(apiArtifactSource.readBytes({ id: ID, version: 1, path: "a.png" }), (error: unknown) => {
    assert.deepEqual(error, { status: 404, code: "FILE_NOT_FOUND" });
    return true;
  });
});

test("S5: save, the saves of attachments on screen, the share audience and share are one route each", async () => {
  const ATT = "3c10b4ed-d947-49df-9031-91ae837f0aaa";
  answer = () => ({ status: 201, data: { artifact: { card }, created: true } });
  await apiArtifactSource.saveAttachment({ attachmentId: ATT });
  assert.deepEqual(requests.at(-1), { method: "POST", url: "/artifacts/save-attachment", data: { attachmentId: ATT }, responseType: undefined });

  const savedAs = { status: "unavailable", url: `https://app.raft.build/artifacts/${ID}` };
  answer = () => ({ status: 200, data: { saves: [{ attachmentId: ATT, savedAs }] } });
  assert.deepEqual(await apiArtifactSource.attachmentSaves([ATT, "att-2"]), { saves: [{ attachmentId: ATT, savedAs }] });
  assert.equal(requests.at(-1)!.method, "GET");
  assert.equal(requests.at(-1)!.url, `/artifacts/attachment-saves?attachmentIds=${ATT}%2Catt-2`);

  answer = () => ({ status: 200, data: { members: 3, cannotSee: 1, guestsCannotSee: 0, widenTo: [] } });
  await apiArtifactSource.shareAudience(ID, { conversationId: asChannelId("c-1") });
  assert.equal(requests.at(-1)!.url, `/artifacts/${ID}/share-audience?conversationId=c-1`);

  answer = () => ({ status: 404, data: { error: "gone", code: "TARGET_NOT_FOUND", details: { conversationId: "c-1" } } });
  const input = { conversationId: asChannelId("c-1"), threadRootId: null, note: "look", widenTo: null, clientKey: "3c10b4ed-d947-49df-9031-91ae837f0bbb" };
  await assert.rejects(apiArtifactSource.share(ID, input), (error: unknown) => {
    assert.deepEqual(error, { status: 404, code: "TARGET_NOT_FOUND", details: { conversationId: "c-1" } });
    return true;
  });
  // The clientKey goes as given: the server makes the message's idempotency key of it.
  assert.deepEqual(requests.at(-1), { method: "POST", url: `/artifacts/${ID}/share`, data: input, responseType: undefined });

  // Core's message limit answers 429 without a code: still RATE_LIMITED.
  answer = () => ({ status: 429, data: { error: "Too many messages, please slow down" } });
  await assert.rejects(apiArtifactSource.share(ID, input), (error: unknown) => {
    assert.deepEqual(error, { status: 429, code: "RATE_LIMITED" });
    return true;
  });
});

test("the home page's list reads its route with the home filter, the title search, the order, the toggle and the cursor", async () => {
  const empty = { rows: [], nextCursor: null };
  answer = () => ({ status: 200, data: empty });
  assert.deepEqual(await apiArtifactSource.dashboardAll({}), empty);
  await apiArtifactSource.dashboardAll({ home: "dm", q: "q3 plan", cursor: "c 1" });
  await apiArtifactSource.dashboardAll({ sort: "comments", dir: "asc" });
  await apiArtifactSource.dashboardAll({ home: "public", sort: "title", cursor: "c 2" });
  await apiArtifactSource.dashboardAll({ sort: "opened", dir: "desc" });
  await apiArtifactSource.dashboardAll({ relevant: true, cursor: "c 3" });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    "GET /artifacts/dashboard/all",
    "GET /artifacts/dashboard/all?home=dm&q=q3%20plan&cursor=c%201",
    "GET /artifacts/dashboard/all?sort=comments&dir=asc",
    "GET /artifacts/dashboard/all?home=public&sort=title&cursor=c%202",
    "GET /artifacts/dashboard/all?sort=opened&dir=desc",
    "GET /artifacts/dashboard/all?cursor=c%203&relevant=1",
  ]);
});

test("the author filter is its key once per value on the list; the authors read their own route", async () => {
  const empty = { rows: [], nextCursor: null };
  answer = () => ({ status: 200, data: empty });
  await apiArtifactSource.dashboardAll({ author: ["me", "my-agents"] });
  await apiArtifactSource.dashboardAll({ home: "dm", author: ["user:u-1"], q: "plan" });
  answer = () => ({ status: 200, data: { authors: [] } });
  assert.deepEqual(await apiArtifactSource.dashboardAuthors({ q: "ann b" }), { authors: [] });
  await apiArtifactSource.dashboardAuthors();
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    "GET /artifacts/dashboard/all?author=me&author=my-agents",
    "GET /artifacts/dashboard/all?home=dm&author=user%3Au-1&q=plan",
    "GET /artifacts/dashboard/authors?q=ann%20b",
    "GET /artifacts/dashboard/authors",
  ]);
});

test("the conversation filter is one id on the list; the conversations read their own route", async () => {
  answer = () => ({ status: 200, data: { rows: [], nextCursor: null } });
  await apiArtifactSource.dashboardAll({ conversation: "c-1", q: "plan" });
  answer = () => ({ status: 200, data: { conversations: [] } });
  assert.deepEqual(await apiArtifactSource.dashboardConversations({ q: "#proj" }), { conversations: [] });
  await apiArtifactSource.dashboardConversations();
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    "GET /artifacts/dashboard/all?conversation=c-1&q=plan",
    "GET /artifacts/dashboard/conversations?q=%23proj",
    "GET /artifacts/dashboard/conversations",
  ]);
});

test("open asks its route with no X-Server-Id, whichever server is current; the version only when pinned", async () => {
  useServerStore.setState({ current: { id: "server-current", slug: "current", name: "Current" } } as never);
  const sent: Array<string | undefined> = [];
  const viewer = { card: { id: ID, version: 2 } };
  answer = (config) => {
    sent.push(config.headers.toJSON()["X-Server-Id"] as string | undefined);
    return { status: 200, data: { opensIn: null, viewer } };
  };
  assert.deepEqual(await apiArtifactSource.open({ id: ID, version: null }), { opensIn: null, viewer });
  await apiArtifactSource.open({ id: ID, version: 2 });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`GET /artifacts/${ID}/open`, `GET /artifacts/${ID}/open?version=2`]);
  assert.deepEqual(sent, [undefined, undefined], "no server sent");

  answer = () => ({ status: 404, data: { error: "not visible", code: "NOT_VISIBLE" } });
  await assert.rejects(apiArtifactSource.open({ id: ID, version: null }), (error: unknown) => {
    assert.deepEqual(error, { status: 404, code: "NOT_VISIBLE" });
    return true;
  });
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("locate (`open`'s 404 fallback) asks its route from the server it names (X-Server-Id), not the current one", async () => {
  let serverHeader: unknown;
  answer = (config) => {
    serverHeader = config.headers["X-Server-Id"];
    return { status: 200, data: { serverSlug: "acme" } };
  };
  assert.deepEqual(await apiArtifactSource.locate(ID, { id: "server-asked", slug: "asked" }), { serverSlug: "acme" });
  assert.deepEqual(requests.at(-1), { method: "GET", url: `/artifacts/${ID}/locate`, data: undefined, responseType: undefined });
  assert.equal(serverHeader, "server-asked");
});

test("@ candidates ask core's audience route with the Artifact as an object audience, not the Artifact route", async () => {
  const actor = { type: "user", id: "u1", name: "judith", displayName: "Judith", avatarUrl: null, guest: false };
  answer = () => ({ status: 200, data: { candidates: [actor], capped: false } });
  const answerOf = await apiArtifactSource.mentionCandidates(ID, "ju");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/mentions/audience");
  assert.deepEqual(requests[0].data, { audience: { kind: "object", app: "artifacts", objectKind: "artifact", objectId: ID }, q: "ju" });
  assert.deepEqual(answerOf, { candidates: [actor], capped: false });
});

test("a conversation's Artifacts page reads its route, with the cursor when there is one; a bare 429 is RATE_LIMITED", async () => {
  const conversation = asChannelId("c1");
  answer = () => ({ status: 200, data: { rows: [{ card }], nextCursor: "n2" } });
  assert.deepEqual(await apiArtifactSource.conversationArtifacts(conversation), { rows: [{ card }], nextCursor: "n2" });
  await apiArtifactSource.conversationArtifacts(conversation, { cursor: "n2" });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /artifacts/conversations/c1", "GET /artifacts/conversations/c1?cursor=n2"]);

  answer = () => ({ status: 429 });
  await assert.rejects(apiArtifactSource.conversationArtifacts(conversation), (error: unknown) => {
    assert.deepEqual(error, { status: 429, code: "RATE_LIMITED" });
    return true;
  });
});

// ---- Batch comments (S8): review drafts and submitting a review ----

const DRAFT = asArtifactCommentDraftId("0b8a3a62-5d1c-4a8e-9f53-2c4b8a9e7d10");
const draft = {
  id: DRAFT,
  version: 2,
  target: { scope: "file", path: "index.html", anchor: null },
  body: [{ type: "text", text: "Double-counted?" }],
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-10-31T10:00:00.000Z",
};

test("S8: drafts are listed, made, edited and deleted one route each, and discarded all at once", async () => {
  answer = () => ({ status: 200, data: { drafts: [draft] } });
  assert.deepEqual(await apiArtifactSource.reviewDrafts(ID), { drafts: [draft] });
  answer = () => ({ status: 201, data: { draft } });
  const input = { version: 2, target: { scope: "file" as const, path: "index.html", anchor: null }, body: [{ type: "text" as const, text: "Double-counted?" }] };
  assert.deepEqual(await apiArtifactSource.createReviewDraft(ID, input), { draft });
  answer = () => ({ status: 200, data: { draft } });
  await apiArtifactSource.editReviewDraft(ID, DRAFT, [{ type: "mention", actor: { type: "agent", id: "agent-1" } }]);
  answer = () => ({ status: 204 });
  await apiArtifactSource.deleteReviewDraft(ID, DRAFT);
  await apiArtifactSource.discardReviewDrafts(ID);
  assert.deepEqual(requests.map(({ method, url, data }) => ({ method, url, data })), [
    { method: "GET", url: `/artifacts/${ID}/review/drafts`, data: undefined },
    { method: "POST", url: `/artifacts/${ID}/review/drafts`, data: input },
    { method: "PATCH", url: `/artifacts/${ID}/review/drafts/${DRAFT}`, data: { body: [{ type: "mention", actor: { type: "agent", id: "agent-1" } }] } },
    { method: "DELETE", url: `/artifacts/${ID}/review/drafts/${DRAFT}`, data: undefined },
    { method: "DELETE", url: `/artifacts/${ID}/review/drafts`, data: undefined },
  ]);
});

test("S8: a draft's refusals keep their code and details: 409 DRAFT_LIMIT { limit }, 404 DRAFT_NOT_FOUND", async () => {
  answer = () => ({ status: 409, data: { error: "too many drafts", code: "DRAFT_LIMIT", details: { limit: 50 } } });
  await assert.rejects(apiArtifactSource.createReviewDraft(ID, { version: 1, target: { scope: "artifact" }, body: [] }), (error: unknown) => {
    assert.deepEqual(error, { status: 409, code: "DRAFT_LIMIT", details: { limit: 50 } });
    return true;
  });
  answer = () => ({ status: 404, data: { error: "no such draft", code: "DRAFT_NOT_FOUND" } });
  for (const write of [() => apiArtifactSource.editReviewDraft(ID, DRAFT, []), () => apiArtifactSource.deleteReviewDraft(ID, DRAFT)]) {
    await assert.rejects(write(), (error: unknown) => {
      assert.deepEqual(error, { status: 404, code: "DRAFT_NOT_FOUND" });
      return true;
    });
  }
});

test("S8: submit posts { version, summary, clientKey }; 201 and a key's 200 replay are the same `ok`", async () => {
  const comment = { id: "c_1", reviewId: "r_1" };
  answer = () => ({ status: 201, data: { status: "ok", comments: [comment] } });
  const input = { version: 2, summary: [{ type: "text" as const, text: "LGTM" }], clientKey: "k-1" };
  assert.deepEqual(await apiArtifactSource.submitReview(ID, input), { status: "ok", comments: [comment] });
  answer = () => ({ status: 200, data: { status: "ok", comments: [comment] } });
  assert.deepEqual(await apiArtifactSource.submitReview(ID, input), { status: "ok", comments: [comment] });
  assert.deepEqual(requests.map(({ method, url, data }) => ({ method, url, data })), [
    { method: "POST", url: `/artifacts/${ID}/review/submit`, data: input },
    { method: "POST", url: `/artifacts/${ID}/review/submit`, data: input },
  ]);
});

test("S8: a 422 `rejected` is an answer, not a failure: the draft (or null, the summary), its code and details", async () => {
  answer = () => ({ status: 422, data: { status: "rejected", draftId: DRAFT, code: "MENTION_NOT_VISIBLE", error: "mentioned actor cannot see this artifact", details: { actors: [{ type: "agent", id: "a" }] } } });
  assert.deepEqual(await apiArtifactSource.submitReview(ID, { version: 2, summary: null }), {
    status: "rejected", draftId: DRAFT, code: "MENTION_NOT_VISIBLE", error: "mentioned actor cannot see this artifact", details: { actors: [{ type: "agent", id: "a" }] },
  });
  answer = () => ({ status: 422, data: { status: "rejected", draftId: null, code: "FIELD_TOO_LONG", error: "too long", details: { field: "body", limit: 8000 } } });
  assert.deepEqual(await apiArtifactSource.submitReview(ID, { version: 2, summary: [{ type: "text", text: "x" }] }), {
    status: "rejected", draftId: null, code: "FIELD_TOO_LONG", error: "too long", details: { field: "body", limit: 8000 },
  });
  // INVALID_REQUEST has no details; VERSION_NOT_FOUND may have none.
  answer = () => ({ status: 422, data: { status: "rejected", draftId: DRAFT, code: "VERSION_NOT_FOUND", error: "gone" } });
  assert.deepEqual(await apiArtifactSource.submitReview(ID, { version: 2, summary: null }), { status: "rejected", draftId: DRAFT, code: "VERSION_NOT_FOUND", error: "gone" });
  // A reply draft whose comment was deleted: no details.
  answer = () => ({ status: 422, data: { status: "rejected", draftId: DRAFT, code: "COMMENT_NOT_FOUND", error: "no such comment" } });
  assert.deepEqual(await apiArtifactSource.submitReview(ID, { version: 2, summary: null }), { status: "rejected", draftId: DRAFT, code: "COMMENT_NOT_FOUND", error: "no such comment" });
  // A 422 that isn't the contract's ArtifactReviewRejected is thrown as any error: an unknown code, a
  // code it never carries (FORBIDDEN is the route's 403), or details that aren't its code's.
  for (const data of [
    { status: "rejected", draftId: DRAFT, code: "SOMETHING_NEW", error: "?" },
    { status: "rejected", draftId: DRAFT, code: "FORBIDDEN", error: "?" },
    { status: "rejected", draftId: DRAFT, code: "FIELD_TOO_LONG", error: "?", details: { limit: "a lot" } },
    { status: "rejected", draftId: DRAFT, code: "MENTION_NOT_VISIBLE", error: "?", details: { actors: [{ id: 3 }] } },
    { status: "rejected", draftId: DRAFT, code: "COMMENT_NOT_FOUND", error: "?", details: { replyTo: "c_1" } },
  ]) {
    answer = () => ({ status: 422, data });
    await assert.rejects(apiArtifactSource.submitReview(ID, { version: 2, summary: null }), (error: unknown) => {
      assert.deepEqual(error, { status: 422, code: data.code, ...(data.details ? { details: data.details } : {}) });
      return true;
    });
  }
});

test("S8: submit's other refusals are thrown with their codes: NO_DRAFTS, DRAFTS_CHANGED, CLIENT_KEY_REUSED, VERSION_NOT_FOUND", async () => {
  for (const [status, code] of [[409, "NO_DRAFTS"], [409, "DRAFTS_CHANGED"], [409, "CLIENT_KEY_REUSED"], [404, "VERSION_NOT_FOUND"]] as const) {
    answer = () => ({ status, data: { error: "refused", code } });
    await assert.rejects(apiArtifactSource.submitReview(ID, { version: 2, summary: null, clientKey: "k" }), (error: unknown) => {
      assert.deepEqual(error, { status, code });
      return true;
    });
  }
});

test("S8: one review's comments are the comments route with `review`", async () => {
  answer = () => ({ status: 200, data: { comments: [], olderCursor: null } });
  await apiArtifactSource.getComments(ID, { review: "r_1" });
  assert.equal(requests[0].url, `/artifacts/${ID}/comments?review=r_1`);
});
