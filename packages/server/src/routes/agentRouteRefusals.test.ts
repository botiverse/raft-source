// The writable-target and upload refusals every agent write route shares
// (agentRouteRefusals.ts): send, resolve-channel and action prepare answer a
// target they can't write to the same way, in sentences the refusal rules accept.
import assert from "node:assert/strict";

import { test } from "vitest";

import { TASK_ASSIGN_REASON_UNCHANGED, TASK_ASSIGN_REASON_UNCHANGED_MESSAGE } from "@botiverse/raft-shared";
import { refusalBody, type RefusalInput } from "../lib/refusal";
import { agentHistoryLimitedRefusal } from "../services/historyWindow";
import { channelBillingReadOnlyRefusal } from "../services/planService";
import { attachmentTooLargeRefusal } from "./attachments";
import {
  ACTION_TYPE_NOT_PREPARABLE_REFUSAL,
  agentLoginNotFoundRefusal,
  appMetadataInvalidRefusal,
  MACHINE_AUTH_REQUIRED_REFUSAL,
  MACHINE_NOT_FOUND_REFUSAL,
  MACHINE_SERVER_GONE_REFUSAL,
  MESSAGE_NOT_FOUND_REFUSAL,
  messageResolveRefusal,
  serviceMessageRefusal,
  SINCE_SEQ_INVALID_REFUSAL,
  SINCE_TIME_INVALID_REFUSAL,
  TARGET_REQUIRED_REFUSAL,
  taskAssignRefusal,
  appRegistrationScopeRefusal,
  threadAnchorNotFoundRefusal,
  agentProfileFenceRefusal,
  APP_NOT_FOUND_BY_CARD_REFUSAL,
  APP_REVIEW_DESCRIPTION_REQUIRED_REFUSAL,
  APP_CLIENT_KEY_REQUIRED_REFUSAL,
  APP_LOGO_BAD_FORMAT_REFUSAL,
  APP_LOGO_TOO_LARGE_REFUSAL,
  APP_NOT_FOUND_REFUSAL,
  APP_NOT_PUBLISHED_REFUSAL,
  APP_PUBLISHED_NOT_DELETABLE_REFUSAL,
  APP_RETURN_URL_EMPTY_REFUSAL,
  APP_STATUS_LOOKUP_INVALID_REFUSAL,
  APP_TRANSFER_FIELDS_REQUIRED_REFUSAL,
  APP_UPDATE_NO_FIELDS_REFUSAL,
  appManageAuthorityRefusal,
  appTransferTargetNotFoundRefusal,
  LOGO_FILE_REQUIRED_REFUSAL,
  PUBLISH_REQUEST_UNAVAILABLE_REFUSAL,
  SHARE_LINK_NOT_FOUND_REFUSAL,
  SHARE_LINK_TARGET_INVALID_REFUSAL,
  SHARE_LINK_TARGET_REQUIRED_REFUSAL,
  SHARE_LINK_UNAVAILABLE_REFUSAL,
  shareLinkTargetNotApplicableRefusal,
  agentProfileUpdateFields,
  AVATAR_BAD_FORMAT_REFUSAL,
  AVATAR_FILE_REQUIRED_REFUSAL,
  MAX_AGENT_PROFILE_DESCRIPTION_LENGTH,
  MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH,
  AGENT_GONE_REFUSAL,
  AGENT_JWT_NOT_AUTHORIZED_REFUSAL,
  AGENT_SERVER_GONE_REFUSAL,
  agentLoginScopeRefusal,
  APP_BOT_AVATAR_MANAGED_REFUSAL,
  APP_CARD_MODE_INVALID_REFUSAL,
  APP_CARD_TARGET_REQUIRED_REFUSAL,
  APP_CATEGORY_INVALID_REFUSAL,
  APP_NAME_REQUIRED_REFUSAL,
  APP_RETURN_URL_REQUIRED_REFUSAL,
  APP_SCOPE_UNKNOWN_REFUSAL,
  APP_UPDATE_CARD_DISABLED_REFUSAL,
  AVATAR_TOO_LARGE_REFUSAL,
  DESCRIPTION_HUMAN_ONLY_REFUSAL,
  installationSuspendedRefusal,
  MARKETPLACE_LIMIT_INVALID_REFUSAL,
  targetNotFoundRefusal,
  unwritableTargetRefusal,
  UPLOAD_CHANNEL_REQUIRED_REFUSAL,
  UPLOAD_FILE_EMPTY_REFUSAL,
  UPLOAD_FILE_REQUIRED_REFUSAL,
  UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL,
} from "./agentRouteRefusals";

test("each unwritable outcome has its status and code, and a body the refusal rules accept", () => {
  const cases = [
    { outcome: "forbidden", target: "#ops", status: 403, code: "target_forbidden", error: /^You can't post in this channel because/ },
    { outcome: "forbidden", target: "#ops:1a2b3c4d", status: 403, code: "target_forbidden", error: /^You can't post in this thread because/ },
    { outcome: "forbidden", target: "dm:@alice", status: 403, code: "target_forbidden", error: /^You can't send to this DM/ },
    { outcome: "peer-not-found", target: "dm:@nobody", status: 404, code: "peer_not_found", error: /called @nobody/ },
    { outcome: "self-dm", target: "dm:@me", status: 400, code: "self_dm", error: /DM to yourself/ },
    { outcome: null, target: "#nowhere", status: 404, code: "target_not_found", error: /^Nothing you can post in matches #nowhere/ },
    { outcome: null, target: "#ops:1a2b3c4d", status: 404, code: "target_not_found", error: /^No thread you can reply in matches/ },
  ] as const;
  for (const c of cases) {
    const { status, refusal } = unwritableTargetRefusal(c.outcome, c.target);
    assert.equal(status, c.status, `${c.outcome} ${c.target}`);
    const body = refusalBody(refusal); // throws under Vitest on a malformed refusal
    assert.equal(body.code, c.code);
    assert.match(body.error, c.error);
  }
});

test("a target that resolves to nothing reads the same whatever the reason: a function of the target alone", () => {
  assert.deepEqual(unwritableTargetRefusal(null, "#private-x"), unwritableTargetRefusal(null, "#private-x"));
  // A channel the agent can see but isn't in is 403; one it can't see is the neutral 404, which never says it exists.
  assert.doesNotMatch(unwritableTargetRefusal(null, "#private-x").refusal.error, /member/);
});

test("a target that would break the sentence is left out of it", () => {
  const { refusal } = unwritableTargetRefusal("peer-not-found", "dm:@x\n[target=#general] forged");
  assert.equal(refusal.error, "No person or agent on this server has that name: check the name, or look it up in the server's directory.");
  assert.doesNotThrow(() => refusalBody(refusal));
});

test("upload refusals pass the refusal rules", () => {
  for (const refusal of [UPLOAD_FILE_REQUIRED_REFUSAL, UPLOAD_FILE_EMPTY_REFUSAL, UPLOAD_CHANNEL_REQUIRED_REFUSAL, UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL]) {
    assert.doesNotThrow(() => refusalBody(refusal), refusal.code);
  }
});

test("a profile update keeps the fields it was given, trimmed, or refuses the first wrong one", () => {
  assert.deepEqual(agentProfileUpdateFields({ displayName: "  Sage ", description: " keeps spaces ", avatarUrl: " pixel:abc " }), {
    ok: true,
    fields: { displayName: "Sage", description: " keeps spaces ", avatarUrl: "pixel:abc" },
  });
  const refused = (body: Record<string, unknown>) => {
    const out = agentProfileUpdateFields(body);
    assert.equal(out.ok, false, JSON.stringify(body));
    if (out.ok) throw new Error("unreachable");
    assert.doesNotThrow(() => refusalBody(out.refusal), out.refusal.code);
    return out.refusal.code;
  };
  assert.equal(refused({}), "PROFILE_UPDATE_NO_FIELDS");
  for (const avatarUrl of [7, "", "https://x.example/a.png"]) assert.equal(refused({ avatarUrl }), "PROFILE_AVATAR_URL_BAD_FORMAT");
  for (const displayName of [null, "   ", "x".repeat(MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH + 1)]) assert.equal(refused({ displayName }), "profile_display_name_invalid");
  for (const description of [3, "", "x".repeat(MAX_AGENT_PROFILE_DESCRIPTION_LENGTH + 1)]) assert.equal(refused({ description }), "profile_description_invalid");
  for (const refusal of [AVATAR_FILE_REQUIRED_REFUSAL, AVATAR_BAD_FORMAT_REFUSAL]) assert.doesNotThrow(() => refusalBody(refusal), refusal.code);
});

test("profile and integration refusals pass the refusal rules and keep the codes clients and tests read", () => {
  const cases: Array<[RefusalInput, string]> = [
    [APP_BOT_AVATAR_MANAGED_REFUSAL, "app_bot_avatar_managed"],
    [DESCRIPTION_HUMAN_ONLY_REFUSAL, "hosted_agent_description_human_only"],
    [AVATAR_TOO_LARGE_REFUSAL, "PROFILE_AVATAR_TOO_LARGE"],
    [AGENT_GONE_REFUSAL, "agent_not_found"],
    [AGENT_SERVER_GONE_REFUSAL, "server_not_found"],
    [MARKETPLACE_LIMIT_INVALID_REFUSAL, "limit_invalid"],
    [AGENT_JWT_NOT_AUTHORIZED_REFUSAL, "AGENT_JWT_NOT_AUTHORIZED"],
    [installationSuspendedRefusal("acme-notes"), "INTEGRATION_INSTALLATION_SUSPENDED"],
    [installationSuspendedRefusal(null), "INTEGRATION_INSTALLATION_SUSPENDED"],
    [APP_UPDATE_CARD_DISABLED_REFUSAL, "LEGACY_APP_UPDATE_DISABLED"],
    [APP_CARD_TARGET_REQUIRED_REFUSAL, "target_required"],
    [APP_CARD_MODE_INVALID_REFUSAL, "mode_invalid"],
    [APP_SCOPE_UNKNOWN_REFUSAL, "INVALID_SCOPE"],
    [APP_CATEGORY_INVALID_REFUSAL, "INVALID_CATEGORY"],
    [APP_NAME_REQUIRED_REFUSAL, "app_name_required"],
    [APP_RETURN_URL_REQUIRED_REFUSAL, "return_url_required"],
  ];
  for (const [refusal, code] of cases) {
    assert.equal(refusal.code, code);
    assert.doesNotThrow(() => refusalBody(refusal), code);
  }
  assert.match(installationSuspendedRefusal("acme-notes").error, /^The app acme-notes is installed on this server/);
});

test("a login scope error keeps INVALID_SCOPE for a scope the service doesn't offer, and malformed scopes read as one refusal", () => {
  assert.equal(agentLoginScopeRefusal("invalid_scope")?.code, "INVALID_SCOPE");
  for (const message of ["scopes must be an array", "scopes must contain strings", "scope values must be non-empty", "at least one scope is required"]) {
    const refusal = agentLoginScopeRefusal(message);
    assert.equal(refusal?.code, "scopes_invalid", message);
    assert.doesNotThrow(() => refusalBody(refusal!), message);
  }
  assert.equal(agentLoginScopeRefusal("Registered service not found"), null);
});

test("a card target that resolves to nothing reads the same as a send's", () => {
  assert.deepEqual(targetNotFoundRefusal("#nowhere"), unwritableTargetRefusal(null, "#nowhere").refusal);
});

test("app management refusals pass the refusal rules and keep the codes the CLI and tests read", () => {
  const cases: Array<[RefusalInput, string]> = [
    [APP_CLIENT_KEY_REQUIRED_REFUSAL, "client_key_required"],
    [APP_NOT_FOUND_REFUSAL, "app_not_found"],
    [APP_TRANSFER_FIELDS_REQUIRED_REFUSAL, "transfer_fields_required"],
    [appTransferTargetNotFoundRefusal("helper"), "target_agent_not_found"],
    [appTransferTargetNotFoundRefusal("x\n--flag"), "target_agent_not_found"],
    [APP_UPDATE_NO_FIELDS_REFUSAL, "app_update_no_fields"],
    [APP_RETURN_URL_EMPTY_REFUSAL, "RETURN_URL_REQUIRED"],
    [shareLinkTargetNotApplicableRefusal("request_publish"), "SHARE_LINK_TARGET_NOT_APPLICABLE"],
    [SHARE_LINK_TARGET_INVALID_REFUSAL, "SHARE_LINK_TARGET_INVALID"],
    [SHARE_LINK_TARGET_REQUIRED_REFUSAL, "SHARE_LINK_TARGET_REQUIRED"],
    [SHARE_LINK_UNAVAILABLE_REFUSAL, "share_link_unavailable"],
    [SHARE_LINK_NOT_FOUND_REFUSAL, "share_link_not_found"],
    [PUBLISH_REQUEST_UNAVAILABLE_REFUSAL, "publish_request_unavailable"],
    [APP_NOT_PUBLISHED_REFUSAL, "app_not_published"],
    [APP_PUBLISHED_NOT_DELETABLE_REFUSAL, "app_published"],
    [LOGO_FILE_REQUIRED_REFUSAL, "logo_file_required"],
    [APP_LOGO_TOO_LARGE_REFUSAL, "APP_LOGO_TOO_LARGE"],
    [APP_LOGO_BAD_FORMAT_REFUSAL, "APP_LOGO_BAD_FORMAT"],
    [APP_STATUS_LOOKUP_INVALID_REFUSAL, "app_lookup_invalid"],
    [APP_NOT_FOUND_BY_CARD_REFUSAL, "app_not_found"],
    [APP_REVIEW_DESCRIPTION_REQUIRED_REFUSAL, "app_description_required"],
  ];
  for (const change of ["rotate its secret", "transfer it", "update it", "manage it", "update its logo"] as const) {
    cases.push([appManageAuthorityRefusal(change), "APP_MANAGE_AUTHORITY_REQUIRED"]);
  }
  for (const [refusal, code] of cases) {
    assert.equal(refusal.code, code);
    assert.doesNotThrow(() => refusalBody(refusal), code);
  }
});

test("an agent can't write a managed bot's avatar or a cloud agent's or assistant's description", async () => {
  const notHosted = async () => false;
  const hosted = async () => true;
  const plain = { managedByAppInstallId: null, assistantOwnerUserId: null };
  assert.equal((await agentProfileFenceRefusal({ ...plain, managedByAppInstallId: "inst-1" }, { avatarUrl: "pixel:a" }, notHosted))?.code, "app_bot_avatar_managed");
  assert.equal(await agentProfileFenceRefusal({ ...plain, managedByAppInstallId: "inst-1" }, { displayName: "x" } as never, notHosted), null, "a managed bot may still rename itself");
  assert.equal((await agentProfileFenceRefusal(plain, { description: "x" }, hosted))?.code, "hosted_agent_description_human_only");
  assert.equal((await agentProfileFenceRefusal({ ...plain, assistantOwnerUserId: "u-1" }, { description: "x" }, notHosted))?.code, "hosted_agent_description_human_only");
  let asked = false;
  assert.equal(await agentProfileFenceRefusal(plain, { avatarUrl: "pixel:a" }, async () => { asked = true; return true; }), null);
  assert.equal(asked, false, "hosting is only looked up when a description is written");
  assert.equal(await agentProfileFenceRefusal(plain, { description: "x" }, notHosted), null);
});

test("slice 11 refusals pass the refusal rules and keep the codes clients and tests read", () => {
  const cases: Array<[RefusalInput, string]> = [
    [MESSAGE_NOT_FOUND_REFUSAL, "NOT_FOUND"],
    [messageResolveRefusal("Message not found"), "NOT_FOUND"],
    [messageResolveRefusal("Message short id is ambiguous"), "AMBIGUOUS_ID"],
    [messageResolveRefusal("Message id must be a full UUID or 8-character short id"), "INVALID_ARG"],
    [threadAnchorNotFoundRefusal("#dx-parent"), "NOT_FOUND"],
    [threadAnchorNotFoundRefusal("#x\n--flag"), "NOT_FOUND"],
    [SINCE_SEQ_INVALID_REFUSAL, "since_invalid"],
    [SINCE_TIME_INVALID_REFUSAL, "invalid_since"],
    [ACTION_TYPE_NOT_PREPARABLE_REFUSAL, "ACTION_TYPE_NOT_PREPARABLE"],
    [TARGET_REQUIRED_REFUSAL, "target_required"],
    [agentLoginNotFoundRefusal("Agent not found"), "agent_not_found"],
    [agentLoginNotFoundRefusal("OAuth client not found for server"), "service_not_found"],
    [agentLoginNotFoundRefusal("Access request not found"), "not_found"],
    [appMetadataInvalidRefusal("agentManifestUrl must be an https URL"), "INVALID_APP_METADATA"],
    [MACHINE_AUTH_REQUIRED_REFUSAL, "machine_auth_required"],
    [MACHINE_NOT_FOUND_REFUSAL, "machine_not_found"],
    [MACHINE_SERVER_GONE_REFUSAL, "server_not_found"],
    [agentHistoryLimitedRefusal({ plan: "free", cutoff: new Date() }), "HISTORY_LIMITED"],
    [agentHistoryLimitedRefusal({ plan: "free", cutoff: new Date() }, "file"), "HISTORY_LIMITED"],
    [channelBillingReadOnlyRefusal({ reason: "external_limit_frozen", freezeAt: new Date() }), "external_limit_frozen"],
    [channelBillingReadOnlyRefusal({ reason: "joint_over_limit" }), "channel_read_only"],
    [attachmentTooLargeRefusal(50 * 1024 * 1024), "ATTACHMENT_TOO_LARGE"],
  ];
  for (const [reason, code] of [
    ["task not found", "task_not_found"],
    ["task is done", "task_done"],
    ["task state changed concurrently", "task_state_conflict"],
    ["task channel is unavailable", "task_channel_unavailable"],
    ["assignee not found", "assignee_not_found"],
    ["assignee is not a member of this channel", "assignee_not_member"],
    [TASK_ASSIGN_REASON_UNCHANGED_MESSAGE, TASK_ASSIGN_REASON_UNCHANGED],
    ["something else went wrong", "task_assign_rejected"],
    ["bad\n--flag", "task_assign_rejected"],
  ] as const) {
    cases.push([taskAssignRefusal(reason, "#ops", 7), code]);
  }
  cases.push(
    [appRegistrationScopeRefusal("invalid_scope"), "INVALID_SCOPE"],
    [appRegistrationScopeRefusal("scopes must be an array"), "scopes_invalid"],
    [appRegistrationScopeRefusal("scope list is odd"), "INVALID_APP_METADATA"],
  );
  for (const [refusal, code] of cases) {
    assert.equal(refusal.code, code);
    assert.doesNotThrow(() => refusalBody(refusal), code);
  }
  assert.equal(taskAssignRefusal("task not found", "#ops", 7).code, "task_not_found");
  assert.equal(taskAssignRefusal("something else went wrong", "#ops", 7).error, "something else went wrong");
  assert.match(attachmentTooLargeRefusal(50 * 1024 * 1024).error, /50MB per file/);
  // An app left without scopes gets none, so its scope refusals never say to leave them out.
  for (const message of ["invalid_scope", "scopes must be an array", "at least one scope is required"]) {
    assert.doesNotMatch(appRegistrationScopeRefusal(message).error, /leave them out/);
  }
});

test("a message lookup that finds nothing reads the same whatever the reason, and a thread anchor miss is a function of its parent alone", () => {
  assert.deepEqual(messageResolveRefusal("Message not found"), MESSAGE_NOT_FOUND_REFUSAL);
  assert.deepEqual(threadAnchorNotFoundRefusal("#dx-parent"), threadAnchorNotFoundRefusal("#dx-parent"));
});

test("a service message that would break the sentence is replaced by the fallback", () => {
  assert.equal(serviceMessageRefusal("x_invalid", "scope is required", "Fallback sentence here.").error, "scope is required");
  assert.equal(serviceMessageRefusal("x_invalid", "use --force\nnow", "Fallback sentence here.").error, "Fallback sentence here.");
});
