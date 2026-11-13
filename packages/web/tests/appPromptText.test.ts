// The web side of app prompt-text consent (#proj-apps task #4): the text a page
// shows is the text agents get, and the API readers follow the agreed contract
// and tolerate absence (an older server, or the flag off).
import assert from "node:assert/strict";
import {
  appTextChangedCurrent,
  expectedTextRevisionBody,
  isPromptTextReviewGoneError,
  isPromptTextReviewStaleError,
  readClientPromptTextState,
  readInstallCardPromptText,
  readInstalledAppPromptTextState,
  readPromptTextRevisionId,
} from "../src/lib/appPromptText";

function apiRevision(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    revision: 3,
    state: "active",
    name: "Orbital Notes",
    description: null,
    when_to_use: "When asked.",
    created_at: "2026-10-20T00:00:00.000Z",
    reviewed_at: null,
    reject_reason: null,
    ...extra,
  };
}

test("install entry points read only promptTextRevisionId; the card reads its bound raw text", () => {
  assert.equal(readPromptTextRevisionId({ promptTextRevisionId: "rev-1" }), "rev-1");
  assert.equal(readPromptTextRevisionId({}), null);
  assert.ok(readInstallCardPromptText({}) === null);
  assert.deepEqual(
    readInstallCardPromptText({ installTextRevisionId: "rev-4", installText: { name: "N", description: "D", whenToUse: "W" } }),
    { revisionId: "rev-4", fields: { name: "N", description: "D", whenToUse: "W" } },
  );
});

test("installed app: prompt_text { confirmed, current, confirmation_required }; confirmed may be null", () => {
  assert.ok(readInstalledAppPromptTextState({ approval_required: false }) === null);
  const state = readInstalledAppPromptTextState({
    prompt_text: { confirmed: null, current: apiRevision("rev-9"), confirmation_required: true },
  });
  assert.ok(state);
  assert.ok(state.confirmed === null);
  assert.equal(state.current?.id, "rev-9");
  assert.equal(state.current?.whenToUse, "When asked.");
  assert.equal(state.current?.revision, 3);
  assert.equal(state.confirmationRequired, true);
});

test("developer/reviewer state: a self-built app needs confirmation when the local confirmed revision isn't current", () => {
  const state = readClientPromptTextState({
    current: apiRevision("rev-2"),
    pending: apiRevision("rev-3", { state: "pending_review" }),
    rejected: apiRevision("rev-1", { state: "rejected", reject_reason: "Too vague" }),
    local_confirmed_revision_id: "rev-1",
    can_review: true,
  });
  assert.ok(state);
  assert.equal(state.pending?.state, "pending_review");
  assert.equal(state.rejected?.rejectReason, "Too vague");
  assert.equal(state.canReview, true);
  assert.equal(state.localConfirmationRequired, true);
  assert.equal(readClientPromptTextState({ current: apiRevision("rev-2"), local_confirmed_revision_id: "rev-2" })?.localConfirmationRequired, false);
  assert.equal(readClientPromptTextState({ current: null, local_confirmed_revision_id: null })?.localConfirmationRequired, false);
});

test("the expected text revision is sent only when one was shown", () => {
  assert.deepEqual(expectedTextRevisionBody("rev-1"), { expected_text_revision_id: "rev-1" });
  assert.deepEqual(expectedTextRevisionBody(null), {});
});

test("a 409 APP_PERMISSIONS_CHANGED naming a different text revision carries the current text", () => {
  const conflict = (revisionId: string) => ({
    response: {
      status: 409,
      data: {
        code: "APP_PERMISSIONS_CHANGED",
        current_scopes: ["openid"],
        current_groups: [],
        current_text_revision_id: revisionId,
        current_text: { name: "N", description: null, when_to_use: "W" },
      },
    },
  });
  assert.deepEqual(appTextChangedCurrent(conflict("rev-2"), "rev-1"), {
    revisionId: "rev-2",
    fields: { name: "N", description: null, whenToUse: "W" },
  });
  // Same revision: the permissions changed, not the text.
  assert.ok(appTextChangedCurrent(conflict("rev-1"), "rev-1") === null);
  assert.ok(appTextChangedCurrent({ response: { status: 400, data: { code: "EXPECTED_PERMISSIONS_REQUIRED" } } }, "rev-1") === null);
  assert.ok(appTextChangedCurrent(new Error("network"), "rev-1") === null);
});

test("review errors: 409 PROMPT_TEXT_REVIEW_STALE is stale, 404 is gone", () => {
  assert.equal(isPromptTextReviewStaleError({ response: { status: 409, data: { code: "PROMPT_TEXT_REVIEW_STALE" } } }), true);
  assert.equal(isPromptTextReviewStaleError({ response: { status: 409, data: { code: "OTHER" } } }), false);
  assert.equal(isPromptTextReviewGoneError({ response: { status: 404, data: {} } }), true);
  assert.equal(isPromptTextReviewGoneError({ response: { status: 409, data: {} } }), false);
});
