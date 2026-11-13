import assert from "node:assert/strict";
import type { ArtifactKind, ServerPlan } from "./index";
import { ARTIFACT_FRAMED_KINDS } from "./workspaceArtifacts";
import { ACTION_CARD_ACTION_TYPES } from "./actionCards";
import { NOTIFICATION_MOBILE_DELAYS, NOTIFICATION_PREVIEW_MODES } from "./notifications";
import { RUNTIME_ACCOUNT_USAGE_PROVIDERS } from "./runtimeAccountUsage";
import {
  ARTIFACT_EVENT_KINDS,
  ARTIFACT_FRAMED_EVENT_KINDS,
  ARTIFACT_OPEN_SOURCES,
  BILLING_ENTRIES,
  BILLING_PORTAL_FROM,
  CHECKOUT_ENTRIES,
  COMPUTERS_LIST_RUNTIMES,
  COMPUTERS_LIST_SORT_RUNTIMES,
  NOTIFICATION_SETTINGS_MOBILE_DELAYS,
  NOTIFICATION_SETTINGS_PREVIEW_MODES,
  PAYWALL_GATES,
  PAYWALL_HIT_ACTORS,
  PAYWALL_HIT_VIAS,
  PAYWALL_LIMIT_SIDES,
  PAYWALL_SURFACES,
  PAYWALL_PLANS,
  PLAN_BILLING_DIALOGS,
  PRODUCT_EVENT_ACTION_CARD_TYPES,
  PRODUCT_EVENT_REGISTRY,
  DESKTOP_COMPUTER_MIGRATION_ERROR_CODE_MAX_LENGTH,
  DESKTOP_COMPUTER_MIGRATION_ERROR_CODES,
  EXTERNAL_CONNECT_PATHS,
  EXTERNAL_CONNECT_REFUSAL_CODES,
  EXTERNAL_CONNECT_RESULTS,
  type ProductEventSpec,
  campaignToken,
  referrerHostname,
  validateProductEvent,
} from "./productEvents";

// Product events are designed on purpose (RFC-067 §3.2). Changing this list is
// a deliberate act that needs the event-registry owner's sign-off.
test("the product event registry changes only on purpose", () => {
  assert.deepEqual(Object.keys(PRODUCT_EVENT_REGISTRY).sort(), [
    "account_created",
    "account_profile_completed",
    "action_card_action",
    "action_card_shown",
    "activity_item_open",
    "activity_mark",
    "activity_open",
    "agent_create_opened",
    "agent_read_progress_shown",
    "announcement_interacted",
    "announcement_shown",
    "app_opened",
    "app_rating_prompt_requested",
    "artifact_comment_posted",
    "artifact_frame_loaded",
    "artifact_imported",
    "artifact_opened",
    "artifact_saved_from_attachment",
    "artifact_shared",
    "artifact_viewer_action",
    "billing_cancellation_scheduled",
    "billing_cancellation_withdrawn",
    "billing_checkout_completed",
    "billing_checkout_started",
    "billing_portal_opened",
    "billing_prepaid_checkout_completed",
    "billing_prepaid_checkout_started",
    "billing_prepaid_seats_checkout_completed",
    "billing_prepaid_seats_checkout_started",
    "billing_seats_updated",
    "bulk_model_change_closed",
    "bulk_model_change_finished",
    "bulk_model_change_opened",
    "bulk_model_change_submitted",
    "channel_tab_selected",
    "checkout_started",
    "community_cn_qr_page_view",
    "computers_list_computer_opened",
    "computers_list_control_changed",
    "computers_list_viewed",
    "confirm_dialog_closed",
    "conversation_mute_changed",
    "desktop_computer_migration_finished",
    "drafts_item_opened",
    "drafts_page_viewed",
    "email_verification_sent",
    "email_verified",
    "external_channel_connect_finished",
    "external_invite_closed",
    "external_invite_email_sent",
    "external_invite_link_opened",
    "external_invite_opened",
    "external_invite_page_viewed",
    "external_invite_reviewed",
    "external_invite_send_finished",
    "feature_action",
    "message_action_selected",
    "nav_entry_selected",
    "notification_level_changed",
    "notification_settings_changed",
    "page_viewed",
    "paywall_action",
    "paywall_hit",
    "paywall_shown",
    "plan_billing_dialog_closed",
    "plan_billing_dialog_opened",
    "public_page_channel_opened",
    "public_page_server_joined",
    "public_page_thread_opened",
    "public_page_viewed",
    "pwa_install_appinstalled",
    "pwa_install_cta_clicked",
    "pwa_install_cta_shown",
    "pwa_install_eligible",
    "pwa_install_ios_instruction_dismissed",
    "pwa_install_native_prompt_result",
    "pwa_install_standalone_detected",
    "server_created",
    "server_setup_blocked",
    "server_setup_step_action",
    "server_setup_step_shown",
    "undo_offered",
    "undo_used",
    "upgrade_prompt_interacted",
    "upgrade_prompt_shown",
    "upload_limit_hit",
  ]);
});

test("an upload limit names the limit, where it was met and what Raft did, with counts and a coarse size only", () => {
  const hit = { limit: "file_size", entry: "drop", response: "upgrade_dialog", viewer_role: "member", plan: "free", files: 1, largest_size: "50_100mb" };
  assert.equal(validateProductEvent("upload_limit_hit", hit, "web").ok, true);
  // An attach button tapped with the month used up: no file, so no size.
  assert.equal(validateProductEvent("upload_limit_hit", { ...hit, limit: "monthly_quota", entry: "attach_file", files: 0, largest_size: undefined }, "desktop").ok, true);
  assert.equal(validateProductEvent("upload_limit_hit", { ...hit, largest_size: "63mb" }, "web").ok, false);
  assert.equal(validateProductEvent("upload_limit_hit", { ...hit, entry: "toolbar" }, "web").ok, false);
  assert.equal(validateProductEvent("upload_limit_hit", { ...hit, filename: "q3.pdf" }, "web").ok, false, "no file names");
  assert.equal(validateProductEvent("upload_limit_hit", hit, "server").ok, false, "a client event");
});

// #wg-rbac:#60 (Nova's contract): the invite emails a host sends and the invitee's page view.
test("external invite events are server facts of enums and booleans: no address, invite, channel or server property", () => {
  const email = { trigger: "send", result: "sent" };
  assert.deepEqual(validateProductEvent("external_invite_email_sent", email, "server"), { ok: true, event: "external_invite_email_sent" });
  assert.equal(validateProductEvent("external_invite_email_sent", { trigger: "resend", result: "failed" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("external_invite_email_sent", email, "web"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("external_invite_email_sent", { trigger: "send" }, "server"), { ok: false, reason: "missing_property", property: "result" });
  assert.deepEqual(validateProductEvent("external_invite_email_sent", { ...email, result: "rate_limited" }, "server"), { ok: false, reason: "invalid_property_value", property: "result" }, "a resend has no cooldown");
  for (const extra of ["email_domain", "invite_id", "channel_id"]) {
    assert.deepEqual(validateProductEvent("external_invite_email_sent", { ...email, [extra]: "x" }, "server"), { ok: false, reason: "unknown_property", property: extra });
  }

  const viewed = { guest_offered: true, connect_offered: false, request_approval_offered: false, new_server_offered: true, new_account: true };
  assert.deepEqual(validateProductEvent("external_invite_page_viewed", viewed, "server"), { ok: true, event: "external_invite_page_viewed" });
  assert.deepEqual(validateProductEvent("external_invite_page_viewed", viewed, "web"), { ok: false, reason: "source_not_allowed" });
  for (const property of Object.keys(viewed)) {
    const { [property]: _left, ...rest } = viewed as Record<string, boolean>;
    assert.deepEqual(validateProductEvent("external_invite_page_viewed", rest, "server"), { ok: false, reason: "missing_property", property });
  }
  for (const extra of ["host_server_id", "invite_id", "channel_id", "inviter"]) {
    assert.deepEqual(validateProductEvent("external_invite_page_viewed", { ...viewed, [extra]: "x" }, "server"), { ok: false, reason: "unknown_property", property: extra });
  }

  // The signed-out link: one boolean, nothing of who opened it or which invite, nor the User-Agent.
  for (const likely_bot of [true, false]) {
    assert.deepEqual(validateProductEvent("external_invite_link_opened", { likely_bot }, "server"), { ok: true, event: "external_invite_link_opened" });
  }
  assert.deepEqual(validateProductEvent("external_invite_link_opened", {}, "server"), { ok: false, reason: "missing_property", property: "likely_bot" });
  assert.deepEqual(validateProductEvent("external_invite_link_opened", { likely_bot: "yes" }, "server"), { ok: false, reason: "invalid_property_value", property: "likely_bot" });
  assert.deepEqual(validateProductEvent("external_invite_link_opened", { likely_bot: false }, "web"), { ok: false, reason: "source_not_allowed" });
  for (const extra of ["user_agent", "invite_id", "channel_id", "host_server_id"]) {
    assert.deepEqual(validateProductEvent("external_invite_link_opened", { likely_bot: false, [extra]: "x" }, "server"), { ok: false, reason: "unknown_property", property: extra });
  }
});

// #wg-rbac:db8d6e83 (cindyz via Warden/Nova): the host's invite-people-outside flow, from the web.
test("the host's external invite flow: web events with fixed values, buckets for counts, nothing identifying", () => {
  const cases = {
    external_invite_opened: { flow: "existing_channel", entry: "add_members_row" },
    external_invite_reviewed: { flow: "create_channel", emails: "2-5", servers: "2+", history_warning_shown: false, becomes_private: false },
    external_invite_send_finished: { flow: "existing_channel", result: "failed", error_code: "free_external_limit", upgrade_offered: true },
    external_invite_closed: { flow: "create_channel", stage: "people", sent: false },
  } as const;
  for (const [event, properties] of Object.entries(cases)) {
    assert.deepEqual(validateProductEvent(event, properties, "web"), { ok: true, event });
    assert.equal(validateProductEvent(event, properties, "desktop").ok, true, event);
    assert.deepEqual(validateProductEvent(event, properties, "server"), { ok: false, reason: "source_not_allowed" }, event);
    for (const extra of ["channel_id", "email", "server_id", "error"]) {
      assert.deepEqual(validateProductEvent(event, { ...properties, [extra]: "x" }, "web"), { ok: false, reason: "unknown_property", property: extra });
    }
  }
  assert.deepEqual(validateProductEvent("external_invite_opened", { flow: "existing_channel" }, "web"), { ok: false, reason: "missing_property", property: "entry" });
  assert.deepEqual(validateProductEvent("external_invite_reviewed", { ...cases.external_invite_reviewed, emails: "3" }, "web"), { ok: false, reason: "invalid_property_value", property: "emails" }, "a bucket, never a count");
  assert.equal(validateProductEvent("external_invite_send_finished", { flow: "existing_channel", result: "sent", upgrade_offered: false }, "web").ok, true, "error_code only with failed");
  assert.deepEqual(validateProductEvent("external_invite_send_finished", { ...cases.external_invite_send_finished, error_code: "joint_party_limit" }, "web"), { ok: false, reason: "invalid_property_value", property: "error_code" }, "a code the dialog has no sentence for is sent as other");
  assert.deepEqual(validateProductEvent("external_invite_closed", { flow: "existing_channel", stage: "review" }, "web"), { ok: false, reason: "missing_property", property: "sent" });
});

// cindyz via Warden, 2026-11-12 (#wg-rbac:db8d6e83): each finished join or connect attempt.
test("external_channel_connect_finished is a server fact of enums and booleans: the way, the result, the refusal, nothing identifying", () => {
  assert.deepEqual([...EXTERNAL_CONNECT_PATHS], ["guest", "connect", "new_server", "request_approval", "approve", "decline", "host_direct", "self_connect"]);
  assert.deepEqual([...EXTERNAL_CONNECT_RESULTS], ["connected", "connecting", "awaiting_approval", "declined", "refused", "expired", "error"]);
  assert.equal(EXTERNAL_CONNECT_REFUSAL_CODES.at(-1), "other", "a code not listed is other");
  assert.ok(EXTERNAL_CONNECT_REFUSAL_CODES.includes("invite_unusable"));
  const connected = { path: "connect", result: "connected", async: false, multi: false, host_plan: "paid" };
  assert.deepEqual(validateProductEvent("external_channel_connect_finished", connected, "server"), { ok: true, event: "external_channel_connect_finished" });
  assert.deepEqual(validateProductEvent("external_channel_connect_finished", connected, "web"), { ok: false, reason: "source_not_allowed" });
  const refused = { path: "host_direct", result: "refused", refusal_code: "free_external_limit", limit_side: "connecting", async: false, multi: true };
  assert.equal(validateProductEvent("external_channel_connect_finished", refused, "server").ok, true, "host_plan is optional");
  assert.equal(validateProductEvent("external_channel_connect_finished", { ...refused, refusal_code: "other" }, "server").ok, true);
  // The host side's own refusals (Nova, #14526); its `connecting` is recorded as connect_in_progress, not a value of its own.
  for (const refusal_code of ["channel_not_invitable", "make_private_required", "forbidden", "channel_membership_required", "invite_open", "invite_not_pending", "daily_cap"]) {
    assert.equal(validateProductEvent("external_channel_connect_finished", { ...refused, refusal_code }, "server").ok, true, refusal_code);
  }
  assert.equal(validateProductEvent("external_channel_connect_finished", { ...refused, refusal_code: "connecting" }, "server").ok, false);
  assert.deepEqual(validateProductEvent("external_channel_connect_finished", { ...refused, refusal_code: "internal_error" }, "server"), { ok: false, reason: "invalid_property_value", property: "refusal_code" });
  assert.deepEqual(validateProductEvent("external_channel_connect_finished", { ...refused, limit_side: "guest" }, "server"), { ok: false, reason: "invalid_property_value", property: "limit_side" });
  assert.deepEqual(validateProductEvent("external_channel_connect_finished", { ...connected, host_plan: "pro" }, "server"), { ok: false, reason: "invalid_property_value", property: "host_plan" }, "free or paid, not the plan");
  assert.equal(validateProductEvent("external_channel_connect_finished", { path: "connect", result: "expired", async: true, multi: false }, "server").ok, true);
  for (const property of ["path", "result", "async", "multi"]) {
    const { [property]: _left, ...rest } = connected as Record<string, unknown>;
    assert.deepEqual(validateProductEvent("external_channel_connect_finished", rest, "server"), { ok: false, reason: "missing_property", property });
  }
  for (const extra of ["invite_id", "channel_id", "host_server_id", "server_name", "error"]) {
    assert.deepEqual(validateProductEvent("external_channel_connect_finished", { ...connected, [extra]: "x" }, "server"), { ok: false, reason: "unknown_property", property: extra });
  }
});

// #proj-onboarding:#2 (Ferry): the new-user journey. Before a server the server records the
// steps; after it the web records the setup steps. Enums and booleans only.
test("new-user journey events: account steps are server facts, setup steps web events, nothing identifying", () => {
  assert.equal(validateProductEvent("email_verification_sent", { trigger: "resend", result: "rate_limited", platform: "web" }, "server").ok, true);
  assert.equal(validateProductEvent("email_verification_sent", { trigger: "resend", result: "sent", platform: "web" }, "web").ok, false, "a server fact");
  assert.equal(validateProductEvent("email_verification_sent", { trigger: "signup", result: "sent", platform: "web", email: "a@b.c" }, "server").ok, false, "no email");
  assert.equal(validateProductEvent("email_verified", { platform: "unknown" }, "server").ok, true);
  assert.equal(validateProductEvent("account_profile_completed", { platform: "ios" }, "server").ok, true);
  assert.equal(validateProductEvent("server_created", { first_server: true, platform: "mobile_web" }, "server").ok, true);
  assert.equal(validateProductEvent("server_created", { platform: "mobile_web" }, "server").ok, false, "first_server is required");

  assert.equal(validateProductEvent("server_setup_step_shown", { step: "computer_runtime" }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_step_shown", { step: "computer_runtime" }, "server").ok, false, "a web event");
  assert.equal(validateProductEvent("server_setup_step_action", { step: "computer_runtime", action: "copy_install_command", os: "windows" }, "desktop").ok, true);
  assert.equal(validateProductEvent("server_setup_step_action", { step: "handoff", action: "lets_go" }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_step_action", { step: "computer_runtime", action: "copy_install_and_setup_command", os: "mac_linux" }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_step_action", { step: "handoff", action: "lets_go", command: "npx raft" }, "web").ok, false, "no command text");
  assert.equal(validateProductEvent("server_setup_blocked", { step: "computer_runtime", reason: "computer_offline" }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_blocked", { step: "computer_runtime", reason: "setup_complete" }, "web").ok, false, "not a reason that holds a step");
  // mobile_server_setup_v1: the same web page inside the mobile app says so.
  assert.equal(validateProductEvent("server_setup_step_shown", { step: "create_agent", native_host: true }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_step_action", { step: "handoff", action: "lets_go", native_host: true }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_blocked", { step: "computer_runtime", reason: "computer_offline", native_host: true }, "web").ok, true);
  assert.equal(validateProductEvent("server_setup_step_shown", { step: "create_agent", native_host: "ios" }, "web").ok, false, "a flag, not the app's name");
  assert.equal(validateProductEvent("server_setup_step_shown", { step: "create_agent", native_host: true }, "ios").ok, false, "the app sends no setup events: its WebView's page does");
});

// Gated features with no server record (tygg, #proj-o11y:a5f3094f): Drafts and agent read progress,
// from every client that has them, with fixed values only.
test("gated feature events: Drafts and agent read progress carry fixed values only", () => {
  for (const source of ["web", "desktop", "ios", "android"] as const) {
    assert.equal(validateProductEvent("drafts_page_viewed", { drafts: "2-5" }, source).ok, true, source);
    assert.equal(validateProductEvent("drafts_item_opened", { place: "task" }, source).ok, true, source);
    assert.equal(validateProductEvent("agent_read_progress_shown", { part: "faces", conversation: "thread" }, source).ok, true, source);
  }
  assert.equal(validateProductEvent("drafts_page_viewed", { drafts: "2-5" }, "server").ok, false, "a client event");
  assert.equal(validateProductEvent("drafts_page_viewed", {}, "web").ok, false, "the count bucket is required");
  assert.equal(validateProductEvent("drafts_page_viewed", { drafts: "3" }, "web").ok, false, "a bucket, never a count");
  assert.equal(validateProductEvent("drafts_item_opened", { place: "channel", channel_id: "c-1" }, "web").ok, false, "no ids");
  assert.equal(validateProductEvent("drafts_item_opened", { place: "channel", length: 12 }, "web").ok, false, "nothing about the text");
  assert.equal(validateProductEvent("agent_read_progress_shown", { part: "not_reaching_line", conversation: "channel" }, "web").ok, true);
  assert.equal(validateProductEvent("agent_read_progress_shown", { part: "faces", conversation: "dm" }, "web").ok, false, "DMs show no faces");
  assert.equal(validateProductEvent("agent_read_progress_shown", { part: "faces", conversation: "channel", agents: 3 }, "web").ok, false, "no counts of agents");
});

// #proj-analytics:#17 (AndyLok, #proj-o11y:#16): notification levels and mutes are server facts
// (every client writes through one route); confirm dialogs and undo toasts are web events.
test("notification, confirm and undo events carry enums and booleans only", () => {
  assert.equal(validateProductEvent("notification_level_changed", { scope: "channel", level: "default" }, "server").ok, true);
  assert.equal(validateProductEvent("notification_level_changed", { scope: "thread", level: "all" }, "server").ok, false, "a thread has no level");
  assert.equal(validateProductEvent("notification_level_changed", { scope: "server", level: "all" }, "web").ok, false, "a server fact");
  assert.equal(validateProductEvent("conversation_mute_changed", { muted: true, kind: "dm" }, "server").ok, true);
  assert.equal(validateProductEvent("confirm_dialog_closed", { dialog: "computer_restart", result: "cancelled" }, "desktop").ok, true);
  assert.equal(validateProductEvent("confirm_dialog_closed", { dialog: "computer_restart" }, "web").ok, false, "result is required");
  assert.equal(validateProductEvent("undo_offered", { action: "activity_done" }, "web").ok, true);
  assert.equal(validateProductEvent("undo_used", { action: "role_change", result: "superseded" }, "web").ok, true);
  assert.equal(validateProductEvent("undo_used", { action: "role_change", result: "undone", role: "admin" }, "web").ok, false, "no role names");
});

test("account notification settings: one setting per event, fixed values only, the same values the settings take", () => {
  assert.deepEqual(NOTIFICATION_SETTINGS_PREVIEW_MODES, NOTIFICATION_PREVIEW_MODES);
  assert.deepEqual(NOTIFICATION_SETTINGS_MOBILE_DELAYS, NOTIFICATION_MOBILE_DELAYS);
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "pause", change: "on", pause_length: "45m_to_90m" }, "server").ok, true);
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "preview", preview: "sender_only" }, "server").ok, true);
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "mobile_delay", mobile_delay: "always" }, "server").ok, true);
  assert.equal(validateProductEvent("notification_settings_changed", { change: "on" }, "server").ok, false, "setting is required");
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "quiet_hours", change: "edited", start_minute: 1320 }, "server").ok, false, "no times");
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "sound", change: "off" }, "web").ok, false, "a server fact");
  assert.equal(validateProductEvent("notification_settings_changed", { setting: "sound", enabled: false }, "server").ok, false, "change, not enabled");
});

test("upgrade path events name their prompt and action, and checkout carries no ids", () => {
  assert.equal(validateProductEvent("upgrade_prompt_shown", { surface: "onboarding_setup" }, "web").ok, true);
  assert.equal(validateProductEvent("upgrade_prompt_interacted", { surface: "onboarding_setup", action: "not_now" }, "web").ok, true);
  assert.equal(validateProductEvent("upgrade_prompt_interacted", { surface: "onboarding_setup", action: "maybe" }, "web").ok, false);
  assert.equal(validateProductEvent("upgrade_prompt_interacted", { surface: "onboarding_setup" }, "web").ok, false);
  assert.equal(
    validateProductEvent("checkout_started", { entry: "onboarding_setup", billing_interval: "annual", seat_count: 2, has_promotion_code: false }, "web").ok,
    true,
  );
  // The upgrade dialog a Free paywall opens starts checkout in place (task #7).
  assert.equal(
    validateProductEvent("checkout_started", { entry: "paywall_panel", billing_interval: "monthly", seat_count: 3, has_promotion_code: false }, "web").ok,
    true,
  );
  assert.equal(
    validateProductEvent("checkout_started", { entry: "settings", billing_interval: "annual", seat_count: 2, has_promotion_code: false, promotion_code: "x" }, "web").ok,
    false,
  );
  assert.equal(
    validateProductEvent("checkout_started", { billing_interval: "annual", seat_count: 2, has_promotion_code: false }, "web").ok,
    false,
    "entry is required",
  );
  // What opened the upgrade dialog when not a paywall (task #6): optional, so paywalls and older clients send none.
  const checkout = { entry: "paywall_panel", billing_interval: "annual", seat_count: 2, has_promotion_code: false };
  assert.equal(validateProductEvent("checkout_started", checkout, "web").ok, true, "absent: a paywall opened it");
  assert.equal(validateProductEvent("checkout_started", { ...checkout, opened_from: "agent_card" }, "web").ok, true);
  // A member's request for Pro (the same card, from a person; task #10) is its own opener.
  assert.equal(validateProductEvent("checkout_started", { ...checkout, opened_from: "member_request" }, "web").ok, true);
  for (const openedFrom of ["paywall", "agent_card_7"]) {
    assert.equal(
      validateProductEvent("checkout_started", { ...checkout, opened_from: openedFrom }, "web").ok,
      false,
      `opened_from is a closed set without a paywall value: ${openedFrom}`,
    );
  }
  // `source` is the event's platform column, never a property name here.
  assert.equal(validateProductEvent("checkout_started", { ...checkout, source: "agent_card" }, "web").ok, false);
  // The surface the paywall that opened the dialog was on (#proj-commercial:#22): optional, one of PAYWALL_SURFACES.
  assert.equal(validateProductEvent("checkout_started", { ...checkout, surface: "artifact" }, "web").ok, true);
  assert.deepEqual(validateProductEvent("checkout_started", { ...checkout, surface: "attachment" }, "web"), { ok: false, reason: "invalid_property_value", property: "surface" });
});

test("every entry states its question and stays JSON-shaped", () => {
  const entries: Array<[string, ProductEventSpec]> = Object.entries(PRODUCT_EVENT_REGISTRY);
  for (const [name, spec] of entries) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, name);
    assert.ok(spec.question.trim().length > 0, `${name} needs a question`);
    assert.ok(spec.requestedBy.trim().length > 0, `${name} needs a requester`);
    assert.ok(spec.sources.length > 0, `${name} needs a source`);
    for (const property of Object.keys(spec.properties)) {
      assert.match(property, /^[a-z][a-z0-9_]*$/, `${name}.${property}: \`$\` names are reserved for the pipeline`);
    }
  }
  // Native clients generate their APIs from a JSON export (RFC-067 §6).
  assert.deepEqual(JSON.parse(JSON.stringify(PRODUCT_EVENT_REGISTRY)), PRODUCT_EVENT_REGISTRY);
});

test("validateProductEvent accepts registered events and rejects everything else", () => {
  assert.deepEqual(validateProductEvent("activity_open", { from: "rail" }, "web"), { ok: true, event: "activity_open" });
  assert.deepEqual(validateProductEvent("activity_open", {}, "desktop"), { ok: true, event: "activity_open" });
  assert.deepEqual(validateProductEvent("activity_open", { from: "mobile_tab_bar" }, "web"), { ok: true, event: "activity_open" });
  assert.deepEqual(
    validateProductEvent("community_cn_qr_page_view", { from: "wechat_group_3" }, "web"),
    { ok: true, event: "community_cn_qr_page_view" },
  );

  assert.deepEqual(validateProductEvent("button_clicked", {}, "web"), { ok: false, reason: "unregistered_event" });
  assert.deepEqual(validateProductEvent("toString", {}, "web"), { ok: false, reason: "unregistered_event" });
  assert.deepEqual(validateProductEvent("activity_open", { from: "rail" }, "ios"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(
    validateProductEvent("activity_open", { from: "rail", text: "hello" }, "web"),
    { ok: false, reason: "unknown_property", property: "text" },
  );
  assert.deepEqual(
    validateProductEvent("activity_open", { from: "elsewhere" }, "web"),
    { ok: false, reason: "invalid_property_value", property: "from" },
  );
  assert.deepEqual(
    validateProductEvent("community_cn_qr_page_view", { from: "x".repeat(65) }, "web"),
    { ok: false, reason: "invalid_property_value", property: "from" },
  );
  for (const from of ["someone@example.com", "+86 138 0000 0000", "WeChat", "join the group"]) {
    assert.deepEqual(
      validateProductEvent("community_cn_qr_page_view", { from }, "web"),
      { ok: false, reason: "invalid_property_value", property: "from" },
      from,
    );
  }
});

// Public Server visit sources (cindyz, 2026-10-14): a host name, never a URL.
test("hostname properties keep a referring site's host name and nothing more", () => {
  const viewed = (referrer_domain: unknown) => validateProductEvent("public_page_viewed", { referrer_domain }, "server");
  for (const host of ["x.com", "news.ycombinator.com", "xn--fiqs8s.cn"]) {
    assert.deepEqual(viewed(host), { ok: true, event: "public_page_viewed" }, host);
  }
  for (const value of [
    "https://x.com/someone/status/1", "x.com/path", "localhost", "192.168.1.10", "X.com", "x.com:8080",
    "someone@example.com", "", 42,
  ]) {
    assert.deepEqual(viewed(value), { ok: false, reason: "invalid_property_value", property: "referrer_domain" }, String(value));
  }

  assert.equal(referrerHostname("https://www.Google.com/search?q=raft"), "google.com");
  assert.equal(referrerHostname("https://t.co/abc"), "t.co");
  assert.equal(referrerHostname("http://raft.build/"), "raft.build");
  for (const referrer of ["", "not a url", "android-app://com.slack/", "http://10.0.0.1/", "http://[::1]/", "http://intranet/"]) {
    assert.equal(referrerHostname(referrer), null, referrer);
  }
});

test("campaignToken lowercases a utm value but never rewrites it into a token", () => {
  assert.equal(campaignToken(" Newsletter_Oct "), "newsletter_oct");
  assert.equal(campaignToken("launch-2026"), "launch-2026");
  for (const value of [null, undefined, "", "someone@example.com", "spring sale", "news.ycombinator.com", "x".repeat(65)]) {
    assert.equal(campaignToken(value), null, String(value));
  }
});


test("announcement samples accept version identity and reject content or URL properties", () => {
  const properties = { announcement_id: "90000000-0000-4000-8000-000000000001", delivery_version: 7 };
  for (const event of ["announcement_shown", "announcement_interacted"]) {
    assert.equal(validateProductEvent(event, event === "announcement_interacted" ? { ...properties, action: "primary", has_cta: true } : properties, "web").ok, true);
    assert.equal(validateProductEvent(event, event === "announcement_interacted" ? { ...properties, action: "primary", has_cta: true } : properties, "desktop").ok, true);
    assert.equal(validateProductEvent(event, event === "announcement_interacted" ? { ...properties, action: "primary", has_cta: true } : properties, "server").ok, false);
    for (const key of ["title", "body", "url", "user_id"]) assert.equal(validateProductEvent(event, { ...properties, ...(event === "announcement_interacted" ? { action: "primary", has_cta: true } : {}), [key]: "private" }, "web").ok, false);
  }
});

test("announcement interaction accepts explicit controls and rejects unclassified actions", () => {
  for (const action of ["primary", "secondary", "close", "outside", "escape"]) {
    assert.equal(validateProductEvent("announcement_interacted", { announcement_id: "90000000-0000-4000-8000-000000000001", delivery_version: 7, action, has_cta: true }, "web").ok, true);
  }
  assert.equal(validateProductEvent("announcement_interacted", { announcement_id: "90000000-0000-4000-8000-000000000001", delivery_version: 7, action: "unknown", has_cta: true }, "web").ok, false);
});

test("new announcement events distinguish missing required properties from invalid values", () => {
  const complete = { announcement_id: "90000000-0000-4000-8000-000000000001", delivery_version: 7, action: "primary", has_cta: true };
  assert.deepEqual(validateProductEvent("announcement_interacted", complete, "web"), { ok: true, event: "announcement_interacted" });
  for (const event of ["announcement_shown", "announcement_interacted"] as const) {
    const keys = event === "announcement_shown" ? ["announcement_id", "delivery_version"] : Object.keys(complete);
    for (const property of keys) {
      const props: Record<string, string | number | boolean | undefined> = event === "announcement_shown"
        ? { announcement_id: complete.announcement_id, delivery_version: 7 } : { ...complete };
      delete props[property];
      assert.deepEqual(validateProductEvent(event, props, "web"), { ok: false, reason: "missing_property", property });
      props[property] = undefined;
      assert.deepEqual(validateProductEvent(event, props, "web"), { ok: false, reason: "missing_property", property });
    }
  }
  assert.deepEqual(validateProductEvent("announcement_interacted", { ...complete, has_cta: "true" }, "web"), { ok: false, reason: "invalid_property_value", property: "has_cta" });
  assert.equal(validateProductEvent("page_viewed", {}, "web").ok, true, "existing event contracts stay optional");
});

// xxchan 2026-10-17: the one event the native apps may send so far, so web and
// native entries compare in one table.
test("nav_entry_selected comes from web and the native apps, and always says where, from which entry, and whether already there", () => {
  const complete = { destination: "tasks", surface: "mobile_tab_bar", was_active: false };
  for (const source of ["web", "desktop", "ios", "android", "harmonyos"] as const) {
    assert.deepEqual(validateProductEvent("nav_entry_selected", complete, source), { ok: true, event: "nav_entry_selected" });
  }
  assert.deepEqual(validateProductEvent("nav_entry_selected", complete, "server"), { ok: false, reason: "source_not_allowed" });
  for (const property of Object.keys(complete)) {
    const props: Record<string, unknown> = { ...complete };
    delete props[property];
    assert.deepEqual(validateProductEvent("nav_entry_selected", props, "ios"), { ok: false, reason: "missing_property", property });
  }
  assert.deepEqual(validateProductEvent("nav_entry_selected", { ...complete, destination: "raftbench" }, "web"), { ok: false, reason: "invalid_property_value", property: "destination" });
  assert.deepEqual(validateProductEvent("nav_entry_selected", { ...complete, path: "/s/x/tasks" }, "web"), { ok: false, reason: "unknown_property", property: "path" });
  assert.equal(validateProductEvent("nav_entry_selected", { ...complete, display_mode: "standalone" }, "web").ok, true);
  assert.equal(validateProductEvent("nav_entry_selected", { ...complete, destination: "assistant", surface: "rail" }, "web").ok, true);
});

// Entry-level events (xxchan, 2026-10-23): one per area of the screen, fixed values, no ids or text.
test("channel_tab_selected and message_action_selected come from every client, with fixed values and nothing else", () => {
  const tab = { tab: "files", surface: "side_card_toggle", was_active: true };
  const action = { action: "copy_link", surface: "long_press", in_thread: true };
  for (const source of ["web", "desktop", "ios", "android", "harmonyos"] as const) {
    assert.equal(validateProductEvent("channel_tab_selected", tab, source).ok, true, source);
    assert.equal(validateProductEvent("message_action_selected", action, source).ok, true, source);
  }
  assert.deepEqual(validateProductEvent("channel_tab_selected", tab, "server"), { ok: false, reason: "source_not_allowed" });
  for (const property of ["tab", "surface", "was_active"]) {
    const props: Record<string, unknown> = { ...tab };
    delete props[property];
    assert.deepEqual(validateProductEvent("channel_tab_selected", props, "web"), { ok: false, reason: "missing_property", property });
  }
  assert.deepEqual(validateProductEvent("channel_tab_selected", { ...tab, tab: "pins" }, "web"), { ok: false, reason: "invalid_property_value", property: "tab" });
  assert.equal(validateProductEvent("message_action_selected", { action: "forward", surface: "hover_toolbar" }, "web").ok, true, "in_thread is optional");
  assert.equal(validateProductEvent("message_action_selected", { action: "react_quick", surface: "hover_toolbar" }, "web").ok, true, "the hover toolbar's reaction button");
  assert.deepEqual(validateProductEvent("message_action_selected", { action: "forward" }, "web"), { ok: false, reason: "missing_property", property: "surface" });
  assert.deepEqual(validateProductEvent("message_action_selected", { ...action, action: "delete_all" }, "web"), { ok: false, reason: "invalid_property_value", property: "action" });
  assert.deepEqual(validateProductEvent("message_action_selected", { ...action, message_id: "m-1" }, "web"), { ok: false, reason: "unknown_property", property: "message_id" });
  for (const mark of ["read", "unread", "read_all", "done"]) {
    assert.equal(validateProductEvent("activity_mark", { action: mark }, "web").ok, true, mark);
    assert.equal(validateProductEvent("activity_mark", { action: mark }, "android").ok, true, `${mark} from the apps`);
  }
  assert.equal(validateProductEvent("activity_item_open", { item_kind: "thread" }, "ios").ok, true, "the apps open Activity rows too");
  assert.deepEqual(validateProductEvent("activity_item_open", { item_kind: "thread" }, "server"), { ok: false, reason: "source_not_allowed" });
  assert.equal(validateProductEvent("activity_item_open", { item_kind: "artifact" }, "web").ok, true, "an Artifact's Activity row");
  assert.deepEqual(validateProductEvent("activity_item_open", { item_kind: "object" }, "web"), { ok: false, reason: "invalid_property_value", property: "item_kind" }, "the row's kind is not a value: its objectKind is");
  for (const entry of ["members_page", "channel_members"]) {
    assert.equal(validateProductEvent("agent_create_opened", { entry }, "ios").ok, true, `the apps' ${entry}`);
  }
  assert.equal(validateProductEvent("agent_create_opened", { entry: "members_page_external" }, "web").ok, true, "the web Members page's external agent");
  for (const source of ["web", "ios", "android"] as const) {
    assert.equal(validateProductEvent("agent_create_opened", { entry: "computer_rack" }, source).ok, true, `a Computers card's … menu on ${source}`);
  }
  assert.equal(validateProductEvent("channel_tab_selected", { tab: "tasks", surface: "header_swipe", was_active: false }, "android").ok, true, "the apps' swipe between tabs");
  // Values no client sends are not kept (the apps have no such long-press items).
  assert.deepEqual(validateProductEvent("message_action_selected", { action: "pin", surface: "long_press" }, "android"), { ok: false, reason: "invalid_property_value", property: "action" });
  assert.equal(validateProductEvent("page_viewed", { route: "assistant" }, "web").ok, true);
});

// Ginny/huxijin via Lagoon, 2026-11-12 (#proj-mobile:66f15a50): the store rating prompt request.
test("app_rating_prompt_requested: iOS and Android only, a required trigger, nothing else", () => {
  for (const source of ["ios", "android"] as const) {
    for (const trigger of ["task_result_viewed", "action_card_approved"]) {
      assert.deepEqual(validateProductEvent("app_rating_prompt_requested", { trigger }, source), { ok: true, event: "app_rating_prompt_requested" });
    }
  }
  for (const source of ["web", "desktop", "harmonyos", "server"] as const) {
    assert.deepEqual(validateProductEvent("app_rating_prompt_requested", { trigger: "task_result_viewed" }, source), { ok: false, reason: "source_not_allowed" });
  }
  assert.deepEqual(validateProductEvent("app_rating_prompt_requested", {}, "ios"), { ok: false, reason: "missing_property", property: "trigger" });
  assert.deepEqual(validateProductEvent("app_rating_prompt_requested", { trigger: "app_opened" }, "ios"), { ok: false, reason: "invalid_property_value", property: "trigger" });
  // The platform and the app version are on the row and the batch, not properties.
  assert.deepEqual(validateProductEvent("app_rating_prompt_requested", { trigger: "task_result_viewed", platform: "ios" }, "ios"), { ok: false, reason: "unknown_property", property: "platform" });
  assert.deepEqual(validateProductEvent("app_rating_prompt_requested", { trigger: "task_result_viewed", app_version: "1.25.0" }, "android"), { ok: false, reason: "unknown_property", property: "app_version" });
});

// artin, 2026-10-21 (#proj-mobile:5a014ada): native app opens and page views.
test("native apps: app_opened is native-only with a required start, and page_viewed takes native routes and sections", () => {
  for (const source of ["ios", "android", "harmonyos"] as const) {
    assert.deepEqual(validateProductEvent("app_opened", { start: "cold" }, source), { ok: true, event: "app_opened" });
  }
  assert.equal(validateProductEvent("app_opened", { start: "foreground", via: "notification" }, "ios").ok, true);
  assert.deepEqual(validateProductEvent("app_opened", { start: "cold" }, "web"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("app_opened", { via: "link" }, "android"), { ok: false, reason: "missing_property", property: "start" });
  assert.deepEqual(validateProductEvent("app_opened", { start: "resume" }, "android"), { ok: false, reason: "invalid_property_value", property: "start" });
  assert.deepEqual(validateProductEvent("app_opened", { start: "cold", version: "1.15.2" }, "ios"), { ok: false, reason: "unknown_property", property: "version" });

  for (const route of ["home", "more", "thread", "task", "conversation_search", "channel"] as const) {
    assert.equal(validateProductEvent("page_viewed", { route }, "android").ok, true, route);
  }
  assert.equal(validateProductEvent("page_viewed", { route: "settings", settings_tab: "storage" }, "ios").ok, true);
  assert.equal(validateProductEvent("page_viewed", { route: "settings", settings_tab: "billing" }, "web").ok, true);
  assert.deepEqual(validateProductEvent("page_viewed", { route: "login" }, "ios"), { ok: false, reason: "invalid_property_value", property: "route" });
});

// xxchan via Till, 2026-10-20 (#proj-analytics:8fc671a3): hits, checkouts and
// seat updates are server facts; what was shown and clicked comes from the web.
test("paywall and billing events: server facts stay server-only, and every entry is a known paywall, a checkout start point or unknown", () => {
  const plans: Record<ServerPlan, true> = { free: true, founder: true, partner: true, pro: true };
  assert.deepEqual([...PAYWALL_PLANS].sort(), Object.keys(plans).sort());
  // The client checkout_started entries are server entries too, so the setup
  // Pro step's checkouts are not `unknown` on the server side; except
  // `paywall_panel`: the upgrade dialog names its paywall instead, or
  // `general` when it was opened for no specific limit (the agent upgrade card).
  assert.deepEqual(BILLING_ENTRIES, [...PAYWALL_GATES, "general", ...CHECKOUT_ENTRIES.filter((entry) => entry !== "paywall_panel"), "unknown"]);
  assert.ok(BILLING_ENTRIES.includes("onboarding_setup"));
  assert.ok(!(BILLING_ENTRIES as readonly string[]).includes("paywall_panel"));

  const checkout = { entry: "history_30d", billing_interval: "monthly", seat_quantity: 3, returning_customer: false };
  for (const event of ["billing_checkout_started", "billing_checkout_completed"] as const) {
    assert.deepEqual(validateProductEvent(event, checkout, "server"), { ok: true, event });
    assert.equal(validateProductEvent(event, { ...checkout, default_seat_quantity: 1 }, "server").ok, true);
    assert.equal(validateProductEvent(event, { ...checkout, entry: "general", opened_from: "agent_card" }, "server").ok, true);
    assert.deepEqual(validateProductEvent(event, { ...checkout, opened_from: "paywall" }, "server"), { ok: false, reason: "invalid_property_value", property: "opened_from" });
    // The paywall's surface (#proj-commercial:#22): an Artifact's quota paywall reads apart from an attachment's.
    assert.equal(validateProductEvent(event, { ...checkout, entry: "upload_monthly_quota", surface: "artifact" }, "server").ok, true);
    assert.deepEqual(validateProductEvent(event, { ...checkout, surface: "not_a_surface" }, "server"), { ok: false, reason: "invalid_property_value", property: "surface" });
    assert.deepEqual(validateProductEvent(event, checkout, "web"), { ok: false, reason: "source_not_allowed" });
    assert.deepEqual(validateProductEvent(event, { ...checkout, checkout_id: "cs_123" }, "server"), { ok: false, reason: "unknown_property", property: "checkout_id" });
    assert.deepEqual(validateProductEvent(event, { ...checkout, entry: "direct" }, "server"), { ok: false, reason: "invalid_property_value", property: "entry" });
  }
  const prepaid = { entry: "upload_monthly_quota", months: 1, seat_quantity: 2, renewal: false, surface: "artifact" };
  assert.equal(validateProductEvent("billing_prepaid_checkout_started", prepaid, "server").ok, true);
  assert.equal(validateProductEvent("billing_prepaid_checkout_completed", { ...prepaid, result: "granted" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("billing_prepaid_checkout_started", { ...prepaid, surface: "not_a_surface" }, "server"), { ok: false, reason: "invalid_property_value", property: "surface" });
  assert.equal(validateProductEvent("billing_seats_updated", { entry: "settings", previous_seat_quantity: 1, seat_quantity: 4, result: "pending_webhook" }, "server").ok, true);
  assert.equal(validateProductEvent("paywall_hit", { gate: "translation", actor: "person", plan: "free", viewer_role: "member" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("paywall_hit", { gate: "translation", plan: "free" }, "web"), { ok: false, reason: "source_not_allowed" });
  assert.equal(validateProductEvent("paywall_action", { gate: "history_30d", viewer_role: "member", action: "message_owner" }, "web").ok, true);
  assert.deepEqual(validateProductEvent("paywall_shown", { gate: "history_30d", viewer_role: "owner", plan: "free" }, "server"), { ok: false, reason: "source_not_allowed" });

  // `general` (an upgrade no specific limit asks for) is a checkout entry, never a paywall (Nova).
  assert.deepEqual(validateProductEvent("billing_checkout_started", { ...checkout, entry: "general" }, "server"), { ok: true, event: "billing_checkout_started" });
  assert.ok(!(PAYWALL_GATES as readonly string[]).includes("general"));
  assert.deepEqual(validateProductEvent("paywall_shown", { gate: "general", viewer_role: "owner", plan: "free" }, "web"), { ok: false, reason: "invalid_property_value", property: "gate" });
  assert.deepEqual(validateProductEvent("paywall_action", { gate: "general", viewer_role: "member", action: "upgrade" }, "web"), { ok: false, reason: "invalid_property_value", property: "gate" });
  assert.deepEqual(validateProductEvent("paywall_hit", { gate: "general", actor: "person", plan: "free", viewer_role: "member" }, "server"), { ok: false, reason: "invalid_property_value", property: "gate" });

  // Where a paywall shown in several places was met (Nova, 2026-10-29): optional, one of PAYWALL_SURFACES.
  assert.deepEqual([...PAYWALL_SURFACES], [
    "conversation", "search", "saved", "files", "quoted_message", "agent_activity", "artifact",
    "create_channel", "external_invite_dialog", "external_invite_page", "connect_request_page", "channel_banner",
    "sidebar",
  ]);
  assert.equal(validateProductEvent("paywall_shown", { gate: "history_30d", viewer_role: "owner", plan: "free", surface: "search" }, "web").ok, true);
  // Save as Artifact's quota paywall (#proj-commercial:#22).
  assert.equal(validateProductEvent("paywall_shown", { gate: "upload_monthly_quota", viewer_role: "owner", plan: "free", surface: "artifact" }, "web").ok, true);
  assert.equal(validateProductEvent("paywall_action", { gate: "history_30d", viewer_role: "member", action: "dismiss", surface: "quoted_message" }, "web").ok, true);
  assert.deepEqual(validateProductEvent("paywall_shown", { gate: "history_30d", viewer_role: "owner", plan: "free", surface: "not_a_surface" }, "web"), { ok: false, reason: "invalid_property_value", property: "surface" });

  // The monthly quota's hit (xxchan, #proj-workspace:#231 item 10): which Artifacts write, and the usage numbers; an agent's has no viewer_role.
  assert.deepEqual([...PAYWALL_HIT_VIAS], ["artifact_publish", "artifact_upload", "artifact_import", "artifact_save_attachment", "artifact_comment_image"]);
  const quotaHit = { gate: "upload_monthly_quota", actor: "person", plan: "free", requested_bytes: 5_000_000, month_used_bytes: 99_000_000 };
  assert.equal(validateProductEvent("paywall_hit", { ...quotaHit, viewer_role: "member" }, "server").ok, true, "an attachment's: no via");
  assert.equal(validateProductEvent("paywall_hit", { ...quotaHit, actor: "agent", via: "artifact_upload" }, "server").ok, true, "an agent's: no viewer_role");
  assert.deepEqual(validateProductEvent("paywall_hit", { ...quotaHit, via: "attachment" }, "server"), { ok: false, reason: "invalid_property_value", property: "via" });
  assert.deepEqual(validateProductEvent("paywall_hit", { ...quotaHit, requested_bytes: -1 }, "server"), { ok: false, reason: "invalid_property_value", property: "requested_bytes" });
  assert.deepEqual(validateProductEvent("paywall_hit", { ...quotaHit, month_used_bytes: 1.5 }, "server"), { ok: false, reason: "invalid_property_value", property: "month_used_bytes" });
});

// meichen, 2026-11-11 (#raft-botiverse-user-analytics:ad42552e): whom a refusal is attributed to is written, not read from the role.
test("paywall_hit says whom its refusal is attributed to: actor is required, person or agent, whatever the role", () => {
  assert.deepEqual([...PAYWALL_HIT_ACTORS], ["person", "agent"]);
  const hit = { gate: "upload_monthly_quota", plan: "free" };
  assert.deepEqual(validateProductEvent("paywall_hit", hit, "server"), { ok: false, reason: "missing_property", property: "actor" });
  assert.deepEqual(validateProductEvent("paywall_hit", { ...hit, viewer_role: "owner" }, "server"), { ok: false, reason: "missing_property", property: "actor" }, "a role does not stand in for it");
  assert.deepEqual(validateProductEvent("paywall_hit", { ...hit, actor: "unknown" }, "server"), { ok: false, reason: "invalid_property_value", property: "actor" }, "unknown is how old rows are read, never written");
  // A person without a member row is still a person; an agent has no role.
  assert.equal(validateProductEvent("paywall_hit", { ...hit, actor: "person" }, "server").ok, true);
  assert.equal(validateProductEvent("paywall_hit", { ...hit, actor: "agent" }, "server").ok, true);
  // The web's own paywall events have no actor: a person saw them.
  assert.deepEqual(validateProductEvent("paywall_shown", { gate: "history_30d", viewer_role: "owner", plan: "free", actor: "person" }, "web"), { ok: false, reason: "unknown_property", property: "actor" });
});

// Nova, 2026-11-10 (#wg-rbac:#60): the Free plan's one external channel.
test("the external channel paywalls: two gates, limit_side on paywall_hit only, and the surfaces the web will send", () => {
  assert.deepEqual([...PAYWALL_GATES], [
    "history_30d", "agent_migration", "seat_limit_agent_create", "seat_limit_invite",
    "joint_channel_free_cap", "joint_channel_host_limit", "joint_channel_over_limit", "joint_channel_read_only",
    "upload_file_size", "upload_monthly_quota", "translation", "cloud_agent_daily_quota", "plan_downgraded",
    "pro_theme",
    "external_channel_free_limit", "external_channel_frozen",
  ]);
  assert.deepEqual([...PAYWALL_LIMIT_SIDES], ["host", "connecting"]);
  const hit = { gate: "external_channel_free_limit", actor: "person", plan: "free", viewer_role: "owner" };
  for (const limit_side of PAYWALL_LIMIT_SIDES) {
    assert.deepEqual(validateProductEvent("paywall_hit", { ...hit, limit_side }, "server"), { ok: true, event: "paywall_hit" });
  }
  assert.equal(validateProductEvent("paywall_hit", { ...hit, gate: "external_channel_frozen", limit_side: "host" }, "server").ok, true);
  assert.equal(validateProductEvent("paywall_hit", hit, "server").ok, true, "limit_side is optional");
  assert.deepEqual(validateProductEvent("paywall_hit", { ...hit, limit_side: "guest" }, "server"), { ok: false, reason: "invalid_property_value", property: "limit_side" });
  // Nothing about the other server or the channel is a property.
  for (const property of ["limit_server_id", "channel_id", "invite_id"]) {
    assert.deepEqual(validateProductEvent("paywall_hit", { ...hit, [property]: "x" }, "server"), { ok: false, reason: "unknown_property", property });
  }
  // The client events take the gates and their surfaces, not limit_side.
  for (const surface of ["create_channel", "external_invite_dialog", "external_invite_page", "connect_request_page", "channel_banner", "sidebar"]) {
    assert.equal(validateProductEvent("paywall_shown", { gate: "external_channel_free_limit", viewer_role: "owner", plan: "free", surface }, "web").ok, true, surface);
    assert.equal(validateProductEvent("paywall_action", { gate: "external_channel_frozen", viewer_role: "admin", action: "upgrade", surface }, "web").ok, true, surface);
  }
  assert.deepEqual(
    validateProductEvent("paywall_shown", { gate: "external_channel_free_limit", viewer_role: "owner", plan: "free", limit_side: "host" }, "web"),
    { ok: false, reason: "unknown_property", property: "limit_side" },
  );
  // A paywall is a billing entry: checkout can name either gate.
  assert.ok(BILLING_ENTRIES.includes("external_channel_free_limit") && BILLING_ENTRIES.includes("external_channel_frozen"));
});

test("Plan & Billing: cancellation and portal facts are server-only, the page's dialogs come from the web with every property required", () => {
  assert.deepEqual([...PLAN_BILLING_DIALOGS], ["upgrade", "add_seats", "keep_pro", "remove_seats", "cancel_subscription"]);
  assert.deepEqual([...BILLING_PORTAL_FROM], ["plan_card", "past_due_banner", "unknown"]);

  const cancellation = { entry: "settings", seat_quantity: 3, billing_interval: "annual" };
  for (const event of ["billing_cancellation_scheduled", "billing_cancellation_withdrawn"] as const) {
    assert.deepEqual(validateProductEvent(event, cancellation, "server"), { ok: true, event });
    assert.deepEqual(validateProductEvent(event, cancellation, "web"), { ok: false, reason: "source_not_allowed" });
    assert.equal(validateProductEvent(event, { entry: "settings", billing_interval: "annual" }, "server").ok, false);
  }
  assert.equal(validateProductEvent("billing_portal_opened", { entry: "settings", from: "past_due_banner" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("billing_portal_opened", { entry: "settings", from: "sidebar" }, "server"), { ok: false, reason: "invalid_property_value", property: "from" });
  assert.deepEqual(validateProductEvent("billing_portal_opened", { entry: "settings", from: "plan_card" }, "web"), { ok: false, reason: "source_not_allowed" });

  const dialog = { dialog: "keep_pro", entry: "seat_limit_invite", viewer_role: "owner" };
  assert.equal(validateProductEvent("plan_billing_dialog_opened", dialog, "web").ok, true);
  assert.equal(validateProductEvent("plan_billing_dialog_closed", { ...dialog, result: "dismissed" }, "desktop").ok, true);
  assert.equal(validateProductEvent("plan_billing_dialog_closed", dialog, "web").ok, false);
  assert.equal(validateProductEvent("plan_billing_dialog_opened", { dialog: "upgrade", entry: "settings" }, "web").ok, false);
  assert.deepEqual(validateProductEvent("plan_billing_dialog_opened", dialog, "server"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("plan_billing_dialog_closed", { ...dialog, result: "failed" }, "web"), { ok: false, reason: "invalid_property_value", property: "result" });
});

// xxchan, 2026-10-22 (task #13): where new accounts come from.
test("account_created is server-only, with the client, method and invite required", () => {
  const created = { platform: "mobile_web", method: "google", invited: false };
  assert.deepEqual(validateProductEvent("account_created", created, "server"), { ok: true, event: "account_created" });
  assert.equal(validateProductEvent("account_created", { ...created, platform: "unknown" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("account_created", created, "web"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("account_created", { method: "email", invited: true }, "server"), { ok: false, reason: "missing_property", property: "platform" });
  assert.deepEqual(validateProductEvent("account_created", { ...created, method: "password" }, "server"), { ok: false, reason: "invalid_property_value", property: "method" });
  assert.deepEqual(validateProductEvent("account_created", { ...created, email_domain: "example" }, "server"), { ok: false, reason: "unknown_property", property: "email_domain" });
});

// Workspace Artifacts (xxchan, 2026-10-26, #proj-workspace:7c500d89): web only,
// fixed values only, everything required; never an id, title, name or path.
test("Artifact events come from the web with fixed values only, every property required", () => {
  const web = (event: string, properties: Record<string, unknown>) => validateProductEvent(event, properties, "web");
  const opened = { source: "message_card", kind: "html", is_author: false, surface: "side" };
  assert.deepEqual(web("artifact_opened", opened), { ok: true, event: "artifact_opened" });
  assert.equal(validateProductEvent("artifact_opened", opened, "desktop").ok, true);
  for (const source of ["ios", "android", "harmonyos", "server"] as const) {
    assert.deepEqual(validateProductEvent("artifact_opened", opened, source), { ok: false, reason: "source_not_allowed" }, source);
  }
  for (const property of Object.keys(opened)) {
    const { [property]: _left, ...rest } = opened as Record<string, unknown>;
    assert.deepEqual(web("artifact_opened", rest), { ok: false, reason: "missing_property", property }, property);
  }
  assert.deepEqual(web("artifact_opened", { ...opened, artifact_id: "pt_x" }), { ok: false, reason: "unknown_property", property: "artifact_id" });
  assert.deepEqual(web("artifact_opened", { ...opened, title: "Q3 plan" }), { ok: false, reason: "unknown_property", property: "title" });
  assert.deepEqual(web("artifact_opened", { ...opened, source: "email" }), { ok: false, reason: "invalid_property_value", property: "source" });
  // The chip in a message's text has its own source beside the card's (Remy,
  // #proj-workspace:fbc76200). Values are added, never renamed: `other` stays.
  // The Artifacts page's All tab is `all`, beside `dashboard` (its For you tab; task #115).
  assert.deepEqual([...ARTIFACT_OPEN_SOURCES], ["message_card", "message_chip", "link", "dashboard", "search", "activity", "share", "other", "all"]);
  assert.deepEqual(web("artifact_opened", { ...opened, source: "all" }), { ok: true, event: "artifact_opened" });
  assert.deepEqual(web("artifact_opened", { ...opened, source: "message_chip" }), { ok: true, event: "artifact_opened" });

  assert.equal(web("artifact_viewer_action", { action: "comments_open" }).ok, true);
  assert.deepEqual(web("artifact_viewer_action", { action: "rename" }), { ok: false, reason: "invalid_property_value", property: "action" });
  assert.equal(web("artifact_comment_posted", { anchor: "page_anchor", is_reply: true, mention_count_bucket: "2-3" }).ok, true);
  assert.deepEqual(web("artifact_comment_posted", { anchor: "none", is_reply: false, mention_count_bucket: 2 }), { ok: false, reason: "invalid_property_value", property: "mention_count_bucket" });
  assert.equal(web("artifact_shared", { target: "thread", with_note: true, widen: "server" }).ok, true);
  assert.deepEqual(web("artifact_shared", { target: "thread", with_note: true, widen: "server", note: "hi" }), { ok: false, reason: "unknown_property", property: "note" });
  assert.equal(web("artifact_saved_from_attachment", {}).ok, true);
  assert.deepEqual(web("artifact_saved_from_attachment", { kind: "image" }), { ok: false, reason: "unknown_property", property: "kind" });
  assert.equal(web("artifact_imported", { via: "web" }).ok, true);
  assert.deepEqual(web("artifact_imported", {}), { ok: false, reason: "missing_property", property: "via" });
  assert.equal(web("artifact_frame_loaded", { result: "timeout", kind: "pdf", duration_bucket: ">5s" }).ok, true);
  // Only framed kinds have a frame; the duration is a bucket, never milliseconds.
  assert.deepEqual(web("artifact_frame_loaded", { result: "ok", kind: "image", duration_bucket: "<500ms" }), { ok: false, reason: "invalid_property_value", property: "kind" });
  assert.deepEqual(web("artifact_frame_loaded", { result: "ok", kind: "html", duration_bucket: 420 }), { ok: false, reason: "invalid_property_value", property: "duration_bucket" });
});

test("the Artifact event kinds are the shared ArtifactKind and ARTIFACT_FRAMED_KINDS", () => {
  const kinds: Record<ArtifactKind, true> = { html: true, markdown: true, text: true, csv: true, image: true, pdf: true, video: true, other: true };
  assert.deepEqual([...ARTIFACT_EVENT_KINDS].sort(), Object.keys(kinds).sort());
  const eventKinds: readonly ArtifactKind[] = ARTIFACT_EVENT_KINDS;
  assert.ok(eventKinds.length > 0);
  assert.deepEqual([...ARTIFACT_FRAMED_EVENT_KINDS], [...ARTIFACT_FRAMED_KINDS]);
});

test("action card events: every card type, steps only from the server, shown only from the web", () => {
  // productEvents.ts imports nothing, so it lists the types itself; a new card type must be added here too.
  assert.deepEqual([...PRODUCT_EVENT_ACTION_CARD_TYPES].sort(), [...ACTION_CARD_ACTION_TYPES].sort());

  const step = { action: "execute_fail", action_type: "agent:create", reported_by: "server", error_class: "conflict" };
  assert.deepEqual(validateProductEvent("action_card_action", step, "server"), { ok: true, event: "action_card_action" });
  assert.equal(validateProductEvent("action_card_action", { action: "open", action_type: "plan:upgrade", reported_by: "client", platform: "pwa" }, "server").ok, true);
  // A client cannot send a step itself, least of all a success.
  assert.deepEqual(validateProductEvent("action_card_action", { ...step, action: "execute_success" }, "web"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("action_card_action", { ...step, action: "expired" }, "server"), { ok: false, reason: "invalid_property_value", property: "action" });
  assert.deepEqual(validateProductEvent("action_card_action", { action: "open", reported_by: "client" }, "server"), { ok: false, reason: "missing_property", property: "action_type" });

  assert.deepEqual(validateProductEvent("action_card_shown", { action_type: "channel:create" }, "web"), { ok: true, event: "action_card_shown" });
  assert.deepEqual(validateProductEvent("action_card_shown", { action_type: "channel:create" }, "server"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("action_card_shown", { action_type: "channel:create", card_id: "x" }, "desktop"), { ok: false, reason: "unknown_property", property: "card_id" });
});

test("feature_action: one event for every feature, from the web clients, with fixed values", () => {
  const sent = { feature: "invite", action: "submit", surface: "sidebar", variant: "email", count: 2 };
  assert.deepEqual(validateProductEvent("feature_action", sent, "web"), { ok: true, event: "feature_action" });
  assert.equal(validateProductEvent("feature_action", { feature: "invite", action: "open", surface: "server_menu" }, "desktop").ok, true);
  assert.equal(validateProductEvent("feature_action", { feature: "invite", action: "open", surface: "members_page" }, "web").ok, true);
  assert.deepEqual(validateProductEvent("feature_action", { action: "open" }, "web"), { ok: false, reason: "missing_property", property: "feature" });
  assert.deepEqual(validateProductEvent("feature_action", { ...sent, feature: "chat" }, "web"), { ok: false, reason: "invalid_property_value", property: "feature" });
  assert.deepEqual(validateProductEvent("feature_action", { ...sent, email: "a" }, "web"), { ok: false, reason: "unknown_property", property: "email" });
  assert.deepEqual(validateProductEvent("feature_action", sent, "server"), { ok: false, reason: "source_not_allowed" });
});

// AndyLok (data owner, 2026-11-08): Raft Desktop's move to the official raft-computer.
test("desktop_computer_migration_finished: desktop only, closed lists, bounded integers and versions, no free text", () => {
  const sent = {
    operation_id: "3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b",
    report_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
    outcome: "failed",
    step: "install",
    error_code: "computer_install_held",
    proxy: "shell",
    platform: "darwin-arm64",
    desktop_version: "1.21.58",
    computer_version: "0.62.0",
    attempt: 2,
    duration_ms: 41_250,
    ended_at: 1_793_000_000_000,
  };
  const ok = { ok: true, event: "desktop_computer_migration_finished" };
  assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", sent, "desktop"), ok);
  // Success: no error code; an unknown Computer version is left out.
  const { error_code: _code, computer_version: _version, ...succeeded } = sent;
  assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", { ...succeeded, outcome: "succeeded", step: "verify" }, "desktop"), ok);
  assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", { ...sent, desktop_version: "1.22.0-beta.3" }, "desktop"), ok);
  assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", { ...sent, attempt: 20, duration_ms: 3_600_000 }, "desktop"), ok);
  assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", sent, "web"), { ok: false, reason: "source_not_allowed" });

  const invalid = (patch: Record<string, unknown>, property: string, why: string) =>
    assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", { ...sent, ...patch }, "desktop"), { ok: false, reason: "invalid_property_value", property }, why);
  invalid({ outcome: "done" }, "outcome", "outcomes are a closed list");
  invalid({ step: "journal" }, "step", "steps are the six of the move");
  invalid({ error_code: "EACCES" }, "error_code", "an OS code is not one of the list");
  invalid({ error_code: "computer_install_failed: could not reach hands.build" }, "error_code", "never a message");
  invalid({ proxy: "http://10.0.0.1:7890" }, "proxy", "the source, never the address");
  invalid({ platform: "darwin" }, "platform", "os and arch");
  invalid({ desktop_version: "1.21" }, "desktop_version", "a full version");
  invalid({ desktop_version: "/Applications/Raft.app" }, "desktop_version", "no paths");
  invalid({ computer_version: "0.62.0 (darwin; Bob's MacBook)" }, "computer_version", "a version and nothing more");
  invalid({ attempt: 21 }, "attempt", "capped at 20");
  invalid({ attempt: 0 }, "attempt", "counted from 1");
  invalid({ attempt: 1.5 }, "attempt", "an integer");
  invalid({ duration_ms: 3_600_001 }, "duration_ms", "capped");
  invalid({ duration_ms: -1 }, "duration_ms", "never negative");
  invalid({ operation_id: "machine 7f3a" }, "operation_id", "a random token");
  invalid({ report_id: "Report For Bob" }, "report_id", "a random token");
  invalid({ ended_at: -1 }, "ended_at", "an epoch time");
  invalid({ ended_at: "2026-11-08T10:00:00Z" }, "ended_at", "epoch ms, not a string");
  for (const property of ["operation_id", "report_id", "outcome", "proxy", "platform", "desktop_version", "attempt", "duration_ms", "ended_at"]) {
    const { [property]: _dropped, ...rest } = sent as Record<string, unknown>;
    assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", rest, "desktop"), { ok: false, reason: "missing_property", property });
  }
  for (const property of ["machine_id", "message", "proxy_url", "path", "user"]) {
    assert.deepEqual(validateProductEvent("desktop_computer_migration_finished", { ...sent, [property]: "x" }, "desktop"), { ok: false, reason: "unknown_property", property });
  }
  for (const code of DESKTOP_COMPUTER_MIGRATION_ERROR_CODES) {
    assert.ok(code.length <= DESKTOP_COMPUTER_MIGRATION_ERROR_CODE_MAX_LENGTH, code);
  }
});

// The Computers page (cindyz, 2026-11-12, #proj-analytics:a559ea75): enums, booleans and counts, nothing that names a computer.
test("computers_list_viewed is a web snapshot of the view, grouping, sort, counts and whether a filter or a search stood, with a direction and a runtime only where the sort has one", () => {
  const viewed = { variant: "desktop", view: "cards", group_by: "none", sort_key: "default", computer_count: 12, online_count: 5, own_count: 2, filtered: false, searched: false };
  assert.equal(validateProductEvent("computers_list_viewed", { ...viewed, filtered: true, searched: true }, "web").ok, true, "a page opened again with its filters standing");
  for (const source of ["web", "desktop"] as const) assert.equal(validateProductEvent("computers_list_viewed", viewed, source).ok, true, source);
  assert.equal(validateProductEvent("computers_list_viewed", { ...viewed, computer_count: 0, online_count: 0, own_count: 0 }, "web").ok, true, "no computers yet");
  assert.equal(validateProductEvent("computers_list_viewed", { ...viewed, variant: "phone", view: "list", group_by: "prefix", sort_key: "remaining", sort_direction: "desc", sort_runtime: "claude" }, "web").ok, true);
  for (const source of ["server", "ios", "android", "harmonyos"] as const) {
    assert.deepEqual(validateProductEvent("computers_list_viewed", viewed, source), { ok: false, reason: "source_not_allowed" }, source);
  }
  for (const property of Object.keys(viewed)) {
    const props: Record<string, unknown> = { ...viewed };
    delete props[property];
    assert.deepEqual(validateProductEvent("computers_list_viewed", props, "web"), { ok: false, reason: "missing_property", property });
  }
  for (const [property, value] of Object.entries({ variant: "tablet", view: "board", group_by: "owner", sort_key: "remaining:claude", sort_direction: "ascending", sort_runtime: "other", computer_count: -1, online_count: 10_001, own_count: 1.5, filtered: "status", searched: 3 })) {
    assert.deepEqual(validateProductEvent("computers_list_viewed", { ...viewed, [property]: value }, "web"), { ok: false, reason: "invalid_property_value", property });
  }
  for (const property of ["machine_id", "name", "hostname", "query"]) {
    assert.deepEqual(validateProductEvent("computers_list_viewed", { ...viewed, [property]: "x" }, "web"), { ok: false, reason: "unknown_property", property });
  }
});

test("the Computers page's runtimes are the usage providers, written out in the registry", () => {
  assert.deepEqual([...COMPUTERS_LIST_SORT_RUNTIMES], [...RUNTIME_ACCOUNT_USAGE_PROVIDERS]);
  assert.deepEqual([...COMPUTERS_LIST_RUNTIMES], [...RUNTIME_ACCOUNT_USAGE_PROVIDERS, "other"]);
});

test("computers_list_control_changed names the control, where it is and what it was set to, never the search text", () => {
  const changed = { control: "status", value: "online", surface: "toolbar", variant: "desktop", computer_count: 12 };
  for (const source of ["web", "desktop"] as const) assert.equal(validateProductEvent("computers_list_control_changed", changed, source).ok, true, source);
  const valid: Array<Record<string, unknown>> = [
    { ...changed, control: "search", value: undefined },
    { ...changed, control: "runtime", value: undefined, runtime: "other", runtime_selected: true },
    { ...changed, control: "runtime", value: undefined, runtime: "codex", runtime_selected: false, variant: "phone" },
    { ...changed, control: "group", value: "prefix", surface: "more_menu" },
    { ...changed, control: "sort_key", value: "remaining", runtime: "kimi", surface: "column_heading" },
    { ...changed, control: "sort_key", value: "default" },
    { ...changed, control: "sort_direction", value: "asc", surface: "column_heading" },
    { ...changed, control: "view", value: "list" },
    { ...changed, control: "clear_all", value: undefined, surface: "empty_state" },
    { ...changed, control: "group_fold", value: "folded", surface: "list" },
    { ...changed, control: "offline_fold", value: "open", surface: "list" },
  ];
  for (const props of valid) assert.equal(validateProductEvent("computers_list_control_changed", props, "web").ok, true, JSON.stringify(props));
  assert.deepEqual(validateProductEvent("computers_list_control_changed", changed, "server"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("computers_list_control_changed", changed, "ios"), { ok: false, reason: "source_not_allowed" });
  for (const property of ["control", "surface", "variant", "computer_count"]) {
    const props: Record<string, unknown> = { ...changed };
    delete props[property];
    assert.deepEqual(validateProductEvent("computers_list_control_changed", props, "web"), { ok: false, reason: "missing_property", property });
  }
  for (const [property, value] of Object.entries({ control: "add_computer", value: "remaining:claude", runtime: "cursor", runtime_selected: "yes", surface: "sidebar", variant: "tablet", computer_count: 10_001 })) {
    assert.deepEqual(validateProductEvent("computers_list_control_changed", { ...changed, [property]: value }, "web"), { ok: false, reason: "invalid_property_value", property });
  }
  for (const property of ["query", "query_length", "group_key", "machine_id"]) {
    assert.deepEqual(validateProductEvent("computers_list_control_changed", { ...changed, [property]: "ax42" }, "web"), { ok: false, reason: "unknown_property", property });
  }
});

test("computers_list_computer_opened says whose computer, its status and what was applied to the list, never which computer", () => {
  const opened = { variant: "desktop", view: "list", relation: "own", status: "online", filtered: false, searched: true, sorted: false, grouped: false };
  for (const source of ["web", "desktop"] as const) assert.equal(validateProductEvent("computers_list_computer_opened", opened, source).ok, true, source);
  assert.equal(validateProductEvent("computers_list_computer_opened", { ...opened, relation: "this_device", status: "offline", position: 1 }, "desktop").ok, true);
  assert.equal(validateProductEvent("computers_list_computer_opened", { ...opened, variant: "phone", view: "cards", relation: "other", position: 37 }, "web").ok, true);
  assert.equal(validateProductEvent("computers_list_computer_opened", { ...opened, search_matched_name: true, search_matched_hostname: false, search_matched_owner: true }, "web").ok, true, "which fields the search found it by");
  for (const property of ["search_matched_name", "search_matched_hostname", "search_matched_owner"]) {
    assert.deepEqual(validateProductEvent("computers_list_computer_opened", { ...opened, [property]: "hetzner" }, "web"), { ok: false, reason: "invalid_property_value", property }, "never the text");
  }
  assert.deepEqual(validateProductEvent("computers_list_computer_opened", opened, "server"), { ok: false, reason: "source_not_allowed" });
  assert.deepEqual(validateProductEvent("computers_list_computer_opened", opened, "android"), { ok: false, reason: "source_not_allowed" });
  for (const property of Object.keys(opened)) {
    const props: Record<string, unknown> = { ...opened };
    delete props[property];
    assert.deepEqual(validateProductEvent("computers_list_computer_opened", props, "web"), { ok: false, reason: "missing_property", property });
  }
  for (const [property, value] of Object.entries({ variant: "tablet", view: "board", relation: "mine", status: "attention", filtered: "no", searched: 1, sorted: "name", grouped: "prefix", position: 0 })) {
    assert.deepEqual(validateProductEvent("computers_list_computer_opened", { ...opened, [property]: value }, "web"), { ok: false, reason: "invalid_property_value", property });
  }
  for (const property of ["machine_id", "name", "hostname", "owner_id"]) {
    assert.deepEqual(validateProductEvent("computers_list_computer_opened", { ...opened, [property]: "x" }, "web"), { ok: false, reason: "unknown_property", property });
  }
});

test("every bounded property's own values fit its bounds", () => {
  for (const [name, spec] of Object.entries(PRODUCT_EVENT_REGISTRY) as Array<[string, ProductEventSpec]>) {
    for (const [property, propertySpec] of Object.entries(spec.properties)) {
      if (propertySpec.type === "enum" && propertySpec.maxLength !== undefined) {
        for (const value of propertySpec.values) assert.ok(value.length <= propertySpec.maxLength, `${name}.${property}: ${value}`);
      }
      if (propertySpec.type === "integer" && propertySpec.min !== undefined && propertySpec.max !== undefined) {
        assert.ok(propertySpec.min <= propertySpec.max, `${name}.${property}`);
      }
    }
  }
});
