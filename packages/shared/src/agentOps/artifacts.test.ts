// artifacts.* operations over the real shared client (fetch transport):
// which paths are refused before any request, how links become ids, and how
// the Server's Artifacts codes become RaftOpErrors (standard classification,
// the Artifacts' own sentence and next step, tool style without commands).
import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { formatArtifactCheck } from "../agentText/artifacts";
import { ARTIFACT_CHECK_POLL_MS, ARTIFACT_CHECK_WAIT_MS, artifactCommentImageUploaderForFetch, artifactsCheck, artifactsCheckShot, artifactsComment, artifactsCommentImage, artifactsCommentImageUpload, artifactsComments, artifactsDelete, artifactsFile, artifactsFileContent, artifactsList, artifactsMatchQuery, artifactsMove, artifactsPublish, ARTIFACTS_PROBE_GRACE_MS, artifactsRead, artifactsReview, artifactsReviewRefusal, artifactsFollow, artifactsSaveAttachment, artifactsUnfollow, artifactsUpload, artifactUploaderForFetch, artifactUploadFailure, searchMessages } from "./index";

type Call = { method: string; path: string };

function client(script: (path: string) => Response, calls: Call[] = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}` });
        return script(url.pathname);
      },
    },
  });
}

const refuse = (status: number, code: string, details?: object) => () => Response.json({ error: code.toLowerCase(), code, ...(details ? { details } : {}) }, { status });
const BASE = "/internal/agent-api/artifacts";
const BYTES = new Uint8Array([1, 2, 3]);
/** sha256 of [1, 2, 3]. */
const SHA = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

test("paths: valid ones go out as one encoded segment; invalid ones are refused before any request", async () => {
  for (const path of ["index.html", "assets/logo.png", "a b.txt", "docs/v1.2/notes.md", ".well-known/x.json", "图.png", "a..b.txt"]) {
    const calls: Call[] = [];
    const api = client(() => Response.json({ kind: "text", path, version: 1, size: 1, contentType: "text/plain", encoding: "utf8", content: "x", truncated: false }), calls);
    const out = await artifactsFileContent(api, { artifact: "pt_abc", path });
    assert.ok(out.ok, `${path} accepted`);
    assert.equal(calls[0]?.path, `${BASE}/pt_abc/files/${encodeURIComponent(path)}/content`);
  }
  // The Server's isWellFormedArtifactFilePath (Porthole's rule); keep the two lists in step.
  for (const path of ["..", "../x", "a/../b", "./a", "a/./b", "/a", "a/", "a//b", "a\\b", "a\u0000b", "a\nb", "100%.html", "a%2Fb", "a?b", "a#b", "a\u200bb"]) {
    const calls: Call[] = [];
    const out = await artifactsFile(client(() => Response.json({}), calls), { artifact: "pt_abc", path });
    assert.ok(!out.ok, `${JSON.stringify(path)} refused`);
    assert.equal(out.error.code, "INVALID_REQUEST");
    assert.equal(out.error.serverCode, "INVALID_PATH");
    assert.deepEqual(calls, [], `${JSON.stringify(path)}: nothing sent`);
  }
});

test("refs: a link is sent as its id, a /v/<n> link pins the version, an explicit version wins, a bad ref is refused locally", async () => {
  const read = { artifact: { id: "pt_abc" }, version: null, versions: { total: 0, latest: [] }, unseen: null, viewing: [] };
  const calls: Call[] = [];
  const api = client(() => Response.json({ ...read, artifact: { id: "pt_abc", url: "u", name: "n", title: "T", description: null, kind: null, home: { kind: "server" }, currentVersion: null, author: { type: "agent", name: "Remy" }, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" } }), calls);
  await artifactsRead(api, { artifact: "https://app.raft.build/s/raft/artifacts/pt_abc/v/4" });
  await artifactsRead(api, { artifact: "https://app.raft.build/artifacts/pt_abc/v/4", version: 2 });
  await artifactsRead(api, { artifact: "workspace-prototype" });
  // A title (any text that is neither an id nor a link) goes as written, trimmed: the Server looks it up.
  await artifactsRead(api, { artifact: "  Q3 report " });
  await artifactsRead(api, { artifact: "财务报告 / v2" });
  assert.deepEqual(calls.map((c) => c.path), [
    `${BASE}/pt_abc?version=4`,
    `${BASE}/pt_abc?version=2`,
    `${BASE}/workspace-prototype`,
    `${BASE}/${encodeURIComponent("Q3 report")}`,
    `${BASE}/${encodeURIComponent("财务报告 / v2")}`,
  ]);

  const legacy = await artifactsRead(client(() => Response.json({}), []), { artifact: "https://raft-artifacts.com/a/tok123" });
  assert.ok(!legacy.ok);
  assert.equal(legacy.error.code, "INVALID_REQUEST");
  assert.equal(legacy.error.serverCode, "INVALID_ARTIFACT_REF");
  assert.ok(legacy.error.message.includes("old link to a single version"));

  // A link that names no Artifact is still refused here, never sent as a title.
  const sent: Call[] = [];
  const page = await artifactsRead(client(() => Response.json({}), sent), { artifact: "https://example.com/report" });
  assert.ok(!page.ok);
  assert.equal(page.error.serverCode, "INVALID_ARTIFACT_REF");
  assert.equal(page.error.message, `"https://example.com/report" isn't a link to an artifact.`);
  assert.deepEqual(sent, []);
});

test("Server codes: standard classification, the Artifacts' sentence and next step, in tool style too", async () => {
  const hidden = await artifactsRead(client(refuse(404, "NOT_VISIBLE")), { artifact: "pt_zzz" }, { hints: "tool" });
  assert.ok(!hidden.ok);
  assert.equal(hidden.error.code, "NOT_FOUND");
  assert.equal(hidden.error.serverCode, "NOT_VISIBLE");
  assert.equal(hidden.error.status, 404);
  assert.equal(hidden.error.message, `No artifact "pt_zzz" that you can see (by that id, link or exact title).`);
  assert.equal(hidden.error.nextAction, "List the ones you can: artifacts_list({})");
  assert.ok(hidden.text.includes("Next action: List the ones you can: artifacts_list({})"));

  const off = await artifactsList(client(refuse(403, "ARTIFACTS_NOT_ENABLED")), {});
  assert.ok(!off.ok);
  assert.equal(off.error.code, "HTTP_ERROR", "a disabled feature is not the caller's malformed request");
  assert.equal(off.error.serverCode, "ARTIFACTS_NOT_ENABLED");
  assert.equal(off.error.nextAction, "To read one: raft artifact read <artifact>. To share a file, send it as an attachment, and each later version as a new attachment in the same thread: raft attachment upload --path <file> --target <conversation>");

  const storage = await artifactsFileContent(client(refuse(503, "ARTIFACTS_STORAGE_UNAVAILABLE")), { artifact: "pt_abc", path: "a.png" });
  assert.ok(!storage.ok);
  assert.equal(storage.error.code, "UNAVAILABLE");

  const ambiguous = await artifactsRead(client(refuse(409, "AMBIGUOUS_ARTIFACT_NAME", { ref: "report", candidates: ["pt_a", "pt_b"] })), { artifact: "report" });
  assert.ok(!ambiguous.ok);
  assert.equal(ambiguous.error.code, "CONFLICT");
  assert.equal(ambiguous.error.message, `Several artifacts you can see are called "report": pt_a, pt_b.`);
  assert.equal(ambiguous.error.nextAction, "Pass the id instead, e.g. raft artifact read pt_a");

  // Several with one title: each candidate by id and title, the next step by id.
  const titled = await artifactsRead(client(refuse(409, "AMBIGUOUS_ARTIFACT_NAME", {
    ref: "Q3 report",
    candidates: [{ id: "pt_a", title: "Q3 report", home: { kind: "server" } }, { id: "pt_b", title: "q3 Report", home: { kind: "conversation", conversation: { id: "c", type: "channel", target: "#ops" } } }],
  })), { artifact: "Q3 report" });
  assert.ok(!titled.ok);
  assert.equal(titled.error.message, `Several artifacts you can see are called "Q3 report": pt_a "Q3 report" (home: the whole server), pt_b "q3 Report" (home: #ops).`);
  assert.equal(titled.error.nextAction, "Pass the id instead, e.g. raft artifact read pt_a");

  const file = await artifactsComments(client(refuse(404, "TARGET_NOT_FOUND")), { artifact: "pt_abc" });
  assert.ok(!file.ok);
  assert.equal(file.error.serverCode, "TARGET_NOT_FOUND");

  const other = await artifactsRead(client(refuse(500, "something_else")), { artifact: "pt_abc" });
  assert.ok(!other.ok);
  assert.equal(other.error.code, "UNAVAILABLE");
  assert.equal(other.error.serverCode, "something_else");
});

// ── push (S1b) ──

const summaryRow = { id: "pt_abc", url: "https://app.raft.build/artifacts/pt_abc", title: "Proto", description: null, kind: "html", home: { kind: "server" }, currentVersion: 13, author: { type: "agent", name: "Remy" }, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" };
const publishedBody = { artifact: summaryRow, version: { number: 13, filesFromYou: ["a.png"], deleted: [], base: 12, previous: 12, merged: [] }, unseen: { otherComments: 0 }, notified: [], replayed: false, unchanged: false };

test("push: bytes are listed by sha256; missing ones are uploaded and the same request is sent again", async () => {
  const calls: Call[] = [];
  let publishes = 0;
  const api = client((path) => {
    if (path.endsWith("/push")) {
      publishes += 1;
      return publishes === 1 ? Response.json({ missing: [SHA] }) : Response.json(publishedBody, { status: 201 });
    }
    return new Response(null, { status: 204 });
  }, calls);
  const uploads: Array<[string, number]> = [];
  const out = await artifactsPublish(api, { artifact: "pt_abc", base: 12, files: [{ path: "a.png", bytes: BYTES }] }, {
    upload: async (sha, bytes) => { uploads.push([sha, bytes.byteLength]); return { ok: true }; },
  });
  assert.ok(out.ok, out.ok ? "" : out.text);
  assert.equal(out.state, "pushed");
  assert.deepEqual(uploads, [[SHA, 3]]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST ${BASE}/push`, `POST ${BASE}/push`]);
  assert.ok(out.text.startsWith(`Pushed v13 of "Proto" (pt_abc): changed a.png.`));
});

test("push: a file with two or no bodies, a bad path, or a missing upload is refused before or without guessing", async () => {
  const calls: Call[] = [];
  const api = client(() => Response.json({ missing: [SHA] }), calls);
  const two = await artifactsPublish(api, { artifact: "pt_abc", base: 12, files: [{ path: "a.txt", content: "x", content_base64: "eA==" }] });
  assert.ok(!two.ok && two.error.code === "INVALID_REQUEST" && two.error.message.includes("exactly one of content"));
  const bad = await artifactsPublish(api, { artifact: "pt_abc", base: 12, files: [{ path: "../a", content: "x" }] });
  assert.ok(!bad.ok && bad.error.serverCode === "INVALID_PATH");
  assert.deepEqual(calls, [], "nothing sent for either");
  const noUploader = await artifactsPublish(api, { artifact: "pt_abc", base: 12, files: [{ path: "a.png", sha256: SHA, size: 3 }] }, { hints: "tool" });
  assert.ok(!noUploader.ok);
  assert.equal(noUploader.error.message, "The Server doesn't have the bytes of a.png.");
});

/** A client that keeps each push's JSON body. */
function pushRecorder(bodies: Array<Record<string, unknown>>): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ...publishedBody, version: { ...publishedBody.version, number: 1, base: null, previous: null } }, { status: 201 });
      },
    },
  });
}

test("push: a new artifact needs a title: the one given, else its entry page's <title>; none is refused before any request", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const api = pushRecorder(bodies);
  const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>hi</body></html>`;

  assert.ok((await artifactsPublish(api, { target: "#ops", title: "Q3 report", files: [{ path: "index.html", content: page("Ignored") }] })).ok);
  assert.equal(bodies.at(-1)!.title, "Q3 report", "--title wins over the page's");

  assert.ok((await artifactsPublish(api, { target: "#ops", files: [{ path: "index.html", content: page("  Q3 &amp; Q4\n report ") }, { path: "a.css", content: "" }] })).ok);
  assert.equal(bodies.at(-1)!.title, "Q3 & Q4 report", "index.html's <title>, decoded and on one line");

  assert.ok((await artifactsPublish(api, { target: "#ops", files: [{ path: "deck.html", bytes: new TextEncoder().encode(page("财务报告")) }] })).ok);
  assert.equal(bodies.at(-1)!.title, "财务报告", "the only file, given as bytes");

  assert.ok((await artifactsPublish(api, { target: "#ops", entry: "b.html", files: [{ path: "a.html", content: page("A") }, { path: "b.html", content_base64: btoa(page("B")) }] })).ok);
  assert.equal(bodies.at(-1)!.title, "B", "the named entry, given as base64");
  assert.equal("name" in bodies.at(-1)!, false, "no name is ever sent");
  const sent = bodies.length;

  const none = await artifactsPublish(api, { target: "#ops", files: [{ path: "index.html", content: "<h1>no title</h1>" }] }, { dir: "./report" });
  assert.ok(!none.ok);
  assert.equal(none.error.code, "INVALID_REQUEST");
  assert.equal(none.error.serverCode, "TITLE_REQUIRED");
  assert.equal(none.error.message, "A new artifact needs a title: none was given, and its entry page index.html has no <title>.");
  assert.equal(none.error.nextAction, "Add --title with a title people will recognise, or give index.html a <title>, then push again.");

  const notPage = await artifactsPublish(api, { target: "#ops", files: [{ path: "notes.md", content: "# Notes" }] }, { hints: "tool" });
  assert.ok(!notPage.ok && notPage.error.serverCode === "TITLE_REQUIRED");
  assert.equal(notPage.error.nextAction, "Add title with a title people will recognise, then push again.");

  const byHash = await artifactsPublish(api, { target: "#ops", files: [{ path: "index.html", sha256: SHA, size: 3 }] });
  assert.ok(!byHash.ok && byHash.error.serverCode === "TITLE_REQUIRED", "a page listed by sha256 alone has no bytes to read");

  const blank = await artifactsPublish(api, { artifact: "pt_abc", base: 12, title: "   ", files: [] });
  assert.ok(!blank.ok && blank.error.serverCode === "TITLE_REQUIRED");
  assert.equal(blank.error.message, "A title can't be blank.");
  assert.equal(bodies.length, sent, "nothing sent for any refusal");
});

test("push: a new artifact pushed into a thread sends the thread target as given, and its text says nothing was posted there and gives the call that sends its link", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const api = pushRecorder(bodies);
  const out = await artifactsPublish(api, { target: "#ops:fde584d1", title: "Demo", files: [{ path: "x.txt", content: "x" }] }, { hints: "tool" });
  assert.ok(out.ok, out.ok ? "" : out.text);
  assert.equal(bodies.at(-1)!.target, "#ops:fde584d1");
  assert.ok(out.text.includes(`Nothing was posted to #ops:fde584d1; a card appears there once its link is sent: messages_send({ target: "#ops:fde584d1", content: "<what to look at>: https://app.raft.build/artifacts/pt_abc" })\n`), out.text);
});

test("push: a new title alone is sent as a push, and the answer says the title changed with no new version", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          ...publishedBody,
          artifact: { ...summaryRow, title: "Proto (final)", currentVersion: 12 },
          version: { number: 12, filesFromYou: [], deleted: [], base: 12, previous: 12, merged: [] },
          unchanged: true,
          titleChanged: { from: "Proto" },
        });
      },
    },
  });
  const out = await artifactsPublish(api, { artifact: "Proto", base: 12, title: "Proto (final)", files: [] });
  assert.ok(out.ok, out.ok ? "" : out.text);
  assert.deepEqual(bodies, [{ artifact: "Proto", base: 12, title: "Proto (final)", files: [] }]);
  assert.ok(out.text.startsWith(`Title changed to "Proto (final)" (was "Proto") on pt_abc; no new version: v12 is still the current one.\n`), out.text);
});

test("push: BASE_MOVED and UNSEEN_CHANGES come back in the Artifacts' words, with the details", async () => {
  const moved = await artifactsPublish(client(refuse(409, "BASE_MOVED", { base: 12, current: 14, overlaps: [{ path: "a.html", setting: null, version: 13, author: { type: "agent", name: "Tenny" } }] })), { artifact: "pt_abc", base: 12, files: [{ path: "a.html", content: "x" }] }, { dir: "./proto" });
  assert.ok(!moved.ok);
  assert.equal(moved.error.code, "CONFLICT");
  assert.equal(moved.error.serverCode, "BASE_MOVED");
  assert.equal(moved.error.message, "Not pushed: since v12, others changed what you changed: a.html (v13 by @Tenny). The current version is v14.");
  assert.ok(moved.error.nextAction.includes("raft artifact pull pt_abc --dir <new dir>"));

  const held = await artifactsPublish(client(refuse(409, "UNSEEN_CHANGES", { unseen: { comments: [], commentCount: 1, commentsCursor: "c1" }, seen: 3 })), { artifact: "pt_abc", base: 12, files: [{ path: "a.html", content: "x" }] }, { hints: "tool" });
  assert.ok(!held.ok);
  assert.equal(held.error.serverCode, "UNSEEN_CHANGES");
  assert.ok(held.error.message.startsWith("Held — not pushed."));
  assert.ok(held.error.nextAction.includes("make the same push call again"));
});

test("push: FILE_UPLOAD_QUOTA_EXCEEDED with the Server's upgrade card offers it as the CLI's next action; the tool style keeps the billing line", async () => {
  const billingUrl = "https://app.raft.build/s/team/settings/billing";
  const upgradeHint = [
    "The files were not stored: this server is on the Free plan and has used this month's upload allowance. Pro would take them. Say in the conversation that the files weren't stored and why, then offer an upgrade card unless that is clearly out of place here (put what the files are for in place of the <…>):",
    `raft action prepare --target "#ops" <<'RAFTACTION'`,
    '{"type":"plan:upgrade","gate":"upload_monthly_quota","reason":"<one sentence: what the files are for>"}',
    "RAFTACTION",
  ].join("\n");
  const details = { requestedBytes: 1, quota: { plan: "free", limitBytes: 100 * 1024 * 1024, usedBytes: 100 * 1024 * 1024 }, billingUrl, upgradeHint };
  const request = { target: "#ops", title: "Q3", files: [{ path: "index.html", content: "x" }] };
  const cli = await artifactsPublish(client(refuse(403, "FILE_UPLOAD_QUOTA_EXCEEDED", details)), request);
  assert.ok(!cli.ok);
  assert.equal(cli.error.serverCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(cli.error.nextAction, `${upgradeHint}\nUntil then, only files the server already has (unchanged ones) can be pushed.`);
  const tool = await artifactsPublish(client(refuse(403, "FILE_UPLOAD_QUOTA_EXCEEDED", details)), request, { hints: "tool" });
  assert.ok(!tool.ok);
  assert.equal(tool.error.nextAction, `Say in the conversation that the files weren't stored and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}. Until then, only files the server already has (unchanged ones) can be pushed.`);
});

test("SDK uploader: PUT …/uploads/:sha256 with the raw bytes and auth; refusals in the Artifacts' words", async () => {
  const seen: Array<{ url: string; method?: string; type: string | null; auth: string | null; body: number[] }> = [];
  const transport = (status: number, body?: unknown) => ({
    serverUrl: "https://raft.example",
    headers: { "x-extra": "1" },
    authorization: "Bearer sk_agent_test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(input), method: init?.method, type: h.get("content-type"), auth: h.get("authorization"), body: [...new Uint8Array(init?.body as ArrayBuffer)] });
      return body === undefined ? new Response(null, { status }) : Response.json(body, { status });
    }) as typeof fetch,
  });
  const ok = await artifactsUpload(transport(204), { bytes: BYTES });
  assert.ok(ok.ok);
  assert.deepEqual(ok.data, { sha256: SHA, size: 3 });
  assert.deepEqual(seen[0], { url: `https://raft.example${BASE}/uploads/${SHA}`, method: "PUT", type: "application/octet-stream", auth: "Bearer sk_agent_test", body: [1, 2, 3] });

  const quota = await artifactUploaderForFetch(transport(413, { error: "quota", code: "UPLOAD_QUOTA_EXCEEDED", details: { used: 1073741824, limit: 1073741824 } }), "tool")(SHA, BYTES);
  assert.ok(!quota.ok);
  assert.equal(quota.failure.error.serverCode, "UPLOAD_QUOTA_EXCEEDED");
  assert.equal(quota.failure.error.message, "This server holds too many uploaded files that no version uses yet (1024 MiB of 1024 MiB).");

  const billingUrl = "https://app.raft.build/s/team/settings/billing";
  const monthlyQuota = { plan: "free", limitBytes: 100 * 1024 * 1024, usedBytes: 100 * 1024 * 1024 };
  const monthly = await artifactUploaderForFetch(transport(403, {
    error: "Monthly file upload quota exceeded.",
    errorCode: "FILE_UPLOAD_QUOTA_EXCEEDED",
    code: "FILE_UPLOAD_QUOTA_EXCEEDED",
    billingUrl,
    suggestedNextAction: `Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}`,
    details: { requestedBytes: 3, quota: monthlyQuota, billingUrl },
  }), "tool")(SHA, BYTES);
  assert.ok(!monthly.ok);
  assert.equal(monthly.failure.error.serverCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(monthly.failure.error.status, 403);
  assert.ok(monthly.failure.error.message.startsWith("Not stored: this server's monthly file upload quota is used up (100 MiB of 100 MiB used this month)."));
  assert.ok(monthly.failure.error.nextAction.includes(billingUrl));

  const other = artifactUploadFailure(500, { error: "boom" }, "cli");
  assert.equal(other.error.code, "UNAVAILABLE");
});

// ── comments and following (S1c) ──

test("comment: body, path, reply and version go to the Server; a bad path is refused locally; COMMENT_NOT_FOUND in words", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const created = { artifact: { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 }, comment: { id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: "a.html", anchor: null, replyTo: "c_1", body: "ok", createdAt: "2026-10-22T00:00:00.000Z", editedAt: null }, notified: [], notNotified: [], newlySubscribed: false };
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(created, { status: 201 });
      },
    },
  });
  const out = await artifactsComment(api, { artifact: "https://app.raft.build/artifacts/pt_abc/v/12", body: "ok", path: "a.html", replyTo: "c_1" });
  assert.ok(out.ok);
  assert.deepEqual(calls, [{ path: `${BASE}/pt_abc/comments`, body: { body: "ok", path: "a.html", version: 12, replyTo: "c_1" } }]);
  const bad = await artifactsComment(api, { artifact: "pt_abc", body: "x", path: "../a" });
  assert.ok(!bad.ok && bad.error.serverCode === "INVALID_PATH");
  assert.equal(calls.length, 1);
  const missing = await artifactsComment(client(refuse(404, "COMMENT_NOT_FOUND", { replyTo: "c_404" })), { artifact: "pt_abc", body: "x", replyTo: "c_404" });
  assert.ok(!missing.ok);
  assert.equal(missing.error.message, `"c_404" isn't a comment of "pt_abc".`);
});

test("follow / unfollow: PUT and DELETE, the state as text", async () => {
  const calls: Call[] = [];
  const answer = (following: boolean) => () => Response.json({ artifact: { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 1 }, following });
  const on = await artifactsFollow(client(answer(true), calls), { artifact: "pt_abc" });
  const off = await artifactsUnfollow(client(answer(false), calls), { artifact: "pt_abc" });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`PUT ${BASE}/pt_abc/subscription`, `DELETE ${BASE}/pt_abc/subscription`]);
  assert.ok(on.ok && on.state === "following" && on.text.startsWith(`You follow "Proto" (pt_abc)`));
  assert.ok(off.ok && off.state === "not_following" && off.text.startsWith(`You no longer follow "Proto" (pt_abc).`));
});

test("comment: an empty or over-long body is refused before any request, naming the body", async () => {
  const calls: Call[] = [];
  const api = client(() => Response.json({}), calls);
  const blank = await artifactsComment(api, { artifact: "pt_abc", body: "  \n " });
  assert.ok(!blank.ok && blank.error.code === "INVALID_REQUEST" && blank.error.message.includes("body"), blank.ok ? "" : blank.error.message);
  const long = await artifactsComment(api, { artifact: "pt_abc", body: "x".repeat(8001) });
  assert.ok(!long.ok && long.error.serverCode === "FIELD_TOO_LONG");
  assert.equal(long.error.message, "The comment's body is over 8000 characters.");
  assert.deepEqual(calls, []);
});

test("review: one call with every comment; local refusals name the comment; a Server refusal with index names it too, in tool style as a call", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const ref = { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 };
  const created = {
    artifact: ref,
    review: { id: "rv_1", author: { type: "agent", name: "Sage" }, version: 12, body: null, createdAt: "2026-10-27T18:30:00.000Z" },
    comments: [{ id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: "a.html", anchor: null, replyTo: null, body: "x", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_1" }],
    notified: [], notNotified: [], newlySubscribed: false,
  };
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(created, { status: 201 });
      },
    },
  });
  const out = await artifactsReview(api, { artifact: "https://app.raft.build/artifacts/pt_abc/v/12", body: "  ", comments: [{ body: "x", path: "a.html" }] });
  assert.ok(out.ok && out.state === "reviewed");
  // A blank summary is left out; a /v/<n> link pins the version; a key is generated, sent and returned.
  assert.match(out.data.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(calls, [{ path: `${BASE}/pt_abc/reviews`, body: { version: 12, comments: [{ body: "x", path: "a.html" }], idempotencyKey: out.data.idempotencyKey } }]);

  const local = client(() => { throw new Error("no request expected"); });
  const badPath = await artifactsReview(local, { artifact: "pt_abc", comments: [{ body: "a" }, { body: "b", path: "../x" }] });
  assert.ok(!badPath.ok && badPath.error.serverCode === "INVALID_PATH" && badPath.error.message.startsWith("Comment 2 of 2 (../x): "), badPath.ok ? "" : badPath.error.message);
  const long = await artifactsReview(local, { artifact: "pt_abc", comments: [{ body: "x".repeat(8001) }] });
  assert.ok(!long.ok && long.error.message === "Comment 1 of 1 (the whole artifact): The comment's body is over 8000 characters. Nothing of the review was posted.", long.ok ? "" : long.error.message);
  const longSummary = await artifactsReview(local, { artifact: "pt_abc", body: "y".repeat(8001), comments: [{ body: "a" }] });
  assert.ok(!longSummary.ok && longSummary.error.message === "The review's summary is over 8000 characters. Nothing of the review was posted.", longSummary.ok ? "" : longSummary.error.message);
  const tooMany = await artifactsReview(local, { artifact: "pt_abc", comments: Array.from({ length: 51 }, () => ({ body: "a" })) });
  assert.ok(!tooMany.ok && tooMany.error.serverCode === "TOO_MANY_COMMENTS" && tooMany.error.message === "A review holds at most 50 comments; this one has 51. Nothing was posted.", tooMany.ok ? "" : tooMany.error.message);
  const blankPath = await artifactsReview(local, { artifact: "pt_abc", comments: [{ body: "a", path: "" }] });
  assert.ok(!blankPath.ok && blankPath.error.message === "Comment 1 of 1 (the whole artifact): Its path is empty. Nothing of the review was posted." && blankPath.error.nextAction.startsWith("Fix comment 1, then run the same command again."), blankPath.ok ? "" : blankPath.error.message);

  // A Server without the route (before S8), or the stub before the handler: say so, and how to comment instead.
  for (const answer of [refuse(404, "REVIEWS_NOT_AVAILABLE"), () => Response.json({ error: "Not found" }, { status: 404 })]) {
    const none = await artifactsReview(client(answer), { artifact: "pt_abc", comments: [{ body: "a" }] });
    assert.ok(!none.ok && none.error.serverCode === "REVIEWS_NOT_AVAILABLE" && none.error.message === "This Server doesn't take reviews yet. Nothing was posted.", none.ok ? "" : none.error.message);
    assert.ok(none.error.nextAction.startsWith("Post the comments one at a time instead: raft artifact comment pt_abc --path '<file>'"), none.error.nextAction);
  }
  // An index past the review's comments names none: read as the review's refusal.
  const past = await artifactsReview(client(refuse(404, "FILE_NOT_FOUND", { index: 7, path: "z.html", version: 12 })), { artifact: "pt_abc", comments: [{ body: "a" }] });
  assert.ok(!past.ok && !past.error.message.startsWith("Comment 8"), past.ok ? "" : past.error.message);

  const refused = await artifactsReview(client(refuse(404, "FILE_NOT_FOUND", { index: 1, path: "b.html", version: 12 })), { artifact: "pt_abc", comments: [{ body: "a" }, { body: "b", path: "b.html" }] }, { hints: "tool" });
  assert.ok(!refused.ok);
  assert.equal(refused.error.serverCode, "FILE_NOT_FOUND");
  assert.equal(refused.error.message, `Comment 2 of 2 (b.html): v12 of "pt_abc" has no file "b.html". Nothing of the review was posted.`);
  assert.equal(refused.error.nextAction, `Fix comment 2, then make the same review call again. Its files: artifacts_read({ artifact: "pt_abc", files: true })`);
  // Without an index the refusal is the review's own.
  const held = await artifactsReview(client(refuse(409, "UNSEEN_CHANGES", { unseen: { comments: [], commentCount: 0, commentsCursor: null }, seen: 3, skipped: {} })), { artifact: "pt_abc", comments: [{ body: "a" }] }, { hints: "tool" });
  assert.ok(!held.ok && held.error.message.startsWith("Held — nothing of the review was posted.") && held.error.nextAction.includes("make the same review call again"), held.ok ? "" : held.error.message);
  assert.notEqual(held.next?.kind, "retry_same_key", "a refusal is not retried under the key");
});

test("review: under an idempotency key; a lost answer says to repeat with it, and the Server's 200 for it is the review replayed", async () => {
  const ref = { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 };
  const posted = {
    artifact: ref,
    review: { id: "rv_1", author: { type: "agent", name: "Sage" }, version: 12, body: "Two things.", createdAt: "2026-10-27T18:30:00.000Z" },
    comments: [{ id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: "a.html", anchor: null, replyTo: null, body: "x", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_1" }],
    notified: [], notNotified: [], newlySubscribed: false,
  };
  const request = { artifact: "pt_abc", body: "Two things.", comments: [{ body: "x", path: "a.html" }], idempotencyKey: " key-1 " };
  const lost = await artifactsReview(client(() => Response.json({ error: "bad gateway" }, { status: 502 })), request, { hints: "tool" });
  assert.ok(!lost.ok && lost.error.retryable);
  assert.deepEqual(lost.next?.kind, "retry_same_key");
  assert.deepEqual(lost.next?.args, { idempotencyKey: "key-1" });

  const sent: unknown[] = [];
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json(posted, { status: 200 });
      },
    },
  });
  const replayed = await artifactsReview(api, request, { hints: "tool" });
  assert.ok(replayed.ok && replayed.state === "replayed", replayed.ok ? replayed.state : replayed.error.message);
  assert.equal(replayed.data.idempotencyKey, "key-1");
  assert.equal((sent[0] as { idempotencyKey?: string }).idempotencyKey, "key-1");
  assert.equal(replayed.text, [
    `Already posted: an earlier attempt of this same review went through, so nothing was posted or told again. It is rv_1, on v12 of "Proto" (pt_abc): 1 comment on a.html, with a summary.`,
    "Comments, in order: c_9.",
    `To read it back: artifacts_comments({ artifact: "pt_abc", review: "rv_1" })`,
    "",
  ].join("\n"));

  const reused = await artifactsReview(client(refuse(409, "IDEMPOTENCY_KEY_REUSED")), request, { hints: "tool" });
  assert.ok(!reused.ok && reused.error.serverCode === "IDEMPOTENCY_KEY_REUSED" && !reused.error.retryable && reused.next?.kind !== "retry_same_key", reused.ok ? "" : reused.error.message);
  assert.equal(reused.error.message, "A review was already posted under that idempotencyKey, and this request differs from it (an edit, another version, or images uploaded again under new ids). Nothing more was posted.");
  assert.ok(reused.error.nextAction.startsWith(`See the review that was posted among your comments: artifacts_comments({ artifact: "pt_abc", all: true }). Only to post a second review, call artifacts_review(`), reused.error.nextAction);

  // Replayed after its comments were deleted: says so, lists none.
  const gone = await artifactsReview(client(() => Response.json({ ...posted, comments: [] }, { status: 200 })), request);
  assert.ok(gone.ok && gone.state === "replayed");
  assert.ok(gone.text.includes(`It is rv_1, on v12 of "Proto" (pt_abc): its comments since deleted.`) && !gone.text.includes("Comments, in order"), gone.text);
});

const SUMMARY = { id: "pt_abc", url: "https://app.raft.build/artifacts/pt_abc", name: "workspace-prototype", title: "Workspace prototype", description: null, kind: "html", home: { kind: "server" }, currentVersion: 12, author: { type: "agent", name: "Remy" }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-22T14:02:00.000Z" };

test("list with a query: sent as query, most relevant first, a line for a match outside the title, and the top result's read and file", async () => {
  const calls: Call[] = [];
  const page = {
    artifacts: [
      { ...SUMMARY, matches: [
        { field: "title", snippet: "Workspace prototype", highlights: [{ start: 0, length: 9 }] },
        // Offsets are code points: the emoji is one.
        { field: "content", path: "notes/plan.md", snippet: "🚀 the workspace rollout; ask @Kirby", highlights: [{ start: 6, length: 9 }] },
      ] },
      { ...SUMMARY, id: "pt_def", title: "Q4 report", matches: [] },
    ],
    nextCursor: "c2",
    target: null,
  };
  const out = await artifactsList(client(() => Response.json(page), calls), { query: " workspace ", limit: 2 });
  assert.ok(out.ok);
  assert.equal(calls[0]?.path, `${BASE}?query=workspace&limit=2`);
  assert.equal(out.text, [
    `Artifacts you can see with "workspace" in the title, most relevant first:`,
    `- pt_abc "Workspace prototype" · v12, updated 2026-10-22 14:02:00Z · created by @Remy · home: the whole server`,
    // The title match repeats the row's title: no line. A match elsewhere (not searched today) keeps one.
    "  in notes/plan.md: 🚀 the <match>workspace</match> rollout; ask user:Kirby",
    `- pt_def "Q4 report" · v12, updated 2026-10-22 14:02:00Z · created by @Remy · home: the whole server`,
    "More: raft artifact list --query 'workspace' --cursor c2 --limit 2",
    `Next: raft artifact read pt_abc; the file it matched in: raft artifact download pt_abc 'notes/plan.md' --output <file>`,
    "",
  ].join("\n"));

  const tool = await artifactsList(client(() => Response.json(page)), { query: "workspace" }, { hints: "tool" });
  assert.ok(tool.ok);
  assert.match(tool.text, /\nMore: artifacts_list\(\{ query: "workspace", cursor: "c2" \}\)\nNext: artifacts_read\(\{ artifact: "pt_abc" \}\); the file it matched in: artifacts_file_content\(\{ artifact: "pt_abc", path: "notes\/plan.md" \}\)\n$/);
});

test("list with a query, nothing found: only titles are searched, the same search everywhere, and the messages", async () => {
  const none = { artifacts: [], nextCursor: null, target: { target: "#ops", conversationId: "c-3", homeFromThread: null } };
  const out = await artifactsList(client(() => Response.json(none)), { query: "rollout's plan", target: "#ops" });
  assert.ok(out.ok);
  assert.equal(out.state, "empty");
  assert.equal(out.text, [
    `No artifacts you can see with home #ops have "rollout's plan" in the title. Only titles are searched, and every word has to be in the title: try fewer or other words.`,
    "In every conversation: raft artifact list --query 'rollout'\\''s plan'",
    "Messages: raft message search --query 'rollout'\\''s plan'",
    "",
  ].join("\n"));
});

test("list with a query: an over-long one is refused before any request, saying what to do", async () => {
  const calls: Call[] = [];
  const out = await artifactsList(client(() => Response.json({}), calls), { query: "字".repeat(201) });
  assert.ok(!out.ok);
  assert.equal(out.error.code, "INVALID_REQUEST");
  assert.match(out.error.message, /query is longer than 200 characters: use fewer words/);
  assert.deepEqual(calls, []);
  // 200 code points is fine, however many UTF-16 units.
  const ok = await artifactsList(client(() => Response.json({ artifacts: [], nextCursor: null, target: null })), { query: "😀".repeat(200) });
  assert.ok(ok.ok);
});

test("artifactsMatchQuery: one row asked for; Artifacts off, a failure or no client is no", async () => {
  const calls: Call[] = [];
  assert.equal(await artifactsMatchQuery(client(() => Response.json({ artifacts: [{ ...SUMMARY, matches: [] }], nextCursor: null, target: null }), calls), { query: " plan ", target: "#ops:abcd1234" }), true);
  assert.equal(calls[0]?.path, `${BASE}?target=${encodeURIComponent("#ops:abcd1234")}&query=plan&limit=1`);
  assert.equal(await artifactsMatchQuery(client(() => Response.json({ artifacts: [], nextCursor: null, target: null })), { query: "plan" }), false);
  assert.equal(await artifactsMatchQuery(client(refuse(403, "ARTIFACTS_NOT_ENABLED")), { query: "plan" }), false);
  assert.equal(await artifactsMatchQuery(client(() => { throw new Error("network down"); }), { query: "plan" }), false);
  // A Server without search ignores the query: a plain list, no `matches`.
  assert.equal(await artifactsMatchQuery(client(() => Response.json({ artifacts: [SUMMARY], nextCursor: null, target: null })), { query: "plan" }), false);
});

test("message search: a first-page text search adds the Artifacts line when they match; filters it can't apply skip the probe", async () => {
  const hits = { results: [], hasMore: false };
  const routed = (artifacts: () => Response) => (path: string) => path.startsWith(BASE) ? artifacts() : Response.json(hits);
  const calls: Call[] = [];
  const HIT = { artifacts: [{ ...SUMMARY, matches: [] }], nextCursor: null, target: null };
  const match = await searchMessages(client(routed(() => Response.json(HIT)), calls), { query: "rollout plan", target: "#ops" });
  assert.ok(match.ok);
  assert.equal(match.state, "empty", "the line does not change what the message search found");
  assert.equal(match.text, `No search results. (truncated=false)\nArtifacts also match "rollout plan": raft artifact list --query 'rollout plan' --target "#ops"`);
  assert.deepEqual(calls.map((c) => c.path).sort(), [`${BASE}?target=%23ops&query=rollout+plan&limit=1`, "/internal/agent-api/search?q=rollout+plan&channel=%23ops"].sort());

  const tool = await searchMessages(client(routed(() => Response.json(HIT))), { query: "plan" }, { hints: "tool" });
  assert.ok(tool.ok);
  assert.match(tool.text, /\nArtifacts also match "plan": artifacts_list\(\{ query: "plan" \}\)$/);

  const off = await searchMessages(client(routed(refuse(403, "ARTIFACTS_NOT_ENABLED"))), { query: "plan" });
  assert.ok(off.ok);
  assert.equal(off.text, "No search results. (truncated=false)");

  for (const request of [{ query: "plan", sender: "alice" }, { query: "plan", after: "2026-10-01T00:00:00Z" }, { query: "plan", before: "2026-10-01T00:00:00Z" }, { query: "plan", offset: 20 }, { query: "plan", sort: "recent" as const, cursor: "CUR" }, { target: "#ops" }]) {
    const seen: Call[] = [];
    await searchMessages(client(routed(() => Response.json(HIT)), seen), request);
    assert.ok(seen.every((c) => !c.path.startsWith(BASE)), `${JSON.stringify(request)}: no Artifacts probe`);
  }
});

test("message search: a slow Artifacts probe is given a short grace once the search answered, then left out", async () => {
  const hits = { results: [], hasMore: false };
  const slow = client((path) => path.startsWith(BASE)
    ? new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ artifacts: [{ ...SUMMARY, matches: [] }], nextCursor: null, target: null })), 3_000)) as never
    : Response.json(hits));
  const started = Date.now();
  const out = await searchMessages(slow, { query: "plan" });
  const took = Date.now() - started;
  assert.ok(out.ok);
  assert.equal(out.text, "No search results. (truncated=false)");
  assert.ok(took >= ARTIFACTS_PROBE_GRACE_MS - 50 && took < 2_000, `waited ${took} ms`);
});

test("list text: a highlight on a quoted @handle or #channel covers it whole and neutralises it; overlapping, unsorted and out-of-range highlights", async () => {
  const page = (snippet: string, highlights: Array<{ start: number; length: number }>) => ({
    artifacts: [{ ...SUMMARY, matches: [{ field: "description", snippet, highlights }] }],
    nextCursor: null,
    target: null,
  });
  const line = async (snippet: string, highlights: Array<{ start: number; length: number }>) => {
    const out = await artifactsList(client(() => Response.json(page(snippet, highlights))), { query: "x" });
    assert.ok(out.ok);
    return out.text.split("\n")[2];
  };
  assert.equal(await line("ask @Kirby in #ops", [{ start: 5, length: 5 }, { start: 15, length: 3 }]), "  description: ask <match>user:Kirby</match> in <match>channel:ops</match>");
  assert.equal(await line("dm:@bob said so", [{ start: 4, length: 3 }]), "  description: <match>dm:user:bob</match> said so");
  // One highlight across two refs covers both whole.
  assert.equal(await line("ask @alice in dm:@bob x", [{ start: 5, length: 14 }]), "  description: ask <match>user:alice in dm:user:bob</match> x");
  // Unsorted and overlapping merge into one; past the end is clamped; one wholly outside drops.
  assert.equal(await line("rollout plan", [{ start: 8, length: 4 }, { start: 0, length: 9 }, { start: 40, length: 2 }]), "  description: <match>rollout plan</match>");
  assert.equal(await line("plan", [{ start: 2, length: 10 }]), "  description: pl<match>an</match>");
});

test("list text: a Server that ignored the query (no matches) is said so, not called a match", async () => {
  const out = await artifactsList(client(() => Response.json({ artifacts: [SUMMARY], nextCursor: null, target: null })), { query: "plan" });
  assert.ok(out.ok);
  assert.match(out.text, /^This server can't search artifacts yet, so "plan" was not applied\.\nArtifacts you can see, most recently updated first:\n/);
  assert.doesNotMatch(out.text, /matching/);
});

test("list with a blank query: refused before any request, saying what to do", async () => {
  const calls: Call[] = [];
  const out = await artifactsList(client(() => Response.json({}), calls), { query: "   " });
  assert.ok(!out.ok);
  assert.match(out.error.message, /query has no words: leave it out to list every artifact/);
  assert.deepEqual(calls, []);
});

test("move / delete: POST …/home { to: server } and DELETE, a link sent as its id; anyone-with-link refused before any request (public is no value of to); refusals in words", async () => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const recording = (script: () => Response) => createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        sent.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return script();
      },
    },
  });
  const moved = await artifactsMove(recording(() => Response.json({ artifact: summaryRow, from: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#ops" } } })), { artifact: "https://app.raft.build/artifacts/pt_abc", to: "server" });
  assert.ok(moved.ok && moved.state === "moved", JSON.stringify(moved));
  assert.ok(moved.text.startsWith(`Moved "Proto" (pt_abc) to the whole server:`) && moved.text.includes("An agent can't move it back; a person can, from the web, to #ops, unless that conversation is shared with another server or has guests."), moved.text);
  const deleted = await artifactsDelete(recording(() => Response.json({ artifact: { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 13 }, deleted: true })), { artifact: "proto" });
  assert.ok(deleted.ok && deleted.state === "deleted" && deleted.text.startsWith(`Deleted "Proto" (pt_abc):`), JSON.stringify(deleted));
  assert.deepEqual(sent, [
    { method: "POST", path: `${BASE}/pt_abc/home`, body: { to: "server" } },
    { method: "DELETE", path: `${BASE}/proto`, body: undefined },
  ]);

  // A model asking for link sharing is told who can, and what it can do instead: nothing is sent.
  sent.length = 0;
  const toPublic = await artifactsMove(recording(() => { throw new Error("no request expected"); }), { artifact: "pt_abc", to: "anyone-with-link" }, { hints: "tool" });
  assert.ok(!toPublic.ok);
  assert.deepEqual([toPublic.error.code, toPublic.error.serverCode, toPublic.error.message], ["INVALID_REQUEST", "FORBIDDEN", "Only a person can turn on link sharing (anyone with the link can then open it)."]);
  assert.equal(toPublic.error.nextAction, `Ask a person who manages it to choose "Anyone with the link" under "Who can see" in its ⋯ menu on the web. To let the whole server see it: artifacts_move({ artifact: "pt_abc", to: "server" })`);
  // `public`, the wire name of that home, is no value of `to`: refused as any other.
  for (const to of ["nowhere", "public"]) {
    const nowhere = await artifactsMove(recording(() => { throw new Error("no request expected"); }), { artifact: "pt_abc", to: to as never });
    assert.ok(!nowhere.ok && nowhere.error.code === "INVALID_REQUEST" && !nowhere.error.serverCode && nowhere.error.message.startsWith("Invalid request: to:"), JSON.stringify(nowhere));
  }
  assert.deepEqual(sent, []);

  const forbidden = await artifactsDelete(client(refuse(403, "FORBIDDEN", { title: "Proto", author: { type: "user", name: "xxchan" } })), { artifact: "pt_abc" });
  assert.ok(!forbidden.ok);
  assert.deepEqual([forbidden.error.serverCode, forbidden.error.message], ["FORBIDDEN", `You can't delete "Proto": only its author (@xxchan), the person who manages an agent author, and the server's owners and admins can.`]);
  const wide = await artifactsMove(client(refuse(409, "HOME_NOT_WIDER", { title: "Proto", home: "server", to: "server" })), { artifact: "pt_abc", to: "server" });
  assert.ok(!wide.ok);
  assert.deepEqual([wide.error.code, wide.error.serverCode, wide.error.message], ["CONFLICT", "HOME_NOT_WIDER", `"Proto" is already visible to the whole server; nothing changed.`]);
  const taken = await artifactsMove(client(refuse(409, "NAME_TAKEN", { name: "proto" })), { artifact: "pt_abc", to: "server" });
  assert.ok(!taken.ok && taken.error.message === `Another artifact visible to the whole server is already named "proto", so this one can't move there.`, JSON.stringify(taken));
});

test("save an attachment: POST …/save-attachment { attachmentId } trimmed, saved or already saved; a refusal in the Artifacts' words, the tool style naming operations", async () => {
  const id = "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const answering = (created: boolean) => createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        sent.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return Response.json({ artifact: { ...summaryRow, home: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#ops" } }, currentVersion: 1 }, created, attachment: { id, filename: "proto.html" } }, { status: created ? 201 : 200 });
      },
    },
  });
  const made = await artifactsSaveAttachment(answering(true), { attachmentId: ` ${id} ` });
  assert.ok(made.ok && made.state === "saved" && made.text.startsWith(`Saved proto.html as "Proto" (pt_abc) in #ops: whoever can see #ops can open it`), JSON.stringify(made));
  const again = await artifactsSaveAttachment(answering(false), { attachmentId: id }, { hints: "tool" });
  assert.ok(again.ok && again.state === "already_saved" && again.text.includes(`artifacts_read({ artifact: "pt_abc" })`), JSON.stringify(again));
  assert.deepEqual(sent, [
    { method: "POST", path: `${BASE}/save-attachment`, body: { attachmentId: id } },
    { method: "POST", path: `${BASE}/save-attachment`, body: { attachmentId: id } },
  ]);

  const blank = await artifactsSaveAttachment(client(() => { throw new Error("no request expected"); }), { attachmentId: " " });
  assert.ok(!blank.ok && blank.error.code === "INVALID_REQUEST", JSON.stringify(blank));
  const missing = await artifactsSaveAttachment(client(refuse(404, "ATTACHMENT_NOT_FOUND", { attachmentId: id })), { attachmentId: id }, { hints: "tool" });
  assert.ok(!missing.ok);
  assert.deepEqual([missing.error.code, missing.error.serverCode], ["NOT_FOUND", "ATTACHMENT_NOT_FOUND"]);
  assert.equal(missing.error.nextAction, `Check the id: it is the one after the file name, (id:…), when you read the conversation: messages_read({ target: "<conversation>" }). If the id is right, attachments_download_url({ attachmentId: "${id}" }) answers HISTORY_LIMITED when its message is older than the history limit.`);
  const hidden = await artifactsSaveAttachment(client(refuse(409, "ALREADY_SAVED", { attachmentId: id })), { attachmentId: id });
  assert.ok(!hidden.ok && hidden.error.serverCode === "ALREADY_SAVED" && hidden.error.message === "That attachment was already saved as an artifact you can't see; nothing new was made.", JSON.stringify(hidden));
});

test("429 RATE_LIMITED (core's per-agent write limit): the Server's sentence, the wait, retryable, no command in tool style; an upload's too; anything else unchanged", async () => {
  const writes = { error: "This agent made too many artifact changes: the limit is 60 a minute. Retry in 23 seconds.", code: "RATE_LIMITED", details: { operation: "artifactComment", limit: 60, windowSeconds: 60, retryAfterSeconds: 23 } };
  const limited = await artifactsComment(client(() => Response.json(writes, { status: 429, headers: { "Retry-After": "23" } })), { artifact: "pt_abc", body: "hi" }, { hints: "tool" });
  assert.ok(!limited.ok);
  assert.deepEqual(
    [limited.error.message, limited.error.status, limited.error.serverCode, limited.error.retryable, limited.error.retryAfterSeconds],
    [writes.error, 429, "RATE_LIMITED", true, 23],
  );
  assert.equal(limited.error.nextAction, "Wait 23 seconds, then make the same request again (the refused one changed nothing).");
  assert.ok(limited.text.includes(`Error: ${writes.error}`) && limited.text.includes("Retryable: yes"), limited.text);

  const uploads = { ...writes, error: "This agent made too many artifact file uploads: the limit is 600 a minute. Retry in 1 second.", details: { ...writes.details, operation: "artifactUpload", limit: 600, retryAfterSeconds: 1 } };
  const upload = artifactUploadFailure(429, uploads, "cli");
  assert.deepEqual([upload.error.message, upload.error.retryAfterSeconds, upload.error.nextAction], [uploads.error, 1, "Wait 1 second, then make the same request again (the refused one changed nothing)."]);

  // A sentence that isn't one short line: a stand-in from the details.
  const long = artifactUploadFailure(429, { ...writes, error: "x\ny" }, "cli");
  assert.equal(long.error.message, "Too many writes of this kind: the limit is 60 per 60 seconds. Retry in 23 seconds.");
  // Not the declared body (no details, a bad wait), or not a 429: no wait; the Server's sentence, as for any refusal.
  for (const [status, body] of [[429, { error: "slow down", code: "RATE_LIMITED" }], [429, { ...writes, details: { ...writes.details, retryAfterSeconds: 0 } }], [403, writes]] as const) {
    const other = artifactUploadFailure(status, body, "cli");
    assert.equal(other.error.retryAfterSeconds, undefined, JSON.stringify(body));
    assert.equal(other.error.message, body.error);
  }
  // No sentence the client can show (none, or not one line): its own.
  // A bare code or word in `error` ("invalid_scope", "Unauthorized") is not a sentence either.
  for (const body of [{ code: "SOMETHING" }, { error: "two\nlines", code: "SOMETHING" }, { error: "x ".repeat(251), code: "SOMETHING" }, { error: "invalid_scope", code: "INVALID_SCOPE" }, { error: "Unauthorized" }]) {
    assert.equal(artifactUploadFailure(403, body, "cli").error.message, "The Raft Server rejected the request.", JSON.stringify(body).slice(0, 80));
  }
});

// ---- publish check (#130) ---------------------------------------------------------

/** A Server answering the check route from a script of answers (the last one repeats), recording each request with its query. */
function checkServer(answers: Array<object>, calls: Call[] = []): AgentApiClient {
  let n = 0;
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}` });
        if (url.pathname.endsWith("/check/phone") || url.pathname.endsWith("/check/desktop")) {
          return url.pathname.endsWith("/desktop")
            ? new Response(BYTES, { headers: { "content-type": "image/png" } })
            : Response.json({ error: "screenshot not found", code: "SCREENSHOT_NOT_FOUND", details: { shot: "phone", version: 13 } }, { status: 404 });
        }
        const answer = answers[Math.min(n, answers.length - 1)]!;
        n += 1;
        return "status" in answer && typeof answer.status === "number" ? Response.json(answer, { status: answer.status as number }) : Response.json(answer);
      },
    },
  });
}

const checkAnswer = (status: "pending" | "running" | "done" | "failed" | "skipped" | null, over: object = {}) => ({
  artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 },
  version: 13,
  check: status === null ? null : {
    id: "5f0c2d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f", status, skipReason: null, errorClass: null,
    findings: status === "done" ? { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null } : null,
    createdAt: "2026-11-04T10:00:00.000Z", finishedAt: status === "pending" || status === "running" ? null : "2026-11-04T10:01:12.000Z",
    screenshots: status === "done" ? [{ shot: "desktop" }, { shot: "phone" }] : [],
    ...over,
  },
});

/** A clock that only moves when the operation sleeps. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return { sleeps, now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}

test("check: one read, the version from a link or the request; no wait without wait; none when the version has no check", async () => {
  const calls: Call[] = [];
  const clock = fakeClock();
  const waits: string[] = [];
  const pending = await artifactsCheck(checkServer([checkAnswer("pending")], calls), { artifact: "https://app.raft.build/artifacts/pt_abc/v/13" }, { ...clock, onWait: (text) => waits.push(text) });
  assert.ok(pending.ok);
  assert.equal(pending.state, "pending");
  assert.equal(pending.data.timedOut, false);
  assert.deepEqual(calls.map((c) => c.path), [`${BASE}/pt_abc/check?version=13`]);
  assert.equal(clock.sleeps.length, 0);
  // (Counted, not compared with []: that would narrow `waits` to never[] for the calls below.)
  assert.equal(waits.length, 0);
  assert.equal(pending.text, formatArtifactCheck(checkAnswer("pending") as never));

  const none = await artifactsCheck(checkServer([checkAnswer(null)]), { artifact: "pt_abc", wait: true }, fakeClock());
  assert.ok(none.ok);
  assert.equal(none.state, "none");
  // Done at once: nothing to wait for.
  const doneCalls: Call[] = [];
  const done = await artifactsCheck(checkServer([checkAnswer("done")], doneCalls), { artifact: "pt_abc", version: 13, wait: true }, { ...fakeClock(), onWait: (text) => waits.push(text) });
  assert.ok(done.ok);
  assert.equal(done.state, "done");
  assert.equal(doneCalls.length, 1);
  assert.deepEqual(waits, []);
});

test("check with wait: asks every 5 s on the version first read, pending → running → done within the window, told once", async () => {
  assert.equal(ARTIFACT_CHECK_WAIT_MS, 90_000);
  assert.equal(ARTIFACT_CHECK_POLL_MS, 5_000);
  const calls: Call[] = [];
  const clock = fakeClock();
  const waits: Array<[string, number]> = [];
  const out = await artifactsCheck(
    checkServer([checkAnswer("pending"), checkAnswer("pending"), checkAnswer("running"), checkAnswer("done")], calls),
    { artifact: "pt_abc", wait: true },
    { ...clock, hints: "tool", onWait: (text, version) => waits.push([text, version]) },
  );
  assert.ok(out.ok);
  assert.equal(out.state, "done");
  assert.equal(out.data.timedOut, false);
  assert.deepEqual(waits, [["Waiting up to 90 s for the publish check of v13…\n", 13]]);
  assert.deepEqual(clock.sleeps, [5000, 5000, 5000]);
  // The first read is the current version's; the wait stays on that version (v13), whatever is current meanwhile.
  assert.deepEqual(calls.map((c) => c.path), [`${BASE}/pt_abc/check`, `${BASE}/pt_abc/check?version=13`, `${BASE}/pt_abc/check?version=13`, `${BASE}/pt_abc/check?version=13`]);
  assert.equal(out.text, formatArtifactCheck(checkAnswer("done") as never, "tool"));
  assert.ok(out.text.includes("A program can download them with artifacts.checkShot."));
});

test("check with wait: still pending at 90 s is timedOut, and the text says to run it again", async () => {
  const calls: Call[] = [];
  const clock = fakeClock();
  const out = await artifactsCheck(checkServer([checkAnswer("pending")], calls), { artifact: "pt_abc", wait: true }, clock);
  assert.ok(out.ok);
  assert.equal(out.state, "pending");
  assert.equal(out.data.timedOut, true);
  // 18 polls of 5 s: the last one at exactly 90 s after the call started, then no more.
  assert.equal(clock.sleeps.length, 18);
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 90_000);
  assert.equal(calls.length, 19);
  assert.equal(out.text, [
    `Publish check of "Workspace prototype" v13 (pt_abc): not started yet. Raft usually opens the page within a minute of the push.`,
    "Still not finished after waiting 90 s.",
    "Next: run this to keep waiting: raft artifact check pt_abc --rev 13 --wait",
    "",
  ].join("\n"));

  // A clock that moves on its own (requests take time): the last sleep is cut to what is left of the 90 s.
  let now = 0;
  const sleeps: number[] = [];
  const slow = await artifactsCheck(checkServer([checkAnswer("running")]), { artifact: "pt_abc", wait: true }, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms + 1_500; },
  });
  assert.ok(slow.ok && slow.data.timedOut);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 5000), JSON.stringify(sleeps));
  assert.ok(sleeps.reduce((a, b) => a + b, 0) + sleeps.length * 1_500 >= 90_000);
});

test("check: refusals in the Artifacts' words (a refusal while waiting too); a bad request is refused before any request", async () => {
  const hidden = await artifactsCheck(checkServer([{ status: 404, error: "not visible", code: "NOT_VISIBLE" }]), { artifact: "pt_zzz" }, fakeClock());
  assert.ok(!hidden.ok);
  assert.equal(hidden.error.serverCode, "NOT_VISIBLE");
  assert.equal(hidden.error.message, `No artifact "pt_zzz" that you can see (by that id, link or exact title).`);
  const version = await artifactsCheck(checkServer([{ status: 404, error: "no such version", code: "VERSION_NOT_FOUND", details: { version: 40, currentVersion: 13 } }]), { artifact: "pt_abc", version: 40 }, fakeClock());
  assert.ok(!version.ok);
  assert.equal(version.error.message, `"pt_abc" has no version 40 that you can read (the current one is v13).`);
  const midWait = await artifactsCheck(checkServer([checkAnswer("pending"), { status: 404, error: "not visible", code: "NOT_VISIBLE" }]), { artifact: "pt_abc", wait: true }, fakeClock());
  assert.ok(!midWait.ok);
  assert.equal(midWait.error.serverCode, "NOT_VISIBLE");
  const calls: Call[] = [];
  const bad = await artifactsCheck(checkServer([checkAnswer("done")], calls), { artifact: "pt_abc", version: 0 }, fakeClock());
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, "INVALID_REQUEST");
  assert.deepEqual(calls, []);
});

test("checkShot: the PNG's bytes for a version; SCREENSHOT_NOT_FOUND in words, pointing at the version's check; an unknown shot is refused before any request", async () => {
  const calls: Call[] = [];
  const api = checkServer([], calls);
  const desktop = await artifactsCheckShot(api, { artifact: "pt_abc", version: 13, shot: "desktop" });
  assert.ok(desktop.ok);
  assert.deepEqual([...desktop.data.bytes], [...BYTES]);
  assert.equal(desktop.data.shot, "desktop");
  assert.equal(desktop.text, "desktop screenshot: 3 bytes\n");
  const phone = await artifactsCheckShot(api, { artifact: "https://app.raft.build/artifacts/pt_abc/v/13", shot: "phone" }, { hints: "tool" });
  assert.ok(!phone.ok);
  assert.equal(phone.error.code, "NOT_FOUND");
  assert.equal(phone.error.serverCode, "SCREENSHOT_NOT_FOUND");
  assert.equal(phone.error.message, `v13 of "pt_abc" has no phone screenshot from its publish check.`);
  assert.equal(phone.error.nextAction, `Read the version's check: artifacts_check({ artifact: "pt_abc", version: 13 }). Only a check that is done has screenshots, and only the newest three checked versions of an Artifact keep theirs.`);
  assert.deepEqual(calls.map((c) => c.path), [`${BASE}/pt_abc/check/desktop?version=13`, `${BASE}/pt_abc/check/phone?version=13`]);
  const before = calls.length;
  const tablet = await artifactsCheckShot(api, { artifact: "pt_abc", shot: "tablet" as never });
  assert.ok(!tablet.ok);
  assert.equal(tablet.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, before);
});

// ── images in comments (#146) ──

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const keptImage = { fileId: "f-1", contentType: "image/png", sizeBytes: 319_488, width: 1280, height: 800 };

test("comment with images: their ids go to the Server in order; with one the body may be empty; without, an empty body is still refused", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const created = { artifact: { id: "pt_abc", title: "Proto", currentVersion: 12 }, comment: { id: "c_9", author: { type: "agent", name: "Sage" }, version: 12, path: null, anchor: null, replyTo: null, body: "", createdAt: "2026-10-22T00:00:00.000Z", editedAt: null, images: [keptImage] }, notified: [], notNotified: [], newlySubscribed: false };
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(created, { status: 201 });
      },
    },
  });
  const out = await artifactsComment(api, { artifact: "pt_abc", body: "", images: ["f-1", "f-2"] });
  assert.ok(out.ok, out.ok ? "" : out.error.message);
  assert.deepEqual(calls, [{ path: `${BASE}/pt_abc/comments`, body: { body: "", images: ["f-1", "f-2"] } }]);
  assert.ok(out.text.includes("\n  Images (1):\n    1. PNG 1280x800, 312 KiB: raft artifact download pt_abc --image f-1 --output comment-c_9-1.png\n"), out.text);
  const blank = await artifactsComment(api, { artifact: "pt_abc", body: " ", images: [] });
  assert.ok(!blank.ok && blank.error.message === "Invalid request: body: the comment is empty. Nothing was sent.", blank.ok ? "" : blank.error.message);
  const five = await artifactsComment(api, { artifact: "pt_abc", body: "x", images: ["a", "b", "c", "d", "e"] });
  assert.ok(!five.ok && five.error.message.includes("a comment takes at most 4 images"), five.ok ? "" : five.error.message);
  assert.equal(calls.length, 1);
});

test("comment image upload (SDK, over fetch): POST …/comment-images with the raw bytes; what the Server kept; refused locally, nothing sent", async () => {
  const seen: Array<{ url: string; method?: string; type: string | null; auth: string | null; size: number }> = [];
  const transport = (status: number, body?: unknown) => ({
    serverUrl: "https://raft.example",
    headers: {},
    authorization: "Bearer sk_agent_test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(input), method: init?.method, type: h.get("content-type"), auth: h.get("authorization"), size: (init?.body as ArrayBuffer).byteLength });
      return body === undefined ? new Response(null, { status }) : Response.json(body, { status });
    }) as typeof fetch,
  });
  const ok = await artifactsCommentImageUpload(artifactCommentImageUploaderForFetch(transport(201, keptImage)), { artifact: "https://app.raft.build/artifacts/pt_abc", bytes: PNG_BYTES });
  assert.ok(ok.ok, ok.ok ? "" : ok.error.message);
  assert.deepEqual(ok.data, keptImage);
  assert.equal(ok.text, `Uploaded image f-1 (PNG 1280x800, 312 KiB) for a comment on "pt_abc". Comment with it within the hour (unused, it is gone), its fileId in images: raft artifact comment pt_abc\n`);
  assert.deepEqual(seen, [{ url: `https://raft.example${BASE}/pt_abc/comment-images`, method: "POST", type: "application/octet-stream", auth: "Bearer sk_agent_test", size: PNG_BYTES.byteLength }]);

  // Bytes the Server would refuse are refused here.
  const svg = await artifactsCommentImageUpload(artifactCommentImageUploaderForFetch(transport(201, keptImage)), { artifact: "pt_abc", bytes: new TextEncoder().encode("<svg/>") }, { hints: "tool" });
  assert.ok(!svg.ok);
  assert.equal(svg.error.code, "INVALID_REQUEST");
  assert.equal(svg.error.message, "The image is not a PNG, JPEG, WebP or GIF image (checked by its first bytes). Nothing was sent.");
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  big.set(PNG_BYTES);
  const tooBig = await artifactsCommentImageUpload(artifactCommentImageUploaderForFetch(transport(201, keptImage)), { artifact: "pt_abc", bytes: big }, { named: "--image ./big.png" });
  assert.ok(!tooBig.ok && tooBig.error.message === "--image ./big.png is 10.1 MiB; an image can be at most 10 MiB. Nothing was sent.", tooBig.ok ? "" : tooBig.error.message);
  assert.equal(seen.length, 1, "nothing sent for either");

  // An answer that isn't an image's metadata.
  const odd = await artifactsCommentImageUpload(artifactCommentImageUploaderForFetch(transport(201, { fileId: "f-1" })), { artifact: "pt_abc", bytes: PNG_BYTES });
  assert.ok(!odd.ok && odd.error.code === "INVALID_RESPONSE");
  const down = await artifactsCommentImageUpload(async () => null, { artifact: "pt_abc", bytes: PNG_BYTES });
  assert.ok(!down.ok && down.error.code === "TRANSPORT_ERROR");
});

test("comment image upload refusals: a Server without the route (404, no code) says so; the image's own refusals name it and say nothing was posted; the Artifact's don't", async () => {
  const answer = (status: number, body: unknown) => async () => ({ status, body });
  const named = { named: "--image ./a.png" };
  const old = await artifactsCommentImageUpload(answer(404, { error: "Not found" }), { artifact: "pt_abc", bytes: PNG_BYTES }, named);
  assert.ok(!old.ok);
  assert.deepEqual([old.error.code, old.error.status, old.error.serverCode], ["NOT_FOUND", 404, undefined]);
  const oldNoBody = await artifactsCommentImageUpload(answer(404, null), { artifact: "pt_abc", bytes: PNG_BYTES }, { hints: "tool" });
  assert.ok(!oldNoBody.ok && oldNoBody.error.nextAction === "Post the comment without images, or describe the image in words.");

  const refused = await artifactsCommentImageUpload(answer(422, { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "too_many_pixels", limit: 40_000_000 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, named);
  assert.ok(!refused.ok);
  assert.equal(refused.error.serverCode, "IMAGE_REFUSED");
  assert.equal(refused.error.message, "--image ./a.png: The image wasn't kept: it has more than 40000000 pixels. Nothing was posted.");
  assert.equal(refused.error.nextAction, "Send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.");
  // Unnamed (a program's upload): the Artifacts' sentence alone.
  const plain = await artifactsCommentImageUpload(answer(422, { error: "x", code: "IMAGE_REFUSED", details: { reason: "unsupported_type" } }), { artifact: "pt_abc", bytes: PNG_BYTES });
  assert.ok(!plain.ok && plain.error.message === "The image wasn't kept: it isn't a PNG, JPEG, WebP or GIF image.");

  // NOT_VISIBLE has its Artifacts code: the Artifact's refusal, not the old Server's.
  const hidden = await artifactsCommentImageUpload(answer(404, { error: "artifact not visible", code: "NOT_VISIBLE" }), { artifact: "pt_abc", bytes: PNG_BYTES }, named);
  assert.ok(!hidden.ok);
  assert.equal(hidden.error.serverCode, "NOT_VISIBLE");
  assert.equal(hidden.error.message, `No artifact "pt_abc" that you can see (by that id, link or exact title).`);
  const forbidden = await artifactsCommentImageUpload(answer(403, { error: "x", code: "FORBIDDEN" }), { artifact: "pt_abc", bytes: PNG_BYTES }, named);
  assert.ok(!forbidden.ok && forbidden.error.message === `You can see "pt_abc" but can't comment on it: only members and agents of its server can.`);
});

test("comment image download: the bytes and their type; IMAGE_NOT_FOUND in words, pointing at the comments; a blank id refused before any request", async () => {
  const calls: Call[] = [];
  const api = client((path) => (path.endsWith("/comment-images/f-1")
    ? new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
    : Response.json({ error: "no such image", code: "IMAGE_NOT_FOUND", details: { fileId: "f-9" } }, { status: 404 })), calls);
  const ok = await artifactsCommentImage(api, { artifact: "https://app.raft.build/artifacts/pt_abc", fileId: "f-1" });
  assert.ok(ok.ok);
  assert.deepEqual([...ok.data.bytes], [...PNG_BYTES]);
  assert.equal(ok.data.contentType, "image/png");
  const missing = await artifactsCommentImage(api, { artifact: "pt_abc", fileId: "f-9" }, { hints: "tool" });
  assert.ok(!missing.ok);
  assert.equal(missing.error.serverCode, "IMAGE_NOT_FOUND");
  assert.equal(missing.error.message, `No image f-9 on a comment of "pt_abc" that you can see.`);
  assert.equal(missing.error.nextAction, `Its id is on the comment's Images line: artifacts_comments({ artifact: "pt_abc", all: true })`);
  assert.deepEqual(calls.map((c) => c.path), [`${BASE}/pt_abc/comment-images/f-1`, `${BASE}/pt_abc/comment-images/f-9`]);
  const blank = await artifactsCommentImage(api, { artifact: "pt_abc", fileId: " " });
  assert.ok(!blank.ok && blank.error.code === "INVALID_REQUEST");
  assert.equal(calls.length, 2);
});

// ---- images in review comments (#146 phase 3b) ----------------------------------

test("review with images: each comment's ids go to the Server in order; with one its body may be empty; too many refused naming the comment, nothing sent", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const at = { author: { type: "agent", name: "Sage" }, version: 12, anchor: null, replyTo: null, createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_1" };
  const created = {
    artifact: { id: "pt_abc", name: "proto", title: "Proto", currentVersion: 12 },
    review: { id: "rv_1", author: { type: "agent", name: "Sage" }, version: 12, body: null, createdAt: "2026-10-27T18:30:00.000Z" },
    comments: [{ ...at, id: "c_9", path: "a.html", body: "", images: [keptImage, keptImage] }, { ...at, id: "c_10", path: null, body: "and text" }],
    notified: [], notNotified: [], newlySubscribed: false,
  };
  const api = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json(created, { status: 201 });
      },
    },
  });
  const out = await artifactsReview(api, { artifact: "pt_abc", comments: [{ body: "", path: "a.html", images: ["f-1", "f-2"] }, { body: "and text", images: [] }] }, { hints: "tool" });
  assert.ok(out.ok, out.ok ? "" : out.error.message);
  assert.deepEqual(calls, [{ path: `${BASE}/pt_abc/reviews`, body: { comments: [{ body: "", path: "a.html", images: ["f-1", "f-2"] }, { body: "and text" }], idempotencyKey: out.data.idempotencyKey } }]);
  assert.ok(out.text.includes("\nComments, in order: c_9 (2 images), c_10.\n"), out.text);

  const local = client(() => { throw new Error("no request expected"); });
  // Without images an empty body is still refused, naming the comment.
  const blank = await artifactsReview(local, { artifact: "pt_abc", comments: [{ body: "a" }, { body: " ", images: [] }] });
  assert.ok(!blank.ok && blank.error.message === "Comment 2 of 2 (the whole artifact): The comment is empty. Nothing of the review was posted.", blank.ok ? "" : blank.error.message);
  const five = await artifactsReview(local, { artifact: "pt_abc", comments: [{ body: "a" }, { body: "b", path: "b.html", images: ["1", "2", "3", "4", "5"] }] }, { hints: "tool" });
  assert.ok(!five.ok);
  assert.equal(five.error.code, "INVALID_REQUEST");
  assert.equal(five.error.message, "Comment 2 of 2 (b.html): A comment takes at most 4 images (5 given). Nothing of the review was posted.");
  assert.equal(five.error.nextAction, "Fix comment 2, then make the same review call again. Keep 4 in this comment and put the others in another comment of the review.");

  // An id that isn't the agent's unused upload: the Server's IMAGE_NOT_FOUND names the comment, "nothing posted" said once.
  const notFound = await artifactsReview(client(refuse(400, "IMAGE_NOT_FOUND", { fileId: "f-9", index: 0, path: "a.html" })), { artifact: "pt_abc", comments: [{ body: "", path: "a.html", images: ["f-9"] }] }, { hints: "tool" });
  assert.ok(!notFound.ok && notFound.error.serverCode === "IMAGE_NOT_FOUND");
  assert.equal(notFound.error.message, `Comment 1 of 1 (a.html): "f-9" isn't an image you uploaded to "pt_abc" that no comment has yet. Nothing of the review was posted.`);
});

test("artifactsReviewRefusal: the review's checks without a request, its images only counted (the CLI's are file paths)", () => {
  const longPath = `./${"d/".repeat(120)}shot.png`;
  assert.equal(artifactsReviewRefusal({ artifact: "pt_abc", comments: [{ body: "", path: "a.html", images: [longPath] }, { body: "b" }] }), null);
  const blank = artifactsReviewRefusal({ artifact: "pt_abc", comments: [{ body: "a", images: ["./a.png"] }, { body: "  " }] });
  assert.ok(blank && blank.error.message === "Comment 2 of 2 (the whole artifact): The comment is empty. Nothing of the review was posted.", blank?.error.message);
  const five = artifactsReviewRefusal({ artifact: "pt_abc", comments: [{ body: "", replyTo: "c_812", images: ["./1.png", "./2.png", "./3.png", "./4.png", "./5.png"] }] });
  assert.ok(five && five.error.message === "Comment 1 of 1 (the reply to c_812): A comment takes at most 4 images (5 given). Nothing of the review was posted.", five?.error.message);
  const badPath = artifactsReviewRefusal({ artifact: "pt_abc", comments: [{ body: "", path: "../x", images: ["./a.png"] }] });
  assert.ok(badPath && badPath.error.serverCode === "INVALID_PATH", badPath?.error.message);
});

test("an image uploaded for a review's comment: its own refusals name the comment and the image; the rest say nothing of the review was posted; an older Server says post the review without images", async () => {
  const answer = (status: number, body: unknown) => async () => ({ status, body });
  const forReview = { named: "image ./a.png", reviewComment: { index: 2, total: 5, commentPath: "docs/a.html" } };
  const refused = await artifactsCommentImageUpload(answer(413, { error: "x", code: "IMAGE_REFUSED", details: { reason: "too_large", limit: 10 * 1024 * 1024 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!refused.ok);
  assert.equal(refused.error.serverCode, "IMAGE_REFUSED");
  assert.equal(refused.error.message, "Comment 3 of 5 (docs/a.html): image ./a.png: The image wasn't kept: it is larger than 10 MiB. Nothing of the review was posted.");
  assert.equal(refused.error.nextAction, "Fix comment 3, then run the same command again. Send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.");
  const old = await artifactsCommentImageUpload(answer(404, { error: "Not found" }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!old.ok && old.error.serverCode === undefined && old.error.status === 404);
  assert.deepEqual([old.error.message, old.error.nextAction], ["This Server can't take images in comments yet; nothing was posted.", "Post the review without images, or describe the images in words."]);
  const hidden = await artifactsCommentImageUpload(answer(404, { error: "x", code: "NOT_VISIBLE" }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!hidden.ok && hidden.error.message === `No artifact "pt_abc" that you can see (by that id, link or exact title). Nothing of the review was posted.`, hidden.ok ? "" : hidden.error.message);
  const down = await artifactsCommentImageUpload(async () => null, { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!down.ok && down.error.code === "TRANSPORT_ERROR" && down.error.message.endsWith(" Nothing of the review was posted."), down.ok ? "" : down.error.message);
  // Bytes refused here: the comment's frame too.
  const svg = await artifactsCommentImageUpload(answer(201, keptImage), { artifact: "pt_abc", bytes: new TextEncoder().encode("<svg/>") }, forReview);
  assert.ok(!svg.ok && svg.error.message === "Comment 3 of 5 (docs/a.html): image ./a.png is not a PNG, JPEG, WebP or GIF image (checked by its first bytes). Nothing of the review was posted.", svg.ok ? "" : svg.error.message);
  // A rate limit is left as the Server said it (the CLI says what it left behind in its wait).
  const limited = await artifactsCommentImageUpload(answer(429, { error: "This agent made too many image uploads: the limit is 30 a minute. Retry in 12 seconds.", code: "RATE_LIMITED", details: { operation: "artifactCommentImageUpload", limit: 30, windowSeconds: 60, retryAfterSeconds: 12 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!limited.ok && limited.error.retryAfterSeconds === 12 && !limited.error.message.includes("Nothing of the review"), limited.ok ? "" : limited.error.message);
});

test("an image uploaded for a review's comment refused for the server's sake (its quota, its storage, its images full) or the upload request's: its own words, nothing of the review posted, the whole review's next step, no comment blamed; cut short, the comment and image named, no fix asked", async () => {
  const answer = (status: number, body: unknown) => async () => ({ status, body });
  const forReview = { named: "image ./a.png", reviewComment: { index: 2, total: 5, commentPath: "docs/a.html" } };
  const billingUrl = "https://app.raft.build/s/team/settings/billing";
  const monthlyQuota = { plan: "free", limitBytes: 100 * 1024 * 1024, usedBytes: 100 * 1024 * 1024 };
  const quota = await artifactsCommentImageUpload(answer(403, { error: "Monthly file upload quota exceeded.", code: "FILE_UPLOAD_QUOTA_EXCEEDED", billingUrl, details: { requestedBytes: 12, quota: monthlyQuota, billingUrl } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!quota.ok);
  assert.equal(quota.error.serverCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
  assert.equal(quota.error.message, "Not stored: this server's monthly file upload quota is used up (100 MiB of 100 MiB used this month). The Free plan includes 100 MB of uploads a month, and comment images count against it as attachments do. Nothing of the review was posted.");
  assert.equal(quota.error.nextAction, `Say in the conversation that the image wasn't stored and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}. Until then, take "images" out of the JSON and run the same command again (describe the images in words instead).`);

  const storage = await artifactsCommentImageUpload(answer(503, { error: "image storage is not configured", code: "ARTIFACTS_STORAGE_UNAVAILABLE" }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!storage.ok);
  assert.equal(storage.error.serverCode, "ARTIFACTS_STORAGE_UNAVAILABLE");
  assert.equal(storage.error.message, "The image couldn't be stored: this server's file storage for Artifacts isn't set up. Nothing of the review was posted.");
  assert.equal(storage.error.nextAction, `Take "images" out of the JSON and run the same command again (describe the images in words instead), and tell a human admin of this server.`);

  const full = await artifactsCommentImageUpload(answer(413, { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "server_quota_exceeded", limit: 1024, used: 1024 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!full.ok);
  assert.deepEqual([full.error.message, full.error.nextAction], [
    "The image wasn't kept: this server's images are full. Nothing of the review was posted.",
    `Take "images" out of the JSON and run the same command again (describe the images in words instead), or tell a human admin of this server.`,
  ]);
  // The tool's words keep the review call (the SDK, or a tool that uploads for a review).
  const fullTool = await artifactsCommentImageUpload(answer(413, { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "server_quota_exceeded", limit: 1024, used: 1024 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, { ...forReview, hints: "tool" });
  assert.ok(!fullTool.ok && fullTool.error.nextAction === "Post the review without images (describe them in words), or tell a human admin of this server.", fullTool.ok ? "" : fullTool.error.nextAction);

  // The uploader's own limit on their server is not the image's fault either: nothing of the review to fix.
  const mine = await artifactsCommentImageUpload(answer(413, { error: "image not kept", code: "IMAGE_REFUSED", details: { reason: "uploader_quota_exceeded", scope: "drafts", limit: 1024, used: 1024 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!mine.ok);
  assert.ok(mine.error.message.endsWith(" Nothing of the review was posted.") && !mine.error.nextAction.includes("Fix comment"), mine.error.nextAction);

  const noLength = await artifactsCommentImageUpload(answer(411, { error: "Content-Length is required", code: "CONTENT_LENGTH_REQUIRED" }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!noLength.ok && noLength.error.nextAction === `This is a client bug: tell a human, and take "images" out of the JSON and run the same command again (describe the images in words instead) meanwhile.`, noLength.ok ? "" : noLength.error.nextAction);

  for (const refused of [quota, storage, full, noLength]) {
    assert.ok(!refused.ok);
    assert.ok(!refused.error.message.startsWith("Comment ") && !refused.error.message.includes("image ./a.png"), refused.error.message);
    assert.ok(refused.error.message.endsWith(" Nothing of the review was posted.") && !refused.error.nextAction.includes("Fix comment"), refused.error.nextAction);
  }

  // Cut short on the way: an image's words, not a push's; the comment and the image named, but nothing in it to fix.
  const cut = await artifactsCommentImageUpload(answer(400, { error: "x", code: "SIZE_MISMATCH", details: { path: null, size: 12, actual: 8 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, forReview);
  assert.ok(!cut.ok);
  assert.equal(cut.error.serverCode, "SIZE_MISMATCH");
  assert.deepEqual([cut.error.message, cut.error.nextAction], [
    "Comment 3 of 5 (docs/a.html): image ./a.png: The image didn't arrive whole (12 bytes sent, 8 received). Nothing of the review was posted.",
    "Run the same command again; if it's refused again, tell a human (it's a client bug).",
  ]);
  const cutComment = await artifactsCommentImageUpload(answer(400, { error: "x", code: "SIZE_MISMATCH", details: { path: null, size: 12, actual: 8 } }), { artifact: "pt_abc", bytes: PNG_BYTES }, { named: "--image ./a.png" });
  assert.ok(!cutComment.ok);
  assert.deepEqual([cutComment.error.message, cutComment.error.nextAction], [
    "--image ./a.png: The image didn't arrive whole (12 bytes sent, 8 received). Nothing was posted.",
    "Run the same command again; if it's refused again, tell a human (it's a client bug).",
  ]);

  // `raft artifact comment --image` keeps its words: the image named, nothing posted, the comment's next step.
  const forComment = await artifactsCommentImageUpload(answer(503, { error: "image storage is not configured", code: "ARTIFACTS_STORAGE_UNAVAILABLE" }), { artifact: "pt_abc", bytes: PNG_BYTES }, { named: "--image ./a.png" });
  assert.ok(!forComment.ok);
  assert.deepEqual([forComment.error.message, forComment.error.nextAction], [
    "--image ./a.png: The image couldn't be stored: this server's file storage for Artifacts isn't set up. Nothing was posted.",
    "Post the comment without it, and tell a human admin of this server.",
  ]);
});
