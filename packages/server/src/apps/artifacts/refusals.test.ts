// The Artifacts app's refusals in the Server's refusal envelope (#wg-ax:#13,
// docs/contracts/agent-api-refusals.md): one representative per family has
// the envelope's shape (errorCode = code, the step written from `next` on the
// agent API, nothing but the envelope's fields) and a sentence that passes
// refusalSentenceProblem and says what to do (a step after its colon or
// semicolon); the "you can't see it" refusals are one body for every reason
// and the same sentence on every API. The routes' own bodies are pinned by
// each route's api test.
import assert from "node:assert/strict";
import { formatHint, RAFT_HINTS, refusalSentenceProblem } from "@botiverse/raft-shared";
import {
  ARTIFACTS_NOT_ENABLED,
  ARTIFACTS_NOT_ENABLED_ERROR,
  commentNotFound,
  fail,
  fileNotFound,
  imageNotClaimable,
  invalidPath,
  mayNotTakePart,
  NOT_VISIBLE_ERROR,
  notVisible,
  storageUnavailable,
  TARGET_NOT_FOUND_ERROR,
  targetNotFound,
  unseenChangesError,
  versionNotFound,
  type ArtifactApiError,
} from "./apiCommon";
import { INTERNAL_ROUTE_NOT_FOUND, WORKER_UNAUTHORIZED } from "./checkRoutes";
import type { ArtifactManageRefusal } from "./manage";
import { TITLE_REQUIRED_ERROR } from "./publish";
import { ALREADY_SAVED_ERROR, ATTACHMENT_NOT_FOUND_ERROR, attachmentTooLargeError } from "./save";
import {
  fileNotFramed,
  notFramed,
  webBadBody,
  webContentUnavailable,
  webFail,
  webFileNotFound,
  webImageNotClaimable,
  webInvalidPath,
  webManageRefusal,
  webNotVisible,
  webVersionNotFound,
  type ArtifactWebApiError,
} from "./webCommon";

const ENVELOPE_KEYS = new Set(["error", "code", "errorCode", "retryAfterSeconds", "next", "suggestedNextAction", "details"]);

/** The envelope's shape and a sentence an agent or a person can act on. */
function assertRefusal(answer: ArtifactApiError | ArtifactWebApiError, label: string): void {
  const { body } = answer;
  for (const key of Object.keys(body)) assert.ok(ENVELOPE_KEYS.has(key), `${label}: ${key} isn't an envelope field`);
  assert.equal(body.errorCode, body.code, `${label}: errorCode is the code, for older clients`);
  assert.equal(refusalSentenceProblem(body.error), null, `${label}: "${body.error}"`);
  assert.match(body.error, /^[A-Z]/, `${label}: a sentence starts with a capital`);
  assert.match(body.error, /[:;] \S/, `${label}: the sentence goes on to what to do`);
  if (body.next) assert.equal(body.suggestedNextAction, formatHint(body.next, "cli"), `${label}: the step for clients that predate next`);
}

/** Every web answer: no `next` (the web ignores it). */
function assertWebRefusal(answer: ArtifactWebApiError, label: string): void {
  assertRefusal(answer, label);
  assert.equal(answer.body.next, undefined, `${label}: no next on the web`);
}

test("access refusals: one body for every reason, the same sentence on the agent, web and signed-out APIs", () => {
  // Built anew per answer, yet equal: nothing about the reason can get in.
  assert.deepEqual(notVisible(), notVisible());
  assert.deepEqual(webNotVisible(), webNotVisible());
  assert.deepEqual(notVisible().body, {
    error: NOT_VISIBLE_ERROR,
    code: "NOT_VISIBLE",
    errorCode: "NOT_VISIBLE",
    next: RAFT_HINTS.artifactList({}),
    suggestedNextAction: "raft artifact list",
  });
  assert.deepEqual(webNotVisible(), { kind: "error", status: 404, body: { error: NOT_VISIBLE_ERROR, code: "NOT_VISIBLE", errorCode: "NOT_VISIBLE" } });
  // A manage refusal that stands in for "can't see it" is that same 404.
  assert.deepEqual(webManageRefusal({ kind: "not_visible" }), webNotVisible());
  assertRefusal(notVisible(), "NOT_VISIBLE (agent)");
  assertWebRefusal(webNotVisible(), "NOT_VISIBLE (web)");

  assert.deepEqual([ARTIFACTS_NOT_ENABLED.status, ARTIFACTS_NOT_ENABLED.body], [403, { error: ARTIFACTS_NOT_ENABLED_ERROR, code: "ARTIFACTS_NOT_ENABLED", errorCode: "ARTIFACTS_NOT_ENABLED" }]);
  assertRefusal(ARTIFACTS_NOT_ENABLED, "ARTIFACTS_NOT_ENABLED");

  // A conversation that isn't there and one the caller can't see: details echo what was sent, never what was found.
  const agentTarget = targetNotFound({ target: "#plans" });
  assert.equal(agentTarget.status, 404);
  assert.equal(agentTarget.body.error, TARGET_NOT_FOUND_ERROR);
  assert.deepEqual(agentTarget.body.details, { target: "#plans" });
  assertRefusal(agentTarget, "TARGET_NOT_FOUND (agent)");
  const webTarget = webManageRefusal({ kind: "target_not_found", conversationId: "c1" });
  assert.deepEqual(webTarget.body, { error: TARGET_NOT_FOUND_ERROR, code: "TARGET_NOT_FOUND", errorCode: "TARGET_NOT_FOUND", details: { conversationId: "c1" } });
  assertWebRefusal(webTarget, "TARGET_NOT_FOUND (web)");

  // An attachment not there, not the caller's to see, or behind the history limit.
  const attachment = fail(404, { code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId: "a1" } });
  assertRefusal(attachment, "ATTACHMENT_NOT_FOUND");
  // An image id that isn't the caller's own unused upload, for every reason.
  assertRefusal(fail(400, imageNotClaimable("f1")), "IMAGE_NOT_FOUND (agent)");
  assertWebRefusal(webFail(400, webImageNotClaimable("f1")), "IMAGE_NOT_FOUND (web)");

  // The Workers' routes: one 401 and one 404 for every route and reason.
  assert.equal(refusalSentenceProblem(INTERNAL_ROUTE_NOT_FOUND.error), null);
  assert.equal(refusalSentenceProblem(WORKER_UNAUTHORIZED.error), null);
});

test("read refusals: the version, the file, the path, storage", () => {
  const missing = versionNotFound("pt_a", 9, 2);
  assert.deepEqual(missing.body.details, { version: 9, currentVersion: 2 });
  assert.match(missing.body.error, /no version 9 that you can read \(the current one is v2\)/);
  assert.deepEqual(missing.body.next, RAFT_HINTS.artifactRead({ artifact: "pt_a" }));
  assertRefusal(missing, "VERSION_NOT_FOUND");
  assertRefusal(versionNotFound("pt_a", null, null), "VERSION_NOT_FOUND (none published)");
  assertWebRefusal(webVersionNotFound(9, 2), "VERSION_NOT_FOUND (web)");
  assert.equal(webVersionNotFound(9, undefined).body.details, undefined, "the web's details only with both numbers");

  const file = fileNotFound("pt_a", "a.html", 3);
  assert.deepEqual(file.body.details, { path: "a.html", version: 3 });
  assert.deepEqual(file.body.next, RAFT_HINTS.artifactRead({ artifact: "pt_a", version: 3, files: true }));
  assertRefusal(file, "FILE_NOT_FOUND");
  assertWebRefusal(webFileNotFound("a.html", 3), "FILE_NOT_FOUND (web)");
  assertRefusal(invalidPath("../x"), "INVALID_PATH");
  assertWebRefusal(webInvalidPath("../x"), "INVALID_PATH (web)");
  assertRefusal(storageUnavailable(), "ARTIFACTS_STORAGE_UNAVAILABLE");
  assertWebRefusal(webContentUnavailable(), "CONTENT_UNAVAILABLE (web)");
  assertWebRefusal(notFramed(), "NOT_FRAMED");
  assert.deepEqual(fileNotFramed("notes.md").body.details, { path: "notes.md" });
  assertWebRefusal(fileNotFramed("notes.md"), "NOT_FRAMED (a file)");
});

test("push refusals: a new artifact's title is the contract's own example", () => {
  assert.equal(TITLE_REQUIRED_ERROR, "A new artifact needs a title: give it one, or give its entry page a <title>.");
  assertRefusal(fail(400, { code: "TITLE_REQUIRED", error: TITLE_REQUIRED_ERROR, suggestedNextAction: "Give the push a title." }), "TITLE_REQUIRED");
  // A held push says how many comments hold it, and the way on, in one line naming no command.
  const held = unseenChangesError("push", { comments: 3, versions: 0, unread: 1 });
  assert.match(held, /^Held, not pushed: since you last looked, others commented on what you're changing \(3 comments\); read the 1 comment still unseen in full first/);
  assertRefusal(fail(409, { code: "UNSEEN_CHANGES", error: held, next: RAFT_HINTS.artifactComments({ artifact: "pt_a" }), details: { unseen: {} } }), "UNSEEN_CHANGES (push)");
});

test("comment and review refusals: taking part, replies, images, a held comment", () => {
  for (const verb of ["comment on it", "follow it", "review it", "push to it"] as const) assertRefusal(mayNotTakePart(verb), `FORBIDDEN (${verb})`);
  assertRefusal(fail(404, commentNotFound("pt_a", "c_1")), "COMMENT_NOT_FOUND");
  assert.deepEqual(fail(404, commentNotFound("pt_a", "c_1")).body.details, { replyTo: "c_1" });
  for (const what of ["comment", "review"] as const) {
    assertRefusal(fail(409, { code: "UNSEEN_CHANGES", error: unseenChangesError(what, { comments: 1, versions: 2, unread: 0 }) }), `UNSEEN_CHANGES (${what})`);
  }
  assertWebRefusal(webBadBody("an ArtifactWebCommentInput"), "INVALID_REQUEST (web)");
});

test("manage refusals: every kind the web answers is a sentence with its way on", () => {
  const refusals: ArtifactManageRefusal[] = [
    { kind: "forbidden", reason: "Only the artifact's author can move it: ask them to." },
    { kind: "not_wider", home: "server", to: "server" },
    { kind: "not_wider", home: "public", to: "server" },
    { kind: "not_narrower", home: "conversation", to: "conversation" },
    { kind: "not_public", home: "server" },
    { kind: "name_taken", name: "plan" },
    { kind: "target_not_found", conversationId: "c1" },
    { kind: "target_not_supported", conversationId: "c1", reason: "thread" },
    { kind: "target_not_supported", conversationId: "c1", reason: "joint" },
    { kind: "target_has_guests", conversationId: "c1", reason: "guest_members" },
    { kind: "target_has_guests", conversationId: "c1", reason: "open_to_guests" },
    { kind: "author_loses_access", reason: "cannot_see" },
    { kind: "author_loses_access", reason: "agent_not_member" },
    { kind: "loss_changed", expected: 2, actual: 3, capped: false },
    { kind: "not_original_home", originalConversationId: null },
  ];
  for (const refusal of refusals) assertWebRefusal(webManageRefusal(refusal), `${refusal.kind} ${JSON.stringify(refusal)}`);
  // The listed codes the web branches on keep their details.
  assert.deepEqual(webManageRefusal({ kind: "loss_changed", expected: 2, actual: 3, capped: false }).body.details, { expected: 2, actual: 3, capped: false });
});

test("save refusals: already saved and too large", () => {
  assertRefusal(fail(409, { code: "ALREADY_SAVED", error: ALREADY_SAVED_ERROR, details: { attachmentId: "a1" } }), "ALREADY_SAVED");
  assertRefusal(fail(422, { code: "ATTACHMENT_NOT_SAVABLE", error: attachmentTooLargeError(15 * 1024 * 1024), details: { attachmentId: "a1", reason: "too_large" } }), "ATTACHMENT_NOT_SAVABLE");
});

test("a malformed sentence is refused where it is written, in tests and development", () => {
  assert.throws(() => fail(400, { code: "agent_api_contract_invalid", error: "malformed" }), /single word/);
  assert.throws(() => fail(400, { code: "TITLE_REQUIRED", error: "Pass --title to name it." }), /names a command or a flag/);
  assert.throws(() => webFail(400, { code: "INVALID_REQUEST", error: "Run raft artifact list first." }), /names a command or a flag/);
});
