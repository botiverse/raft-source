import type { SlackLifecycleClock, SlackChannelLifecycleObservation } from "../services/slackChannelLifecycleObservation";
import type { SlackIngressReleaseRecord } from "../services/slackVerifiedIngressRolloutContracts";
import type { SlackReconciliationScan } from "../services/slackReconciliationScan";
import type { AgentRuntimeApprovalItem } from "../services/agentRuntimeApprovalItem";
import type { ILinkBotId, ILinkQrcodeHandle, ILinkUserId, WeChatContextToken } from "../services/wechatILinkClient";
import type { SyncHorizon } from "../services/syncHorizon";
import { createAppSumoClaimId, type AppSumoClaimId, type AppSumoLicenseKey } from "../services/appSumoContracts";
import type { SlackHumanMentionSnapshot, SlackMentionCapability, SlackMentionWriteFailures } from "../services/slackMentionReconcileState";
import type { AppLinkPreviewRevision, AppLinkPreviewVersion } from "@botiverse/raft-shared/src/appLinkPreview";
import type { SsoConnectionConfig } from "../services/sso/ssoConnectionConfig";
import { DISPLAY_LOCALES } from "@botiverse/raft-shared/src/displayLocales";
import type { DisplayLocale } from "@botiverse/raft-shared/src/displayLocales";
import type { AgentCallApprovalDecidedBy, AgentContextViewGrantId, ChannelSideLayout, ReadinessFact, ServerRole, StoredShortcutOverrides } from "@botiverse/raft-shared";
import type { ActivityTurnSummary, AnnouncementAudience, AnnouncementAudienceSnapshot, AnnouncementContent, MentionDeliveryTerminalDecision } from "@botiverse/raft-shared";
import { pgTable, pgSequence, text, timestamp, integer, bigint, bigserial, uuid, primaryKey, unique, uniqueIndex, index, json, jsonb, boolean, customType, check, date, foreignKey, smallint, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentMigrationHostedImportLimits,
  AgentMigrationHostedImportSummary,
  AgentMigrationSourceBuildProgress,
  AgentMigrationSourceDrainRecord,
  AgentMigrationTransferSummary,
  AgentMigrationUserIgnoreAdditionsReceipt,
  AgentRuntimeErrorState,
  AgentMessage,
  AgentMigrationControlManifest,
  AgentMigrationSourceQuiesceReceipt,
  FeatureFlagRolloutNarrowingOperation,
  FeatureFlagRolloutWideningOperation,
  RuntimeConfig,
  TrajectoryEntry,
  ManagedMcpToolCatalogEntry,
  ProviderConnectionProviderId,
  TaskResourceReceipt,
} from "@botiverse/raft-shared";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Users — registered accounts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  preferredLanguage: text("preferred_language"),
  // UI display language (app-chrome i18n). Distinct from preferredLanguage,
  // which is the message-translation target. Nullable → fall back to browser.
  displayLanguage: text("display_language"),
  preferredTimezone: text("preferred_timezone"),
  // Low-sensitivity geo proxies observed from the authenticated browser.
  // Keep these separate from preferredTimezone: product preferences are mutable.
  // `first` is the earliest observation after rollout (not registration/home),
  // while `last` is the most recent observation and is intentionally mutable.
  firstObservedTimezone: text("first_observed_timezone"),
  firstObservedTimezoneAt: timestamp("first_observed_timezone_at", { withTimezone: true }),
  lastObservedTimezone: text("last_observed_timezone"),
  lastObservedTimezoneAt: timestamp("last_observed_timezone_at", { withTimezone: true }),
  // When this account last loaded its profile from Raft Desktop (the web
  // client's X-Raft-Client-Platform: desktop_app on GET /auth/me), at most one
  // write a day. Read only as "used Raft Desktop in the last 30 days", the hint
  // that lets a desktop browser offer to open a message link in the app.
  lastDesktopAppSeenAt: timestamp("last_desktop_app_seen_at", { withTimezone: true }),
  autoTranslationEnabled: boolean("auto_translation_enabled").notNull().default(false),
  preferredTranslationMode: text("preferred_translation_mode", { enum: ["auto", "manual", "off"] }).notNull().default("off"),
  preferredTranslationDisplay: text("preferred_translation_display", { enum: ["translated", "original", "bilingual"] }).notNull().default("translated"),
  preferredTimeFormat: text("preferred_time_format", { enum: ["12h", "24h"] }),
  preferredMessageBodyFontSize: text("preferred_message_body_font_size", { enum: ["sm", "md", "lg"] }),
  referralSource: text("referral_source"),
  referralSourceOther: text("referral_source_other"),
  referralSourceSkippedAt: timestamp("referral_source_skipped_at", { withTimezone: true }),
  serverSwitcherOrder: json("server_switcher_order").$type<string[]>(),
  serverOrderVersion: integer("server_order_version").notNull().default(0),
  // The person's order of the rail's navigation tabs (search, chat, …), one
  // order for every server; null = the default order.
  railTabOrder: json("rail_tab_order").$type<string[]>(),
  // The personal assistant's otter over every page (#proj-assistant:#21): shown
  // unless the person turns it off, and the shortcut that hides it for a while
  // (null = the default, "off" = none; shared assistantOtterShortcut.ts).
  assistantOtterVisible: boolean("assistant_otter_visible").notNull().default(true),
  assistantOtterShortcut: text("assistant_otter_shortcut"),
  // How the message box sends (#triage:#210; shared composerSendKey.ts):
  // null = the default (Enter sends), "mod_enter" = ⌘/Ctrl+Enter sends.
  composerSendKey: text("composer_send_key", { enum: ["mod_enter"] }),
  // The keyboard shortcuts the person changed (#proj-frontend:#37; shared shortcutOverrides.ts): command id → its
  // shortcuts, written with mod (⌘ on Apple platforms, Ctrl elsewhere); only changed commands; null = all defaults.
  shortcutOverrides: json("shortcut_overrides").$type<StoredShortcutOverrides>(),
  passwordHash: text("password_hash").notNull(),
  // null means the hash is only the random, unknowable placeholder created for
  // a social-only signup. Keep credential presence explicit: the hash column is
  // required for rolling-deploy compatibility, but it is not itself evidence
  // that the human has a usable password login method.
  passwordCredentialEstablishedAt: timestamp("password_credential_established_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredReason: text("retired_reason"),
  stagingSelfAccountCapabilityHash: text("staging_self_account_capability_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  // Account-global identity-setup durable state (task #118 PR-2). null = the user
  // has not finished identity setup (display name / @handle chosen) and is gated to
  // the identity-setup step before any business surface; set = complete + monotonic
  // (never reopens). Distinct from serverMembers.setupStatus (per-server setup).
  profileSetupCompletedAt: timestamp("profile_setup_completed_at", { withTimezone: true }),
  // The visible @handle suggestion shown in identity-setup (derived from provider
  // name / email at signup, stored so it is stable across refresh/re-login). This
  // is NOT the internal `pending_<hex>` placeholder in `name`; null once complete.
  profileSetupSuggestedHandle: text("profile_setup_suggested_handle"),
  // Signup survey, asked once between email verification and identity setup.
  //
  // Only the ROLE is new. "How did you hear about us" already lives in
  // `referralSource` / `referralSourceOther` above and is written by PATCH
  // /api/auth/me; the survey reuses those rather than opening a second column for
  // the same fact.
  //
  // `signupRole` is not a vanity metric: it is fed into the onboarding agent's
  // briefing so Cindy adapts to who the person actually is. If that stops being
  // true, stop asking for it.
  signupRole: text("signup_role"),
  // The gate: null = the survey has not been answered. Monotonic, like
  // profileSetupCompletedAt. Backfilled only for accounts that already finished
  // profile setup, so someone still short of a handle is not skipped past it.
  signupSurveyCompletedAt: timestamp("signup_survey_completed_at", { withTimezone: true }),
  // Account-global announcement gate. The first final onboarding handoff stamps
  // both facts atomically; the session-family id suppresses announcements for
  // that same login family while allowing them on the next login.
  firstOnboardingCompletedAt: timestamp("first_onboarding_completed_at", { withTimezone: true }),
  firstOnboardingCompletedSessionFamilyId: uuid("first_onboarding_completed_session_family_id"),
  // RFC-067 §3.6 product-analytics controls, read only through
  // services/productAnalyticsGate.ts. Opting out deletes the user's
  // user_analytics_ids row; this column records the choice.
  analyticsOptedOutAt: timestamp("analytics_opted_out_at", { withTimezone: true }),
  // "Share usage data" (client events). null = not chosen, which counts as
  // sharing (SHARE_USAGE_DATA_DEFAULT in packages/shared, RFC-067 default on).
  shareUsageData: boolean("share_usage_data"),
  // Two-step verification (passkey / TOTP second factor): when the person
  // turned it on. null = off. While it is set, the first-factor sign-in gates require a second factor while it is set
  // (services/sessionIssueGate.ts, services/secondFactor/signIn.ts).
  secondFactorRequiredAt: timestamp("second_factor_required_at", { withTimezone: true }),
  // The WebAuthn user handle (`user.id` in a passkey registration): opaque
  // bytes authenticators keep one passkey per account by. Written once, at the
  // person's first passkey registration (services/secondFactor/passkeyManagement.ts):
  // 32 random bytes, or, for a person who registered passkeys before this
  // column existed, the HMAC handle those passkeys already carry. null = no
  // passkey registered yet. Never looked up: sign-in finds a passkey by its
  // credential id, so no index; random (or per-person HMAC), so no unique
  // constraint either.
  webauthnUserHandle: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("webauthn_user_handle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // The only user identifier traces carry (as `trace_user_id`): random, not
  // derivable from `id`. Traces are kept indefinitely, so retiring or deleting an
  // account rotates this value (never clears it); the old value then matches no
  // one.
  traceUserId: uuid("trace_user_id").notNull().defaultRandom(),
}, (table) => [
  uniqueIndex("idx_users_name_exact_unique").on(table.name),
  // Traces carry only trace_user_id; mapping one back to a user is a lookup on
  // this column. Random, so unique by construction; the index makes duplicates
  // impossible and the reverse lookup one probe.
  uniqueIndex("idx_users_trace_user_id_unique").on(table.traceUserId),
  check(
    "users_timezone_observation_consistent",
    sql`(
      ${table.firstObservedTimezone} IS NULL
      AND ${table.firstObservedTimezoneAt} IS NULL
    ) OR (
      length(btrim(${table.firstObservedTimezone})) > 0
      AND ${table.firstObservedTimezoneAt} IS NOT NULL
    )`,
  ),
  check(
    "users_last_timezone_observation_consistent",
    sql`(
      ${table.firstObservedTimezone} IS NULL
      AND ${table.lastObservedTimezone} IS NULL
      AND ${table.lastObservedTimezoneAt} IS NULL
    ) OR (
      ${table.firstObservedTimezone} IS NOT NULL
      AND ${table.lastObservedTimezone} IS NULL
      AND ${table.lastObservedTimezoneAt} IS NULL
    ) OR (
      ${table.firstObservedTimezone} IS NOT NULL
      AND length(btrim(${table.lastObservedTimezone})) > 0
      AND ${table.lastObservedTimezoneAt} IS NOT NULL
      AND ${table.lastObservedTimezoneAt} >= ${table.firstObservedTimezoneAt}
    )`,
  ),
]);

// RFC-067 §3.4: each user's random product-analytics id. Product tables
// (ScopeDB) store only analytics_id; deleting this row makes them unlinkable.
// It must stay random and stored (never derived from the user id). Rows are
// created by the users insert trigger (migration 0321) and removed on opt-out;
// the derivation job maps ids in memory through productAnalyticsGate.
export const userAnalyticsIds = pgTable("user_analytics_ids", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  analyticsId: uuid("analytics_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userAuthIdentities = pgTable("user_auth_identities", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["google", "github", "apple"] }).notNull(),
  providerUserId: text("provider_user_id").notNull(),
  providerEmail: text("provider_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_user_auth_identities_provider_user").on(table.provider, table.providerUserId),
  uniqueIndex("idx_user_auth_identities_user_provider").on(table.userId, table.provider),
  index("idx_user_auth_identities_user").on(table.userId),
]);

export const newsletterAudienceContacts = pgTable("newsletter_audience_contacts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  audienceId: text("audience_id").notNull(),
  resendContactId: text("resend_contact_id"),
  status: text("status", { enum: ["synced", "sync_failed", "unsubscribed", "bounced", "complained"] }).notNull().default("synced"),
  lastSyncError: text("last_sync_error"),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_newsletter_contacts_audience_email").on(table.audienceId, table.email),
  index("idx_newsletter_contacts_user").on(table.userId),
  index("idx_newsletter_contacts_status").on(table.status),
]);

export const newsletterWebhookEvents = pgTable("newsletter_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  email: text("email"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Product-feedback business and read/unread state is authoritative in Hands.
// Raft persists no ticket, event, read cursor, attachment, reporter, or route-
// subject projection. This one-way commitment only pins the configured route
// cryptographic root so a silent secret swap fails closed before Hands traffic.
export const integrationSecretCommitments = pgTable("integration_secret_commitments", {
  label: text("label").primaryKey(),
  commitment: customType<{ data: Buffer }>({ dataType: () => "bytea" })("commitment").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("integration_secret_commitments_commitment_32", sql`octet_length(${t.commitment}) = 32`),
]);

export const onboardingEmailJourneys = pgTable("onboarding_email_journeys", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  journeyKey: text("journey_key").notNull().default("new_user_day0_day1"),
  releaseMode: text("release_mode", { enum: ["dry_run", "allowlist", "all"] }).notNull(),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull(),
  day0Status: text("day0_status", { enum: ["pending", "dry_run", "sent", "skipped", "failed"] }).notNull().default("pending"),
  day0EmailId: text("day0_email_id"),
  day0SentAt: timestamp("day0_sent_at", { withTimezone: true }),
  day1Status: text("day1_status", { enum: ["pending", "dry_run", "scheduled", "skipped", "failed"] }).notNull().default("pending"),
  day1EmailId: text("day1_email_id"),
  day1ScheduledAt: timestamp("day1_scheduled_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  lastError: text("last_error"),
  suppressedReason: text("suppressed_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_onboarding_email_journeys_user_key").on(table.userId, table.journeyKey),
  index("idx_onboarding_email_journeys_user").on(table.userId),
  index("idx_onboarding_email_journeys_email").on(table.email),
]);

export const socialAuthCompletions = pgTable("social_auth_completions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  codeHash: text("code_hash"),
  provider: text("provider", { enum: ["google", "github", "apple"] }).notNull(),
  mode: text("mode", { enum: ["login", "link"] }).notNull(),
  intendedAction: text("intended_action", { enum: ["login", "link"] }).notNull(),
  status: text("status", {
    enum: ["pending_provider", "provider_processing", "provider_completed", "pending_link", "completed", "failed", "expired"],
  }).notNull().default("provider_completed"),
  codeChallenge: text("code_challenge"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerUserId: text("provider_user_id"),
  providerEmail: text("provider_email"),
  providerDisplayName: text("provider_display_name"),
  providerAvatarUrl: text("provider_avatar_url"),
  returnTo: text("return_to"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_social_auth_completions_code_hash").on(table.codeHash),
  index("idx_social_auth_completions_expires_at").on(table.expiresAt),
  index("idx_social_auth_completions_user").on(table.userId),
  index("idx_social_auth_completions_status").on(table.status),
]);

export const oauthTransactions = socialAuthCompletions;

/**
 * App login handoff: a native app (HarmonyOS first) opens the ordinary web
 * login, the signed-in web user confirms, and the app exchanges a one-time
 * code plus its PKCE verifier for a normal user session. Not an OAuth
 * transaction: no provider, no provider callback.
 */
export const appLoginRequests = pgTable("app_login_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  codeChallenge: text("code_challenge").notNull(),
  returnUri: text("return_uri").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied", "completed"] }).notNull().default("pending"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // The web session family that approved the request (null before approval,
  // for approvals before this column, and for a token without a family). The
  // code is exchanged only while that sign-in is live, and a revoke of the
  // family denies it (sessionService.isApprovingSessionLive /
  // denyLoginCodesApprovedBy); an approved code with null is refused.
  // SET NULL like the other family pointers: a family row goes only with its user.
  approverFamilyId: uuid("approver_family_id").references((): AnyPgColumn => sessionFamilies.id, { onDelete: "set null" }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_app_login_requests_code_hash").on(table.codeHash),
  index("idx_app_login_requests_approver_family").on(table.approverFamilyId),
  index("idx_app_login_requests_expires_at").on(table.expiresAt),
  check("app_login_requests_status_check", sql`${table.status} IN ('pending', 'approved', 'denied', 'completed')`),
]);

export const userLegalAcceptances = pgTable("user_legal_acceptances", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  termsVersion: text("terms_version").notNull(),
  privacyVersion: text("privacy_version").notNull(),
  termsUrl: text("terms_url").notNull(),
  privacyUrl: text("privacy_url").notNull(),
  source: text("source", { enum: ["signup", "oauth", "invite"] }).notNull(),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  locale: text("locale"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_user_legal_acceptances_user").on(table.userId),
  index("idx_user_legal_acceptances_source").on(table.source),
]);

// Servers — multi-tenant isolation unit
export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  slug: text("slug").notNull().unique(),
  kind: text("kind", { enum: ["normal", "joint_storage"] }).notNull().default("normal"),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  onboardingAgentId: uuid("onboarding_agent_id"),
  agentAllChannelGreetingEnabled: boolean("agent_all_channel_greeting_enabled").notNull().default(true),
  hideHumansFromMembers: boolean("hide_humans_from_members").notNull().default(false),
  // Task #70. When true, logged-out visitors may READ this server's guest-visible ordinary
  // channels. Deliberately a plain column read on every anonymous request rather than anything
  // cached or token-shaped: after turning it off, the next anonymous list/page request must fail
  // (@cindyz, hard requirement 2). Already-downloaded content and a query that passed its check
  // cannot be revoked; the contract deliberately does not pretend otherwise.
  publiclyVisible: boolean("publicly_visible").notNull().default(false),
  // public_guest_join_enabled (Task #74, public Guest join) is retired
  // (#wg-rbac:#47) and dropped (migration guest_join_public_column_drop).
  // Public server SEO (#proj-public-server-seo). Whether a public server's
  // pages may be indexed on raft.build. Reading stays governed by
  // publiclyVisible; this only decides search indexing. Default true, but
  // nothing is exposed by the default alone: the indexing master switch
  // (public_server_search_index_v0) stays closed until owners are notified.
  publicSearchEnabled: boolean("public_search_enabled").notNull().default(true),
  plan: text("plan", { enum: ["free", "founder", "partner", "pro"] }).notNull().default("free"),
  translationEnabled: boolean("translation_enabled").notNull().default(false),
  // RFC-067 §3.6: the owner's workspace-wide product-analytics switch. When
  // false, nobody's activity in this server is linked to an analytics_id.
  productAnalyticsEnabled: boolean("product_analytics_enabled").notNull().default(true),
  planDowngradedAt: timestamp("plan_downgraded_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Closed-server purge, `delete` mode (services/closedServerPurge.ts): its
  // progress on a server closed over 30 days ago, so a purge stopped by a
  // crash, a deploy or its run budget resumes where it was. NULL on every
  // server the purge has not claimed. purge_state is the step it is on
  // (apps, channels, object_events, agents, scrub; `blocked`: channels it
  // could not clear, retried a day later; `rows_deleted`: its rows are
  // deleted and the finish (closedServerPurgeFinish.ts) is on it, purged_at
  // still NULL while a finish step is not done (retried a day later);
  // `done`). purge_lease_until and
  // purge_lease_token: the run that holds the server; every batch re-checks
  // both (and that the server is still closed over 30 days) under the row's
  // lock, so two runs never purge one server. A server whose purge failed
  // keeps its step and waits under a lease with no token (a day out); one
  // found reopened has its purge_state cleared. purged_at: when the purge
  // finished (`done`); the tombstone row itself is never deleted.
  purgeState: text("purge_state", { enum: ["apps", "channels", "object_events", "agents", "scrub", "blocked", "rows_deleted", "done"] }),
  purgeLeaseUntil: timestamp("purge_lease_until", { withTimezone: true }),
  purgeLeaseToken: uuid("purge_lease_token"),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
}, (t) => [
  check("servers_purge_state_known", sql`${t.purgeState} IS NULL OR ${t.purgeState} IN ('apps', 'channels', 'object_events', 'agents', 'scrub', 'blocked', 'rows_deleted', 'done')`),
]);

// Server members — user ↔ server relationship
export const serverMembers = pgTable("server_members", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "member", "guest"] }).notNull().default("member"),
  // A Guest belongs to exactly one channel of this server (guest + external
  // channels, #wg-rbac:#15): set iff role is guest. No ON DELETE action:
  // channels are soft-deleted, and deleting or archiving a channel removes
  // or cuts off its Guest through the normal member paths.
  guestChannelId: uuid("guest_channel_id").references((): AnyPgColumn => channels.id),
  setupModalReminderOptOut: boolean("setup_modal_reminder_opt_out").notNull().default(false),
  dismissedAddComputerStepAt: timestamp("dismissed_add_computer_step_at", { withTimezone: true }),
  dismissedCreateAgentStepAt: timestamp("dismissed_create_agent_step_at", { withTimezone: true }),
  dismissedInviteStepAt: timestamp("dismissed_invite_step_at", { withTimezone: true }),
  dismissedCommunityStepAt: timestamp("dismissed_community_step_at", { withTimezone: true }),
  dismissedNotificationStepAt: timestamp("dismissed_notification_step_at", { withTimezone: true }),
  onboardingWizardCurrentStep: text("onboarding_wizard_current_step", {
    enum: ["add-computer", "detect-runtime", "create-agent", "referral-source", "invite-teammates", "join-community", "enable-notifications", "complete"],
  }),
  // Phase-4 durable owner-setup state (task #118 / #113 note + A1-A4). Transitions
  // not_started -> in_progress -> (deferred) -> complete; `complete` is the single
  // terminal state and never regresses on transient Computer/runtime flux (live
  // conditions are resolver inputs, not persisted). Single source of setup truth —
  // consumers migrate off derived onboardingWizardCurrentStep to getServerSetupState.
  // Written only via transitionServerSetupState (#117).
  setupStatus: text("setup_status", {
    enum: ["not_started", "in_progress", "deferred", "complete"],
  }).notNull().default("not_started"),
  setupDeferredAt: timestamp("setup_deferred_at", { withTimezone: true }),
  setupCompletionReason: text("setup_completion_reason", {
    enum: ["normal", "grandfathered", "complete_after_defer", "admin_override"],
  }),
  setupContractVersion: text("setup_contract_version").notNull().default("onboarding-setup-v1"),
  // The handoff screen's own truth: "the owner pressed Let's Go".
  //
  // It used to be inferred from the briefing DELIVERY timestamps below, which answer a
  // different question ("did the letter arrive?"). The two diverge in both directions:
  // a briefing can fail to deliver after the owner pressed the button (agent still booting),
  // and an old server that never had a briefing at all reads as "this owner still owes a
  // handoff" — which is how existing users got shown the completion celebration. Every
  // onboarding screen needs a field of its own, or progress cannot be restored in a
  // different browser (stdrc, 2026-07-13).
  setupHandoffAcknowledgedAt: timestamp("setup_handoff_acknowledged_at", { withTimezone: true }),
  // The Pro step between the survey and the handoff was answered ("Upgrade" or "Not now").
  // Shown once, so either answer stamps it; which one is product analytics, not state.
  setupUpgradePromptSeenAt: timestamp("setup_upgrade_prompt_seen_at", { withTimezone: true }),
  // Replaced the legacy server_push_muted boolean. The table still has it,
  // kept in step with this by the server_members_push_mode_sync trigger;
  // nothing here declares or reads it. Its drop (migration
  // server_members_push_muted_drop) waits for the RisingWave owner:
  // server_members is replicated to RisingWave as rw_server_members, created
  // with (*), so the upstream column drop must be confirmed safe there first.
  serverPushMode: text("server_push_mode", { enum: ["all", "mentions", "none"] }).notNull().default("all"),
  // Legacy level counter: no longer written (user_notification_level_versions,
  // backfilled by migration notification_level_versions_backfill); reads take
  // GREATEST of both until a later step stops reading it.
  notificationPrefsVersion: integer("notification_prefs_version").notNull().default(0),
  // Raft theme this member sees in this server (RAFT_THEME_IDS); null is the
  // default, Raft Yellow. A Pro theme stays stored on a Free server and shows
  // as Raft Yellow there (effectiveRaftTheme), so it returns after an upgrade.
  theme: text("theme"),
  // The theme's pixel decorations on the frame; the colours stay when off.
  themeDecor: boolean("theme_decor").notNull().default(true),
  onboardingDmSentAt: timestamp("onboarding_dm_sent_at", { withTimezone: true }),
  onboardingDmSentByAgentId: uuid("onboarding_dm_sent_by_agent_id"),
  onboardingOwnerOpenerV2SentAt: timestamp("onboarding_owner_opener_v2_sent_at", { withTimezone: true }),
  onboardingOwnerOpenerV2SentByAgentId: uuid("onboarding_owner_opener_v2_sent_by_agent_id"),
  onboardingOwnerOpenerV2MessageIds: json("onboarding_owner_opener_v2_message_ids").$type<string[]>().notNull().default([]),
  onboardingOwnerOpenerV2Version: text("onboarding_owner_opener_v2_version"),
  onboardingOwnerOpenerV2Topics: json("onboarding_owner_opener_v2_topics").$type<string[]>().notNull().default([]),
  // One sender at a time: a trigger claims the opener before briefing and
  // posting it, so concurrent entry points cannot send it twice. A claim older
  // than the lease (a sender that died) can be taken over.
  onboardingOwnerOpenerClaimedAt: timestamp("onboarding_owner_opener_claimed_at", { withTimezone: true }),
  crossChannelHintShownAt: timestamp("cross_channel_hint_shown_at", { withTimezone: true }),
  allChannelUnlockInstructionSentAt: timestamp("all_channel_unlock_instruction_sent_at", { withTimezone: true }),
  sidebarChannelOrder: json("sidebar_channel_order").$type<string[]>(),
  sidebarAgentOrder: json("sidebar_agent_order").$type<string[]>(),
  sidebarDmOrder: json("sidebar_dm_order").$type<string[]>(),
  sidebarChannelSortMode: text("sidebar_channel_sort_mode", { enum: ["manual", "recent", "az"] }).notNull().default("manual"),
  sidebarJointChannelSortMode: text("sidebar_joint_channel_sort_mode", { enum: ["manual", "recent", "az"] }).notNull().default("manual"),
  sidebarDmSortMode: text("sidebar_dm_sort_mode", { enum: ["manual", "recent", "az"] }).notNull().default("manual"),
  sidebarPinnedSortMode: text("sidebar_pinned_sort_mode", { enum: ["manual", "recent", "az"] }).notNull().default("manual"),
  pinnedRefs: json("pinned_refs").$type<Array<{ kind: "channel" | "agent" | "human"; id: string }>>(),
  pinnedChannelIds: json("pinned_channel_ids").$type<string[]>(),
  pinnedAgentIds: json("pinned_agent_ids").$type<string[]>(),
  pinnedOrder: json("pinned_order").$type<string[]>(),
  hiddenDmIds: json("hidden_dm_ids").$type<string[]>(),
  channelPanelTabOrder: json("channel_panel_tab_order").$type<string[]>(),
  agentPanelTabOrder: json("agent_panel_tab_order").$type<string[]>(),
  // Where Thread, Tasks and Files stand right of a channel (task #165); read leniently (parseChannelSideLayout).
  channelSideLayout: jsonb("channel_side_layout").$type<ChannelSideLayout>(),
  sidebarCustomSections: json("sidebar_custom_sections").$type<Array<{
    id: string;
    name: string;
    emoji: string | null;
    sortMode: "manual" | "recent" | "az";
  }>>(),
  sidebarSectionOrder: json("sidebar_section_order").$type<string[]>(),
  sidebarSectionPlacements: json("sidebar_section_placements").$type<Array<{
    kind: "channel" | "agent";
    id: string;
    sectionId: string;
    position: number;
  }>>(),
  sidebarSectionsVersion: integer("sidebar_sections_version").notNull().default(0),
  serverSwitcherOrder: json("server_switcher_order").$type<string[]>(),
  pinnedVersion: integer("pinned_version").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.userId] }),
  index("idx_server_members_user").on(t.userId),
  index("idx_server_members_guest_channel").on(t.guestChannelId).where(sql`guest_channel_id IS NOT NULL`),
  // A channel binding only on a Guest, and every Guest has one (#wg-rbac:#15,
  // #48). The second is added NOT VALID and validated in a later
  // release.
  check("server_members_guest_channel_only_for_guest", sql`${t.guestChannelId} IS NULL OR ${t.role} = 'guest'`),
  check("server_members_guest_has_channel", sql`${t.role} <> 'guest' OR ${t.guestChannelId} IS NOT NULL`),
  check(
    "server_members_onboarding_wizard_current_step_valid",
    sql`${t.onboardingWizardCurrentStep} IS NULL OR ${t.onboardingWizardCurrentStep} IN ('add-computer', 'detect-runtime', 'create-agent', 'referral-source', 'invite-teammates', 'join-community', 'enable-notifications', 'complete')`,
  ),
  check(
    "server_members_setup_status_valid",
    sql`${t.setupStatus} IN ('not_started', 'in_progress', 'deferred', 'complete')`,
  ),
  check(
    "server_members_setup_completion_reason_valid",
    sql`${t.setupCompletionReason} IS NULL OR ${t.setupCompletionReason} IN ('normal', 'grandfathered', 'complete_after_defer', 'admin_override')`,
  ),
  // completion_reason is set iff status is complete (Huarong nail: reason only when complete).
  check(
    "server_members_setup_completion_reason_requires_complete",
    sql`${t.setupCompletionReason} IS NULL OR ${t.setupStatus} = 'complete'`,
  ),
  check(
    "server_members_server_push_mode_valid",
    sql`${t.serverPushMode} IN ('all', 'mentions', 'none')`,
  ),
]);

// Latest reason a human membership ended. Active membership remains
// authoritative; this row only preserves the distinction needed by historical
// message/profile surfaces after server_members is deleted.
export const serverMembershipDepartures = pgTable("server_membership_departures", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: ["left", "removed"] }).notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  // The role they left with (null on rows from before it was kept): SSO auto-join never turns a Guest who left into a member.
  role: text("role").$type<ServerRole>(),
  departedAt: timestamp("departed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.userId] }),
  index("idx_server_membership_departures_user").on(t.userId),
]);

export const labDefinitions = pgTable("lab_definitions", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  state: text("state", { enum: ["draft", "open", "paused", "retired"] }).notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("lab_definitions_key_valid", sql`${t.key} ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'`),
  check("lab_definitions_name_nonempty", sql`length(btrim(${t.name})) > 0`),
  check("lab_definitions_description_nonempty", sql`length(btrim(${t.description})) > 0`),
  check("lab_definitions_state_valid", sql`${t.state} IN ('draft', 'open', 'paused', 'retired')`),
]);

/**
 * Server-wide Labs master gate and coherent cache cursor. A missing row means
 * Labs access is disabled at version 0. Enrollment writers bump this version
 * in the same transaction so serving caches can invalidate one server key.
 */
export const serverLabAccess = pgTable("server_lab_access", {
  serverId: uuid("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedByActorType: text("updated_by_actor_type", { enum: ["human", "agent"] }),
  updatedByActorId: text("updated_by_actor_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("server_lab_access_version_nonnegative", sql`${t.version} >= 0`),
  check(
    "server_lab_access_actor_complete",
    sql`(${t.updatedByActorType} IS NULL) = (${t.updatedByActorId} IS NULL)`,
  ),
  check(
    "server_lab_access_actor_type_valid",
    sql`${t.updatedByActorType} IS NULL OR ${t.updatedByActorType} IN ('human', 'agent')`,
  ),
]);

/** Durable server membership in a product Lab cohort. Disabled rows remain. */
export const serverLabEnrollments = pgTable("server_lab_enrollments", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  labKey: text("lab_key").notNull().references(() => labDefinitions.key, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedByActorType: text("updated_by_actor_type", { enum: ["human", "agent"] }),
  updatedByActorId: text("updated_by_actor_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.labKey] }),
  index("idx_server_lab_enrollments_lab").on(t.labKey, t.serverId),
  check("server_lab_enrollments_version_nonnegative", sql`${t.version} >= 0`),
  check(
    "server_lab_enrollments_actor_complete",
    sql`(${t.updatedByActorType} IS NULL) = (${t.updatedByActorId} IS NULL)`,
  ),
  check(
    "server_lab_enrollments_actor_type_valid",
    sql`${t.updatedByActorType} IS NULL OR ${t.updatedByActorType} IN ('human', 'agent')`,
  ),
]);

/**
 * Append-only receipt for server Labs mutations. The server-wide access
 * version is the single cache/CAS cursor, so one effective mutation owns one
 * unique `(server_id, version_after)` receipt. Task #18 owns all writes.
 */
export const serverLabAuditEvents = pgTable("server_lab_audit_events", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  versionAfter: bigint("version_after", { mode: "number" }).notNull(),
  id: uuid("id").notNull().$defaultFn(() => randomUUID()),
  operation: text("operation", { enum: ["master_access_set", "enrollment_set"] }).notNull(),
  labKey: text("lab_key").references(() => labDefinitions.key, { onDelete: "restrict" }),
  actorType: text("actor_type", { enum: ["human", "agent"] }).notNull(),
  actorId: text("actor_id").notNull(),
  requestId: text("request_id").notNull(),
  versionBefore: bigint("version_before", { mode: "number" }).notNull(),
  before: jsonb("before").$type<Record<string, unknown>>().notNull(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.versionAfter] }),
  uniqueIndex("idx_server_lab_audit_events_id").on(t.id),
  index("idx_server_lab_audit_events_request").on(t.requestId),
  check("server_lab_audit_events_actor_type_valid", sql`${t.actorType} IN ('human', 'agent')`),
  check(
    "server_lab_audit_events_operation_valid",
    sql`${t.operation} IN ('master_access_set', 'enrollment_set')`,
  ),
  check(
    "server_lab_audit_events_lab_key_matches_operation",
    sql`(${t.operation} = 'master_access_set' AND ${t.labKey} IS NULL) OR (${t.operation} = 'enrollment_set' AND ${t.labKey} IS NOT NULL)`,
  ),
  check(
    "server_lab_audit_events_version_step",
    sql`${t.versionBefore} >= 0 AND ${t.versionAfter} = ${t.versionBefore} + 1`,
  ),
]);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  killSwitch: boolean("kill_switch").notNull().default(false),
  randomizationUnit: text("randomization_unit", { enum: ["user", "server"] }).notNull(),
  defaultEnabled: boolean("default_enabled").notNull().default(false),
  defaultVariant: text("default_variant"),
  salt: text("salt").notNull(),
  // Task #205: the flag may be read before login through GET /api/public/feature-flags. Only its
  // kill switch, enabled bit, platform rules and default decide the answer there; no identity rule
  // can match without a user or server.
  preAuthEvaluable: boolean("pre_auth_evaluable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("feature_flags_randomization_unit_valid", sql`${t.randomizationUnit} IN ('user', 'server')`),
]);

export const featureFlagAudiences = pgTable("feature_flag_audiences", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const featureFlagAudienceMembers = pgTable("feature_flag_audience_members", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  audienceKey: text("audience_key").notNull().references(() => featureFlagAudiences.key, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["user", "server"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_feature_flag_audience_members_target").on(t.audienceKey, t.kind, t.targetId),
  index("idx_feature_flag_audience_members_lookup").on(t.kind, t.targetId, t.audienceKey),
  check("feature_flag_audience_members_kind_valid", sql`${t.kind} IN ('user', 'server')`),
]);

export const featureFlagRules = pgTable("feature_flag_rules", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  flagKey: text("flag_key").notNull().references(() => featureFlags.key, { onDelete: "cascade" }),
  stage: text("stage", { enum: ["user", "platform", "client", "server", "audience", "lab", "plan", "percentage"] }).notNull(),
  priority: integer("priority").notNull().default(0),
  decision: text("decision", { enum: ["allow", "deny"] }).notNull(),
  values: jsonb("values").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  percentageBasisPoints: integer("percentage_basis_points"),
  variant: text("variant"),
  // `client` stage only (task #1144): the rule additionally requires the client's OS / build type to be
  // listed and its build number to be >= min_client_build (each only when set). Other stages must leave
  // all three NULL (CHECK below), so an evaluator that does not know the `client` stage can only skip
  // these constraints, never drop them.
  clientOs: jsonb("client_os").$type<string[]>(),
  minClientBuild: integer("min_client_build"),
  clientBuildTypes: jsonb("client_build_types").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_feature_flag_rules_flag").on(t.flagKey),
  index("idx_feature_flag_rules_flag_stage_priority").on(t.flagKey, t.stage, t.priority),
  check("feature_flag_rules_stage_valid", sql`${t.stage} IN ('user', 'platform', 'client', 'server', 'audience', 'lab', 'plan', 'percentage')`),
  check("feature_flag_rules_decision_valid", sql`${t.decision} IN ('allow', 'deny')`),
  check(
    "feature_flag_rules_percentage_valid",
    sql`${t.percentageBasisPoints} IS NULL OR (${t.percentageBasisPoints} >= 0 AND ${t.percentageBasisPoints} <= 10000)`,
  ),
  check(
    "feature_flag_rules_lab_shape_valid",
    sql`${t.stage} <> 'lab' OR (${t.percentageBasisPoints} IS NULL AND ${t.variant} IS NULL AND jsonb_array_length(${t.values}) > 0)`,
  ),
  check(
    "feature_flag_rules_audience_shape_valid",
    sql`${t.stage} <> 'audience' OR (${t.percentageBasisPoints} IS NULL AND ${t.variant} IS NULL AND jsonb_array_length(${t.values}) > 0)`,
  ),
  check(
    "feature_flag_rules_client_fields_scoped",
    sql`${t.stage} = 'client' OR (${t.clientOs} IS NULL AND ${t.minClientBuild} IS NULL AND ${t.clientBuildTypes} IS NULL)`,
  ),
  check(
    "feature_flag_rules_client_shape_valid",
    sql`${t.stage} <> 'client' OR (${t.percentageBasisPoints} IS NULL AND ${t.variant} IS NULL AND jsonb_array_length(${t.values}) > 0 AND (${t.clientOs} IS NOT NULL OR ${t.minClientBuild} IS NOT NULL OR ${t.clientBuildTypes} IS NOT NULL))`,
  ),
  check(
    "feature_flag_rules_client_os_valid",
    sql`${t.clientOs} IS NULL OR (jsonb_typeof(${t.clientOs}) = 'array' AND jsonb_array_length(${t.clientOs}) > 0 AND ${t.clientOs} <@ '["android","ios","ohos"]'::jsonb)`,
  ),
  check(
    "feature_flag_rules_client_build_types_valid",
    sql`${t.clientBuildTypes} IS NULL OR (jsonb_typeof(${t.clientBuildTypes}) = 'array' AND jsonb_array_length(${t.clientBuildTypes}) > 0 AND ${t.clientBuildTypes} <@ '["release","alpha","debug"]'::jsonb)`,
  ),
  check(
    "feature_flag_rules_min_client_build_valid",
    sql`${t.minClientBuild} IS NULL OR ${t.minClientBuild} >= 0`,
  ),
]);

export const featureFlagConfigVersions = pgTable("feature_flag_config_versions", {
  scope: text("scope").primaryKey(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
  lastAuditEventId: text("last_audit_event_id"),
}, (t) => [
  check("feature_flag_config_versions_scope_valid", sql`${t.scope} = 'global'`),
  check("feature_flag_config_versions_version_nonnegative", sql`${t.version} >= 0`),
]);

/**
 * Append-only authorization + mutation receipt for authoritative feature-flag
 * rollout writes. A migration for this shape must land before the writer is
 * wired into a route; until then the same-transaction insert deliberately
 * makes an attempted mutation roll back instead of committing without audit.
 */
export const featureFlagRolloutAuditEvents = pgTable("feature_flag_rollout_audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  actorType: text("actor_type", { enum: ["human", "agent", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  requestId: text("request_id").notNull(),
  reason: text("reason").notNull(),
  controlPlaneId: text("control_plane_id").notNull(),
  flagKey: text("flag_key").notNull(),
  configVersionBefore: bigint("config_version_before", { mode: "number" }).notNull(),
  configVersionAfter: bigint("config_version_after", { mode: "number" }).notNull(),
  authorization: text("authorization", { enum: ["narrowing", "guardrail_passed"] }).notNull(),
  operation: jsonb("operation").$type<
    FeatureFlagRolloutNarrowingOperation | FeatureFlagRolloutWideningOperation
  >().notNull(),
  receiptId: uuid("receipt_id"),
  beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>().notNull(),
  afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_feature_flag_rollout_audit_version").on(t.configVersionAfter),
  index("idx_feature_flag_rollout_audit_request").on(t.requestId),
  index("idx_feature_flag_rollout_audit_flag_time").on(t.flagKey, t.createdAt),
  index("idx_feature_flag_rollout_audit_actor_time").on(t.actorType, t.actorId, t.createdAt),
  check("feature_flag_rollout_audit_request_nonempty", sql`length(btrim(${t.requestId})) > 0`),
  check("feature_flag_rollout_audit_reason_nonempty", sql`length(btrim(${t.reason})) > 0`),
  check(
    "feature_flag_rollout_audit_actor_type_valid",
    sql`${t.actorType} IN ('human', 'agent', 'system')`,
  ),
  check(
    "feature_flag_rollout_audit_authorization_valid",
    sql`${t.authorization} IN ('narrowing', 'guardrail_passed')`,
  ),
  check(
    "feature_flag_rollout_audit_receipt_matches_authorization",
    sql`(
      (${t.authorization} = 'narrowing' AND ${t.receiptId} IS NULL)
      OR (${t.authorization} = 'guardrail_passed' AND ${t.receiptId} IS NOT NULL)
    )`,
  ),
  check(
    "feature_flag_rollout_audit_version_before_nonnegative",
    sql`${t.configVersionBefore} >= 0`,
  ),
  check(
    "feature_flag_rollout_audit_version_after_nonnegative",
    sql`${t.configVersionAfter} >= 0`,
  ),
  check(
    "feature_flag_rollout_audit_version_step",
    sql`${t.configVersionAfter} = ${t.configVersionBefore} + 1`,
  ),
]);

export const serverAgreements = pgTable("server_agreements", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  enabled: boolean("enabled").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_server_agreements_server_version").on(t.serverId, t.version),
  uniqueIndex("idx_server_agreements_active").on(t.serverId).where(sql`${t.enabled} = true`),
  index("idx_server_agreements_server").on(t.serverId),
]);

export const serverMembershipAgreementAudit = pgTable("server_membership_agreement_audit", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  subjectType: text("subject_type", { enum: ["user", "agent"] }).notNull(),
  subjectId: uuid("subject_id").notNull(),
  agreementId: uuid("agreement_id").references(() => serverAgreements.id),
  agreementVersion: integer("agreement_version"),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  source: text("source", { enum: ["invite", "join", "request-access", "admin-add", "sso"] }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  signatureMethod: text("signature_method"),
  signaturePayload: jsonb("signature_payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_server_membership_agreement_audit_server").on(t.serverId),
  index("idx_server_membership_agreement_audit_subject").on(t.subjectType, t.subjectId),
  index("idx_server_membership_agreement_audit_agreement").on(t.agreementId),
]);

// Append-only audit for human server-role transitions. The role mutation,
// Guest authority cleanup, and this fact are committed in one transaction;
// realtime refresh is only a post-commit projection of the durable result.
export const serverMemberRoleAuditEvents = pgTable("server_member_role_audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  previousRole: text("previous_role", { enum: ["owner", "admin", "member", "guest"] }).notNull(),
  nextRole: text("next_role", { enum: ["owner", "admin", "member", "guest"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_server_member_role_audit_server_created").on(t.serverId, t.createdAt),
  index("idx_server_member_role_audit_target_created").on(t.targetUserId, t.createdAt),
  check("server_member_role_audit_previous_role_check", sql`${t.previousRole} IN ('owner', 'admin', 'member', 'guest')`),
  check("server_member_role_audit_next_role_check", sql`${t.nextRole} IN ('owner', 'admin', 'member', 'guest')`),
  check("server_member_role_audit_transition_check", sql`${t.previousRole} <> ${t.nextRole}`),
]);

// Session families bind refresh-token rotation to durable push revocation.
/** A session family's scope: see `sessionFamilies.scope`. */
export type SessionScope = "full" | "device";
/**
 * A request's session scope (req.sessionScope): a stored family's, or
 * `assistant_as_owner` when a personal assistant acts as its owner on one of
 * the owner's own routes (middleware/assistantAsOwner.ts; no family, never
 * `full`). Never stored.
 */
export type RequestSessionScope = SessionScope | "assistant_as_owner";
/** Why a session family was retired: see `sessionFamilies.retiredAt`. */
export type SessionFamilyRetiredReason = "migration";

export const sessionFamilies = pgTable("session_families", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  revokeCapabilityNonce: text("revoke_capability_nonce"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  capabilityRetainUntil: timestamp("capability_retain_until", { withTimezone: true }),
  // What the family's tokens may do, kept across every refresh: `full` (a
  // person's own sign-in) or `device` (issued by a device login: only the
  // routes Raft Computer and the raft CLI call, a 7-day refresh window;
  // middleware/auth.ts DEVICE_SESSION_ROUTES).
  scope: text("scope").$type<SessionScope>().notNull().default("full"),
  // Retired (device-auth design v2 §4 step 2): a Computer that has its own
  // key ended the device session it logged in with (POST
  // /api/computer/retire-session). Its tokens no longer authenticate or
  // refresh, like a revoked family, but nothing it issued is revoked and its
  // keys keep naming it (issued_by_session_family_id): revoking it later (its
  // revoke link, a password change, the account's retirement) still revokes
  // them. Every family revoker and the key cascade ignore this column.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredReason: text("retired_reason").$type<SessionFamilyRetiredReason>(),
  // Two-step verification: when this sign-in passed its second factor, and
  // with which. Both null (not verified) or both set. Set when the sign-in
  // passed its second step (createSession with a verified proof), when the
  // person turns two-step verification on from it, or by step-up
  // (services/secondFactor/); never by refresh. Approving a device or app
  // login needs it once two-step verification is on (sessionIssueGate.ts).
  secondFactorVerifiedAt: timestamp("second_factor_verified_at", { withTimezone: true }),
  secondFactorMethod: text("second_factor_method").$type<SecondFactorMethod>(),
  // When this sign-in last proved the person again (re-authentication before
  // a sensitive change such as adding a passkey); the family's created_at
  // counts as one too. Set by the password re-authentication route, read by
  // TOTP setup
  // (services/secondFactor/reauthentication.ts).
  reauthenticatedAt: timestamp("reauthenticated_at", { withTimezone: true }),
  // SSO v1 (rfcs/083-server-sso.md §4): the Server SSO connection that signed
  // this family in and when, set only by the sso_login gate's sessions (and
  // copied to a device or app login approved from one). A plain id, no
  // foreign key: a deleted connection leaves an id no live connection has,
  // which every "require SSO" check reads as "not signed in by SSO".
  ssoConnectionId: uuid("sso_connection_id"),
  ssoAuthenticatedAt: timestamp("sso_authenticated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_session_families_user_active").on(t.userId, t.revokedAt),
  index("idx_session_families_capability_retention").on(t.capabilityRetainUntil),
  check(
    "session_families_second_factor_check",
    sql`(${t.secondFactorVerifiedAt} IS NULL AND ${t.secondFactorMethod} IS NULL) OR (${t.secondFactorVerifiedAt} IS NOT NULL AND ${t.secondFactorMethod} IS NOT NULL AND ${t.secondFactorMethod} IN ('passkey', 'totp', 'backup_code'))`,
  ),
]);

// --- Two-step verification (passkey / TOTP second factor) ---
// Services live in services/secondFactor/; sign-in enforces it through
// services/sessionIssueGate.ts.

/** How a session family passed its second factor: see `sessionFamilies.secondFactorMethod`. */
export type SecondFactorMethod = "passkey" | "totp" | "backup_code";

// A person's registered passkeys (WebAuthn credentials). Revoked rows are
// kept (revoked_at) so the management list and audit can name them.
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The authenticator's raw credential ID, as the browser reports it.
  credentialId: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("credential_id").notNull().unique(),
  // The COSE-encoded public key from registration.
  publicKey: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("public_key").notNull(),
  // A counter that stays 0 is valid (synced passkeys); a non-zero one that
  // does not increase is a risk signal, never a rejection (design §5).
  signCount: bigint("sign_count", { mode: "number" }).notNull().default(0),
  aaguid: text("aaguid"),
  backupEligible: boolean("backup_eligible").notNull().default(false),
  backupState: boolean("backup_state").notNull().default(false),
  transports: text("transports").array(),
  // The person's own label for it.
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  index("idx_webauthn_credentials_user").on(t.userId),
]);

// A person's authenticator-app (TOTP, RFC 6238) secret: one per person.
// confirmed_at null = set up but never confirmed with a code. The secret is
// stored only encrypted (services/secondFactor/totpSecretCrypto.ts).
export const userTotp = pgTable("user_totp", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  secretCiphertext: text("secret_ciphertext").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  // The last 30-second step a code was accepted for: a code whose step is
  // not above it is refused (replay guard).
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Re-binding a confirmed secret (services/secondFactor/management.ts): the
  // new secret waits here, encrypted like secret_ciphertext, until a code from
  // it confirms it; then it replaces secret_ciphertext in one update. Until
  // then the confirmed secret keeps working; an abandoned re-bind is just
  // overwritten by the next one. Written and cleared together.
  pendingSecretCiphertext: text("pending_secret_ciphertext"),
  pendingCreatedAt: timestamp("pending_created_at", { withTimezone: true }),
});

// Single-use backup codes, stored only as argon2 hashes.
export const userBackupCodes = pgTable("user_backup_codes", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_user_backup_codes_user").on(t.userId),
]);

/** What an auth challenge is for: see `authChallenges.kind`. */
export type AuthChallengeKind = "webauthn_registration" | "webauthn_assertion" | "second_factor_login" | "account_deletion_email_code";
/**
 * Context bound to a challenge when it is created (a pending sign-in's token
 * hash, a client binding, the WebAuthn user handle, ...): flat JSON scalars,
 * compared on consume, never secrets.
 */
export type AuthChallengePayload = Readonly<Record<string, string | number | boolean | null>>;

// Short-lived, single-use challenges: WebAuthn registration and assertion,
// the second-factor step of a sign-in, and the emailed code that confirms an
// account deletion request (services/accountDeletion/emailCode.ts; its
// payload binds the session family and holds a keyed digest of the code).
// Only a SHA-256 hash of the challenge is stored; it is consumed once by
// compare-and-set.
export const authChallenges = pgTable("auth_challenges", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // Null for a challenge issued before the person is known (passkey-first sign-in).
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").$type<AuthChallengeKind>().notNull(),
  challengeHash: text("challenge_hash").notNull().unique(),
  // Which sign-in flow it belongs to (web, device login, app login, ...).
  flow: text("flow"),
  payload: jsonb("payload").$type<AuthChallengePayload>(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_auth_challenges_user_kind").on(t.userId, t.kind),
  index("idx_auth_challenges_expires_at").on(t.expiresAt),
  check("auth_challenges_kind_check", sql`${t.kind} IN ('webauthn_registration', 'webauthn_assertion', 'second_factor_login', 'account_deletion_email_code')`),
]);

// Per-person limit on second-step attempts after a first factor: a rolling
// window of claims and, once it is used up, a lock (locked_until). One row
// per person, claimed atomically (services/secondFactor/attemptWindow.ts).
// It never blocks passkey sign-in.
export const secondFactorAttemptWindows = pgTable("second_factor_attempt_windows", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

// The same limit, counted apart, for password re-authentication of a signed-in
// session (POST /api/auth/second-factor/reauth/password): wrong passwords from
// a stolen session lock only re-authentication, never the owner's second step
// at sign-in (services/secondFactor/attemptWindow.ts).
export const reauthAttemptWindows = pgTable("reauth_attempt_windows", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

/** Where a second-factor recovery request is: see `secondFactorRecoveryRequests.status`. */
export type SecondFactorRecoveryStatus = "pending_confirmation" | "waiting" | "completed" | "cancelled" | "expired";
/** Who ended a recovery request early: a signed-in session, the emailed cancel link, or a right second-factor answer. */
export type SecondFactorRecoveryCancelledBy = "user" | "token" | "auto_factor";

// Email recovery of two-step verification (services/secondFactor/recovery.ts):
// someone who lost every second factor asks by email; the emailed link
// (pending_confirmation, 30 minutes) starts a 72-hour wait (waiting, until
// eligible_at); after it, a sign-in with the first factor can remove every
// factor (completed) within 7 days (else expired). Any right second-factor
// answer, a signed-in session or the emailed cancel link ends it (cancelled).
// Tokens are stored only as SHA-256 hashes. At most one active
// (pending_confirmation or waiting) row per person.
export const secondFactorRecoveryRequests = pgTable("second_factor_recovery_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").$type<SecondFactorRecoveryStatus>().notNull(),
  // The emailed confirm link (single use: only a pending_confirmation row answers it).
  linkTokenHash: text("link_token_hash").notNull().unique(),
  linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }).notNull(),
  // The cancel link mailed once the wait starts; answers while the request is waiting.
  cancelTokenHash: text("cancel_token_hash").unique(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }),
  // The "you can finish now" email went (hourly maintenance, once).
  readyNotifiedAt: timestamp("ready_notified_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledBy: text("cancelled_by").$type<SecondFactorRecoveryCancelledBy>(),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
}, (t) => [
  // One active request per person (DB-enforced); also the per-person lookup.
  uniqueIndex("idx_second_factor_recovery_requests_user_active").on(t.userId)
    .where(sql`status IN ('pending_confirmation', 'waiting')`),
  // The per-person rate limit counts recent rows.
  index("idx_second_factor_recovery_requests_user_requested").on(t.userId, t.requestedAt),
  // Maintenance: the ready email and the expiry sweep.
  index("idx_second_factor_recovery_requests_waiting_eligible").on(t.eligibleAt).where(sql`status = 'waiting'`),
  check("second_factor_recovery_requests_status_valid", sql`${t.status} IN ('pending_confirmation', 'waiting', 'completed', 'cancelled', 'expired')`),
  check("second_factor_recovery_requests_cancelled_by_valid", sql`${t.cancelledBy} IS NULL OR ${t.cancelledBy} IN ('user', 'token', 'auto_factor')`),
  check("second_factor_recovery_requests_waiting_times", sql`${t.status} = 'pending_confirmation' OR ${t.status} = 'expired' OR ${t.status} = 'cancelled' OR (${t.confirmedAt} IS NOT NULL AND ${t.eligibleAt} IS NOT NULL AND ${t.cancelTokenHash} IS NOT NULL)`),
  check("second_factor_recovery_requests_end_times", sql`(${t.status} <> 'completed' OR ${t.completedAt} IS NOT NULL) AND (${t.status} <> 'cancelled' OR (${t.cancelledAt} IS NOT NULL AND ${t.cancelledBy} IS NOT NULL)) AND (${t.status} <> 'expired' OR ${t.expiredAt} IS NOT NULL)`),
]);

// Sessions — JWT refresh tokens
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Nullable only for mixed-version rolling deploy compatibility. New code
  // always writes a family and adopts any legacy null row on refresh.
  familyId: uuid("family_id").references(() => sessionFamilies.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_sessions_token_hash").on(t.tokenHash),
  index("idx_sessions_family_active").on(t.familyId, t.expiresAt),
]);

// Hash-only lineage survives further rotations (unlike replay receipts, whose
// successor FK cascades). It authorizes logout, never token replay.
export const sessionTokenPredecessors = pgTable("session_token_predecessors", {
  tokenHash: text("token_hash").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull().references(() => sessionFamilies.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("idx_session_token_predecessors_expiry").on(t.expiresAt),
  // Deleting a session family cascades here; account deletion deletes by family.
  index("idx_session_token_predecessors_family").on(t.familyId),
]);

// Short-lived, durable receipts for crash-safe refresh-token rotation. The
// successor token is AES-GCM encrypted by the service; raw refresh tokens must
// never be stored or logged. A predecessor can authorize exactly one attempt,
// while the remaining columns bind a replay to the original account/session
// family, client installation, and minted child session.
export const sessionRefreshRotationReceipts = pgTable("session_refresh_rotation_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  predecessorTokenHash: text("predecessor_token_hash").notNull(),
  predecessorSessionId: uuid("predecessor_session_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull().references(() => sessionFamilies.id, { onDelete: "cascade" }),
  successorSessionId: uuid("successor_session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  attemptId: text("attempt_id").notNull(),
  installationId: text("installation_id").notNull(),
  successorTokenCiphertext: text("successor_token_ciphertext").notNull(),
  successorTokenIv: text("successor_token_iv").notNull(),
  successorTokenAuthTag: text("successor_token_auth_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_session_refresh_rotation_receipts_predecessor").on(t.predecessorTokenHash),
  index("idx_session_refresh_rotation_receipts_expiry").on(t.expiresAt),
  index("idx_session_refresh_rotation_receipts_family").on(t.familyId, t.expiresAt),
]);

// Agents — AI assistants
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  description: text("description"),
  allChannelIntroSentAt: timestamp("all_channel_intro_sent_at", { withTimezone: true }),
  status: text("status", { enum: ["active", "inactive", "stopped"] }).default("inactive").notNull(),
  sessionId: text("session_id"),
  model: text("model").default("sonnet").notNull(),
  runtime: text("runtime").default("claude").notNull(),
  runtimeConfig: jsonb("runtime_config").$type<RuntimeConfig>(),
  lastRuntimeError: jsonb("last_runtime_error").$type<AgentRuntimeErrorState>(),
  reasoningEffort: text("reasoning_effort", { enum: ["low", "medium", "high", "xhigh", "max", "ultra"] }),
  executionMode: text("execution_mode", { enum: ["byoc", "cloud"] }).default("byoc").notNull(),
  envVars: json("env_vars").$type<Record<string, string>>(),
  /**
   * Reconciler step 11b: the revision of the config the server sends the
   * agent's daemon (`agent:config` `revision`, `agent:start` `configRevision`).
   * Incremented in the same transaction as every change that alters that
   * config (agentConfigRevision.ts); the daemon drops a config at or below the
   * last one it applied.
   */
  configRevision: bigint("config_revision", { mode: "number" }).notNull().default(0),
  creatorType: text("creator_type", { enum: ["user", "agent"] }),
  creatorId: uuid("creator_id"),
  machineId: uuid("daemon_id").references(() => machines.id, { onDelete: "set null" }),
  // Why the agent was taken off its Computer and must stay off until someone
  // binds it on purpose (services/computerAgents.ts): `forced_by_computer_owner`
  // when the person removing that Computer (or deleting their account) forced
  // it off. The machine-online auto-assign skips such an agent; any explicit
  // bind (assign, create, a move, a conversion) clears both.
  machineReleaseReason: text("machine_release_reason", { enum: ["forced_by_computer_owner"] }),
  machineReleasedAt: timestamp("machine_released_at", { withTimezone: true }),
  // External agents: set once, on the first accepted raft-agent-status.v1
  // report. From then on `/activity` hook events no longer drive the live
  // status (they are still logged). Only ever goes NULL -> set.
  statusProtocolAdoptedAt: timestamp("status_protocol_adopted_at", { withTimezone: true }),
  // RFC 074 §2 personal assistant: set = this agent may read as this user
  // (DMs too unless the owner turned that off, RFC 077). Only that user sets or clears it, and only on an agent they
  // created. Effective only while `personal_assistant` is on for the server.
  assistantOwnerUserId: uuid("assistant_owner_user_id").references(() => users.id, { onDelete: "set null" }),
  /** RFC 077: the owner's own switch for letting their assistant read their DMs (default on). */
  assistantReadsDms: boolean("assistant_reads_dms").notNull().default(true),
  /** RFC 077: the owner lets this assistant send messages as them (column default off; a new assistant starts on, v3.2). */
  assistantSendAsOwner: boolean("assistant_send_as_owner").notNull().default(false),
  // External agents (#wg-external-agent-ux:#2): how its person said it would connect when it was made: through an
  // existing agent's CLI login (`existing_agent`), or a program of their own with the SDK (`sdk`). Only which
  // instructions the agent page shows first; either kind may connect either way. Null: an external agent made
  // before this (shown as `existing_agent`), and every other agent.
  externalSetupMethod: text("external_setup_method", { enum: ["existing_agent", "sdk"] }),
  /**
   * A server owner/admin paused this assistant (their one power over it): no
   * doorbell, brief or chat wakes it until its owner starts it again.
   */
  assistantPausedAt: timestamp("assistant_paused_at", { withTimezone: true }),
  assistantPausedByUserId: uuid("assistant_paused_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // App-owned Bot: when set, this agent is a managed Bot identity bound to
  // the given installation. Sender remains `sender_type=agent` (design-v3).
  // The binding row carries the durable install/server/handle contract.
  managedByAppInstallId: uuid("managed_by_app_install_id").references((): AnyPgColumn => oauthClientInstalls.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_agents_managed_by_app_install").on(t.managedByAppInstallId).where(sql`managed_by_app_install_id IS NOT NULL`),
  uniqueIndex("idx_agents_server_name").on(t.serverId, t.name).where(sql`deleted_at is null`),
  // One live assistant per person per server.
  uniqueIndex("idx_agents_server_assistant_owner")
    .on(t.serverId, t.assistantOwnerUserId)
    .where(sql`assistant_owner_user_id is not null and deleted_at is null`),
  index("idx_agents_server").on(t.serverId),
  index("idx_agents_creator").on(t.serverId, t.creatorType, t.creatorId),
  // A person's agents across servers (account deletion; idx_agents_creator leads with server_id).
  index("idx_agents_user_creator").on(t.creatorId).where(sql`creator_type = 'user'`),
  index("idx_agents_assistant_owner").on(t.assistantOwnerUserId).where(sql`assistant_owner_user_id is not null`),
  // RFC-067 product-data derivation reads new agents by a created_at watermark.
  index("idx_agents_created_at").on(t.createdAt),
  // ON DELETE SET NULL from daemons: deleting a machine finds its agents
  // without a scan (migration daemons_fk_indexes).
  index("idx_agents_daemon_id").on(t.machineId).where(sql`daemon_id is not null`),
  // A personal assistant runs hosted, never on a machine: every agent on a
  // Computer shares one OS user (computerAgents.ts AssistantCannotUseComputerError).
  check("agents_assistant_not_on_machine", sql`${t.assistantOwnerUserId} IS NULL OR ${t.machineId} IS NULL`),
]);

/**
 * One row per change of an agent's configured `runtime`, `model` or
 * `reasoning_effort` (and one at creation, `before_*` null), written in the
 * transaction that writes the agents row (services/agentConfigChangeEvents.ts).
 * `agents` keeps only the current values; this answers "which model was this
 * agent configured with at time T". It is the CONFIGURED model, not the one a
 * turn actually ran on. No runtime_config, env vars or message content: they
 * may carry secrets.
 */
export const agentConfigChangeEvents = pgTable("agent_config_change_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who made the change; null when the code path does not know. */
  actorKind: text("actor_kind", { enum: ["user", "agent", "system"] }),
  actorId: uuid("actor_id"),
  /** The code path that wrote it, e.g. `agents_route_update`, `hosted_migration`. */
  source: text("source").notNull(),
  beforeRuntime: text("before_runtime"),
  afterRuntime: text("after_runtime").notNull(),
  beforeModel: text("before_model"),
  afterModel: text("after_model").notNull(),
  beforeReasoningEffort: text("before_reasoning_effort"),
  afterReasoningEffort: text("after_reasoning_effort"),
}, (t) => [
  index("idx_agent_config_change_events_agent_changed").on(t.agentId, t.changedAt),
  // Server deletion cascades here; without it that delete scans the table.
  index("idx_agent_config_change_events_server").on(t.serverId),
  check("agent_config_change_events_actor_kind_check", sql`${t.actorKind} IS NULL OR ${t.actorKind} IN ('user', 'agent', 'system')`),
]);

/**
 * #proj-runtime:#51: what a person did to an agent (start, stop, restart,
 * reset, Stop Current Turn, migration) and the restarts Raft did by itself,
 * shown between turns in the agent's Activity overview. Written by the route
 * that accepted the action (services/agentOperatorEvents.ts), never by the
 * daemon. Model changes are not repeated here: agent_config_change_events
 * already has them with their actor. `details` holds ids and enums only.
 */
export const agentOperatorEvents = pgTable("agent_operator_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actorKind: text("actor_kind", { enum: ["user", "system"] }).notNull(),
  /** The person for `user`; null for `system`, or once that person's account is deleted. */
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  details: jsonb("details").$type<Record<string, string>>(),
}, (t) => [
  index("idx_agent_operator_events_agent_occurred").on(t.agentId, t.occurredAt),
  // Server deletion cascades here; without it that delete scans the table.
  index("idx_agent_operator_events_server").on(t.serverId),
  // Account deletion sets actor_user_id null; without it that update scans the table.
  index("idx_agent_operator_events_actor").on(t.actorUserId).where(sql`actor_user_id is not null`),
  check("agent_operator_events_actor_kind_check", sql`${t.actorKind} IN ('user', 'system')`),
  check("agent_operator_events_kind_check", sql`${t.kind} IN ('start', 'stop', 'restart', 'reset_session', 'reset_full', 'turn_stopped', 'migration_started', 'migration_cancelled', 'system_restart')`),
]);

// Agent archive: one row per archived (soft-deleted) agent that has a
// workspace decision. Agents deleted before archive existed have no row.
export const agentArchives = pgTable("agent_archives", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  archivedByUserId: uuid("archived_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // The Computer that holds the workspace. Not an FK: the workspace evidence
  // outlives the Computer row, and `agents.daemon_id` is cleared on archive.
  machineId: uuid("machine_id"),
  machineNameSnapshot: text("machine_name_snapshot"),
  workspaceState: text("workspace_state", { enum: ["on_computer", "deleted", "unknown"] }).notNull(),
  pendingOp: text("pending_op", { enum: ["delete"] }),
  opId: uuid("op_id"),
  opRequestedAt: timestamp("op_requested_at", { withTimezone: true }),
  opRequestedByUserId: uuid("op_requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Lease: set when the op is sent to the Computer.
  opDispatchedAt: timestamp("op_dispatched_at", { withTimezone: true }),
  opAttempts: integer("op_attempts").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_archives_server").on(t.serverId),
  index("idx_agent_archives_pending").on(t.machineId).where(sql`pending_op is not null`),
  check("agent_archives_op_consistent", sql`(${t.pendingOp} is null) = (${t.opId} is null)`),
]);

export const agentMigrations = pgTable("agent_migrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // Historical identity snapshots, intentionally not entity FKs. Terminal
  // migration evidence must survive after a Computer is deleted.
  sourceMachineId: uuid("source_machine_id").notNull(),
  // A Computer target names its machine; a hosted target has no machine, so
  // both target columns are null (agent_migrations_target_kind_shape). Hosted
  // details live in agent_migration_hosted_targets.
  targetKind: text("target_kind", { enum: ["computer", "hosted"] }).notNull().default("computer"),
  targetMachineId: uuid("target_machine_id"),
  // Frozen names are mandatory durable evidence. The migration backfills
  // historical rows before applying these NOT NULL constraints.
  sourceMachineNameSnapshot: text("source_machine_name_snapshot").notNull(),
  targetMachineNameSnapshot: text("target_machine_name_snapshot"),
  receiptChannelId: uuid("receipt_channel_id").references(() => channels.id, { onDelete: "restrict" }),
  state: text("state", {
    enum: [
      "provisioning",
      "prep",
      "ready",
      "in_transit",
      "arriving",
      "starting",
      "cancel_requested_pre_flip",
      "cancel_requested_post_flip",
      "canceled_pre_flip",
      "canceled_post_flip",
      "completed",
      "aborted",
      "failed",
    ],
  }).notNull().default("prep"),
  // Keep a database default only so omitted legacy INSERTs reach the explicit
  // contract-version checks below and fail deterministically. Current writers
  // always supply both supportRef and contractVersion.
  supportRef: text("support_ref")
    .notNull()
    .default(sql`'mig_' || translate(rtrim(encode(uuid_send(gen_random_uuid()), 'base64'), '='), '+/', '-_')`)
    .unique(),
  contractVersion: integer("contract_version").notNull().default(0),
  grantKey: text("grant_key").notNull().unique(),
  initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  transportSessionId: text("transport_session_id"),
  transportProvider: text("transport_provider"),
  sourceTransportUrl: text("source_transport_url"),
  targetTransportUrl: text("target_transport_url"),
  transportLeaseSource: text("transport_lease_source"),
  transportExpiresAt: timestamp("transport_expires_at", { withTimezone: true }),
  transportMaxBytes: bigint("transport_max_bytes", { mode: "number" }),
  sourceTransportTokenHash: text("source_transport_token_hash"),
  targetTransportTokenHash: text("target_transport_token_hash"),
  transportProvisioningStartedAt: timestamp("transport_provisioning_started_at", { withTimezone: true }),
  transportProvisionedAt: timestamp("transport_provisioned_at", { withTimezone: true }),
  transportProvisionFailedAt: timestamp("transport_provision_failed_at", { withTimezone: true }),
  transportLostAt: timestamp("transport_lost_at", { withTimezone: true }),
  transportTeardownAt: timestamp("transport_teardown_at", { withTimezone: true }),
  transportErrorCode: text("transport_error_code"),
  transportErrorMessage: text("transport_error_message"),
  transportProtocol: text("transport_protocol"),
  transportGeneration: text("transport_generation"),
  transportLeaseId: text("transport_lease_id"),
  transportExpectedMigrationRevision: integer("transport_expected_migration_revision"),
  transportControlManifest: jsonb("transport_control_manifest").$type<AgentMigrationControlManifest>(),
  transportControlSha256: text("transport_control_sha256"),
  transportControlRegisteredAt: timestamp("transport_control_registered_at", { withTimezone: true }),
  transportUploadCompletedAt: timestamp("transport_upload_completed_at", { withTimezone: true }),
  sourceQuiesceReceipt: jsonb("source_quiesce_receipt").$type<AgentMigrationSourceQuiesceReceipt>(),
  sourceQuiescedAt: timestamp("source_quiesced_at", { withTimezone: true }),
  manifestPath: text("manifest_path"),
  manifestSha256: text("manifest_sha256"),
  transferSummary: jsonb("transfer_summary").$type<AgentMigrationTransferSummary>(),
  arrivalReportPath: text("arrival_report_path"),
  arrivalReportSha256: text("arrival_report_sha256"),
  abortReason: text("abort_reason"),
  failureReason: text("failure_reason"),
  autoStartFailureStage: text("auto_start_failure_stage"),
  autoStartFailureCode: text("auto_start_failure_code"),
  autoStartRetryAttempts: integer("auto_start_retry_attempts").notNull().default(0),
  autoStartRetryDeadlineAt: timestamp("auto_start_retry_deadline_at", { withTimezone: true }),
  autoStartLastRetryAt: timestamp("auto_start_last_retry_at", { withTimezone: true }),
  autoStartRemediationLeaseId: text("auto_start_remediation_lease_id"),
  autoStartRemediationLeaseExpiresAt: timestamp("auto_start_remediation_lease_expires_at", { withTimezone: true }),
  cancelGeneration: text("cancel_generation"),
  cancelTransportGeneration: text("cancel_transport_generation"),
  cancelDisposition: text("cancel_disposition", {
    enum: ["pre_flip_source_authoritative", "post_flip_target_authoritative"],
  }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  cancelRequestedByUserId: uuid("cancel_requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  cancelReason: text("cancel_reason"),
  cancelDispatchAttempts: integer("cancel_dispatch_attempts").notNull().default(0),
  cancelLastDispatchAt: timestamp("cancel_last_dispatch_at", { withTimezone: true }),
  cancelAttentionDeadlineAt: timestamp("cancel_attention_deadline_at", { withTimezone: true }),
  cancelCleanupLeaseId: text("cancel_cleanup_lease_id"),
  cancelCleanupLeaseExpiresAt: timestamp("cancel_cleanup_lease_expires_at", { withTimezone: true }),
  cancelSourceAckAt: timestamp("cancel_source_ack_at", { withTimezone: true }),
  cancelSourceOutcome: text("cancel_source_outcome", { enum: ["cleaned", "stopped"] }),
  cancelTargetAckAt: timestamp("cancel_target_ack_at", { withTimezone: true }),
  cancelTargetOutcome: text("cancel_target_outcome", { enum: ["cleaned", "stopped"] }),
  cancelNeedsAttentionAt: timestamp("cancel_needs_attention_at", { withTimezone: true }),
  cancelErrorCode: text("cancel_error_code"),
  cancelErrorMessage: text("cancel_error_message"),
  prepDeadlineAt: timestamp("prep_deadline_at", { withTimezone: true }).notNull(),
  transferDeadlineAt: timestamp("transfer_deadline_at", { withTimezone: true }).notNull(),
  arrivalDeadlineAt: timestamp("arrival_deadline_at", { withTimezone: true }).notNull(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  flippedAt: timestamp("flipped_at", { withTimezone: true }),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  // Durable proof that the source daemon moved the old workspace into its
  // migration-specific archive (or that nothing was left on the source).
  // Not a completion precondition: "completed" means the agent runs on the
  // target; a null value after completion means source cleanup is still
  // pending and the remediation worker retries it (see the columns below).
  // Retries close a lost response through the daemon's migrationId-idempotent
  // `already_archived` result.
  sourceWorkspaceArchivedAt: timestamp("source_workspace_archived_at", { withTimezone: true }),
  // Background source-archive retry bookkeeping. `retry_at` doubles as the
  // claim lease; `abandoned_at` is the visible terminal state when retries are
  // exhausted or the agent moved again (leftovers are then handled by the
  // target-side preexisting-workspace quarantine).
  sourceWorkspaceArchiveAttempts: integer("source_workspace_archive_attempts").notNull().default(0),
  sourceWorkspaceArchiveRetryAt: timestamp("source_workspace_archive_retry_at", { withTimezone: true }),
  sourceWorkspaceArchiveLastError: text("source_workspace_archive_last_error"),
  sourceWorkspaceArchiveAbandonedAt: timestamp("source_workspace_archive_abandoned_at", { withTimezone: true }),
  // Latest bundle-build progress reported by the source between quiesce and
  // control registration; only a report whose counts grew slides prepDeadlineAt.
  // Before quiesce it may instead hold the source's drain report
  // (`phase: "draining"`): cleared by the quiesce, a re-provision, or the first
  // build report. Read it through sourceBuildProgressOf / sourceDrainOf.
  sourceBuildProgress: jsonb("source_build_progress").$type<AgentMigrationSourceBuildProgress | AgentMigrationSourceDrainRecord>(),
  // What the source did with the lease's userIgnoreAdditions (written / already
  // present / rejected), from its source-progress report. The first receipt
  // stands: a re-sent lease reports its lines as already present.
  userIgnoreReceipt: jsonb("user_ignore_receipt").$type<AgentMigrationUserIgnoreAdditionsReceipt>(),
  // Entry limit fixed at creation from the target's capabilities; null on rows
  // created before streamed bundles, which keep the legacy limit.
  transportMaxArchiveEntries: integer("transport_max_archive_entries"),
  // An agent's own retry of a size-failed migration (POST
  // /internal/agent-api/migrations/retry): the failed migration it repeats.
  // At most one retry per migration (idx_agent_migrations_retry_of), and a
  // retry is never retried. Null for every migration a person started.
  retryOfMigrationId: uuid("retry_of_migration_id").references((): AnyPgColumn => agentMigrations.id, { onDelete: "set null" }),
  // The agent that asked for that retry, acting on behalf of
  // `initiatedByUserId` (the failed migration's starter). Null otherwise.
  triggeredByAgentId: uuid("triggered_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  abortedAt: timestamp("aborted_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_migrations_server").on(t.serverId, t.createdAt),
  index("idx_agent_migrations_agent").on(t.agentId, t.state),
  index("idx_agent_migrations_source_machine").on(t.sourceMachineId),
  index("idx_agent_migrations_target_machine").on(t.targetMachineId),
  uniqueIndex("idx_agent_migrations_active_agent").on(t.agentId).where(sql`${t.state} IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving', 'starting')`),
  uniqueIndex("idx_agent_migrations_retry_of").on(t.retryOfMigrationId).where(sql`${t.retryOfMigrationId} IS NOT NULL`),
  check("agent_migrations_distinct_machines", sql`${t.sourceMachineId} <> ${t.targetMachineId}`),
  check("agent_migrations_target_kind_shape", sql`(${t.targetKind} = 'computer' AND ${t.targetMachineId} IS NOT NULL AND ${t.targetMachineNameSnapshot} IS NOT NULL) OR (${t.targetKind} = 'hosted' AND ${t.targetMachineId} IS NULL AND ${t.targetMachineNameSnapshot} IS NULL)`),
  check("agent_migrations_contract_version_check", sql`${t.contractVersion} >= 1`),
  check("agent_migrations_receipt_contract_version_check", sql`${t.contractVersion} >= 2`),
]);

/** The agent's runtime columns just before a hosted switch; read only to revert a never-created provider agent. */
export type AgentMigrationHostedRuntimeSnapshot = {
  runtime: string;
  model: string;
  reasoningEffort: string | null;
  envVarsPresent: boolean;
  machineId: string;
  /**
   * `{runtimeConfig, envVars}` as AES-GCM ciphertext (encryptProviderSecret,
   * scope = the migration id). Both can hold secrets (env values, a builtin
   * provider's API key), so they are never stored in the clear; only the
   * never-created revert decrypts them.
   */
  encryptedRuntime: string;
};

// One row per migration whose target is Raft hosted (target_kind = 'hosted').
// Only the hosted import path reads it; Computer migrations never have a row.
export const agentMigrationHostedTargets = pgTable("agent_migration_hosted_targets", {
  migrationId: uuid("migration_id").primaryKey().references(() => agentMigrations.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["antiproton"] }).notNull(),
  // A model offered by the provider and picked in the dialog; null = provider default.
  hostedModel: text("hosted_model"),
  // GET /provision/import-limits, fixed at preflight.
  importLimits: jsonb("import_limits").$type<AgentMigrationHostedImportLimits>(),
  // The agent's runtime columns just before the switch, for the never-created
  // revert only. envVars is recorded as present/absent, never its values.
  runtimeSnapshot: jsonb("runtime_snapshot").$type<AgentMigrationHostedRuntimeSnapshot>(),
  // Filtered file set in object storage; deleted once the migration completes.
  fileSetObjectKey: text("file_set_object_key"),
  fileSetSha256: text("file_set_sha256"),
  importSummary: jsonb("import_summary").$type<AgentMigrationHostedImportSummary>(),
  reviewReadyAt: timestamp("review_ready_at", { withTimezone: true }),
  reviewConfirmedAt: timestamp("review_confirmed_at", { withTimezone: true }),
  importerLeaseId: text("importer_lease_id"),
  importerLeaseExpiresAt: timestamp("importer_lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentMigrationChunkReceipts = pgTable("agent_migration_chunk_receipts", {
  migrationId: uuid("migration_id").notNull().references(() => agentMigrations.id, { onDelete: "cascade" }),
  transportGeneration: text("transport_generation").notNull(),
  leaseId: text("lease_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  sourceEtag: text("source_etag"),
  sourceReceiptAt: timestamp("source_receipt_at", { withTimezone: true }),
  targetReceiptAt: timestamp("target_receipt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.migrationId, t.transportGeneration, t.chunkIndex] }),
  index("idx_agent_migration_chunk_receipts_generation").on(t.migrationId, t.transportGeneration),
]);

// Server agent members — agent ↔ server membership relationship.
//
// Agents share the server role vocabulary, but v1 intentionally does not grant
// owner to agents; ownership still belongs to human server members.
export const serverAgentMembers = pgTable("server_agent_members", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["member", "admin"] }).notNull().default("member"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.agentId] }),
  index("idx_server_agent_members_agent").on(t.agentId),
  index("idx_server_agent_members_server_role").on(t.serverId, t.role),
]);

// How a person's Login with Raft is bound (RFC 079 §5.1). `server`: the login
// picks one Server and the token carries it (every app today). `account`: the
// login proves the account only and each request names its Server. Nothing
// sets or reads `account` yet; agents log in the same way in both modes.
export const OAUTH_CLIENT_LOGIN_MODES = ["server", "account"] as const;
export type OAuthClientLoginMode = (typeof OAUTH_CLIENT_LOGIN_MODES)[number];

// OAuth clients — third-party apps that can request agent login
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  clientSecret: text("client_secret"),
  appType: text("app_type", { enum: ["server_local", "slock_builtin", "third_party_global"] }).default("server_local").notNull(),
  // RFC 079 phase 0: every app, existing or new, is `server` through the
  // database default; no write path sets the column and no auth path reads it.
  loginMode: text("login_mode", { enum: OAUTH_CLIENT_LOGIN_MODES }).default("server").notNull(),
  // Platform-owned Agent Login handoff contract. Existing and new Apps stay
  // legacy unless a separately reviewed migration opts an App into v1.
  agentHandoffProtocol: text("agent_handoff_protocol", { enum: ["legacy", "v1"] }).default("legacy").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  homepageUrl: text("homepage_url"),
  returnUrl: text("return_url"),
  agentManifestUrl: text("agent_manifest_url"),
  // Optional installation onboarding. URL changes invalidate prior completion;
  // progress never grants permissions or changes OAuth availability.
  setupUrl: text("setup_url"),
  setupDescription: text("setup_description"),
  setupRevision: integer("setup_revision").notNull().default(1),
  // Agent-facing "when to use this app" hint (task #319). Nullable; empty is
  // stored as null by the write path. Hard cap 160 code points, no control
  // characters, single line — enforced again by the shared validator on both
  // write paths (Web PATCH and agent app update); this CHECK is the DB-level
  // backstop so a missed write path cannot store a longer value.
  whenToUse: text("when_to_use"),
  allowedScopes: json("allowed_scopes").$type<string[]>(),
  logoUrl: text("logo_url"),
  logoStorageKey: text("logo_storage_key"),
  category: text("category").default("Other").notNull(),
  dataAccessSummary: text("data_access_summary"),
  // Unread since Agent JWT became built in; kept one release for rollback, then dropped.
  agentJwtEnabled: boolean("agent_jwt_enabled").default(false),
  enabled: boolean("enabled").default(true).notNull(),
  humanMarketplaceVisible: boolean("human_marketplace_visible").default(true).notNull(),
  publishStatus: text("publish_status", { enum: ["private", "publish_requested", "in_review", "published", "rejected", "unpublish_requested"] }).default("private").notNull(),
  publishRequestedAt: timestamp("publish_requested_at", { withTimezone: true }),
  publishReviewedAt: timestamp("publish_reviewed_at", { withTimezone: true }),
  publishReviewedByUserId: uuid("publish_reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  publishRejectionReason: text("publish_rejection_reason"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The agent that registered this app via an `integration:register_app` action
  // card (= the card's requester). Set ONLY in the agent-initiated register
  // flow; null for human-UI and built-in app registrations. This is the
  // owner-scope anchor for agent secret rotation (task #446): only this agent,
  // on the same server, may regenerate the client secret. Never overwritten by
  // rotation — rotation changes the secret, not ownership.
  ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
  // App-owned Bot capability declaration (design-v3). Declaration alone does
  // not create or grant a Bot; install-time grant + activation still required.
  // Only editable while enabled=true on a private/non-published app OR when the
  // current publish revision already includes this capability.
  enableBot: boolean("enable_bot").notNull().default(false),
  // RFC 051 outbound authority is derived from immutable request revisions.
  // These fields are the closed runtime ceiling; remote manifests are never
  // consulted while authorizing pull or delivery.
  outboundRequestRevision: integer("outbound_request_revision").notNull().default(0),
  outboundCurrentRevisionId: uuid("outbound_current_revision_id"),
  outboundPendingRevisionId: uuid("outbound_pending_revision_id"),
  outboundCurrentGroups: jsonb("outbound_current_groups").$type<string[]>().notNull().default([]),
  outboundCurrentEvents: jsonb("outbound_current_events").$type<string[]>().notNull().default([]),
  // Prompt text (name, description, whenToUse) is what every agent of an
  // installing Server reads in its system prompt (task #4, #proj-apps). Each
  // edit is an oauth_app_text_revisions row; name/description/whenToUse above
  // always hold the CURRENT revision's values, so a published app's edit
  // waiting for marketplace review is not visible anywhere until approved.
  textRevision: integer("text_revision").notNull().default(0),
  textCurrentRevisionId: uuid("text_current_revision_id"),
  textPendingRevisionId: uuid("text_pending_revision_id"),
  // A server_local app has no installation: its source Server's confirmation
  // lives here. Third-party installs carry their own on the install row.
  localConfirmedTextRevisionId: uuid("local_confirmed_text_revision_id"),
  // When the App first had a token, grant, login request or link-preview
  // registration; set once by a database trigger and never cleared, because
  // those rows can go. A used App's id stays reserved (RFC 084 §4).
  firstUsedAt: timestamp("first_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("oauth_clients_agent_handoff_protocol_valid", sql`${t.agentHandoffProtocol} in ('legacy', 'v1')`),
  check("oauth_clients_setup_revision_positive", sql`${t.setupRevision} > 0`),
  check("oauth_clients_text_revision_nonnegative", sql`${t.textRevision} >= 0`),
  index("idx_oauth_clients_server").on(t.serverId),
  // Declared as a UNIQUE constraint. A unique index alone would also back the
  // composite FK from official_app_registry; migration 0281 adopts the index
  // from 0277 in place with UNIQUE USING INDEX.
  unique("idx_oauth_clients_registry_identity").on(t.id, t.clientId, t.serverId),
  index("idx_oauth_clients_app_type").on(t.appType),
  index("idx_oauth_clients_owner_agent").on(t.ownerAgentId),
  index("idx_oauth_clients_publish_status").on(t.publishStatus),
  index("idx_oauth_clients_marketplace").on(t.appType, t.publishStatus),
  check(
    "oauth_clients_publish_status_valid",
    sql`${t.publishStatus} IN ('private', 'publish_requested', 'in_review', 'published', 'rejected', 'unpublish_requested')`,
  ),
  check("oauth_clients_login_mode_valid", sql`${t.loginMode} IN ('server', 'account')`),
  check(
    "oauth_clients_when_to_use_valid",
    sql`${t.whenToUse} IS NULL OR (length(${t.whenToUse}) <= 160 AND ${t.whenToUse} !~ '[\\x00-\\x1F\\x7F]')`,
  ),
]);

// ---------------------------------------------------------------------------
// Generic App root (Phase 1A, #wg-mcp task #19) — DARK. Nothing reads these yet.
//
// `oauth_clients.app_type` is the DISTRIBUTION axis (server_local / slock_builtin /
// third_party_global). Execution behaviour is an INDEPENDENT axis, so `mcp` is
// deliberately NOT added to that enum: mixing them would make states like "MCP, but
// is it local or public?" constructible, and would force a fake `client_secret_hash`
// (NOT NULL today) and `return_url` onto MCP-only Apps.
//
// In 1A the root carries NO MUTABLE IDENTITY. name/description/icon/category/enabled
// stay in the legacy tables, which remain authoritative and are where compatibility
// reads already look. Drift between root and source is therefore not prevented by
// policy, it is UNREPRESENTABLE — and symmetrically for both adapters. Adding those
// columns later is a pure superset (see the Phase 1A design note).
export const raftApps = pgTable("raft_apps", {
  id: uuid("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["oauth_service", "mcp"] }).notNull(),
  distribution: text("distribution", { enum: ["server_local", "slock_builtin", "third_party_global"] }).notNull(),
  metadataRevision: integer("metadata_revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_raft_apps_server").on(t.serverId),
  index("idx_raft_apps_kind").on(t.kind),
  check("raft_apps_kind_valid", sql`${t.kind} IN ('oauth_service', 'mcp')`),
  check(
    "raft_apps_distribution_valid",
    sql`${t.distribution} IN ('server_local', 'slock_builtin', 'third_party_global')`,
  ),
  check("raft_apps_metadata_revision_nonnegative", sql`${t.metadataRevision} >= 0`),
  // Referenceable target for each profile's composite FK below. It is what lets a
  // profile bind to a root's KIND and not merely to its id.
  unique("raft_apps_id_kind_unique").on(t.id, t.kind),
]);

// Compatibility association only: app_id <-> oauth_client_id. 1A does NOT move or
// copy credential authority (client_secret_hash / client_secret / return_url /
// allowed_scopes) and does NOT relocate the five outbound_* App Notifications
// columns. `oauth_clients` stays authoritative for every live field.
//
// The outbound_* columns in particular stay put on purpose: "the MCP adapter does not
// declare App Notifications" is a statement about TODAY'S ADAPTER, not about where
// notifications belong forever. Binding them to OAuth credential/redirect structure
// would force a schema re-split the moment a composable adapter declares them.
//
// `appKind` is a pinned discriminator, not data: the CHECK fixes it to one value and the
// composite FK below binds (app_id, kind) to the root. A profile therefore CANNOT attach to
// a root of the other adapter -- the database refuses it, rather than a test noticing it
// afterwards. This closes the case @Huarong found, where two independent legacy uuid
// namespaces could collide onto one root and leave an MCP profile pointing at an OAuth App.
export const appOauthProfiles = pgTable("app_oauth_profiles", {
  appId: uuid("app_id").primaryKey(),
  appKind: text("app_kind", { enum: ["oauth_service"] }).notNull().default("oauth_service"),
  oauthClientId: uuid("oauth_client_id").notNull().unique().references(() => oauthClients.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.appId, t.appKind],
    foreignColumns: [raftApps.id, raftApps.kind],
    name: "app_oauth_profiles_app_id_kind_raft_apps_id_kind_fk",
  }).onDelete("cascade"),
  check("app_oauth_profiles_app_kind_pinned", sql`${t.appKind} = 'oauth_service'`),
]);

// Same shape for managed MCP records. They are ATTACHED, not moved: MCP Settings and
// the runtime keep reading `managed_mcp_servers` unchanged.
export const appMcpProfiles = pgTable("app_mcp_profiles", {
  appId: uuid("app_id").primaryKey(),
  appKind: text("app_kind", { enum: ["mcp"] }).notNull().default("mcp"),
  managedMcpServerId: uuid("managed_mcp_server_id").notNull().unique().references(() => managedMcpServers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.appId, t.appKind],
    foreignColumns: [raftApps.id, raftApps.kind],
    name: "app_mcp_profiles_app_id_kind_raft_apps_id_kind_fk",
  }).onDelete("cascade"),
  check("app_mcp_profiles_app_kind_pinned", sql`${t.appKind} = 'mcp'`),
]);

// A domain proves which App owns its link renderer. One owner per origin.
// RFC 084 §4: a client key that no longer is, or never again will be, some App's
// current `oauth_clients.client_id`. `client_id` set: an alias of that App
// (rename, step 2). `client_id` NULL: a tombstone from a deleted App, reserved
// against every other App; only `source_server_id` may reuse it, and only while
// `reclaimable` (past 50 tombstones on a Server the oldest stay reserved but
// their Server loses that right). No FK on `source_server_id`: a tombstone
// outlives its Server.
export const oauthClientKeyAliases = pgTable("oauth_client_key_aliases", {
  key: text("key").primaryKey(),
  clientId: uuid("client_id").references(() => oauthClients.id, { onDelete: "set null" }),
  sourceServerId: uuid("source_server_id").notNull(),
  reclaimable: boolean("reclaimable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_client_key_aliases_client").on(t.clientId),
  index("idx_oauth_client_key_aliases_source_server").on(t.sourceServerId, t.createdAt),
]);

export const oauthAppLinkPreviews = pgTable("oauth_app_link_previews", {
  clientId: uuid("client_id").primaryKey().references(() => oauthClients.id, { onDelete: "cascade" }),
  origin: text("origin").notNull().unique(),
  endpoint: text("endpoint").notNull(),
  paths: json("paths").$type<string[]>().notNull(),
  revision: uuid("revision").$type<AppLinkPreviewRevision>().notNull().$defaultFn(() => randomUUID() as AppLinkPreviewRevision),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Interactive link cards (RFC 076 §4): the action endpoint in force. Covered by `revision`. */
  actionEndpoint: text("action_endpoint"),
  /** A published App's added/changed action endpoint, waiting for marketplace review. Not in force. */
  pendingActionEndpoint: text("pending_action_endpoint"),
  pendingActionEndpointRequestedAt: timestamp("pending_action_endpoint_requested_at", { withTimezone: true }),
  /** The reviewer's reason for the last rejected action endpoint, for the developer. */
  actionEndpointRejectReason: text("action_endpoint_reject_reason"),
  /** Last successful domain proof (registration or recheck). Rechecked after a day; no assertions past three days. */
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last proof attempt; the recheck claims the row by advancing it (single flight across instances). */
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  /** A suspended registration gets no callbacks until its origin proves again. Suspend/resume move `revision`. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason").$type<AppLinkPreviewSuspendReason>(),
  /**
   * The preview request versions the App declared it answers (`preview_versions`),
   * sorted; `{1}` for an App that declared none. Always includes 1 (the
   * registration schema checks it; no CHECK, which would make the release
   * need a human). Not covered by `revision` and not reviewed
   * (appLinkPreviewService's saveRegistration).
   */
  previewVersions: smallint("preview_versions").array().$type<AppLinkPreviewVersion[]>().notNull().default(sql`'{1}'::smallint[]`),
  /**
   * The client id the origin's domain file last named: the App's current id or
   * one of its aliases (RFC 084 §4). Raft's link-preview and card-action
   * assertions use it as `aud` until the file names another. Null only on a row
   * an older replica wrote during a deploy, which the recheck fills; read it
   * through `linkPreviewAudienceKey`.
   */
  provedClientKey: text("proved_client_key"),
  /**
   * RFC 076 §17: the action endpoint a person with manageIntegrations on the
   * App's own Server confirmed, exactly as they saw it. On that Server only,
   * a card of an App that is not official may call its action endpoint while
   * this equals `actionEndpoint` (an App that changes its endpoint needs a new
   * confirmation) and the registration is not suspended. Not covered by
   * `revision`: eligibility reads it live, and execute locks this row.
   */
  ownServerActionEndpoint: text("own_server_action_endpoint"),
  /** When it was confirmed. Who confirmed (and who withdrew it) is in the integration audit. */
  ownServerActionsConfirmedAt: timestamp("own_server_actions_confirmed_at", { withTimezone: true }),
}, (t) => [
  check("oauth_app_link_previews_pending_action_endpoint", sql`(${t.pendingActionEndpoint} IS NULL) = (${t.pendingActionEndpointRequestedAt} IS NULL)`),
  check("oauth_app_link_previews_suspension", sql`(${t.suspendedAt} IS NULL) = (${t.suspendedReason} IS NULL)`),
  check("oauth_app_link_previews_own_server_actions", sql`(${t.ownServerActionEndpoint} IS NULL) = (${t.ownServerActionsConfirmedAt} IS NULL)`),
]);
/** Why a link preview registration stopped: its origin named another App, or could not be fetched for HARD_TTL. */
export type AppLinkPreviewSuspendReason = "proof_mismatch" | "proof_unavailable";

// Interactive link cards (RFC 076 §5.2). Rendering never writes: these rows
// exist only after a person clicks a card button. No row stores card content,
// raw URLs, JWTs or message text. Every row carries a non-null identity domain
// (provider kind + key + installation key; native providers use
// `native:<server_id>:<provider_key>`), so request uniqueness has no NULLs.
// No foreign keys to users/servers/messages: unknown-outcome records must
// outlive them. Within these tables, rows reference their operation (which is
// trimmed, never deleted).
export const LINK_CARD_OPERATION_STATES = [
  "requested", "sent", "accepted", "done", "refused", "failed_not_sent", "unknown", "needs_reconciliation", "resolved_manually",
] as const;
export type LinkCardOperationState = (typeof LINK_CARD_OPERATION_STATES)[number];
const linkCardIdentity = () => ({
  serverId: uuid("server_id").notNull(),
  providerKind: text("provider_kind", { enum: ["app", "native"] }).notNull(),
  providerKey: text("provider_key").notNull(),
  installationKey: text("installation_key").notNull(),
});
const linkCardIdentityChecks = (name: string, t: { serverId: AnyPgColumn; providerKind: AnyPgColumn; providerKey: AnyPgColumn; installationKey: AnyPgColumn }) => [
  check(`${name}_provider_kind_valid`, sql`${t.providerKind} IN ('app', 'native')`),
  check(`${name}_provider_key_valid`, sql`length(${t.providerKey}) BETWEEN 1 AND 128`),
  check(`${name}_installation_key_valid`, sql`(${t.providerKind} = 'app' AND length(${t.installationKey}) BETWEEN 1 AND 200 AND ${t.installationKey} !~ '^native:') OR (${t.providerKind} = 'native' AND ${t.installationKey} = ('native:' || ${t.serverId}::text || ':' || ${t.providerKey}))`),
];

export const linkCardOperations = pgTable("link_card_operations", {
  operationId: uuid("operation_id").primaryKey(),
  viewerId: uuid("viewer_id").notNull(),
  ...linkCardIdentity(),
  /** The registration revision the operation was sent under; status and updates stay pinned to it. */
  registrationRevision: text("registration_revision").notNull(),
  viewNonce: text("view_nonce").notNull(),
  messageId: uuid("message_id").notNull(),
  /** The URL acted on, as its SHA-256 (64 lowercase hex): status assertions and the by-URL lookup read it (protocol v3.2.3 §5.4). */
  urlSha256: text("url_sha256").notNull(),
  /**
   * Where execute was sent: the SHA-256 of the action endpoint then in force, and
   * its origin. Status goes out while the registration in force still has both,
   * so a change to paths alone no longer strands open operations (Tenny
   * 90cf59b3 #2). Null for a native provider, which has no endpoint.
   */
  actionEndpointSha256: text("action_endpoint_sha256"),
  actionOrigin: text("action_origin"),
  /**
   * created_at + 10 minutes, both from one whole-second reading (protocol v3.2.3
   * §5.3.4). Execute is never first sent after it, and no execute JWT outlives
   * it, so an App's never-execute fence covers every late request. A trigger
   * keeps both values fixed once written.
   */
  firstSendDeadline: timestamp("first_send_deadline", { withTimezone: true }).notNull(),
  actionId: text("action_id").notNull(),
  requestSha256: text("request_sha256").notNull(),
  state: text("state", { enum: LINK_CARD_OPERATION_STATES }).notNull().default("requested"),
  receiptRevision: integer("receipt_revision").notNull().default(0),
  lastStatusAt: timestamp("last_status_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id"),
  resolutionReason: text("resolution_reason"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /**
   * Inserts must pass created_at explicitly, as a whole second, together with
   * first_send_deadline: the default now() carries microseconds and fails the
   * link_card_operations_first_send_deadline CHECK.
   */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  ...linkCardIdentityChecks("link_card_operations", t),
  check("link_card_operations_state_valid", sql`${t.state} IN ('requested', 'sent', 'accepted', 'done', 'refused', 'failed_not_sent', 'unknown', 'needs_reconciliation', 'resolved_manually')`),
  // Manual resolution is all-or-nothing and needs a real reason (RFC 076 §5.2).
  check("link_card_operations_manual_resolution", sql`(${t.state} = 'resolved_manually' AND ${t.resolvedByUserId} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND length(btrim(${t.resolutionReason})) BETWEEN 3 AND 500)
    OR (${t.state} <> 'resolved_manually' AND ${t.resolvedByUserId} IS NULL AND ${t.resolutionReason} IS NULL AND ${t.resolvedAt} IS NULL)`),
  check("link_card_operations_url_sha256_valid", sql`${t.urlSha256} ~ '^[0-9a-f]{64}$'`),
  check("link_card_operations_send_target", sql`(${t.providerKind} = 'app' AND ${t.actionEndpointSha256} ~ '^[0-9a-f]{64}$' AND ${t.actionOrigin} IS NOT NULL)
    OR (${t.providerKind} = 'native' AND ${t.actionEndpointSha256} IS NULL AND ${t.actionOrigin} IS NULL)`),
  check("link_card_operations_first_send_deadline", sql`${t.createdAt} = date_trunc('second', ${t.createdAt}) AND ${t.firstSendDeadline} = ${t.createdAt} + interval '10 minutes'`),
  // Open-operation caps (RFC 076 §5.2): per viewer per Server and per installation.
  index("idx_link_card_operations_viewer_open").on(t.viewerId, t.serverId).where(sql`${t.state} IN ('sent', 'accepted', 'unknown')`),
  // A viewer's open operations on one link, paged in a stable order, for
  // recovery after local records are lost (protocol v3.2.3 §5.4).
  index("idx_link_card_operations_viewer_url_open").on(t.viewerId, t.serverId, t.messageId, t.urlSha256, t.createdAt, t.operationId)
    .where(sql`${t.state} IN ('sent', 'accepted', 'unknown', 'needs_reconciliation')`),
  // The first-send deadline sweep (protocol v3.2.3 §5.3.4).
  index("idx_link_card_operations_send_deadline").on(t.firstSendDeadline).where(sql`${t.state} = 'sent'`),
  index("idx_link_card_operations_installation_open").on(t.installationKey).where(sql`${t.state} IN ('sent', 'accepted', 'unknown', 'needs_reconciliation')`),
  index("idx_link_card_operations_unknown_age").on(t.createdAt).where(sql`${t.state} = 'unknown'`),
  // Terminal detail is trimmed after 24 h.
  index("idx_link_card_operations_terminal_trim").on(t.updatedAt).where(sql`${t.state} IN ('done', 'refused', 'failed_not_sent', 'resolved_manually')`),
]);

export const linkCardClientRequests = pgTable("link_card_client_requests", {
  viewerId: uuid("viewer_id").notNull(),
  ...linkCardIdentity(),
  clientRequestId: text("client_request_id").notNull(),
  operationId: uuid("operation_id").notNull().unique(),
  urlSha256: text("url_sha256").notNull(),
  actionId: text("action_id").notNull(),
  requestSha256: text("request_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "link_card_client_requests_pk", columns: [t.viewerId, t.serverId, t.providerKind, t.providerKey, t.installationKey, t.clientRequestId] }),
  foreignKey({ name: "link_card_client_requests_operation_fk", columns: [t.operationId], foreignColumns: [linkCardOperations.operationId] }),
  ...linkCardIdentityChecks("link_card_client_requests", t),
  check("link_card_client_requests_id_valid", sql`length(${t.clientRequestId}) BETWEEN 16 AND 128`),
]);

export const linkCardPreparedActions = pgTable("link_card_prepared_actions", {
  preparedActionId: uuid("prepared_action_id").primaryKey(),
  viewerId: uuid("viewer_id").notNull(),
  ...linkCardIdentity(),
  viewNonce: text("view_nonce").notNull(),
  handleSha256: text("handle_sha256").notNull(),
  /** SHA-256 of the RFC 8785 canonical JSON of the description the viewer was shown. Never the content. */
  descriptionSha256: text("description_sha256").notNull(),
  businessRevision: text("business_revision").notNull(),
  /** Opaque provider values the confirmation is bound to (protocol §8.4.1). */
  target: text("target"),
  executionMode: text("execution_mode"),
  executionAccountLink: text("execution_account_link"),
  readAt: timestamp("read_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedByOperationId: uuid("consumed_by_operation_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  ...linkCardIdentityChecks("link_card_prepared_actions", t),
  foreignKey({ name: "link_card_prepared_actions_operation_fk", columns: [t.consumedByOperationId], foreignColumns: [linkCardOperations.operationId] }),
  check("link_card_prepared_actions_lifetime", sql`${t.expiresAt} > ${t.readAt} AND ${t.expiresAt} <= ${t.readAt} + interval '5 minutes'`),
  index("idx_link_card_prepared_actions_expiry").on(t.expiresAt),
]);

export const linkCardHandleUses = pgTable("link_card_handle_uses", {
  handleSha256: text("handle_sha256").primaryKey(),
  operationId: uuid("operation_id").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  foreignKey({ name: "link_card_handle_uses_operation_fk", columns: [t.operationId], foreignColumns: [linkCardOperations.operationId] }),
  index("idx_link_card_handle_uses_expiry").on(t.expiresAt),
]);

export const linkCardViews = pgTable("link_card_views", {
  viewNonce: text("view_nonce").primaryKey(),
  viewInstanceId: text("view_instance_id").notNull(),
  viewerId: uuid("viewer_id").notNull(),
  ...linkCardIdentity(),
  messageId: uuid("message_id").notNull(),
  urlSha256: text("url_sha256").notNull(),
  /** At most one pending operation per view; a refresh never clears it. */
  pendingOperationId: uuid("pending_operation_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  ...linkCardIdentityChecks("link_card_views", t),
  foreignKey({ name: "link_card_views_pending_operation_fk", columns: [t.pendingOperationId], foreignColumns: [linkCardOperations.operationId] }),
  index("idx_link_card_views_sweep").on(t.updatedAt).where(sql`${t.pendingOperationId} IS NULL`),
]);

export const linkCardAttempts = pgTable("link_card_attempts", {
  jti: uuid("jti").primaryKey(),
  viewerId: uuid("viewer_id").notNull(),
  ...linkCardIdentity(),
  /** Execute and status attempts belong to an operation. */
  operationId: uuid("operation_id"),
  /** Prepare attempts carry the id minted before sending, even if no prepared record results. */
  preparedActionId: uuid("prepared_action_id"),
  phase: text("phase", { enum: ["prepare", "execute", "status"] }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  outcome: text("outcome"),
}, (t) => [
  ...linkCardIdentityChecks("link_card_attempts", t),
  foreignKey({ name: "link_card_attempts_operation_fk", columns: [t.operationId], foreignColumns: [linkCardOperations.operationId] }),
  check("link_card_attempts_phase_valid", sql`${t.phase} IN ('prepare', 'execute', 'status')`),
  check("link_card_attempts_subject", sql`(${t.phase} = 'prepare' AND ${t.operationId} IS NULL AND ${t.preparedActionId} IS NOT NULL)
    OR (${t.phase} <> 'prepare' AND ${t.operationId} IS NOT NULL AND ${t.preparedActionId} IS NULL)`),
  index("idx_link_card_attempts_operation").on(t.operationId),
]);

export const linkCardUpdateTokens = pgTable("link_card_update_tokens", {
  tokenSha256: text("token_sha256").primaryKey(),
  operationId: uuid("operation_id").notNull(),
  ...linkCardIdentity(),
  registrationRevision: text("registration_revision").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedUpdateId: text("consumed_update_id"),
  contentSha256: text("content_sha256"),
  receipt: jsonb("receipt").$type<{ operationId: string; state: LinkCardOperationState; receiptRevision: number }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  ...linkCardIdentityChecks("link_card_update_tokens", t),
  foreignKey({ name: "link_card_update_tokens_operation_fk", columns: [t.operationId], foreignColumns: [linkCardOperations.operationId] }),
  // A consumed token keeps the receipt it replays to identical retries (RFC 076 §6.5).
  check("link_card_update_tokens_consumed", sql`(${t.consumedUpdateId} IS NULL AND ${t.contentSha256} IS NULL AND ${t.receipt} IS NULL)
    OR (${t.consumedUpdateId} IS NOT NULL AND ${t.contentSha256} IS NOT NULL AND ${t.receipt} IS NOT NULL)`),
  index("idx_link_card_update_tokens_operation").on(t.operationId),
]);

// App-scoped ownership and secret-rotation authority. Registration execution
// is attribution only; active roles on this resource are capability.
export const oauthClientMaintainers = pgTable("oauth_client_maintainers", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["agent", "human"] }).notNull(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "rotate"] }).notNull().default("owner"),
  // Assignment provenance identifies the actor that performed the transfer,
  // not the owner displaced by it. Agent transfers additionally persist the
  // actor's transfer-time authority so a displaced owner can safely replay the
  // exact no-op while a former admin cannot retain authority after demotion.
  assignedByType: text("assigned_by_type", { enum: ["agent", "human", "system"] }).notNull(),
  assignedById: uuid("assigned_by_id"),
  assignedByAuthority: text("assigned_by_authority", { enum: ["owner", "admin"] }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  index("idx_oauth_client_maintainers_client").on(t.clientId),
  index("idx_oauth_client_maintainers_agent").on(t.agentId),
  index("idx_oauth_client_maintainers_user").on(t.userId),
  uniqueIndex("idx_oauth_client_maintainers_active_owner")
    .on(t.clientId)
    .where(sql`${t.role} = 'owner' AND ${t.revokedAt} IS NULL`),
  check(
    "oauth_client_maintainers_principal_valid",
    sql`(${t.principalType} = 'agent' AND ${t.agentId} IS NOT NULL AND ${t.userId} IS NULL)
      OR (${t.principalType} = 'human' AND ${t.userId} IS NOT NULL AND ${t.agentId} IS NULL)`,
  ),
]);

// Immutable app-facing outbound permission requests. A published marketplace
// expansion remains pending review; contractions are reflected immediately in
// oauth_clients.outbound_current_* without mutating this snapshot.
export const oauthAppPermissionRevisions = pgTable("oauth_app_permission_revisions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  requestedGroups: jsonb("requested_groups").$type<string[]>().notNull().default([]),
  requestedEvents: jsonb("requested_events").$type<string[]>().notNull().default([]),
  state: text("state", { enum: ["active", "pending_review", "superseded"] }).notNull(),
  createdByType: text("created_by_type", { enum: ["human", "agent", "system"] }).notNull(),
  createdById: uuid("created_by_id"),
  reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_app_permission_revisions_client_revision").on(t.clientId, t.revision),
  index("idx_oauth_app_permission_revisions_state").on(t.clientId, t.state),
  check("oauth_app_permission_revisions_revision_positive", sql`${t.revision} > 0`),
]);

// Immutable prompt-text snapshots (task #4, #proj-apps). Rows are never
// deleted while an app exists: an installation keeps pointing at the revision
// its admin confirmed, and the agent prompt renders that revision's text until
// a newer one is confirmed.
export const oauthAppTextRevisions = pgTable("oauth_app_text_revisions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  whenToUse: text("when_to_use"),
  state: text("state", { enum: ["active", "pending_review", "superseded", "rejected"] }).notNull(),
  createdByType: text("created_by_type", { enum: ["human", "agent", "system"] }).notNull(),
  createdById: uuid("created_by_id"),
  reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_app_text_revisions_client_revision").on(t.clientId, t.revision),
  index("idx_oauth_app_text_revisions_state").on(t.clientId, t.state),
  check("oauth_app_text_revisions_revision_positive", sql`${t.revision} > 0`),
  check(
    "oauth_app_text_revisions_state_valid",
    sql`${t.state} IN ('active', 'pending_review', 'superseded', 'rejected')`,
  ),
]);

export const oauthClientInstalls = pgTable("oauth_client_installs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  installedByUserId: uuid("installed_by_user_id").references(() => users.id, { onDelete: "cascade" }),
  installedByAgentId: uuid("installed_by_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  installedBySystem: boolean("installed_by_system").notNull().default(false),
  // Unread since Agent JWT became built in; kept one release for rollback, then dropped.
  agentJwtEnabled: boolean("agent_jwt_enabled").notNull().default(false),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  approvedRequestRevisionId: uuid("approved_request_revision_id").references(() => oauthAppPermissionRevisions.id, { onDelete: "set null" }),
  approvedGroups: jsonb("approved_groups").$type<string[]>().notNull().default([]),
  subscribedEvents: jsonb("subscribed_events").$type<string[]>().notNull().default([]),
  grantRevision: integer("grant_revision").notNull().default(0),
  subscriptionRevision: integer("subscription_revision").notNull().default(0),
  setupCompletedRevision: integer("setup_completed_revision"),
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  // Per-installation Bot grant: set at install approval or explicit opt-in.
  // NULL = no Bot declared/requested; 'granted' = binding may be created.
  // Set separately from global App enablement; revoking never back-fills.
  botGrant: text("bot_grant", { enum: ["pending", "granted", "revoked"] }),
  // App-published status for its managed Bot (P4b): a short line the app sets
  // with its client credentials; shown on the Bot's identity card. NULL = no
  // status published; the card renders nothing instead of a fake presence.
  botStatusText: text("bot_status_text"),
  // The OAuth login scopes the installer approved: the app's effective allowed
  // scopes when installed, refreshed only when an admin approves an update.
  // Agents are granted without a person only within this set, so a scope the
  // developer adds later waits for the admin (task #2, #proj-apps). Every
  // install path sets it; the empty default fails closed for one that forgets.
  approvedScopes: jsonb("approved_scopes").$type<string[]>().notNull().default([]),
  // The prompt-text revision this Server's admin confirmed (task #4,
  // #proj-apps). The agent prompt renders this revision, never the app's live
  // text; null keeps the app out of the prompt (fails closed).
  confirmedTextRevisionId: uuid("confirmed_text_revision_id").references(() => oauthAppTextRevisions.id, { onDelete: "set null" }),
  textConfirmedByUserId: uuid("text_confirmed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  textConfirmedAt: timestamp("text_confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("oauth_client_installs_setup_completion_valid", sql`
    (${t.setupCompletedRevision} IS NULL AND ${t.setupCompletedAt} IS NULL)
    OR (${t.setupCompletedRevision} IS NOT NULL AND ${t.setupCompletedRevision} > 0 AND ${t.setupCompletedAt} IS NOT NULL)
  `),
  uniqueIndex("idx_oauth_client_installs_server_client").on(t.serverId, t.clientId),
  index("idx_oauth_client_installs_client").on(t.clientId),
  check(
    "oauth_client_installs_actor_valid",
    sql`(${t.installedByUserId} IS NOT NULL AND ${t.installedByAgentId} IS NULL AND ${t.installedBySystem} = false)
      OR (${t.installedByUserId} IS NULL AND ${t.installedByAgentId} IS NOT NULL AND ${t.installedBySystem} = false)
      OR (${t.installedByUserId} IS NULL AND ${t.installedByAgentId} IS NULL AND ${t.installedBySystem} = true)`,
  ),
  index("idx_oauth_client_installs_status").on(t.clientId, t.status),
  check("oauth_client_installs_grant_revision_nonnegative", sql`${t.grantRevision} >= 0`),
  check("oauth_client_installs_subscription_revision_nonnegative", sql`${t.subscriptionRevision} >= 0`),
]);

// App-owned Bot identity binding. One App has at most one active Bot per
// installation (unique index on install_id, state != 'uninstalled'). The Bot's
// agent_id is immutable once assigned; generation/tombstone survive reinstall.
// display name conflicts are resolved at activation; handle is the app's
// stable client-ID-derived handle, not the agent's Raft name.
export const appBotBindings = pgTable("app_bot_bindings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installId: uuid("install_id").notNull().references(() => oauthClientInstalls.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull().default(1),
  state: text("state", { enum: ["active", "disabled", "uninstalled"] }).notNull().default("active"),
  handle: text("handle").notNull(),
  requestedPermissions: jsonb("requested_permissions").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
}, (t) => [
  // Exactly one live (non-uninstalled) Bot per install.
  uniqueIndex("idx_app_bot_install_live").on(t.installId).where(sql`state != 'uninstalled'`),
  // The Bot agent is attributed to exactly one install.
  uniqueIndex("idx_app_bot_agent_install").on(t.agentId).where(sql`state = 'active'`),
  index("idx_app_bot_server").on(t.serverId),
  index("idx_app_bot_state").on(t.installId, t.state),
  check("app_bot_generation_positive", sql`${t.generation} > 0`),
  check("app_bot_handle_nonempty", sql`length(btrim(${t.handle})) > 0`),
]);

// What follows a marketplace review decision outside the database: written by
// the decision functions (marketplace_decide_publish_review,
// marketplace_approve_permission_review) in the decision's own transaction,
// whoever calls them (App Admin's app_admin_* entries; Raft's own review
// routes were removed); delivered by the server (services/marketplaceReviewOutbox.ts),
// each App's rows in `seq` order, then marked delivered. Delivery is at least
// once and each kind is harmless to repeat. No foreign keys: a row outlives
// the App, bot and Server it names (the bot was removed; telling clients so
// still matters), and the decisions write it as the owner.
export const marketplaceReviewOutbox = pgTable("marketplace_review_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Delivery order: within one App, the order the decisions committed (each
  // decision holds the App row FOR UPDATE before it inserts).
  seq: bigserial("seq", { mode: "number" }).notNull(),
  // The App the decision was about: the ordering key.
  clientId: uuid("client_id").notNull(),
  // app_bot_removed: an offline approval removed this bot from server_id
  //   (`agent:deleted` to server:<server_id>, the credential revocation signal,
  //   the agent's held activity forgotten). Its credentials were revoked by
  //   the decision itself.
  // permission_updates_changed: `permission-updates:changed` to server:<server_id>.
  kind: text("kind", { enum: ["app_bot_removed", "permission_updates_changed"] }).notNull(),
  serverId: uuid("server_id").notNull(),
  agentId: uuid("agent_id"),
  // The decision's audit event type (app.offline_approved, app.outbound_permission_approved, ...).
  cause: text("cause").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
}, (t) => [
  uniqueIndex("idx_marketplace_review_outbox_seq").on(t.seq),
  // The drain (an App's undelivered rows in order) and the oldest-age metric.
  index("idx_marketplace_review_outbox_undelivered").on(t.clientId, t.seq).where(sql`delivered_at IS NULL`),
  check("marketplace_review_outbox_kind_valid", sql`${t.kind} IN ('app_bot_removed', 'permission_updates_changed')`),
  check("marketplace_review_outbox_agent_for_bot", sql`(${t.kind} = 'app_bot_removed') = (${t.agentId} IS NOT NULL)`),
  check("marketplace_review_outbox_attempts_nonnegative", sql`${t.attempts} >= 0`),
]);

// Sticky policy state is deliberately independent of the installation row:
// uninstall deletes the installation, but must not erase the user's opt-out.
export const officialAppAutoInstallStates = pgTable("official_app_auto_install_states", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  state: text("state", { enum: ["default_auto", "auto_suppressed"] }).notNull(),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.clientId] }),
  index("idx_official_app_auto_install_states_client").on(t.clientId, t.state),
  check("official_app_auto_install_states_state_valid", sql`${t.state} IN ('default_auto', 'auto_suppressed')`),
  check("official_app_auto_install_states_revision_nonnegative", sql`${t.revision} >= 0`),
]);

// Platform-owned authority for official-app discovery and default delivery.
// Identity columns deliberately duplicate the OAuth client identity so the
// composite FK can reject publisher/client-key drift at the database boundary.
export const officialAppRegistry = pgTable("official_app_registry", {
  oauthClientId: uuid("oauth_client_id").primaryKey(),
  clientKey: text("client_key").notNull().unique(),
  publisherServerId: uuid("publisher_server_id").notNull(),
  autoInstall: boolean("auto_install").notNull().default(false),
  purpose: text("purpose").notNull(),
  status: text("status", { enum: ["pending_review", "approved", "disabled"] }).notNull().default("pending_review"),
  revision: integer("revision").notNull().default(1),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.oauthClientId, t.clientKey, t.publisherServerId],
    foreignColumns: [oauthClients.id, oauthClients.clientId, oauthClients.serverId],
    name: "official_app_registry_client_identity_fk",
  }).onUpdate("restrict").onDelete("restrict"),
  index("idx_official_app_registry_defaults").on(t.status, t.autoInstall),
  check("official_app_registry_status_valid", sql`${t.status} IN ('pending_review', 'approved', 'disabled')`),
  check("official_app_registry_revision_positive", sql`${t.revision} > 0`),
  check("official_app_registry_client_key_valid", sql`${t.clientKey} ~ '^[a-z][a-z0-9-]{2,63}$'`),
  check("official_app_registry_purpose_valid", sql`length(btrim(${t.purpose})) BETWEEN 1 AND 160 AND ${t.purpose} !~ '[\\r\\n]'`),
]);

export const officialAppAutoInstallTransitions = pgTable("official_app_auto_install_transitions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  state: text("state", { enum: ["default_auto", "auto_suppressed"] }).notNull(),
  transitionSource: text("transition_source", { enum: ["auto_install", "user_install", "user_uninstall", "migration"] }).notNull(),
  actorType: text("actor_type", { enum: ["human", "system"] }).notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  installationId: uuid("installation_id").references(() => oauthClientInstalls.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes a never-shared app this key names (migration
  // closed_server_purge_app_fk_indexes; CONCURRENTLY on a large table).
  index("idx_official_app_auto_install_transitions_client").on(t.clientId),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_official_app_auto_install_transitions_installation").on(t.installationId).where(sql`installation_id IS NOT NULL`),
  uniqueIndex("idx_official_app_auto_install_transitions_revision").on(t.serverId, t.clientId, t.revision),
  index("idx_official_app_auto_install_transitions_latest").on(t.serverId, t.clientId, t.createdAt),
  check("official_app_auto_install_transitions_state_valid", sql`${t.state} IN ('default_auto', 'auto_suppressed')`),
  check(
    "official_app_auto_install_transitions_source_valid",
    sql`${t.transitionSource} IN ('auto_install', 'user_install', 'user_uninstall', 'migration')`,
  ),
  check("official_app_auto_install_transitions_revision_positive", sql`${t.revision} > 0`),
  check(
    "official_app_auto_install_transitions_actor_valid",
    sql`(${t.actorType} = 'human' AND ${t.actorUserId} IS NOT NULL)
      OR (${t.actorType} = 'system' AND ${t.actorUserId} IS NULL)`,
  ),
]);

// Distinct, opaque installation credentials. Only a hash is stored; the
// plaintext is returned once and cannot authenticate principal/agent routes.
export const oauthAppInstallationTokens = pgTable("oauth_app_installation_tokens", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installationId: uuid("installation_id").notNull().references(() => oauthClientInstalls.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  grantRevision: integer("grant_revision").notNull(),
  effectiveGroups: jsonb("effective_groups").$type<string[]>().notNull().default([]),
  audience: text("audience").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes a never-shared app this key names (migration
  // closed_server_purge_app_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_app_installation_tokens_client").on(t.clientId),
  uniqueIndex("idx_oauth_app_installation_tokens_hash").on(t.tokenHash),
  index("idx_oauth_app_installation_tokens_installation").on(t.installationId, t.expiresAt),
  index("idx_oauth_app_installation_tokens_expiry").on(t.expiresAt),
]);

// App-global webhook delivery configuration. Secrets are AES-GCM encrypted at
// rest and shown only on creation/rotation. Previous-secret grace supports
// already in-flight attempts without changing installation authority.
export const oauthAppWebhookConfigs = pgTable("oauth_app_webhook_configs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  endpointUrl: text("endpoint_url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: text("secret_iv").notNull(),
  secretAuthTag: text("secret_auth_tag").notNull(),
  previousSecretCiphertext: text("previous_secret_ciphertext"),
  previousSecretIv: text("previous_secret_iv"),
  previousSecretAuthTag: text("previous_secret_auth_tag"),
  previousValidUntil: timestamp("previous_valid_until", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_app_webhook_configs_client").on(t.clientId),
  check("oauth_app_webhook_configs_revision_positive", sql`${t.revision} > 0`),
]);

// A private share link installs its App on ONE target Server, once
// (#proj-apps:769a57d4). The creator names the target by slug; Raft resolves it
// at creation and never says whether it resolved. `revoked_at IS NULL` means
// active: revoking, being replaced, and being redeemed all set it.
export const oauthClientShareLinks = pgTable("oauth_client_share_links", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  /** The only Server the link installs on. NULL when the typed slug named no
   *  Server (the link can never be redeemed) and on links made before targets. */
  targetServerId: uuid("target_server_id").references(() => servers.id, { onDelete: "cascade" }),
  /** The slug as the creator typed it (lowercased): what the editor lists. Never a resolved name. */
  targetServerSlug: text("target_server_slug"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "cascade" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** When an install redeemed the link; revoked_at is set in the same transaction. */
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_client_share_links_created_by_agent").on(t.createdByAgentId).where(sql`created_by_agent_id IS NOT NULL`),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_client_share_links_target_server").on(t.targetServerId).where(sql`target_server_id IS NOT NULL`),
  index("idx_oauth_client_share_links_client").on(t.clientId),
  // One active link per target, by Server and by the slug as typed (so an
  // unknown slug behaves exactly like a known one).
  uniqueIndex("idx_oauth_client_share_links_active_target_server").on(t.clientId, t.targetServerId).where(sql`revoked_at is null`),
  uniqueIndex("idx_oauth_client_share_links_active_target_slug").on(t.clientId, t.targetServerSlug).where(sql`revoked_at is null`),
  check(
    "oauth_client_share_links_actor_valid",
    sql`(${t.createdByUserId} IS NOT NULL AND ${t.createdByAgentId} IS NULL)
      OR (${t.createdByUserId} IS NULL AND ${t.createdByAgentId} IS NOT NULL)`,
  ),
  check("oauth_client_share_links_active_has_target", sql`${t.revokedAt} IS NOT NULL OR ${t.targetServerSlug} IS NOT NULL`),
]);

// OAuth access requests — pending/approved/denied login attempts by a client.
// Agent requests are headless service grants; human requests are browser
// authorization codes scoped to one server context.
export const oauthAccessRequests = pgTable("oauth_access_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // NULL only for an account-mode human login (RFC 079 phase 3a): the CHECK
  // below and the oauth_login_row_mode_guard trigger hold the shape.
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["agent", "human"] }).notNull().default("agent"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  scopes: json("scopes").$type<string[]>().notNull(),
  resource: text("resource"),
  status: text("status", { enum: ["pending", "approved", "denied"] }).notNull().default("pending"),
  remember: boolean("remember").notNull().default(false),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  // The public approval request ID requires a separately held verifier for v1.
  agentHandoffChallenge: text("agent_handoff_challenge"),
  // A person's code (POST /authorize/human or /authorize/account): the web
  // session family that issued it. The code is exchanged only while that
  // sign-in is live, and a revoke of the family denies it
  // (sessionService.isApprovingSessionLive / denyLoginCodesApprovedBy). NULL
  // on agent requests and on codes issued before this column; a person's
  // code with NULL is refused. SET NULL like the other family pointers.
  approverSessionFamilyId: uuid("approver_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_access_requests_server_status").on(t.serverId, t.status),
  index("idx_oauth_access_requests_agent").on(t.agentId),
  uniqueIndex("idx_oauth_access_requests_agent_handoff_challenge").on(t.agentId, t.clientId, t.agentHandoffChallenge).where(sql`agent_handoff_challenge IS NOT NULL`),
  index("idx_oauth_access_requests_user").on(t.userId),
  index("idx_oauth_access_requests_client").on(t.clientId),
  // The ON DELETE SET NULL when a family goes (with its user).
  index("idx_oauth_access_requests_approver_session_family").on(t.approverSessionFamilyId).where(sql`approver_session_family_id is not null`),
  check(
    "oauth_access_requests_server_id_human_only",
    sql`${t.serverId} IS NOT NULL OR (${t.principalType} = 'human' AND ${t.userId} IS NOT NULL AND ${t.agentId} IS NULL)`,
  ),
]);

// OAuth grants — standing approvals for a client to obtain agent login on a scope set
export const oauthGrants = pgTable("oauth_grants", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  scopes: json("scopes").$type<string[]>().notNull(),
  resource: text("resource"),
  grantedByUserId: uuid("granted_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // How the grant came about: a person approved or granted it, the agent's own
  // login, the app's request auto-granted, or the legacy reminder import (the
  // agent's reminders moved to the Reminder App). Null on grants made before
  // this was recorded.
  grantSource: text("grant_source", { enum: ["person", "agent_login", "app_request", "legacy_import"] }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_grants_server_agent").on(t.serverId, t.agentId),
  index("idx_oauth_grants_client").on(t.clientId),
]);

// A person revoked this app's grant for this agent: the app no longer gets an
// automatic grant for the pair (requests come back pending). Cleared when a
// person grants again (approval or the on-behalf grant). Uninstall and app
// deletion revoke grants without writing here.
export const oauthAgentAutoGrantBlocks = pgTable("oauth_agent_auto_grant_blocks", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  blockedByUserId: uuid("blocked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes a never-shared app this key names (migration
  // closed_server_purge_app_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_agent_auto_grant_blocks_client").on(t.clientId),
  primaryKey({ columns: [t.agentId, t.clientId] }),
]);

// Integration audit events — append-only security/product audit trail for
// third-party app, OAuth, and integration action-card mutations, and the
// server-wide audit of high-impact server actions (profile, membership, agent
// credentials, computers). event_category is plain text: no DB CHECK.
export const integrationAuditEvents = pgTable("integration_audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => oauthClients.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  eventCategory: text("event_category", { enum: ["registration", "scope", "install", "runtime", "revocation", "server_profile", "membership", "agent_credential", "computer", "account_security", "sso"] }).notNull(),
  outcome: text("outcome", { enum: ["success", "failure"] }).notNull(),
  source: text("source", { enum: ["web", "api", "cli", "action_card", "system"] }).notNull(),
  actorType: text("actor_type", { enum: ["human", "agent", "system"] }).notNull(),
  actorId: uuid("actor_id"),
  requesterType: text("requester_type", { enum: ["human", "agent", "app", "system"] }),
  requesterId: uuid("requester_id"),
  subjectType: text("subject_type", { enum: ["human", "agent", "app", "system"] }),
  subjectId: uuid("subject_id"),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  correlationId: text("correlation_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  diff: jsonb("diff").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_integration_audit_server_time").on(t.serverId, t.createdAt),
  index("idx_integration_audit_client_time").on(t.clientId, t.createdAt),
  index("idx_integration_audit_event_time").on(t.eventType, t.createdAt),
  index("idx_integration_audit_outcome_time").on(t.outcome, t.createdAt),
  index("idx_integration_audit_actor_time").on(t.actorType, t.actorId, t.createdAt),
]);

// OAuth access tokens — opaque bearer tokens issued after request approval
export const oauthAccessTokens = pgTable("oauth_access_tokens", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // NULL only for an account-mode human token (RFC 079 phase 3a), which lives
  // at most an hour: the CHECKs below and oauth_login_row_mode_guard.
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["agent", "human"] }).notNull().default("agent"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").references(() => oauthAccessRequests.id, { onDelete: "set null" }),
  // The web session family that approved the grant (copied from the code), so
  // "require SSO" can check at every App call how that sign-in was made
  // (rfcs/083-server-sso.md §6.2). A plain id, no foreign key: a family that
  // is gone reads as "not signed in by SSO". Null for tokens from before.
  issuedBySessionFamilyId: uuid("issued_by_session_family_id"),
  grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull(),
  scopes: json("scopes").$type<string[]>().notNull(),
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes a never-shared app this key names (migration
  // closed_server_purge_app_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_access_tokens_client").on(t.clientId),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_access_tokens_grant").on(t.grantId).where(sql`grant_id IS NOT NULL`),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_access_tokens_request").on(t.requestId).where(sql`request_id IS NOT NULL`),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_access_tokens_server").on(t.serverId).where(sql`server_id IS NOT NULL`),
  uniqueIndex("idx_oauth_access_tokens_hash").on(t.tokenHash),
  index("idx_oauth_access_tokens_agent").on(t.agentId),
  index("idx_oauth_access_tokens_user").on(t.userId),
  index("idx_oauth_access_tokens_expires").on(t.expiresAt),
  check(
    "oauth_access_tokens_server_id_human_only",
    sql`${t.serverId} IS NOT NULL OR (${t.principalType} = 'human' AND ${t.userId} IS NOT NULL AND ${t.agentId} IS NULL)`,
  ),
  check("oauth_access_tokens_account_ttl", sql`${t.serverId} IS NOT NULL OR ${t.expiresAt} <= ${t.createdAt} + interval '1 hour'`),
]);

// A person's standing Login with Raft consent to an App on a Server. Human
// access tokens live an hour with no refresh token; this row outlives them.
// Each human token exchange upserts it in the same commit (a fresh login
// re-consents); the paths that revoke the person's tokens for the App revoke
// it in the same commit. App link previews gate on it, not on a live token.
export const oauthUserConsents = pgTable("oauth_user_consents", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // NULL: the person's account-mode consent to the App (RFC 079 phase 3a),
  // one per (user, App); only an account-mode App may hold one
  // (oauth_login_row_mode_guard).
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  // The union of the scopes granted while the consent stays active (each login
  // and a link-preview prompt add theirs). Only revocation clears it: an
  // inactive consent granted again starts from the new grant's scopes.
  scopes: json("scopes").$type<string[]>().notNull(),
  // How the active consent was first granted: a Login with Raft, or the
  // first-view link-preview prompt. A later grant keeps it; one after a
  // revocation sets it afresh.
  source: text("source", { enum: ["login", "preview_prompt"] }).notNull().default("login"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_user_consents_server").on(t.serverId).where(sql`server_id IS NOT NULL`),
  // Serves the link-preview lookup (viewer, Server, App) and member departure.
  uniqueIndex("idx_oauth_user_consents_user_server_client").on(t.userId, t.serverId, t.clientId),
  // The account-mode consent's upsert target and the per-App revoke list: the
  // index above treats NULL server_ids as distinct, so it cannot keep these
  // to one row.
  uniqueIndex("idx_oauth_user_consents_user_client_account").on(t.userId, t.clientId).where(sql`${t.serverId} IS NULL`),
  // Uninstall and offline review revoke by App and Server.
  index("idx_oauth_user_consents_client_server").on(t.clientId, t.serverId),
  check("oauth_user_consents_source_check", sql`${t.source} IN ('login', 'preview_prompt')`),
]);

// A person answered an App's first-view link-preview prompt with "no" on one
// Server: the prompt stays hidden for that (person, Server, App) until they
// allow it or log in to the App with Raft. Removed with the installation
// (uninstall, marketplace removal) and with the person's membership.
export const oauthLinkPreviewDeclines = pgTable("oauth_link_preview_declines", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  declinedAt: timestamp("declined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_oauth_link_preview_declines_server").on(t.serverId),
  // Serves the prompt lookup (viewer, Server, App) and member departure.
  uniqueIndex("idx_oauth_link_preview_declines_user_server_client").on(t.userId, t.serverId, t.clientId),
  // Uninstall and offline review remove by App and Server.
  index("idx_oauth_link_preview_declines_client_server").on(t.clientId, t.serverId),
]);

/**
 * A Raft system app's key (third_party_agent_events.system_app): core's own
 * (CORE_SYSTEM_APPS) or a first-party app's `system.<id>` (apps/firstPartyApps.ts).
 */
export type SystemAppKey = `system.${string}`;
/**
 * Core's own system apps; first-party apps add theirs through the app
 * registry. Which of them are inbox items is inboxItemsLaunch.ts
 * NOT_ITEM_SYSTEM_APPS (RaftBench is not; the assistant is).
 */
export const CORE_SYSTEM_APPS = ["system.assistant", "system.raftbench", "system.feedback"] as const satisfies readonly SystemAppKey[];
export const thirdPartyAgentEvents = pgTable("third_party_agent_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // Exactly one of clientId / systemApp is set (check constraint). OAuth-client
  // paths always filter by client_id, so a system row (client_id NULL) is
  // invisible to every client.
  clientId: uuid("client_id").references(() => oauthClients.id, { onDelete: "cascade" }),
  // A Raft system app's event: core's own ("system.assistant", RFC 074 §2
  // assistant doorbell; "system.raftbench"; "system.feedback", the product
  // feedback triage notice) or a first-party app's
  // ("system.<id>", apps/firstPartyApps.ts). No CHECK lists the values.
  systemApp: text("system_app").$type<SystemAppKey>(),
  accessTokenId: uuid("access_token_id").references(() => oauthAccessTokens.id, { onDelete: "set null" }),
  externalEventId: text("external_event_id"),
  kind: text("kind", { enum: ["event", "notification", "action_request"] }).notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  payloadHash: text("payload_hash").notNull(),
  resource: text("resource").notNull(),
  status: text("status", { enum: ["queued", "delivering", "delivered", "expired", "rejected"] }).notNull().default("queued"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * RFC 081 §4: what the notice is about (`object.ref`), the key its inbox
   * item groups by: `app:<key>/<object_ref>`; NULL goes into the app's
   * fallback item `app:<key>`. Rows from before the column stay NULL.
   */
  objectRef: text("object_ref"),
  /**
   * RFC 081 D8: the conversation the notice names, resolved for the
   * receiving agent when it came in. No foreign key (a hot core table; the
   * id may dangle once the conversation is gone): every listing checks the
   * agent can still open it, and drops it otherwise.
   */
  relatedChannelId: uuid("related_channel_id"),
  /**
   * How a delivered event was consumed, where an RFC 081 path set it:
   * `read` (inbox read, message read of agent-event:<id>) or `dismissed`
   * (inbox dismiss: never shown, so the Activity overview does not count it
   * as delivered). NULL for every other delivery (/events, the daemon).
   */
  consumedVia: text("consumed_via", { enum: ["read", "dismissed"] }),
  /**
   * Set when the event came in while its inbox item already had unread
   * events (#wg-ax:#24, RFC 081 D7 "one item, one read state"): the item
   * already woke the agent, so this one is only added to it. It stays
   * readable like any other; no delivery path pushes it as a wake, then or
   * on a re-delivery (selectPendingThirdPartyAgentEvents leaves it out).
   */
  wakeCoalescedAt: timestamp("wake_coalesced_at", { withTimezone: true }),
}, (t) => [
  index("idx_third_party_agent_events_agent_status").on(t.agentId, t.status),
  // RFC 081 inbox items: one agent's unconsumed events by app and object, oldest first.
  index("idx_third_party_agent_events_agent_unconsumed_item")
    .on(t.agentId, t.clientId, t.systemApp, t.objectRef, t.createdAt)
    .where(sql`status in ('queued', 'delivering')`),
  check("third_party_agent_events_consumed_via_known", sql`${t.consumedVia} is null or ${t.consumedVia} in ('read', 'dismissed')`),
  index("idx_third_party_agent_events_client").on(t.clientId),
  uniqueIndex("idx_third_party_agent_events_dedupe").on(t.clientId, t.agentId, t.externalEventId),
  // Agent panel list: one agent's events newest first (keyset on created_at, id).
  index("idx_third_party_agent_events_agent_created").on(t.agentId, t.createdAt.desc(), t.id.desc()),
  // Retention sweep: events are deleted 30 days after they expire.
  index("idx_third_party_agent_events_expires").on(t.expiresAt),
  // ON DELETE SET NULL from oauth_access_tokens.
  index("idx_third_party_agent_events_access_token").on(t.accessTokenId).where(sql`access_token_id is not null`),
  check("third_party_agent_events_one_source", sql`num_nonnulls(${t.clientId}, ${t.systemApp}) = 1`),
]);

// What happened to an object that is not a message (technical design §7,
// Activity; first-party app mechanism §三): one row per event, written in the
// same transaction as the change (services/objectEvents.ts,
// recordObjectEvent). Generic: an app names its objects by kind and its own
// id; which kinds and event kinds exist is the app registry's
// (apps/firstPartyApps.ts), checked by recordObjectEvent, so no CHECK lists them.
// `home` is where the object lives after the change (home_kind, and the
// conversation for a conversation home), so whoever reads these (Activity,
// S6) checks visibility by the home without asking the app. Rows written
// before homes were recorded have none (preview data only). A home
// conversation's hard delete leaves home_channel_id NULL: an orphan, as the
// platform's visibility treats it. `seq` orders events for consumers
// (bigserial: assigned at insert, so a consumer reading by seq must allow for
// transactions committing out of order). Kept 90 days
// (services/objectEventRetention.ts, hourly maintenance).
export const OBJECT_EVENT_HOME_KINDS = ["conversation", "server", "public"] as const;
/** Small facts about the event (ids, positions, numbers); at most 4 KiB stored. */
export type ObjectEventData = Readonly<Record<string, string | number | boolean | null>>;
export const objectEvents = pgTable("object_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  objectKind: text("object_kind").notNull(),
  objectId: text("object_id").notNull(),
  eventKind: text("event_kind").notNull(),
  homeKind: text("home_kind", { enum: OBJECT_EVENT_HOME_KINDS }),
  homeChannelId: uuid("home_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
  actorType: text("actor_type", { enum: ["user", "agent"] }).notNull(),
  actorId: uuid("actor_id").notNull(),
  data: jsonb("data").$type<ObjectEventData>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_object_events_seq").on(t.seq),
  index("idx_object_events_object_seq").on(t.objectKind, t.objectId, t.seq),
  index("idx_object_events_server_seq").on(t.serverId, t.seq),
  // The retention sweep deletes by age.
  index("idx_object_events_created").on(t.createdAt),
  // A home conversation's delete sets these NULL.
  index("idx_object_events_home_channel").on(t.homeChannelId),
  check("object_events_home_kind", sql`${t.homeKind} IS NULL OR ${t.homeKind} IN ('conversation', 'server', 'public')`),
  check("object_events_home_channel", sql`${t.homeChannelId} IS NULL OR ${t.homeKind} = 'conversation'`),
  check("object_events_actor_type", sql`${t.actorType} IN ('user', 'agent')`),
  check("object_events_data_small", sql`pg_column_size(${t.data}) <= 4096`),
]);

// Who an object event is for (first-party app mechanism §三): one row per
// person or agent, with why. The app computes the list (it knows who is
// mentioned and who follows), the platform owns the table, written by
// recordObjectEvent in the event's transaction. Visibility is not stored
// here: a reader checks the event's home when it reads (Activity, S6). Goes
// with its event (retention).
export const OBJECT_EVENT_RECIPIENT_REASONS = ["mentioned", "following", "owner"] as const;
export type ObjectEventRecipientReason = (typeof OBJECT_EVENT_RECIPIENT_REASONS)[number];
export const objectEventRecipients = pgTable("object_event_recipients", {
  eventId: uuid("event_id").notNull().references(() => objectEvents.id, { onDelete: "cascade" }),
  recipientType: text("recipient_type", { enum: ["user", "agent"] }).notNull(),
  recipientId: uuid("recipient_id").notNull(),
  reason: text("reason", { enum: OBJECT_EVENT_RECIPIENT_REASONS }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.recipientType, t.recipientId] }),
  // A recipient's events (Activity reads by recipient).
  index("idx_object_event_recipients_recipient").on(t.recipientType, t.recipientId),
  check("object_event_recipients_type", sql`${t.recipientType} IN ('user', 'agent')`),
  check("object_event_recipients_reason", sql`${t.reason} IN ('mentioned', 'following', 'owner')`),
]);

// A person's Activity row for an object (S6, services/objectActivity.ts): one
// row per (person, object kind, object id), written by recordObjectEvent in
// the event's transaction for each person among its recipients (agents get
// none), so Activity and the badge read one index range of this table rather
// than aggregating events, and never ask the app. It holds:
// - the newest event that reached the person (`last_event_*`: the row's time
//   and its Done frontier) and the newest one that mentioned them;
// - Done (`done_through_seq`: hidden while no event is newer);
// - how far the person has read (`read_through_seq`, an event seq): the app
//   reports it when the person's read position moves, in that transaction
//   (platform/activity markObjectRead), so unread is `last_event_seq` past
//   both frontiers;
// - the object's home after its newest event of any kind (every event
//   updates it on every row of the object), for the platform's visibility
//   condition (visibleHomesSql) in the same statement; a hard-deleted home
//   conversation leaves home_channel_id NULL: an orphan, never listed.
// Goes with its events: the retention sweep deletes a row whose newest event
// is past retention (services/objectEventRetention.ts).
export const objectInboxStates = pgTable("object_inbox_states", {
  userId: uuid("user_id").notNull(),
  objectKind: text("object_kind").notNull(),
  objectId: text("object_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  homeKind: text("home_kind", { enum: OBJECT_EVENT_HOME_KINDS }).notNull(),
  homeChannelId: uuid("home_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
  lastEventId: uuid("last_event_id").notNull(),
  lastEventSeq: bigint("last_event_seq", { mode: "number" }).notNull(),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
  /** The newest event that mentioned the person; null when none did. */
  lastMentionSeq: bigint("last_mention_seq", { mode: "number" }),
  /** Read through this event seq (the app's read position, reported back); null when never read. */
  readThroughSeq: bigint("read_through_seq", { mode: "number" }),
  /** Done through this event seq (hidden while last_event_seq is not newer); null when not Done. */
  doneThroughSeq: bigint("done_through_seq", { mode: "number" }),
  doneAt: timestamp("done_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.objectKind, t.objectId] }),
  // Activity and the badge: one person's rows in some servers, newest first.
  index("idx_object_inbox_states_user_server_at").on(t.userId, t.serverId, t.lastEventAt.desc()),
  // Every event updates its object's home on all of the object's rows.
  index("idx_object_inbox_states_object").on(t.objectKind, t.objectId),
  // The retention sweep deletes by age.
  index("idx_object_inbox_states_last_event_at").on(t.lastEventAt),
  // A home conversation's delete sets these NULL.
  index("idx_object_inbox_states_home_channel").on(t.homeChannelId),
  // A server's delete cascades to its rows (server_id's foreign key).
  index("idx_object_inbox_states_server").on(t.serverId),
  check("object_inbox_states_home_kind", sql`${t.homeKind} IN ('conversation', 'server', 'public')`),
  check("object_inbox_states_home_channel", sql`${t.homeChannelId} IS NULL OR ${t.homeKind} = 'conversation'`),
]);

// The files of first-party objects (docs/development/first-party-apps.md,
// "Object files"; services/objectFiles.ts, which apps reach through
// platform/objectFiles): bytes and the type core detected in them, kept for
// an object of a registered kind (`object_kind`, `object_id`, as
// object_events names it) and hung on one of the app's parts (`parent`, the
// app's own opaque reference, such as `version:<id>`). Generic: which kinds
// exist is the registry's, so no CHECK lists them. `server_id` is the
// object's own server (the one the kind's homes report, whoever uploaded).
// `billed_server_id` is the server the bytes count against (its total, its
// uploaders' caps and its monthly file upload quota): the uploader's own
// server for what people and agents upload (a joint channel's member of
// another server pays on their own server), the object's server for what the
// platform makes. Fixed at upload, never changed. Null on rows from before
// it (and on rows an older build writes during a rolling deploy): read as
// `server_id`, so every read is coalesce(billed_server_id, server_id).
// - `unclaimed`: uploaded as a draft (no parent yet), readable only by its
//   uploader; claimObjectFile hangs it on a part (`claimed`); the hourly sweep
//   deletes one left unclaimed for an hour.
// - `deleted`: let go in the app's transaction (its part or its object
//   went); the row stays, invisible to every read, until its bytes are
//   deleted after the commit (or by the sweep, when that failed), so no row
//   ever names bytes that are gone and no bytes outlive every record of them.
// The bytes are at `storage_key` (relative to core's `objects/` prefix of the
// platform's app-content bucket; per row, so bytes are only ever written and
// deleted for their own row). A server's hard delete cascades the rows but
// cannot reach their bytes (servers are only ever soft-deleted; the sweep
// deletes a soft-deleted server's files).
export const OBJECT_FILE_STATES = ["unclaimed", "claimed", "deleted"] as const;
export type ObjectFileState = (typeof OBJECT_FILE_STATES)[number];
/** The types core stores (detected from the bytes, never the uploader's word): raster images a browser draws without running anything. */
export const OBJECT_FILE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ObjectFileContentType = (typeof OBJECT_FILE_CONTENT_TYPES)[number];
/** How putObjectFile counts a file (objectFiles.quota). */
export const OBJECT_FILE_QUOTAS = ["monthly", "exempt"] as const;
export type ObjectFileQuota = (typeof OBJECT_FILE_QUOTAS)[number];
export const objectFiles = pgTable("object_files", {
  /** Assigned before the bytes are written (the key names it). */
  id: uuid("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  objectKind: text("object_kind").notNull(),
  objectId: text("object_id").notNull(),
  /** The app's part the file hangs on (`<part>:<id>`); null while unclaimed (a deleted row keeps what it had). */
  parent: text("parent"),
  state: text("state", { enum: OBJECT_FILE_STATES }).notNull(),
  uploadedByType: text("uploaded_by_type", { enum: ["user", "agent"] }).notNull(),
  uploadedById: uuid("uploaded_by_id").notNull(),
  contentType: text("content_type", { enum: OBJECT_FILE_CONTENT_TYPES }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** Its pixel size, read from the image's header when stored (null: stored before core read it). */
  width: integer("width"),
  height: integer("height"),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** When it was let go; set exactly when `deleted`. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * The server the bytes count against (no foreign key: adding one would lock
   * `servers`; a server is only ever soft-deleted). Null: `server_id` (rows
   * from before the column, or written by an older build).
   */
  billedServerId: uuid("billed_server_id"),
  /**
   * How putObjectFile counted it: `monthly` (what people and agents upload:
   * the billed server's total, its uploader caps and its monthly quota) or
   * `exempt` (what the platform makes: a publish check's screenshots, under
   * none of them). Null on rows from before: counted as an upload.
   */
  quota: text("quota", { enum: OBJECT_FILE_QUOTAS }),
  /**
   * The UTC month (`YYYY-MM`) whose monthly file upload quota of the billed
   * server counted these bytes; null when none did (exempt, a server without
   * a limit, rows from before). The sweep gives an unclaimed upload's bytes
   * back to that month when it lets go of it within it.
   */
  quotaMonth: text("quota_month"),
}, (t) => [
  // An object's files, and a part's (every read and delete names the object; this serves both).
  index("idx_object_files_object_parent").on(t.objectKind, t.objectId, t.parent),
  // What a server is billed for, and each uploader's share of it (putObjectFile's caps).
  index("idx_object_files_billed_uploader").on(t.billedServerId, t.uploadedByType, t.uploadedById),
  // The sweep: unclaimed files by age, and deleted rows whose bytes are still to go.
  index("idx_object_files_unclaimed_created").on(t.createdAt).where(sql`${t.state} = 'unclaimed'`),
  index("idx_object_files_deleted").on(t.deletedAt).where(sql`${t.state} = 'deleted'`),
  // A server's total (the per-server cap), and its delete's cascade.
  index("idx_object_files_server").on(t.serverId),
  check("object_files_state", sql`${t.state} IN ('unclaimed', 'claimed', 'deleted')`),
  check("object_files_parent", sql`${t.state} = 'deleted' OR (${t.parent} IS NULL) = (${t.state} = 'unclaimed')`),
  check("object_files_deleted_at", sql`(${t.deletedAt} IS NULL) = (${t.state} <> 'deleted')`),
  check("object_files_uploaded_by_type", sql`${t.uploadedByType} IN ('user', 'agent')`),
  check("object_files_quota", sql`${t.quota} IS NULL OR ${t.quota} IN ('monthly', 'exempt')`),
  check("object_files_content_type", sql`${t.contentType} IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`),
  check("object_files_size", sql`${t.sizeBytes} > 0`),
  check("object_files_dimensions", sql`(${t.width} IS NULL) = (${t.height} IS NULL) AND (${t.width} IS NULL OR (${t.width} > 0 AND ${t.height} > 0))`),
]);

// RFC 074 §2 assistant doorbell: at most one pending "owner inbox changed" per
// assistant. Written with INSERT ... ON CONFLICT DO NOTHING inside the
// transaction that records the owner's inbox fact (no lock on an existing
// row); a worker turns it into a `system.assistant` event in
// third_party_agent_events and deletes it, at most once per 30 s per assistant.
export const assistantDoorbells = pgTable("assistant_doorbells", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull(),
  firstChangeAt: timestamp("first_change_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * RFC 077 step 2: when a poll first found this doorbell's owner-inbox read
   * behind its sources as they are now (`behindSources`). Lives and dies with
   * the doorbell, so a wait never inherits an earlier doorbell's start (or
   * another replica's memory of one); a new message (a source's seq grew)
   * starts the wait again.
   */
  behindSince: timestamp("behind_since", { withTimezone: true }),
  /** The awaited sources (`channel:seq`, sorted) the current wait started on. */
  behindSources: text("behind_sources"),
  /** When this doorbell was first found behind at all: the restarts above never wait past ASSISTANT_CHECK_LAG_MAX_WAIT_MS from here. */
  behindFirstSince: timestamp("behind_first_since", { withTimezone: true }),
});

// The conversations behind a pending doorbell, each with the highest message seq that
// rang it, so the assistant can tell when its owner-inbox read has caught up (by seq,
// not by clock). One row per conversation; sent and cleared with the doorbell.
export const assistantDoorbellSources = pgTable("assistant_doorbell_sources", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull(),
  maxSeq: bigint("max_seq", { mode: "number" }).notNull(),
  /** RFC 077: this conversation rang (also) because of the owner's own action (a send, reply, reaction or task change). */
  ownerAction: boolean("owner_action").notNull().default(false),
}, (table) => [primaryKey({ columns: [table.agentId, table.sourceChannelId] })]);

// When a person or an agent last posted in a channel (a thread reply counts for
// its parent channel too); system messages and app events do not count. Kept
// by the `messages_channel_last_post` trigger, at most once a minute per
// channel, and backfilled once (scripts/backfill-channel-last-posts.ts). Its
// own table, so posting never rewrites the channels row (which RisingWave
// replicates). Read by the channel list (`lastPostAt`): "last post ... / no posts yet";
// a joint projection reads the later of its canonical channel's row (its posts
// are stored there) and its own (posts from before it was converted).
export const channelLastPosts = pgTable("channel_last_posts", {
  channelId: uuid("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }).notNull(),
});

// One row once scripts/backfill-channel-last-posts.ts has completed with --apply.
// Until then channel_last_posts misses older posts, so the channel list leaves
// `lastPostAt` out instead of reading a channel's absence as "no posts yet".
export const channelLastPostsBackfill = pgTable("channel_last_posts_backfill", {
  id: integer("id").primaryKey().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("channel_last_posts_backfill_single_row", sql`${t.id} = 1`)]);

// RFC 077 step 1 (Tenny's boundary design): a personal assistant's contact rules,
// kept by Raft. One effect (mute / always / digest) on one subject: a channel, a
// thread, a person (by id), a kind of item, all DMs, or an imported multi-condition
// `legacy` rule (names in `legacy`, never created by Raft). Adding the same effect
// on the same subject updates the row. Deleted with the assistant.
export const assistantContactRules = pgTable("assistant_contact_rules", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull(),
  effect: text("effect", { enum: ["mute", "always", "digest"] }).notNull(),
  subjectKind: text("subject_kind", { enum: ["channel", "thread", "person", "kind", "dms", "legacy"] }).notNull(),
  /** Channel or thread channel id, person id, or kind name; null for dms and legacy. */
  subjectId: text("subject_id"),
  /** Person subjects: human or agent. */
  subjectType: text("subject_type", { enum: ["human", "agent"] }),
  /** Legacy subjects only: `{ channel, sender, itemKind }` by name, as imported. */
  legacy: jsonb("legacy").$type<{ channel: string | null; sender: string | null; itemKind: string | null }>(),
  /** `always` only: also during quiet hours. */
  anytime: boolean("anytime").notNull().default(false),
  until: timestamp("until", { withTimezone: true }),
  note: text("note"),
  /** The runtime's id for an imported rule (e.g. `r2`): the import's idempotency key. */
  sourceId: text("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_assistant_contact_rules_source").on(t.agentId, t.sourceId),
  unique("uq_assistant_contact_rules_subject").on(t.agentId, t.effect, t.subjectKind, t.subjectId).nullsNotDistinct(),
]);

// RFC 077 step 2: one row per personal assistant whose checks Raft runs: the
// brief schedule, claimed by `next_brief_at` so one instance briefs once.
export const assistantCheckState = pgTable("assistant_check_state", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  nextBriefAt: timestamp("next_brief_at", { withTimezone: true }),
  /** The owner-local day (YYYY-MM-DD) whose brief went out (or was judged empty). */
  briefSentDay: text("brief_sent_day"),
  /** Whether a brief has asked the owner for their time zone (once, while none is known). */
  askedTimezone: boolean("asked_timezone").notNull().default(false),
  /**
   * Unused: the summary timer is gone (summaries are the assistant's own
   * repeating reminder). Kept until every server runs code that no longer
   * reads it; a later migration drops it with its index.
   */
  nextDigestAt: timestamp("next_digest_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_assistant_check_state_next_brief").on(t.nextBriefAt),
  index("idx_assistant_check_state_next_digest").on(t.nextDigestAt),
]);

// Each check Raft woke an assistant for: the items it was given (conversation,
// why, the first unread message and the latest seq), which notify maps the
// model's summaries back to. Kept 48 h, the last few per assistant.
export const assistantChecks = pgTable("assistant_checks", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  trigger: text("trigger", { enum: ["doorbell", "brief"] }).notNull(),
  /** The owner-local day of a brief check; null for a doorbell's. */
  briefDay: text("brief_day"),
  items: jsonb("items").$type<Array<Record<string, unknown>>>().notNull(),
  /** The check's notify result once it was answered: a check sends at most one DM, and any retry gets this. */
  notifyResult: jsonb("notify_result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("idx_assistant_checks_agent_created").on(t.agentId, t.createdAt)]);

// A personal assistant's contact settings. No row: quiet hours are the default
// (22:00-08:00 owner-local); `quiet` null: the owner turned them off.
export const assistantContactSettings = pgTable("assistant_contact_settings", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  quiet: jsonb("quiet").$type<{ from: string; to: string } | null>(),
  /** A zone the owner told the assistant, used only while Raft knows none for them. */
  statedTimezone: text("stated_timezone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// What a personal assistant already told its owner about (a message id), so it is
// not told twice. Swept after 30 days. Deleted with the assistant.
export const assistantTold = pgTable("assistant_told", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull(),
  /**
   * RFC 077 step 2: how the owner came to know. `skipped` is not a telling: the
   * model judged a conversation that only names the owner as not needing them,
   * so it is not offered again until it moves. `held` is not a telling either:
   * a doorbell DM counted it in its "N more" line, so later doorbells do not
   * offer it again until it moves; the brief and "more" still list it.
   */
  via: text("via", { enum: ["notify", "chat", "skipped", "held"] }).notNull(),
  /** The conversation (a thread's own id) and the seq the telling covers: later activity there brings it back. */
  channelId: uuid("channel_id"),
  seq: bigint("seq", { mode: "number" }),
  toldAt: timestamp("told_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.messageId] }),
  index("idx_assistant_told_told_at").on(t.toldAt),
  index("idx_assistant_told_agent_told_at").on(t.agentId, t.toldAt),
  index("idx_assistant_told_agent_channel").on(t.agentId, t.channelId),
]);

// WeChat bridge (design "微信接入 Ottie" v8, behind `assistant_wechat_v0`): a
// person's WeChat ClawBot (Tencent iLink bot API) mirrored into their DM with
// their own Ottie. services/wechatBridgeService.ts writes the bindings and
// attempts; the poll and mirror worker (services/wechatBridgeWorker.ts) the
// inbound tags, the outbound records and the binding's cursors.
//
// One binding per person per server; one binding per WeChat account
// (ilink_user_id) anywhere. Deleted (never soft-deleted) on disconnect, account
// deletion, the owner leaving the server, the assistant being archived, the
// server being deleted or a reconnect replacing it; each time its inbound tags
// lose their context tokens. The bot token is stored only as an AES-256-GCM envelope
// (wechatBridgeCredentialCipher, AAD bound to id/user/bot) and never leaves
// the server. The cursor, lease, outbound and notice columns belong to the
// poll and mirror worker (wechatBridgeWorker.ts): one replica polls a binding
// at a time (the lease), and every cursor it moves is fenced by
// (lease_owner, lease_generation).
export const wechatBridgeBindings = pgTable("wechat_bridge_bindings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The owner's Ottie when the binding was made. */
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  /** The owner's DM with that Ottie: the only conversation the bridge mirrors. */
  dmChannelId: uuid("dm_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  ilinkBotId: text("ilink_bot_id").$type<ILinkBotId>().notNull(),
  /** Who scanned the QR code: the only WeChat sender the bridge accepts. */
  ilinkUserId: text("ilink_user_id").$type<ILinkUserId>().notNull(),
  /** Normalized https origin on the iLink host allowlist (wechatILinkClient). */
  baseUrl: text("base_url").notNull(),
  encryptedBotToken: text("encrypted_bot_token").notNull(),
  envelopeKeyId: text("envelope_key_id").notNull(),
  aadVersion: integer("aad_version").notNull(),
  /** `reconnect_required`: iLink answered -14 (stale token); only a new QR binding repairs it. */
  state: text("state", { enum: ["active", "reconnect_required"] }).notNull().default("active"),
  getUpdatesBuf: text("get_updates_buf"),
  leaseOwner: text("lease_owner"),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  /** The DM seq the outbound mirror has read up to; at bind time, the connected notice's. */
  outboundSeq: bigint("outbound_seq", { mode: "number" }).notNull().default(0),
  /**
   * The outbound mirror's previous read horizon (an xid8 as decimal text,
   * syncHorizon.ts): messages at or below outbound_seq whose transaction
   * committed after that read are found from it, so none is skipped.
   */
  outboundHorizon: text("outbound_horizon").$type<SyncHorizon>(),
  /** When the first-inbound greeting ("已连接到 X 的 Ottie。") was claimed: at most once per binding. */
  greetedAt: timestamp("greeted_at", { withTimezone: true }),
  /** The assistant's top-level DM messages not mirrored since the last "还有 N 条" note (or the binding). */
  unmirroredCount: integer("unmirrored_count").notNull().default(0),
  /** When the last mirrored reply went out: it ends the current inbound batch. */
  lastMirroredAt: timestamp("last_mirrored_at", { withTimezone: true }),
  /** When the last no-reply notice was claimed: it ends the current inbound batch too. */
  noReplyNoticeAt: timestamp("no_reply_notice_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_wechat_bridge_bindings_server_user").on(t.serverId, t.userId),
  uniqueIndex("idx_wechat_bridge_bindings_ilink_user").on(t.ilinkUserId),
  // The foreign keys' delete actions (a user, an agent, a channel) look rows up by these.
  index("idx_wechat_bridge_bindings_user").on(t.userId),
  index("idx_wechat_bridge_bindings_agent").on(t.agentId),
  index("idx_wechat_bridge_bindings_dm_channel").on(t.dmChannelId),
  check("wechat_bridge_bindings_state_valid", sql`${t.state} IN ('active', 'reconnect_required')`),
]);

// A QR binding in progress: started by POST .../assistant/wechat/attempts,
// finished (once) by the browser that started it (the cookie holding the state
// whose SHA-256 is state_hash). At most one pending attempt per person per
// server; a few minutes long. `qrcode` is iLink's polling handle for the QR
// code: whoever holds it can poll iLink for the bot token until the code is
// confirmed (and the QR content shown to the person likely embeds it), so it
// is cleared as soon as the attempt ends. A confirmed attempt's bot token goes
// straight into the binding, encrypted. poll_in_flight_until: one status poll
// at a time per attempt (a short lease; past it, the next poll may run).
export const wechatBridgeAttempts = pgTable("wechat_bridge_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  stateHash: text("state_hash").notNull(),
  qrcode: text("qrcode").$type<ILinkQrcodeHandle>(),
  /** Where its status is polled: the fixed start host, or an allowlisted redirect host. */
  qrBaseUrl: text("qr_base_url").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "expired", "failed"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  pollInFlightUntil: timestamp("poll_in_flight_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_wechat_bridge_attempts_pending").on(t.serverId, t.userId).where(sql`status = 'pending'`),
  index("idx_wechat_bridge_attempts_user").on(t.userId),
  check("wechat_bridge_attempts_status_valid", sql`${t.status} IN ('pending', 'confirmed', 'expired', 'failed')`),
  // Pending: not consumed and still holding its QR handle. Ended: consumed, handle gone.
  check("wechat_bridge_attempts_pending_shape", sql`(${t.status} = 'pending') = (${t.consumedAt} IS NULL AND ${t.qrcode} IS NOT NULL)`),
]);

// Every WeChat message the bridge writes into the owner's DM, recorded BEFORE
// the message is posted (the tag-first contract, wechatTurn.ts):
// the bridge inserts this row with its own random_id (`wechat:<uuid>`), then
// posts the message as the owner with that randomId (idempotent per sender),
// then fills message_id. Only the bridge writes it, so neither the owner nor
// the assistant can add or remove the "came from WeChat" tag. The row outlives
// its binding (binding_id SET NULL) so a turn it triggered stays a WeChat turn.
// (binding_id, wechat_message_key) dedupes iLink's redeliveries. context_token
// is what a reply to this message must carry; it never leaves the server and
// is cleared 24 hours after the message was sent and whenever its binding goes
// (disconnect, any cleanup, a reconnect replacing it).
export const wechatBridgeInboundMessages = pgTable("wechat_bridge_inbound_messages", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  bindingId: uuid("binding_id").references(() => wechatBridgeBindings.id, { onDelete: "set null" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dmChannelId: uuid("dm_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  /** iLink's message_id (else its context token's digest): the dedupe key. */
  wechatMessageKey: text("wechat_message_key").notNull(),
  /** The randomId the message is (to be) posted with, `wechat:<uuid>`. */
  randomId: text("random_id").notNull(),
  /** The posted message, filled after the post. No FK: a message delete must not pay for this table. */
  messageId: uuid("message_id"),
  contextToken: text("context_token").$type<WeChatContextToken>(),
  /** When it reached Raft: the no-reply notice's clock and batches run on this. */
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * When the owner sent it, by iLink's create_time_ms (null when iLink named
   * none or a time still to come). Only the 24-hour reply window uses it: the
   * window starts at the earlier of sent_at and received_at.
   */
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_wechat_bridge_inbound_random_id").on(t.randomId),
  uniqueIndex("idx_wechat_bridge_inbound_message_id").on(t.messageId),
  uniqueIndex("idx_wechat_bridge_inbound_binding_key").on(t.bindingId, t.wechatMessageKey),
  index("idx_wechat_bridge_inbound_owner").on(t.ownerUserId),
  index("idx_wechat_bridge_inbound_dm_channel").on(t.dmChannelId),
  // The worker's reads: a binding's recent inbound (the no-reply batch, unposted rows).
  index("idx_wechat_bridge_inbound_binding_received").on(t.bindingId, t.receivedAt),
  // The 24-hour context token sweep reads only rows still holding one.
  index("idx_wechat_bridge_inbound_live_token").on(t.receivedAt).where(sql`context_token IS NOT NULL`),
]);

// What the outbound mirror did with each of the assistant's top-level messages
// in a bound DM (wechatBridgeWorker.ts), recorded BEFORE anything is sent: a
// crash or a retry finds the row and never sends twice (`sending` stays as it
// is: maybe sent, never resent). `not_mirrored` and `failed` count toward the
// "还有 N 条在 Raft 里" note. Goes with its binding.
export const wechatBridgeOutboundMessages = pgTable("wechat_bridge_outbound_messages", {
  /** The assistant's message; also the iLink client_id it is sent with. No FK, as for the inbound tags. */
  messageId: uuid("message_id").primaryKey(),
  bindingId: uuid("binding_id").notNull().references(() => wechatBridgeBindings.id, { onDelete: "cascade" }),
  state: text("state", { enum: ["sending", "sent", "failed", "not_mirrored"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_wechat_bridge_outbound_binding").on(t.bindingId),
  index("idx_wechat_bridge_outbound_created").on(t.createdAt),
  check("wechat_bridge_outbound_messages_state_valid", sql`${t.state} IN ('sending', 'sent', 'failed', 'not_mirrored')`),
]);

// A personal assistant's current turn as the server saw it (services/wechatTurn.ts):
// the messages the server handed it since the turn began, and whether a WeChat
// message is among them (then its top-level replies in that DM are mirrored
// back to WeChat, services/wechatMirrorDecision.ts). It reads nothing less for
// it. One row per agent, written only by the server when it hands messages over
// (`/events`), never from anything the runtime reports. A hand-off after the
// agent was observed idle starts a new turn (new turn_id, the ids and the
// WeChat state replaced); any other hand-off joins the current turn: a WeChat
// message merged into it makes it a WeChat turn from then on.
// In the database, not in memory: Agent API requests reach any replica.
export const agentTurnTriggers = pgTable("agent_turn_triggers", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  /** Minted by the server when a hand-off starts a turn. */
  turnId: uuid("turn_id").notNull(),
  /** The turn's trigger message ids, oldest first, the most recent 200 kept. */
  triggerMessageIds: text("trigger_message_ids").array().notNull(),
  /**
   * Named in 0550 for the read restriction that no longer exists (kept: the
   * column is released). Now: a WeChat message is among the turn's triggers
   * (sticky until the next turn starts). Restricts no read.
   */
  wechatRestricted: boolean("wechat_restricted").notNull(),
  /**
   * Named in 0550 (kept: released). Now: while wechatRestricted, the owner DM
   * the turn's replies are mirrored from; null = none (unknown or ambiguous:
   * nothing is mirrored). No FK: a deleted DM has no replies.
   */
  wechatAllowedChannelId: uuid("wechat_allowed_channel_id"),
  turnStartedAt: timestamp("turn_started_at", { withTimezone: true }).notNull(),
  /** The latest hand-off, by the recording replica's clock; an idle observation after it lets the next hand-off start a turn. */
  lastTriggerAt: timestamp("last_trigger_at", { withTimezone: true }).notNull(),
});

// The personal assistant's messages that may be mirrored back to WeChat
// (services/wechatMirrorDecision.ts): one row per message the assistant sent,
// while its turn carried a WeChat message, into that turn's DM. Written by the
// server in the send's own transaction from the turn record as it was then,
// never afterwards; no row = never mirrored (a Raft-triggered turn, another
// conversation, a reply sent before the WeChat message reached the turn).
export const assistantWechatMirrorMarks = pgTable("assistant_wechat_mirror_marks", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  /** agent_turn_triggers.turn_id when the message was sent. */
  turnId: uuid("turn_id").notNull(),
  /** The turn's most recent WeChat trigger: wechat_bridge_inbound_messages.random_id (its context_token answers it). */
  inboundRandomId: text("inbound_random_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The agent foreign key's delete action looks rows up by it.
  index("idx_assistant_wechat_mirror_marks_agent").on(t.agentId),
]);

// Canonical source events shared by notification adapters. App webhooks are a
// delivery adapter over this substrate, not a parallel webhook event stream.
export const notificationEvents = pgTable("notification_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  requiredGroups: jsonb("required_groups").$type<string[]>().notNull().default([]),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id"),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_notification_events_server_time").on(t.serverId, t.occurredAt),
  index("idx_notification_events_type_time").on(t.eventType, t.occurredAt),
]);

// Per-recipient projection. recipient_id is an installation for v0, while the
// discriminator leaves the backbone open to other adapters and receivers.
export const notificationRecipients = pgTable("notification_recipients", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  eventId: uuid("event_id").notNull().references(() => notificationEvents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  recipientType: text("recipient_type", { enum: ["app_installation"] }).notNull(),
  // Logical recipient id intentionally has no FK: uninstall removes live
  // authority but must preserve terminal operator-visible delivery history.
  recipientId: uuid("recipient_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_notification_recipients_installation_event").on(t.recipientType, t.recipientId, t.eventId),
  index("idx_notification_recipients_event").on(t.eventId),
  index("idx_notification_recipients_server").on(t.serverId, t.createdAt),
]);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  notificationId: uuid("notification_id").notNull().references(() => notificationRecipients.id, { onDelete: "cascade" }),
  adapter: text("adapter", { enum: ["webhook"] }).notNull(),
  status: text("status", { enum: ["pending", "processing", "delivered", "suppressed", "dead_lettered"] }).notNull().default("pending"),
  configRevision: integer("config_revision").notNull(),
  grantRevision: integer("grant_revision").notNull(),
  subscriptionRevision: integer("subscription_revision").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_notification_deliveries_notification_adapter").on(t.notificationId, t.adapter),
  index("idx_notification_deliveries_ready").on(t.status, t.nextAttemptAt),
  check("notification_deliveries_attempt_count_nonnegative", sql`${t.attemptCount} >= 0`),
]);

export const notificationDeliveryAttempts = pgTable("notification_delivery_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id").notNull().references(() => notificationDeliveries.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  configRevision: integer("config_revision").notNull(),
  httpStatus: integer("http_status"),
  outcome: text("outcome", { enum: ["delivered", "retry", "suppressed", "dead_lettered"] }).notNull(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_notification_delivery_attempts_delivery_number").on(t.deliveryId, t.attemptNumber),
  index("idx_notification_delivery_attempts_delivery_time").on(t.deliveryId, t.createdAt),
  check("notification_delivery_attempts_number_positive", sql`${t.attemptNumber} > 0`),
]);

// Channels — context-isolated group chats or DMs.
// Archive contract (2026-04-20, #proj-channel task #3):
//   archived_at    — set when channel is archived; cleared on unarchive.
//                    Archive freezes writes (no messages, reactions, tasks,
//                    attachments) but preserves read access and the name.
//                    Archive ≠ delete: the name stays reserved so
//                    re-creation must explicitly reuse or rename.
//   archived_by_user_id / archived_by_agent_id — durable actor provenance;
//                    exactly one is set for a changed archive operation and
//                    both are cleared on unarchive. Actor deletion clears its
//                    reference without changing the archived state.
export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // `task` (task v2): a task's own conversation. Like a thread it is a
  // sub-conversation (see isSubConversationType); its parent is the task
  // (`task_id`), not a message, and `parent_channel_id` is the channel the
  // task lives in (this server's local channel for a joint projection).
  type: text("type", { enum: ["channel", "private", "joint", "dm", "thread", "task"] }).default("channel").notNull(),
  // Task #70 / #wg-rbac:#51: the channel is readable by signed-out visitors of
  // its server's public page (publicServer.ts also requires type 'channel', a
  // publicly visible server and public_server_v0). The API calls it
  // `visitorVisible` (payloads mirror `guestVisible` for older clients); the
  // column keeps its old name, as renaming it would need dual writes across a
  // rolling deploy for no behavior change. Guests never read through it.
  guestVisible: boolean("guest_visible").notNull().default(false),
  // guest_joinable (Guest self-join) is retired (#wg-rbac:#47) and dropped
  // (migrations 0653-0654, guest_join_public_column_drop, channels_guest_joinable_drop).
  // Forum-style channels (#proj-chat:#24, flag channel_thread_sort_v0): how
  // the channel orders its top-level messages, the same for every member.
  // 'time' = post order (default); 'activity' = latest activity, the
  // message's own time or its latest thread reply. Regular channels only
  // (channel/private); the API refuses it elsewhere. No DB CHECK: adding one
  // would scan channels; the API validates the value.
  threadSort: text("thread_sort", { enum: ["time", "activity"] }).notNull().default("time"),
  // Channel announcements (#proj-chat:#29, flag channel_announcement_v0): the
  // id (`pt_…`) of the Artifact this channel has as its announcement, or
  // NULL. Written only by services/channelAnnouncements.ts, on every
  // projection of a joint at once. No foreign key (never from a hot core table
  // to an app's): an id whose Artifact was deleted, taken down or moved out
  // of the channel reads as none (resolved on read), and deleting or moving
  // it out clears it (platform/channelAnnouncements.ts).
  announcementArtifactId: text("announcement_artifact_id"),
  parentMessageId: uuid("parent_message_id"),
  // Derived: for a thread, the channel its parent message currently lives in;
  // NULL otherwise. Maintained only by the channels_parent_channel_id_* and
  // messages_parent_channel_id_follow triggers (0297), never by app writes.
  // No FK: triggers own the cached fact. The validated parent-message CHECK
  // makes it safe for family readers to follow this column without message scans.
  // Task conversations (migration task_conversation_channels): the channel holding the task — derived from
  // tasks.channel_id by the same trigger when the insert leaves it NULL
  // (canonical conversation), or the local channel written explicitly for a
  // joint local projection; re-derived when the task moves channel.
  parentChannelId: uuid("parent_channel_id"),
  // Task v2: the task whose conversation this is (type = 'task' only). The
  // canonical conversation and every joint local projection carry it; one
  // live row per (task, parent channel).
  taskId: uuid("task_id").references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByUserId: uuid("archived_by_user_id").references(() => users.id, { onDelete: "set null" }),
  archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Highest task number ever allocated in this channel (RFC 078: a task
  // number is never reused). Allocation takes max(messages.task_number,
  // tasks.task_number, this) + 1 and stores it here, so deleting the newest
  // v2 task (no host message keeps its number) does not free its number.
  // 0 = nothing recorded yet: existing channels still get their max from rows.
  taskNumberHighWater: integer("task_number_high_water").notNull().default(0),
}, (t) => [
  index("idx_channels_server").on(t.serverId),
  // Name uniqueness spans archived and active channels: archive must not
  // release the name. The partial index stays gated only on deleted_at.
  uniqueIndex("idx_channels_server_name_type").on(t.serverId, t.name).where(sql`type in ('channel', 'private', 'joint') and deleted_at is null`),
  check("channels_parent_message_requires_channel", sql`${t.parentMessageId} IS NULL OR ${t.parentChannelId} IS NOT NULL`),
  index("idx_channels_parent_message").on(t.parentMessageId),
  // Full descendant closure, including soft-deleted threads/tasks; built concurrently on large tables.
  index("idx_channels_parent_channel").on(t.parentChannelId).where(sql`parent_channel_id IS NOT NULL`),
  uniqueIndex("idx_channels_active_thread_parent").on(t.parentMessageId).where(sql`type = 'thread' and deleted_at is null`),
  // Live threads by parent channel: "threads under these visible channels" as an index-only scan.
  // Built with CREATE INDEX CONCURRENTLY by db:create-channels-thread-parent-channel-index; migration 0298 is a no-op.
  index("idx_channels_thread_parent_channel").on(t.parentChannelId, t.id).where(sql`type = 'thread' AND deleted_at IS NULL`),
  index("idx_channels_archived").on(t.serverId, t.archivedAt),
  // Task v2: one live task conversation per task per parent channel (the
  // canonical one under the task's storage channel, one local projection under
  // each joint server's local channel).
  uniqueIndex("idx_channels_active_task_parent").on(t.taskId, t.parentChannelId).where(sql`type = 'task' and deleted_at is null`),
  // Task conversations by parent channel ("task conversations under these
  // visible channels": search scoping, inbox reads), like the thread index above.
  index("idx_channels_task_parent_channel").on(t.parentChannelId, t.id).where(sql`type = 'task' AND deleted_at IS NULL`),
  // The cascade from tasks (channels.task_id ON DELETE cascade): deleting a
  // task finds its conversations, live or soft-deleted, without a scan.
  index("idx_channels_task_id").on(t.taskId).where(sql`task_id IS NOT NULL`),
  // A task conversation carries its task while it is live. Deleting the task
  // soft-deletes its conversation and detaches it (task_id NULL) instead of
  // letting the cascade hard-delete messages that external bridges still
  // reference (RFC 078 "Deleting a task"; migration task_conversation_detach_on_delete).
  check(
    "channels_task_id_matches_type",
    sql`((${t.type} = 'task') = (${t.taskId} IS NOT NULL)) OR (${t.type} = 'task' AND ${t.taskId} IS NULL AND ${t.deletedAt} IS NOT NULL)`,
  ),
]);

// Public server SEO (#proj-public-server-seo): stable public routing ids for
// raft.build URLs and the lastmod stamps of what public pages show. Kept out
// of `servers` / `channels` on purpose: those rows are returned whole by many
// member and agent routes, and a routing id must only ever leave the server
// through the search API, after its predicate passed (Ark). Ids are 128
// random bits (gen_random_uuid() as 32 hex), never derived from the row id,
// and never change once issued.
//
// Rows are created by the 0347 triggers (every new server; every new channel
// and thread), by the 0347 backfill (all servers; live channels and threads
// of servers public at the time) and when a server goes public. A channel
// without a row is never indexable. `public_changed_at` is stamped by the
// 0347 update triggers only, never by app code.
export const serverPublicRoutes = pgTable("server_public_routes", {
  serverId: uuid("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  publicId: text("public_id").notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  // Name, slug, avatar, public/search switches or deletion last changed.
  publicChangedAt: timestamp("public_changed_at", { withTimezone: true }),
});

export const channelPublicRoutes = pgTable("channel_public_routes", {
  channelId: uuid("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  publicId: text("public_id").notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  // Name, description, type, Guest visibility, archive or deletion last
  // changed while the row was or became a Guest-visible live channel, or for
  // a thread. Private channel edits never set it.
  publicChangedAt: timestamp("public_changed_at", { withTimezone: true }),
});

// Public server SEO, task #4: service credentials for the raft.build Pages
// Function (lib/publicSearchServiceAccess.ts). Only SHA-256 digests of the
// tokens are stored. Read on every service request, so removing or replacing
// a row takes effect on the next request without a deploy. One current key
// (no expiry) per client, enforced here; at most one previous key, which
// stops working at its `expires_at`. Rows are managed by operators.
export const publicSearchServiceKeys = pgTable("public_search_service_keys", {
  keyId: text("key_id").primaryKey(),
  clientId: text("client_id").notNull(),
  sha256: text("sha256").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_public_search_service_keys_current").on(t.clientId).where(sql`expires_at IS NULL`),
  index("idx_public_search_service_keys_client").on(t.clientId),
  check("public_search_service_keys_key_id_shape", sql`${t.keyId} ~ '^[A-Za-z0-9_-]{1,32}$'`),
  check("public_search_service_keys_sha256_shape", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
]);

// Durable DM provenance. Membership rows are intentionally mutable (for
// example, deleting an agent removes channel_agents), so they cannot be the
// source of truth for whether a one-human DM is a self-DM. New/adopted DMs get
// an explicit kind + canonical sorted participant key that survives peer
// deletion and channel soft deletion without widening the channels API shape.
export const dmChannelIdentities = pgTable("dm_channel_identities", {
  channelId: uuid("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["human_self", "human_human", "human_agent", "agent_agent"] }).notNull(),
  peerKey: text("peer_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Legacy duplicate DMs can share the same participant identity. Keep every
  // channel's provenance; the per-pair advisory lock prevents new duplicates.
  index("idx_dm_channel_identities_peer").on(t.serverId, t.kind, t.peerKey),
  check("dm_channel_identities_kind", sql`${t.kind} in ('human_self', 'human_human', 'human_agent', 'agent_agent')`),
]);

// Joint channels — shared conversations projected into multiple servers.
//
// Contract:
// - joint_channels owns the canonical message stream via canonical_channel_id.
// - canonical_channel_id is storage-only; it is not a user-facing projection,
//   not joinable/listable, and must never grant access by itself.
// - joint_channel_servers owns each server-local projection channel.
// - request-time access must resolve through the caller's active local
//   projection before touching canonical storage.
export const jointChannels = pgTable("joint_channels", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  canonicalChannelId: uuid("canonical_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  createdByServerId: uuid("created_by_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  // Contract v0.3 §18.8: first time the system observed this top-level joint
  // over its free-server limit. Null while within the limit. Only top-level
  // joints carry it; sub-thread joint records follow their parent.
  overLimitSince: timestamp("over_limit_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One joint record per canonical channel: concurrent first opens of a joint
  // thread upsert on it (channelService.getOrCreateThreadForChannel).
  uniqueIndex("idx_joint_channels_canonical").on(t.canonicalChannelId),
  index("idx_joint_channels_created_by_server").on(t.createdByServerId),
]);

export const jointChannelServers = pgTable("joint_channel_servers", {
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  localChannelId: uuid("local_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["host", "participant"] }).notNull().default("participant"),
  status: text("status", { enum: ["active", "disconnected"] }).notNull().default("active"),
  joinedByUserId: uuid("joined_by_user_id").references(() => users.id, { onDelete: "set null" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedByUserId: uuid("disconnected_by_user_id").references(() => users.id, { onDelete: "set null" }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.jointChannelId, t.serverId] }),
  uniqueIndex("idx_joint_channel_servers_local_channel").on(t.localChannelId),
  index("idx_joint_channel_servers_server").on(t.serverId),
]);

// RFC 074 phase 3: a committed disconnect fixes its victims before bounded
// physical cleanup. This list is a denial fact; joining
// another server after the disconnect cannot rescue a queued membership.
export const jointMembershipDepartures = pgTable("joint_membership_departures", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  localChannelId: uuid("local_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [
  uniqueIndex("idx_joint_departures_pending_connection").on(t.jointChannelId, t.serverId).where(sql`${t.completedAt} IS NULL`),
  index("idx_joint_departures_local").on(t.localChannelId),
  index("idx_joint_departures_server").on(t.serverId),
  index("idx_joint_departures_actor").on(t.actorUserId),
]);

// A free server in more than one external channel (externalChannelFreezeService,
// behind external_channels_v1): from `freeze_at` its side of every external
// channel is read-only. Frozen = a row whose freeze_at has passed, read at
// request time (never flipped by a timer); no row = not over. Kept off the
// `servers` row, which admission paths already lock FOR SHARE / FOR UPDATE.
export const serverExternalFreezes = pgTable("server_external_freezes", {
  // No foreign key to servers: the row is derived state. An insert's key
  // share lock on the servers row would deadlock with paths that hold it FOR
  // UPDATE (a role transition) while a joint accept holds what they wait for.
  // An orphan is harmless (the gate and metadata start from an existing
  // server) and the sweep deletes it.
  serverId: uuid("server_id").primaryKey(),
  freezeAt: timestamp("freeze_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row once scripts/external-freeze-launch-backfill.ts has run with --apply:
// the servers already over at launch got launch_at + 14 days. Until then no
// reconcile or sweep creates a freeze row (they may still delete one).
export const externalFreezeLaunchBackfill = pgTable("external_freeze_launch_backfill", {
  id: smallint("id").primaryKey().default(1),
  launchAt: timestamp("launch_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
}, (t) => [check("external_freeze_launch_backfill_single_row", sql`${t.id} = 1`)]);

export const jointMembershipRemovals = pgTable("joint_membership_removals", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  departureId: uuid("departure_id").notNull().references(() => jointMembershipDepartures.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  // Membership deletion and external stop/revoke are separate commits. Until
  // both finish this durable denial row is retained, including on retry.
  membershipRemovedAt: timestamp("membership_removed_at", { withTimezone: true }),
  // False: this human retains J through another entry, but the disconnected
  // entry's cached subscriptions and compatibility row still need revoking.
  removeMembership: boolean("remove_membership").notNull().default(true),
  // When this row's removal and its post-commit revocation both finished. The
  // row is then history only (who a disconnect removed): every pending-removal
  // read goes through its departure's completed_at IS NULL, never this row
  // alone. Deleted 90 days after its departure completed
  // (jointMembershipRemovalRetention.ts).
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [
  check("joint_removal_one_principal", sql`(${t.userId} IS NULL) <> (${t.agentId} IS NULL)`),
  uniqueIndex("idx_joint_removals_user").on(t.userId, t.departureId),
  uniqueIndex("idx_joint_removals_agent").on(t.agentId, t.departureId),
  index("idx_joint_removals_departure").on(t.departureId, t.id),
]);

// Survives current-member deletion, so even a member with no admission rows
// receives a fresh, monotonically increasing join number on explicit rejoin.
export const jointMembershipGenerations = pgTable("joint_membership_generations", {
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  // This phase migrates human membership only. Keep the principal key explicit
  // without inventing a new agent membership or a polymorphic, unenforced FK.
  principalKind: text("principal_kind", {enum:["user"]}).notNull().default("user"),
  principalId: uuid("principal_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastGeneration: integer("last_generation").notNull().default(1),
}, t => [
  primaryKey({ columns: [t.jointChannelId, t.principalKind, t.principalId] }),
  index("idx_joint_membership_generations_principal").on(t.principalId),
  check("joint_membership_generation_positive", sql`${t.lastGeneration}>0`),
  check("joint_membership_generation_kind",sql`${t.principalKind}='user'`),
]);

// RFC 074 phase 3, P1: shadow membership/admission facts. Serving and local
// operation roles still use channel_humans until their separately reviewed moves.
// There is deliberately no canonical role: one server's appointment grants no
// management authority on another entry.
export const jointChannelMembers = pgTable("joint_channel_members", {
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(1),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.jointChannelId, t.userId] }),
  index("idx_joint_channel_members_user").on(t.userId, t.jointChannelId),
]);

// Historical source records outlive membership and connection removal. They do
// not authorize access. Entity deletion still removes its own records.
export const jointChannelAdmissions = pgTable("joint_channel_admissions", {
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Legacy CH records do not identify the admitting actor. Never invent one.
  admittedBy: uuid("admitted_by").references(() => users.id, { onDelete: "set null" }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  generation: integer("generation").notNull().default(1),
  admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
  // #wg-rbac:#23: 'admission' is an ordinary admission (every write path
  // here); 'recovery' a source an approved ops recovery restored for a
  // current member (details in joint_admission_recoveries). Both count as a
  // live source (jointHumanCurrentSourceSql); neither authorizes anything. An
  // ordinary admission of the same live tuple upgrades a recovery row to
  // 'admission' (services/jointAdmissionKind.ts); nothing else writes
  // 'recovery' except that ops tool.
  kind: text("kind", { enum: ["admission", "recovery"] }).notNull().default("admission"),
}, (t) => [
  primaryKey({ columns: [t.jointChannelId, t.userId, t.generation, t.serverId] }),
  index("idx_joint_channel_admissions_user").on(t.userId, t.jointChannelId),
  index("idx_joint_channel_admissions_source").on(t.serverId, t.jointChannelId, t.userId),
  check("joint_channel_admissions_kind_known", sql`${t.kind} IN ('admission', 'recovery')`),
]);

// The approval behind each recovery source (#wg-rbac:#23): which ops run wrote
// it, under which approval. Goes with its admission row (composite FK), so it
// is kept, and removed, exactly as joint_channel_admissions is. Stays when an
// ordinary admission later upgrades the row's kind: the history of the tuple.
export const jointAdmissionRecoveries = pgTable("joint_admission_recoveries", {
  jointChannelId: uuid("joint_channel_id").notNull(),
  userId: uuid("user_id").notNull(),
  generation: integer("generation").notNull(),
  serverId: uuid("server_id").notNull(),
  runId: text("run_id").notNull(),
  approvalRef: text("approval_ref").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.jointChannelId, t.userId, t.generation, t.serverId] }),
  foreignKey({
    columns: [t.jointChannelId, t.userId, t.generation, t.serverId],
    foreignColumns: [jointChannelAdmissions.jointChannelId, jointChannelAdmissions.userId, jointChannelAdmissions.generation, jointChannelAdmissions.serverId],
    name: "joint_admission_recoveries_admission_fk",
  }).onDelete("cascade"),
]);

export const jointChannelInvites = pgTable("joint_channel_invites", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  jointChannelId: uuid("joint_channel_id").notNull().references(() => jointChannels.id, { onDelete: "cascade" }),
  fromServerId: uuid("from_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  toServerId: uuid("to_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  invitedUserId: uuid("invited_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "accepted", "declined", "revoked", "expired"] }).notNull().default("pending"),
  tokenHash: text("token_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // How an accepted invite was accepted (RFC 075 §4.5): "invitee" when the
  // invited admin accepted it (email link or in-app), "same_admin" when the
  // inviter administers both servers and connected directly without email.
  // NULL for pending/declined/expired invites and for invites accepted before
  // this column existed.
  acceptedVia: text("accepted_via", { enum: ["invitee", "same_admin"] }),
}, (t) => [
  check("joint_channel_invites_accepted_via_known", sql`${t.acceptedVia} IS NULL OR ${t.acceptedVia} IN ('invitee', 'same_admin')`),
  uniqueIndex("idx_joint_channel_invites_token_hash").on(t.tokenHash),
  uniqueIndex("idx_joint_channel_invites_pending_target_user").on(t.jointChannelId, t.toServerId, t.invitedUserId).where(sql`status = 'pending'`),
  index("idx_joint_channel_invites_to_server").on(t.toServerId, t.status),
  index("idx_joint_channel_invites_invited_user").on(t.invitedUserId, t.status),
  index("idx_joint_channel_invites_from_server").on(t.fromServerId, t.status),
]);

// An invite of someone outside the host Server to one of its channels, by
// email (#wg-rbac:#16, behind external_channels_v1). Only the host Server's
// owner or admin sends one. Accepting it makes the invitee a Guest of the
// channel or connects a Server; `outcome` records which. A pending invite
// past `expires_at` reads as expired whether or not its status says so yet.
export const channelExternalInvites = pgTable("channel_external_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  // No ON DELETE action: channels are soft-deleted.
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  hostServerId: uuid("host_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // awaiting_approval: the invitee asked to connect a server whose owner/admin
  // must approve (channel_server_connect_requests); still open, like pending.
  // A rejected or cancelled request returns the invite to pending.
  // connecting: a server is being connected with this invite and the channel
  // first has to become joint (P2a-3); `connect_*` hold the reservation.
  // self_connecting: the same, for a self_connect operation (a channel member
  // connecting a server of theirs, jointMemberConnectService): its own status
  // so a node of an older release, whose worker scans `connecting` only and
  // knows none of its identity checks, never picks it up (design v3 §10).
  status: text("status", { enum: ["pending", "awaiting_approval", "connecting", "self_connecting", "accepted", "revoked", "expired"] }).notNull().default("pending"),
  outcome: text("outcome", { enum: ["guest", "server", "new_server"] }),
  acceptedUserId: uuid("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedServerId: uuid("accepted_server_id").references(() => servers.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Only while connecting. "conversion": the channel's conversion job
  // (connect_conversion_job_id) is running and cannot be interrupted, so the
  // invite cannot be revoked. "connection": the conversion committed (its
  // finalize moves the invite here in the same transaction) and the worker
  // connects connect_server_id, retrying until it does or the invite ends.
  connectPhase: text("connect_phase", { enum: ["conversion", "connection"] }),
  connectServerId: uuid("connect_server_id").references(() => servers.id, { onDelete: "set null" }),
  // Who is added to the joint channel on connect_server_id, and the owner or
  // admin of it who connected or approved: each re-checked when connecting.
  connectJoinerUserId: uuid("connect_joiner_user_id").references(() => users.id, { onDelete: "set null" }),
  connectAuthorizerUserId: uuid("connect_authorizer_user_id").references(() => users.id, { onDelete: "set null" }),
  connectConversionJobId: uuid("connect_conversion_job_id").references(() => channelConversionJobs.id, { onDelete: "set null" }),
  // Fresh each time the invite enters connecting, and copied onto its
  // conversion job: every later write to the reservation (finalize, the
  // worker's settle and retry) matches it, so a worker acting on an earlier
  // reservation of the same invite changes nothing.
  connectGeneration: uuid("connect_generation"),
  // Only while connecting: how the invite ends once the reservation connects,
  // "new_server" when the invitee created the server to connect it, else
  // "server" (the worker sets `outcome` from it).
  connectOutcome: text("connect_outcome", { enum: ["server", "new_server"] }),
  connectAttempts: integer("connect_attempts").notNull().default(0),
  connectNextAttemptAt: timestamp("connect_next_attempt_at", { withTimezone: true }),
  connectLastError: text("connect_last_error"),
  // Only while connecting: more servers the invitee owns or administers,
  // chosen with connect_server_id (several at once), connected one after
  // another once it is: each in turn becomes connect_server_id (with a fresh
  // generation), each re-checked when connecting.
  connectQueuedServerIds: uuid("connect_queued_server_ids").array().notNull().default(sql`'{}'::uuid[]`),
  // Every server connected with this invite, in the order connected (the
  // first is accepted_server_id): what the invitee's page lists as connected
  // by it. Never cleared; empty for invites connected before it existed
  // (their one server is accepted_server_id).
  connectedServerIds: uuid("connected_server_ids").array().notNull().default(sql`'{}'::uuid[]`),
  // Which joint membership sources this invite (one "operation" of the
  // invitee's, however many servers it connects) records for its joiner.
  // Set once, when the invitee first uses the invite, and kept for its
  // lifetime (never cleared with the connect state). NULL: set before this
  // existed, or before computed joint membership was the only mode (the
  // retired joint_human_membership_v1 rollout); connecting records what it
  // always did.
  // awaiting_first_join: the joiner was no member when it started
  // (source_start_generation = their joint_membership_generations counter
  // then, 0 for none); its first connection may admit them, if nothing else
  // did meanwhile. joined: it did (source_generation = that membership);
  // each further server it connects is a source of that membership.
  // awaiting_joint_creation: the actor's own direct-connect invite on a
  // channel not joint yet, so this operation's conversion creates the joint;
  // its finalize resolves it from what it wrote: member_at_start (the actor
  // a member, source_generation = that membership; each server is a source
  // of it) or awaiting_first_join. member_at_start is also a host_direct
  // operation's ("Your servers") whose actor was already a member when it
  // started: each server it connects is a source of that membership.
  // no_sources: the joiner is a member through another route (an emailed or
  // legacy invite); it connects servers but records no source, and never
  // re-adds a joiner who left.
  sourceState: text("source_state", { enum: ["awaiting_joint_creation", "awaiting_first_join", "joined", "member_at_start", "no_sources"] }),
  sourceStartGeneration: integer("source_start_generation"),
  sourceGeneration: integer("source_generation"),
  // Which creation path made the invite, written by every path
  // (insertExternalInvites, whose type requires it): external_invite (the
  // host owner/admin's email invite, or its resend), host_direct (their
  // "Your servers" direct connect, never emailed), self_connect (a channel
  // member connecting a server of theirs: a later release's). NULL: made
  // before this column existed, its origin not recorded (never backfilled);
  // connects exactly as it always did. Nullable with no default and no
  // NOT NULL guard yet: during a rolling deploy and its rollback window an
  // older node still inserts without it. Never read for authorization: it
  // only adds checks (externalInviteConnectService, "Membership sources").
  origin: text("origin", { enum: ["external_invite", "host_direct", "self_connect"] }),
  // self_connect on a private channel only: the actor's channel_humans
  // joined_at on it, read under the channel row and the conversion fence the
  // reservation publishes in the same commit. The conversion fence keeps
  // anybody from being added back to the channel until its finalize, which
  // turns the membership into a joint one (its generation): so a joint
  // membership whose joined_at is this one is the same stint, and a leave
  // followed by a rejoin never matches (design v3 §4).
  selfMemberJoinedAt: timestamp("self_member_joined_at", { withTimezone: true }),
  // self_connect only: when this operation ended its actor's Guest seat on the
  // host (in the commit of the server it connected first). Set once: a later
  // server of the same operation, a retry or a replay never releases (or
  // credits) a seat again.
  selfGuestReleasedAt: timestamp("self_guest_released_at", { withTimezone: true }),
}, (t) => [
  // Only this release's nodes write source_*: older ones never do, so the CHECK cannot refuse them.
  check("channel_external_invites_source_state_known", sql`${t.sourceState} IS NULL OR ${t.sourceState} IN ('awaiting_joint_creation', 'awaiting_first_join', 'joined', 'member_at_start', 'no_sources')`),
  check("channel_external_invites_origin_known", sql`${t.origin} IS NULL OR ${t.origin} IN ('external_invite', 'host_direct', 'self_connect')`),
  check("channel_external_invites_status_known", sql`${t.status} IN ('pending', 'awaiting_approval', 'connecting', 'self_connecting', 'accepted', 'revoked', 'expired')`),
  check("channel_external_invites_outcome_known", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('guest', 'server', 'new_server')`),
  check("channel_external_invites_outcome_iff_accepted", sql`(${t.status} = 'accepted') = (${t.outcome} IS NOT NULL)`),
  check("channel_external_invites_connect_phase_iff_connecting", sql`(${t.status} IN ('connecting', 'self_connecting')) = (${t.connectPhase} IS NOT NULL)`),
  check("channel_external_invites_connect_generation_iff_connecting", sql`(${t.status} IN ('connecting', 'self_connecting')) = (${t.connectGeneration} IS NOT NULL)`),
  check("channel_external_invites_connect_outcome_iff_connecting", sql`(${t.status} IN ('connecting', 'self_connecting')) = (${t.connectOutcome} IS NOT NULL)`),
  check("channel_external_invites_connect_outcome_known", sql`${t.connectOutcome} IS NULL OR ${t.connectOutcome} IN ('server', 'new_server')`),
  check("channel_external_invites_connect_phase_known", sql`${t.connectPhase} IS NULL OR ${t.connectPhase} IN ('conversion', 'connection')`),
  // connect_queued_server_ids is empty unless connecting: kept by the code
  // (CLEARED_CONNECT_STATE) for now; a CHECK would refuse an older node's
  // writes during a rolling deploy, so it comes in a later release.
  uniqueIndex("idx_channel_external_invites_open_email").on(t.channelId, t.email).where(sql`status IN ('pending', 'awaiting_approval', 'connecting', 'self_connecting')`),
  // One connection in progress per channel, across all its invites.
  uniqueIndex("idx_channel_external_invites_one_connecting").on(t.channelId).where(sql`status IN ('connecting', 'self_connecting')`),
  index("idx_channel_external_invites_host_created").on(t.hostServerId, t.createdAt),
  index("idx_channel_external_invites_channel").on(t.channelId),
]);

// An external invitee's request that an owner or admin of their Server
// approve connecting it to the invite's channel (#wg-rbac:#16, P2a-3). The
// invite is awaiting_approval while one is pending; it expires with the
// invite. The approver's role is checked when they act, not watched.
export const channelServerConnectRequests = pgTable("channel_server_connect_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  inviteId: uuid("invite_id").notNull().references(() => channelExternalInvites.id, { onDelete: "cascade" }),
  // No ON DELETE action: channels are soft-deleted.
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  hostServerId: uuid("host_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  targetServerId: uuid("target_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  approverUserId: uuid("approver_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled", "expired"] }).notNull().default("pending"),
  // Why a request was cancelled: the approver no longer administers the
  // target, the requester left it, the invite was revoked, or the requester
  // withdrew it.
  cancelReason: text("cancel_reason", { enum: ["approver_lost_role", "requester_left", "invite_revoked", "requester_cancelled"] }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  check("channel_server_connect_requests_status_known", sql`${t.status} IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')`),
  check("channel_server_connect_requests_cancel_reason_known", sql`${t.cancelReason} IS NULL OR ${t.cancelReason} IN ('approver_lost_role', 'requester_left', 'invite_revoked', 'requester_cancelled')`),
  // One pending request per server an invite connects (several servers may each wait for their own approver).
  uniqueIndex("idx_channel_server_connect_requests_pending_invite_target").on(t.inviteId, t.targetServerId).where(sql`status = 'pending'`),
  index("idx_channel_server_connect_requests_approver").on(t.approverUserId, t.status),
]);

// Durable state machine for converting an existing public/private local
// channel into the host projection of a joint channel. This is intentionally
// not a generic job framework: every phase is specific to this migration and
// must be idempotent so an expired lease can resume after process restart.
export const channelConversionJobs = pgTable("channel_conversion_jobs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  sourceChannelType: text("source_channel_type", { enum: ["channel", "private"] }).notNull(),
  targetKind: text("target_kind", { enum: ["joint"] }).notNull().default("joint"),
  // `status`/`phase` are retained for rolling compatibility with the v0
  // runner. `state` is the durable contract state machine; it is monotonic
  // across retries and is never inferred from the legacy phase strings.
  state: text("state", {
    enum: [
      "prepared",
      "fenced",
      "draining",
      "copying",
      "projections_rebuilt",
      "audience_cutover",
      "residual_cleanup",
      "verifying",
      "succeeded",
      "retry_waiting",
      "failed",
      "canceled",
    ],
  }).notNull().default("prepared"),
  conversionEpoch: uuid("conversion_epoch").notNull().default(sql`gen_random_uuid()`),
  status: text("status", { enum: ["pending", "running", "failed", "done", "canceled"] }).notNull().default("pending"),
  phase: text("phase", {
    enum: [
      "prepare",
      "prepare_tasks",
      "move_parent_messages",
      "prepare_threads",
      "move_thread_messages",
      "verify",
      "audience_cutover",
      "residual_cleanup",
      "finalize",
      "done",
    ],
  }).notNull().default("prepare"),
  canonicalChannelId: uuid("canonical_channel_id").references(() => channels.id, { onDelete: "set null" }),
  jointChannelId: uuid("joint_channel_id").references(() => jointChannels.id, { onDelete: "set null" }),
  progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // The external invite reservation this run converts for
  // (channel_external_invites.connect_generation), if any (#wg-rbac:#16 P2a-3).
  externalConnectGeneration: uuid("external_connect_generation"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_channel_conversion_jobs_server_status").on(t.serverId, t.status),
  index("idx_channel_conversion_jobs_phase").on(t.phase),
  index("idx_channel_conversion_jobs_lease").on(t.leaseExpiresAt),
  uniqueIndex("idx_channel_conversion_jobs_active_source")
    .on(t.sourceChannelId)
    .where(sql`status in ('pending', 'running', 'failed')`),
  index("idx_channel_conversion_jobs_epoch").on(t.conversionEpoch),
]);

// Published before a conversion command waits on the source lock. This is
// admission/observation state, not an assertion that copying has succeeded.
export const channelConversionCommands = pgTable("channel_conversion_commands", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["start", "retry", "cancel"] }).notNull(),
  status: text("status", { enum: ["pending", "completed", "failed"] }).notNull().default("pending"),
  jobId: uuid("job_id").references(() => channelConversionJobs.id, { onDelete: "set null" }),
  error: text("error"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_channel_conversion_commands_source").on(t.serverId, t.sourceChannelId, t.createdAt),
  index("idx_channel_conversion_commands_pending").on(t.status, t.createdAt),
]);

// A fence is durable state, not a projection of channels.archived_at. The
// source row remains useful for the UI, but every writer must consult this
// table while holding the per-source advisory lock. Historical released rows
// are retained for audit and retry evidence; only one active row is allowed.
export const channelConversionFences = pgTable("channel_conversion_fences", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  jobId: uuid("job_id").notNull().references(() => channelConversionJobs.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  conversionEpoch: uuid("conversion_epoch").notNull(),
  status: text("status", { enum: ["active", "released"] }).notNull().default("active"),
  reason: text("reason"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_channel_conversion_fences_job_epoch").on(t.jobId, t.conversionEpoch),
  uniqueIndex("idx_channel_conversion_fences_active_source")
    .on(t.sourceChannelId)
    .where(sql`status = 'active'`),
  index("idx_channel_conversion_fences_epoch").on(t.conversionEpoch),
]);

// One row per committed phase/batch. The idempotency key is the crash/retry
// boundary: duplicate execution can observe the committed row and skip the
// batch without copying a second projection.
export const channelConversionPhaseLedger = pgTable("channel_conversion_phase_ledger", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  jobId: uuid("job_id").notNull().references(() => channelConversionJobs.id, { onDelete: "cascade" }),
  conversionEpoch: uuid("conversion_epoch").notNull(),
  phase: text("phase").notNull(),
  batchKey: text("batch_key").notNull().default("all"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["started", "committed", "failed"] }).notNull().default("started"),
  sourceCount: integer("source_count").notNull().default(0),
  targetCount: integer("target_count").notNull().default(0),
  checksum: text("checksum").notNull(),
  error: text("error"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_channel_conversion_phase_ledger_idempotency").on(t.jobId, t.conversionEpoch, t.idempotencyKey),
  index("idx_channel_conversion_phase_ledger_job_phase").on(t.jobId, t.phase),
]);

// Channel-Agent assignments
export const channelAgents = pgTable("channel_agents", {
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["member", "admin"] }).notNull().default("member"),
  authorityRevision: integer("authority_revision").notNull().default(1),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.channelId, t.agentId] }),
  index("idx_channel_agents_agent").on(t.agentId),
  index("idx_channel_agents_agent_channel").on(t.agentId, t.channelId),
  index("idx_channel_agents_channel_role").on(t.channelId, t.role),
  check("channel_agents_role_check", sql`${t.role} IN ('member', 'admin')`),
]);

// Channel-User members (for DM visibility and channel access)
export const channelHumans = pgTable("channel_humans", {
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["member", "admin"] }).notNull().default("member"),
  authorityRevision: integer("authority_revision").notNull().default(1),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.channelId, t.userId] }),
  index("idx_channel_humans_user").on(t.userId),
  index("idx_channel_humans_channel_role").on(t.channelId, t.role),
  check("channel_humans_role_check", sql`${t.role} IN ('member', 'admin')`),
]);

// Agent Lounge v0 (#proj-chat:#15, behind agent_lounge_v0): the public
// channel where every non-guest human of the Server talks with one agent.
// The channel itself is an ordinary public channel (type 'channel'); this row
// is what makes it a lounge. Other agents may read it (as any public channel)
// but never join it: trigger channel_agents_agent_lounge_guard refuses a
// channel_agents row for any agent but agent_id, so every write that needs
// membership (post, react, mute, tasks) is closed to them. agent_id becomes
// NULL when the agent row goes away; the channel stays a lounge, closed to
// every agent. channel_id has no ON DELETE action: channels are soft-deleted.
export const agentLounges = pgTable("agent_lounges", {
  channelId: uuid("channel_id").primaryKey().references(() => channels.id),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_lounges_agent").on(t.agentId),
  index("idx_agent_lounges_server").on(t.serverId),
]);

// Durable audit/outbox fact for channel-local role mutations. The membership
// update and this row are committed together; realtime delivery is a
// post-commit projection and may be retried by mutation id.
export const channelMembershipRoleEvents = pgTable("channel_membership_role_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  targetType: text("target_type", { enum: ["user", "agent"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  previousRole: text("previous_role", { enum: ["member", "admin"] }).notNull(),
  nextRole: text("next_role", { enum: ["member", "admin"] }).notNull(),
  authorityRevision: integer("authority_revision").notNull(),
  deliveryStatus: text("delivery_status", { enum: ["pending", "sent", "dead_letter"] }).notNull().default("pending"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastDeliveryError: text("last_delivery_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [
  index("idx_channel_membership_role_events_pending").on(t.deliveryStatus, t.createdAt),
  index("idx_channel_membership_role_events_channel").on(t.channelId, t.createdAt),
  check("channel_membership_role_events_target_type_check", sql`${t.targetType} IN ('user', 'agent')`),
  check("channel_membership_role_events_previous_role_check", sql`${t.previousRole} IN ('member', 'admin')`),
  check("channel_membership_role_events_next_role_check", sql`${t.nextRole} IN ('member', 'admin')`),
  check("channel_membership_role_events_delivery_status_check", sql`${t.deliveryStatus} IN ('pending', 'sent', 'dead_letter')`),
]);

// Messages with server-global seq for reliable delivery
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  // The channel's server, set by a BEFORE INSERT / UPDATE OF channel_id trigger
  // (0317), so per-server reads (the (server_id, search_vector) GIN) need no
  // channels join. Never written by application code. Nullable until the
  // operator backfill of older rows is verified; a NOT VALID CHECK already
  // holds new rows to NOT NULL. Joint messages carry the joint_storage server.
  // Not in slock_rw_publication's column list.
  serverId: uuid("server_id"),
  senderType: text("sender_type", { enum: ["user", "agent", "external_projection"] }).notNull(),
  senderId: text("sender_id").notNull(), // user UUID, agent UUID, or external actor projection UUID
  agentSendKey: text("agent_send_key"),
  randomId: text("random_id"),
  // IANA time zone the human sender's browser reported when sending from the
  // web client (e.g. "Asia/Shanghai"). Exposed to agents only, never to other
  // humans' clients. Null for agent/system/forwarded/non-web messages and for
  // rows written before it existed. Not in slock_rw_publication's column list.
  senderTimezone: text("sender_timezone"),
  // RFC 077: the personal assistant that sent this message as its owner (the
  // sender). No foreign key: an FK on messages would scan the table to add and
  // could block a server's hard delete; agents are soft-deleted, so the id keeps
  // naming it and the "sent by an assistant" label outlives it. Not in
  // slock_rw_publication's column list.
  delegatedByAgentId: uuid("delegated_by_agent_id"),
  // RFC 077 PR 2b: set when the owner retracted a delegated message. The row
  // stays (seq, thread anchor and inbox are untouched); its content is
  // replaced with a fixed placeholder and its search text cleared.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  messageType: text("message_type", { enum: ["chat", "system"] }).notNull().default("chat"),
  content: text("content").notNull(),
  actionMetadata: json("action_metadata"),
  searchText: text("search_text"),
  searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector('simple', COALESCE(search_text, ''))`),
  // `threadId` is the **anchor** marker on a thread PARENT message. It holds
  // the `channels.id` of the thread channel that hangs off this message — set
  // by `channelService.syncParentMessageThreadId` when the thread is first
  // resolved. It is NOT "this message is a reply inside a thread"; thread
  // replies are stored as ordinary messages in the thread channel, with
  // `messages.channelId === threadChannelId` and their own `threadId === null`.
  // Renaming the column would require a migration; reading code should rely on
  // this comment, not the field name's natural reading.
  threadId: text("thread_id"),
  // 061 Stage 2 (P5/A2): causal actor for system messages, and the system-subtype
  // discriminator. Together they let the derivation apply the born-read / skip /
  // notify-exclude classification (systemMessageBornReadRegistry) without a fact
  // snapshot. Null for ordinary user/agent/external_projection messages.
  causalActorType: text("causal_actor_type", { enum: ["user", "agent"] }),
  causalActorId: text("causal_actor_id"),
  systemSubtype: text("system_subtype"),
  // Task fields — DEAD STORAGE as of v1.4 P3. These are NOT read by application
  // code any more: `tasks` is the source of truth and a task's link to its host
  // message is `tasks.message_id`, not state stored here. A non-null
  // `taskStatus` therefore does NOT mean "this message is a task" — after the
  // 2026-07-31 prod backfill such a row is inert.
  //
  // Retained deliberately as a frozen rollback snapshot (@stdrc keep-and-observe);
  // P4 drops them. Only three writers remain and all of them clear or terminate:
  // `taskService.deleteTask`, agent soft-delete, and channel delete.
  // The union also types the projection of `tasks.status` onto a message row; nothing writes backlog here.
  taskStatus: text("task_status", { enum: ["backlog", "todo", "in_progress", "in_review", "done", "closed"] }),
  taskNumber: integer("task_number"),
  taskAssigneeType: text("task_assignee_type", { enum: ["user", "agent"] }),
  taskAssigneeId: text("task_assignee_id"),
  taskClaimedAt: timestamp("task_claimed_at", { withTimezone: true }),
  taskCompletedAt: timestamp("task_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // NOT DECLARED HERE ON PURPOSE: `insert_xid xid8` (migration
  // messages_insert_xid), the inserting transaction's id, always set by the
  // BEFORE INSERT trigger messages_set_insert_xid; NULL on rows written before
  // it existed. Only the sync horizon reads it (services/syncHorizon.ts,
  // messageService.syncMessagesWithHorizon, by raw SQL). Leaving it out of
  // this table means no ORM read (`select().from(messages)`, `returning()`,
  // getTableColumns) can fetch it, so it cannot reach a client, agent,
  // webhook, export or log through a message row. Its partial index
  // idx_messages_insert_xid is owned by the post-migration lifecycle
  // (db/postMigrationIndexes.ts). The drizzle snapshots do not list either, so
  // `drizzle-kit generate` never drops them; do not run `drizzle-kit push`
  // against a migrated database (it would). messagesInsertXidMigration.test.ts
  // pins this.
}, (t) => [
  index("idx_messages_channel_seq").on(t.channelId, t.seq),
  index("idx_messages_seq").on(t.seq),
  index("idx_messages_created_at").on(t.createdAt),
  index("idx_messages_channel_created_at").on(t.channelId, t.createdAt),
  // Sender-driven newest-first access for filter-only message search
  // (sender filter without query text). Without it the planner either walks
  // idx_messages_created_at backwards filtering sender in the heap (unbounded
  // for rare/absent senders) or scans every visible channel's messages
  // (>15s statement_timeout at production scale). Built CONCURRENTLY by the
  // post-migration lifecycle step; 0248 is a protected no-op marker.
  index("idx_messages_sender_created_at").on(t.senderId, t.createdAt, t.id),
  index("idx_messages_thread").on(t.threadId),
  index("idx_messages_search_vector_gin").using("gin", t.searchVector).with({ fastupdate: false }),
  uniqueIndex("idx_messages_channel_task_number").on(t.channelId, t.taskNumber),
  uniqueIndex("idx_messages_agent_send_key")
    .on(t.senderId, t.agentSendKey)
    .where(sql`sender_type = 'agent' and agent_send_key is not null`),
  uniqueIndex("idx_messages_user_random_id")
    .on(t.senderId, t.randomId)
    .where(sql`sender_type = 'user' and random_id is not null`),
  index("idx_messages_channel_task_status").on(t.channelId, t.taskStatus),
  index("idx_messages_task_assignee")
    .on(t.taskAssigneeType, t.taskAssigneeId)
    .where(sql`task_assignee_type is not null and task_assignee_id is not null`),
]);

// Card messages (RFC 082 §4.5): every version of a message card, as it was
// sent (revision 1) and as each update replaced it. The message row holds only
// the current one (`messages.action_metadata`, kind "message-card"). Written in
// the same transaction as the message (send) or its update; never changed
// afterwards. Readable only by whoever may read the message, from the message
// (GET /api/messages/:messageId/card-revisions: no admin view, never by the
// sender's App). The hourly maintenance deletes a message's rows 44 days after
// it was sent (messageCardService.pruneMessageCardRevisions, through the
// `created_at` index).
export const messageCardRevisions = pgTable("message_card_revisions", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  /** The card as stored on the message for this revision (defaults filled in). */
  card: jsonb("card").notNull(),
  /** The fallback text of this revision: the sender's, or the one derived from the card. */
  content: text("content").notNull(),
  senderAgentId: uuid("sender_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * The `idempotencyKey` of the update that wrote this revision (RFC 082
   * §4.2), unique per message: the same key again answers this revision. NULL
   * for revision 1 (the send keeps its key on the message) and keyless updates.
   */
  idempotencyKey: text("idempotency_key"),
}, (t) => [
  primaryKey({ columns: [t.messageId, t.revision] }),
  check("message_card_revisions_revision_positive", sql`${t.revision} >= 1`),
  index("idx_message_card_revisions_created_at").on(t.createdAt),
  // The agent foreign key's delete action looks rows up by it.
  index("idx_message_card_revisions_sender_agent").on(t.senderAgentId),
  // NULL keys are distinct, so keyless revisions never collide.
  uniqueIndex("idx_message_card_revisions_idempotency_key").on(t.messageId, t.idempotencyKey),
]);

// One row per message: its server in time order, so a newest-first search can
// read one server's messages instead of every server's (idx_messages_created_at).
// Derived data owned by the 0310 triggers only (message insert, channel_id /
// created_at change; channels.server_id is immutable, guarded by a trigger).
// Deliberately NOT in the RisingWave publication (slock_rw_publication): it is
// a Postgres-only read path, and keeping it out keeps its backfill off the CDC
// stream (messageServerTimelineMigration.test.ts pins this).
export const messageServerTimeline = pgTable("message_server_timeline", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  channelId: uuid("channel_id").notNull(),
  // A copy of messages.search_vector, kept by the same triggers (0658), so the
  // text match of a search reads one server's matches through the
  // (server_id, search_vector) btree_gin index instead of every server's.
  // Stored out of line (STORAGE EXTERNAL, toast_tuple_target 128): the heap
  // stays narrow for the timeline walk and the match's (message_id, channel_id)
  // reads. NULL only on rows the operator backfill has not reached yet. The
  // GIN (idx_message_server_timeline_server_search) is built by that backfill
  // after it verifies, so it is not declared here.
  searchVector: tsvector("search_vector"),
}, (t) => [
  index("idx_message_server_timeline_server_created").on(t.serverId, t.createdAt, t.messageId),
]);

// Provider-neutral external app control plane. These rows carry durable,
// secret-free authority and lifecycle epochs for integrations such as Slack.
// Provider credentials and secret-manager references are deliberately split
// into private tables so ordinary control-plane projections cannot select them
// accidentally.
export const externalAppRegistrations = pgTable("external_app_registrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  oauthClientId: uuid("oauth_client_id").notNull().references(() => oauthClients.id, { onDelete: "restrict" }),
  provider: text("provider", { enum: ["slack"] }).notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  state: text("state", { enum: ["active", "disabled"] }).notNull().default("active"),
  providerAppId: text("provider_app_id").notNull(),
  providerOAuthClientId: text("provider_oauth_client_id").notNull(),
  capabilityManifestVersion: integer("capability_manifest_version").notNull(),
  capabilityManifestHash: text("capability_manifest_hash").notNull(),
  requiredCapabilities: jsonb("required_capabilities").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_registrations_oauth_client_env").on(t.oauthClientId, t.environment),
  uniqueIndex("idx_external_app_registrations_provider_app")
    .on(t.provider, t.environment, t.providerAppId),
  uniqueIndex("idx_external_app_registrations_provider_oauth")
    .on(t.provider, t.environment, t.providerOAuthClientId),
  check("external_app_registration_provider_valid", sql`${t.provider} = 'slack'`),
  check("external_app_registration_environment_valid", sql`${t.environment} IN ('test', 'production')`),
  check("external_app_registration_state_valid", sql`${t.state} IN ('active', 'disabled')`),
  check("external_app_registration_manifest_version_positive", sql`${t.capabilityManifestVersion} > 0`),
  check("external_app_registration_manifest_hash_present", sql`length(btrim(${t.capabilityManifestHash})) > 0`),
]);

export const externalAppRegistrationSecrets = pgTable("external_app_registration_secrets", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  purpose: text("purpose", {
    enum: ["signing_secret", "manifest_manager", "oauth_client_secret"],
  }).notNull(),
  encryptedSecretRef: text("encrypted_secret_ref").notNull(),
  envelopeKeyId: text("envelope_key_id").notNull(),
  aadVersion: integer("aad_version").notNull().default(1),
  secretRevision: integer("secret_revision").notNull().default(1),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_registration_secret_purpose").on(t.registrationId, t.purpose),
  index("idx_external_app_registration_secret_lease").on(t.leaseExpiresAt),
  check(
    "external_app_registration_secret_purpose_valid",
    sql`${t.purpose} IN ('signing_secret', 'manifest_manager', 'oauth_client_secret')`,
  ),
  check("external_app_registration_secret_revision_positive", sql`${t.secretRevision} > 0 AND ${t.aadVersion} > 0`),
]);

// Durable sidecar to oauth_client_installs. Presence in oauth_client_installs
// is necessary but never sufficient: live authority requires both rows to
// agree on server/registration plus a current active grant epoch.
export const externalAppServerGrants = pgTable("external_app_server_grants", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "restrict" }),
  state: text("state", { enum: ["active", "revoked"] }).notNull().default("active"),
  grantEpoch: integer("grant_epoch").notNull().default(1),
  grantedManifestVersion: integer("granted_manifest_version").notNull(),
  grantedManifestHash: text("granted_manifest_hash").notNull(),
  grantedCapabilities: jsonb("granted_capabilities").$type<string[]>().notNull().default([]),
  grantedByType: text("granted_by_type", { enum: ["human", "agent"] }).notNull(),
  grantedById: uuid("granted_by_id").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_server_grants_server_registration").on(t.serverId, t.registrationId),
  index("idx_external_app_server_grants_state").on(t.registrationId, t.state),
  check("external_app_server_grant_state_valid", sql`${t.state} IN ('active', 'revoked')`),
  check("external_app_server_grant_actor_type_valid", sql`${t.grantedByType} IN ('human', 'agent')`),
  check("external_app_server_grant_epoch_positive", sql`${t.grantEpoch} > 0`),
  check(
    "external_app_server_grant_revocation_valid",
    sql`(${t.state} = 'active' AND ${t.revokedAt} IS NULL AND ${t.revokeReason} IS NULL)
      OR (${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL)`,
  ),
]);

// Provider-authoritative application manifest observation. Installed OAuth
// scopes are recorded on the install row and never substitute for this
// separate app-level subscription/settings receipt.
export const externalAppManifestReceipts = pgTable("external_app_manifest_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  receiptRevision: integer("receipt_revision").notNull(),
  managerCredentialRevision: integer("manager_credential_revision").notNull(),
  providerAppId: text("provider_app_id").notNull(),
  normalizedManifestHash: text("normalized_manifest_hash").notNull(),
  normalizedScopes: jsonb("normalized_scopes").$type<string[]>().notNull().default([]),
  normalizedEvents: jsonb("normalized_events").$type<string[]>().notNull().default([]),
  normalizedSettings: jsonb("normalized_settings").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status", { enum: ["valid", "mismatch", "unreadable"] }).notNull(),
  errorCode: text("error_code"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_manifest_receipt_revision").on(t.registrationId, t.receiptRevision),
  index("idx_external_app_manifest_receipt_freshness").on(t.registrationId, t.status, t.expiresAt),
  check("external_app_manifest_receipt_status_valid", sql`${t.status} IN ('valid', 'mismatch', 'unreadable')`),
  check(
    "external_app_manifest_receipt_revision_positive",
    sql`${t.receiptRevision} > 0 AND ${t.managerCredentialRevision} > 0`,
  ),
  check("external_app_manifest_receipt_window_valid", sql`${t.expiresAt} > ${t.observedAt}`),
  check(
    "external_app_manifest_receipt_error_valid",
    sql`(${t.status} = 'valid' AND ${t.errorCode} IS NULL)
      OR (${t.status} <> 'valid' AND ${t.errorCode} IS NOT NULL)`,
  ),
]);

export type SlackBridgeMentionSyncHealth = {
  state: "synced" | "degraded";
  slackError: string | null;
  expected: number;
  actual: number;
  observedAt: string;
};

export const externalAppInstalls = pgTable("external_app_installs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "restrict" }),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "restrict" }),
  serverGrantId: uuid("server_grant_id").notNull().references(() => externalAppServerGrants.id, { onDelete: "restrict" }),
  grantEpoch: integer("grant_epoch").notNull(),
  state: text("state", {
    enum: ["pending", "active", "reauth_required", "disconnected", "revoked", "quarantined"],
  }).notNull().default("pending"),
  stateReason: text("state_reason"),
  connectionEpoch: integer("connection_epoch").notNull().default(1),
  scopeRevision: integer("scope_revision").notNull().default(1),
  credentialRevision: integer("credential_revision").notNull().default(1),
  installedScopes: jsonb("installed_scopes").$type<string[]>().notNull().default([]),
  providerAppId: text("provider_app_id").notNull(),
  providerTeamId: text("provider_team_id"),
  providerEnterpriseId: text("provider_enterprise_id"),
  authorityType: text("authority_type", { enum: ["team", "enterprise"] }).notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  botUserId: text("bot_user_id"),
  providerBotId: text("provider_bot_id"),
  workspaceName: text("workspace_name"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  // Legacy install-level health for older deployed code. Current per-server
  // settings read external_app_install_server_grants.agent_mention_sync.
  agentMentionSync: jsonb("agent_mention_sync").$type<SlackBridgeMentionSyncHealth>(),
  slackMentionCapability: jsonb("slack_mention_capability").$type<SlackMentionCapability>(),
  slackHumanMentionSnapshot: jsonb("slack_human_mention_snapshot").$type<SlackHumanMentionSnapshot>(),
  slackMentionRateLimitedUntil: timestamp("slack_mention_rate_limited_until", { withTimezone: true }),
  slackLifecycleRetryNotBefore: timestamp("slack_lifecycle_retry_not_before", { withTimezone: true }),
  installGrantRenewalLeaseOwner: text("install_grant_renewal_lease_owner"),
  installGrantRenewalLeaseExpiresAt: timestamp("install_grant_renewal_lease_expires_at", { withTimezone: true }),
  installGrantRenewalNextAttemptAt: timestamp("install_grant_renewal_next_attempt_at", { withTimezone: true }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_install_authority")
    .on(t.registrationId, t.authorityType, t.providerAuthorityId),
  index("idx_external_app_install_server_state").on(t.serverId, t.state),
  index("idx_external_app_install_grant").on(t.serverGrantId, t.grantEpoch),
  index("idx_external_app_install_grant_renewal_lease")
    .on(t.installGrantRenewalLeaseExpiresAt, t.installGrantRenewalNextAttemptAt),
  check(
    "external_app_install_state_valid",
    sql`${t.state} IN ('pending', 'active', 'reauth_required', 'disconnected', 'revoked', 'quarantined')`,
  ),
  check("external_app_install_authority_type_valid", sql`${t.authorityType} IN ('team', 'enterprise')`),
  check(
    "external_app_install_epochs_positive",
    sql`${t.grantEpoch} > 0 AND ${t.connectionEpoch} > 0 AND ${t.scopeRevision} > 0 AND ${t.credentialRevision} > 0`,
  ),
  check(
    "external_app_install_m0_team_only",
    sql`${t.authorityType} = 'team' AND ${t.providerTeamId} IS NOT NULL
      AND ${t.providerEnterpriseId} IS NULL AND ${t.providerAuthorityId} = ${t.providerTeamId}`,
  ),
  check(
    "external_app_install_state_reason_valid",
    sql`(${t.state} IN ('pending', 'active') AND ${t.stateReason} IS NULL)
      OR (${t.state} NOT IN ('pending', 'active') AND ${t.stateReason} IS NOT NULL)`,
  ),
]);

// A provider workspace installation and its credential are global to the
// provider authority. Server authorization is separate: each Raft server that
// may bind one of that workspace's channels owns an exact, revocable grant row.
// The legacy server/grant columns on external_app_installs remain the
// credential-AAD owner during the rolling transition; runtime authority must
// use this association instead of treating that owner as the only server.
export const externalAppInstallServerGrants = pgTable("external_app_install_server_grants", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "restrict" }),
  serverGrantId: uuid("server_grant_id").notNull().references(() => externalAppServerGrants.id, { onDelete: "restrict" }),
  grantEpoch: integer("grant_epoch").notNull(),
  state: text("state", { enum: ["active", "revoked"] }).notNull().default("active"),
  // Mention candidates and their results belong to one Raft server, even
  // when several servers share the same Slack workspace installation.
  agentMentionSync: jsonb("agent_mention_sync").$type<SlackBridgeMentionSyncHealth>(),
  authorizedByType: text("authorized_by_type", { enum: ["human", "agent"] }).notNull(),
  authorizedById: uuid("authorized_by_id").notNull(),
  // The Slack human who authorized this server's association. Legacy rows
  // lack this evidence and must not be treated as private-channel consent.
  providerAuthorizingUserId: text("provider_authorizing_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_install_server_grant_scope").on(t.installId, t.serverId),
  index("idx_external_app_install_server_grant_server_state").on(t.serverId, t.registrationId, t.state),
  index("idx_external_app_install_server_grant_authority").on(t.serverGrantId, t.grantEpoch),
  check("external_app_install_server_grant_epoch_positive", sql`${t.grantEpoch} > 0`),
  check("external_app_install_server_grant_state_valid", sql`${t.state} IN ('active', 'revoked')`),
  check("external_app_install_server_grant_actor_type_valid", sql`${t.authorizedByType} IN ('human', 'agent')`),
  check(
    "external_app_install_server_grant_revocation_valid",
    sql`(${t.state} = 'active' AND ${t.revokedAt} IS NULL AND ${t.revokeReason} IS NULL)
      OR (${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL AND length(btrim(${t.revokeReason})) > 0)`,
  ),
]);

// Provider-authoritative observation of the concrete OAuth grant attached to
// one Slack install. This deliberately does not claim to verify the app
// manifest, event subscriptions, or redirect URLs: auth.test plus Slack's
// x-oauth-scopes response header only proves token identity and current scopes.
export const externalAppInstallGrantReceipts = pgTable("external_app_install_grant_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "cascade" }),
  receiptRevision: integer("receipt_revision").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  scopeRevision: integer("scope_revision").notNull(),
  credentialRevision: integer("credential_revision").notNull(),
  providerAppId: text("provider_app_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  botUserId: text("bot_user_id").notNull(),
  providerBotId: text("provider_bot_id").notNull(),
  grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
  grantHash: text("grant_hash").notNull(),
  observationSource: text("observation_source", { enum: ["token_introspection"] }).notNull(),
  status: text("status", { enum: ["valid", "mismatch", "unreadable"] }).notNull(),
  errorCode: text("error_code"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_install_grant_receipt_revision")
    .on(t.installId, t.receiptRevision),
  index("idx_external_app_install_grant_receipt_freshness")
    .on(t.installId, t.status, t.expiresAt),
  check(
    "external_app_install_grant_receipt_revisions_positive",
    sql`${t.receiptRevision} > 0 AND ${t.connectionEpoch} > 0
      AND ${t.scopeRevision} > 0 AND ${t.credentialRevision} > 0`,
  ),
  check(
    "external_app_install_grant_receipt_values_present",
    sql`length(btrim(${t.providerAppId})) > 0
      AND length(btrim(${t.providerAuthorityId})) > 0
      AND length(btrim(${t.botUserId})) > 0
      AND length(btrim(${t.providerBotId})) > 0
      AND ${t.grantHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "external_app_install_grant_receipt_status_valid",
    sql`${t.status} IN ('valid', 'mismatch', 'unreadable')`,
  ),
  check(
    "external_app_install_grant_receipt_error_valid",
    sql`(${t.status} = 'valid' AND ${t.errorCode} IS NULL)
      OR (${t.status} <> 'valid' AND ${t.errorCode} IS NOT NULL)`,
  ),
  check(
    "external_app_install_grant_receipt_window_valid",
    sql`${t.expiresAt} > ${t.observedAt}`,
  ),
]);

// Explicit human-only Raft↔provider identity authority. A Slack install has a
// single bot identity for transport, so agents deliberately never enter this
// table. Active uniqueness prevents either a Raft human or Slack human from
// being silently represented by two current identities inside one install;
// revoked rows preserve the authority history and monotonic link epoch.
// Slack descriptions are display text, not a public carrier for Raft UUIDs.
// The reservation survives an uncertain usergroups.create response; its opaque
// recovery reference is removed from Slack after the provider id is recorded.
export type SlackUsergroupRecoveryRef = string & { readonly __slackUsergroupRecoveryRef: unique symbol };
export const slackUsergroupIdentities = pgTable("slack_usergroup_identities", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalKind: text("principal_kind", { enum: ["agent", "user"] }).notNull(),
  principalId: uuid("principal_id").notNull(),
  recoveryRef: text("recovery_ref").$type<SlackUsergroupRecoveryRef>().notNull(),
  providerUsergroupId: text("provider_usergroup_id"),
  // Only this confirmed human row is eligible for new outbound tokens. Old
  // provider IDs remain aliases for queued inbound messages.
  humanCanonical: boolean("human_canonical").notNull().default(false),
  mentionWriteFailures: jsonb("mention_write_failures").$type<SlackMentionWriteFailures>().notNull().default([]),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_slack_usergroup_identities_server").on(t.serverId),
  uniqueIndex("idx_slack_usergroup_principal").on(t.installId, t.serverId, t.principalKind, t.principalId),
  uniqueIndex("idx_slack_usergroup_provider").on(t.installId, t.providerUsergroupId),
  uniqueIndex("idx_slack_usergroup_recovery").on(t.recoveryRef),
  uniqueIndex("idx_slack_human_usergroup_canonical").on(t.installId, t.principalId)
    .where(sql`${t.principalKind} = 'user' AND ${t.humanCanonical} = true`),
  check("slack_human_usergroup_canonical_valid", sql`NOT ${t.humanCanonical} OR (${t.principalKind} = 'user' AND ${t.providerUsergroupId} IS NOT NULL)`),
  check("slack_usergroup_kind_valid", sql`${t.principalKind} IN ('agent', 'user')`),
]);

export const externalHumanIdentityLinks = pgTable("external_human_identity_links", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["slack"] }).notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerUserId: text("provider_user_id").notNull(),
  state: text("state", { enum: ["active", "revoked"] }).notNull().default("active"),
  linkEpoch: integer("link_epoch").notNull().default(1),
  observedConnectionEpoch: integer("observed_connection_epoch").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_human_identity_active_user")
    .on(t.installId, t.userId)
    .where(sql`${t.state} = 'active'`),
  uniqueIndex("idx_external_human_identity_active_provider_user")
    .on(t.installId, t.providerUserId)
    .where(sql`${t.state} = 'active'`),
  index("idx_external_human_identity_server_state")
    .on(t.serverId, t.state),
  index("idx_external_human_identity_history")
    .on(t.installId, t.userId, t.linkEpoch),
  check("external_human_identity_provider_valid", sql`${t.provider} = 'slack'`),
  check(
    "external_human_identity_values_present",
    sql`length(btrim(${t.providerAuthorityId})) > 0 AND length(btrim(${t.providerUserId})) > 0`,
  ),
  check(
    "external_human_identity_epochs_positive",
    sql`${t.linkEpoch} > 0 AND ${t.observedConnectionEpoch} > 0`,
  ),
  check(
    "external_human_identity_revocation_valid",
    sql`(${t.state} = 'active' AND ${t.revokedAt} IS NULL AND ${t.revokeReason} IS NULL)
      OR (${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL AND length(btrim(${t.revokeReason})) > 0)`,
  ),
]);

export const externalAppCredentials = pgTable("external_app_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "cascade" }),
  state: text("state", { enum: ["active", "persist_unknown", "revoked"] }).notNull().default("active"),
  encryptedMaterial: text("encrypted_material").notNull(),
  envelopeKeyId: text("envelope_key_id").notNull(),
  aadVersion: integer("aad_version").notNull().default(1),
  credentialRevision: integer("credential_revision").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_credentials_install").on(t.installId),
  index("idx_external_app_credentials_lease").on(t.leaseExpiresAt),
  check("external_app_credential_state_valid", sql`${t.state} IN ('active', 'persist_unknown', 'revoked')`),
  check(
    "external_app_credential_revision_positive",
    sql`${t.credentialRevision} > 0 AND ${t.aadVersion} > 0`,
  ),
  check(
    "external_app_credential_revocation_valid",
    sql`(${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL)
      OR (${t.state} <> 'revoked' AND ${t.revokedAt} IS NULL)`,
  ),
]);

export const externalOAuthAttempts = pgTable("external_oauth_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  serverGrantId: uuid("server_grant_id").notNull().references(() => externalAppServerGrants.id, { onDelete: "cascade" }),
  grantEpoch: integer("grant_epoch").notNull(),
  requestingUserId: uuid("requesting_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  stateHash: text("state_hash").notNull(),
  status: text("status", {
    enum: ["pending", "exchanging", "consumed", "exchange_unknown"],
  }).notNull().default("pending"),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  redirectUri: text("redirect_uri").notNull(),
  requestedScopes: jsonb("requested_scopes").$type<string[]>().notNull().default([]),
  manifestVersion: integer("manifest_version").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  grantIntentHash: text("grant_intent_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  exchangeStartedAt: timestamp("exchange_started_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_external_oauth_attempts_server_grant").on(t.serverGrantId),
  uniqueIndex("idx_external_oauth_attempt_state").on(t.stateHash),
  index("idx_external_oauth_attempt_scope").on(t.serverId, t.registrationId, t.status),
  index("idx_external_oauth_attempt_expiry").on(t.expiresAt),
  check(
    "external_oauth_attempt_status_valid",
    sql`${t.status} IN ('pending', 'exchanging', 'consumed', 'exchange_unknown')`,
  ),
  check("external_oauth_attempt_environment_valid", sql`${t.environment} IN ('test', 'production')`),
  check("external_oauth_attempt_epoch_positive", sql`${t.grantEpoch} > 0 AND ${t.manifestVersion} > 0`),
  check(
    "external_oauth_attempt_transition_shape",
    sql`(${t.status} = 'pending' AND ${t.exchangeStartedAt} IS NULL AND ${t.consumedAt} IS NULL)
      OR (${t.status} IN ('exchanging', 'exchange_unknown') AND ${t.exchangeStartedAt} IS NOT NULL AND ${t.consumedAt} IS NULL)
      OR (${t.status} = 'consumed' AND ${t.exchangeStartedAt} IS NOT NULL AND ${t.consumedAt} IS NOT NULL)`,
  ),
]);

export const externalChannelBindings = pgTable("external_channel_bindings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "restrict" }),
  installId: uuid("install_id").notNull().references(() => externalAppInstalls.id, { onDelete: "restrict" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
  providerConversationId: text("provider_conversation_id").notNull(),
  providerConversationKind: text("provider_conversation_kind", {
    enum: ["public_channel", "private_channel"],
  }).notNull(),
  slackLifecycleObservation: jsonb("slack_lifecycle_observation").$type<SlackChannelLifecycleObservation>(),
  privacyClass: text("privacy_class", { enum: ["public", "private"] }).notNull(),
  privacyFreshUntil: timestamp("privacy_fresh_until", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '10 minutes'`),
  state: text("state", { enum: ["active", "paused", "revoked", "quarantined"] }).notNull().default("active"),
  stateReason: text("state_reason"),
  grantEpoch: integer("grant_epoch").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingEpoch: integer("binding_epoch").notNull().default(1),
  audienceRevision: integer("audience_revision"),
  audienceFreshUntil: timestamp("audience_fresh_until", { withTimezone: true }),
  consentedByType: text("consented_by_type", { enum: ["human", "agent"] }).notNull(),
  consentedById: uuid("consented_by_id").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_channel_binding_source")
    .on(t.registrationId, t.channelId)
    .where(sql`${t.state} IN ('active', 'paused', 'quarantined')`),
  uniqueIndex("idx_external_channel_binding_target")
    .on(t.installId, t.providerConversationId)
    .where(sql`${t.state} IN ('active', 'paused', 'quarantined')`),
  index("idx_external_channel_binding_server_state").on(t.serverId, t.state),
  index("idx_external_channel_binding_install_epoch").on(t.installId, t.connectionEpoch, t.bindingEpoch),
  check("external_channel_binding_state_valid", sql`${t.state} IN ('active', 'paused', 'revoked', 'quarantined')`),
  check("external_channel_binding_privacy_class_valid", sql`${t.privacyClass} IN ('public', 'private')`),
  check(
    "external_channel_binding_conversation_kind_valid",
    sql`${t.providerConversationKind} IN ('public_channel', 'private_channel')`,
  ),
  check("external_channel_binding_consent_type_valid", sql`${t.consentedByType} IN ('human', 'agent')`),
  check(
    "external_channel_binding_epochs_positive",
    sql`${t.grantEpoch} > 0 AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0`,
  ),
  // audience_revision / audience_fresh_until are optional refresh metadata
  // for both privacy classes; per-member OAuth links are no longer a private
  // precondition. The CHECK only enforces the privacy mirror between the Raft
  // channel type and the provider conversation kind.
  check(
    "external_channel_binding_privacy_valid",
    sql`(${t.privacyClass} = 'public' AND ${t.providerConversationKind} = 'public_channel')
      OR (${t.privacyClass} = 'private' AND ${t.providerConversationKind} = 'private_channel')`,
  ),
  check("external_channel_binding_consent_valid", sql`${t.consentedAt} IS NOT NULL`),
  check(
    "external_channel_binding_state_reason_valid",
    sql`(${t.state} = 'active' AND ${t.stateReason} IS NULL)
      OR (${t.state} <> 'active' AND ${t.stateReason} IS NOT NULL)`,
  ),
]);

export const externalBindingAudienceSnapshots = pgTable("external_binding_audience_snapshots", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  bindingId: uuid("binding_id").notNull().references(() => externalChannelBindings.id, { onDelete: "cascade" }),
  bindingEpoch: integer("binding_epoch").notNull(),
  audienceRevision: integer("audience_revision").notNull(),
  externalMemberCount: integer("external_member_count").notNull(),
  externalAudienceDigest: text("external_audience_digest").notNull(),
  raftMemberCount: integer("raft_member_count").notNull(),
  raftAudienceDigest: text("raft_audience_digest").notNull(),
  status: text("status", { enum: ["matched", "mismatch", "unavailable"] }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_binding_audience_revision")
    .on(t.bindingId, t.bindingEpoch, t.audienceRevision),
  index("idx_external_binding_audience_freshness").on(t.bindingId, t.status, t.expiresAt),
  check("external_binding_audience_status_valid", sql`${t.status} IN ('matched', 'mismatch', 'unavailable')`),
  check(
    "external_binding_audience_revision_positive",
    sql`${t.bindingEpoch} > 0 AND ${t.audienceRevision} > 0`,
  ),
  check(
    "external_binding_audience_counts_nonnegative",
    sql`${t.externalMemberCount} >= 0 AND ${t.raftMemberCount} >= 0`,
  ),
  check("external_binding_audience_window_valid", sql`${t.expiresAt} > ${t.observedAt}`),
]);

// Exact environment-bound ingress endpoint authority. The request URL is part
// of the signing-secret selection boundary; it is not inferred from Host or
// forwarded headers at runtime.
export const externalAppIngressEndpoints = pgTable("external_app_ingress_endpoints", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  registrationId: uuid("registration_id").notNull().references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  exactRequestUrl: text("exact_request_url").notNull(),
  state: text("state", { enum: ["active", "disabled"] }).notNull().default("active"),
  endpointRevision: integer("endpoint_revision").notNull().default(1),
  signingSecretRevision: integer("signing_secret_revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_app_ingress_endpoint_registration").on(t.registrationId),
  uniqueIndex("idx_external_app_ingress_endpoint_url").on(t.environment, t.exactRequestUrl),
  check("external_app_ingress_endpoint_environment_valid", sql`${t.environment} IN ('test', 'production')`),
  check("external_app_ingress_endpoint_state_valid", sql`${t.state} IN ('active', 'disabled')`),
  check(
    "external_app_ingress_endpoint_revisions_positive",
    sql`${t.endpointRevision} > 0 AND ${t.signingSecretRevision} > 0`,
  ),
  check("external_app_ingress_endpoint_url_present", sql`length(btrim(${t.exactRequestUrl})) > 0`),
]);

// Provider-neutral external actors are display/search/addressability facts,
// never Raft principals or membership authority. Provider-specific control
// planes bind their opaque install/workspace/actor coordinates here without
// giving the external identity a user/agent row.
export const externalActorProjections = pgTable("external_actor_projections", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  externalActorId: text("external_actor_id").notNull(),
  identityKind: text("identity_kind", { enum: ["provider_actor", "anonymous"] }).notNull().default("provider_actor"),
  displayName: text("display_name").notNull(),
  handles: jsonb("handles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  actorKind: text("actor_kind", { enum: ["human", "guest", "remote", "bot", "unknown"] }).notNull(),
  state: text("state", { enum: ["active", "tombstoned"] }).notNull().default("active"),
  deactivated: boolean("deactivated").notNull().default(false),
  projectionRevision: integer("projection_revision").notNull(),
  avatarArtifactId: uuid("avatar_artifact_id").references(() => externalProjectionAvatarArtifacts.id, { onDelete: "restrict" }),
  // Verified only by bots.info under the installation authority. This does
  // not confer a Raft principal or membership; readers must revalidate it.
  slackBotMappingRevision: integer("slack_bot_mapping_revision").notNull().default(0),
  slackBotMappingCheckedAt: timestamp("slack_bot_mapping_checked_at", { withTimezone: true }),
  slackBotMappingConflict: boolean("slack_bot_mapping_conflict").notNull().default(false),
  slackBotUserId: text("slack_bot_user_id"),
  slackBotConnectionEpoch: integer("slack_bot_connection_epoch"),
  slackBotCredentialRevision: integer("slack_bot_credential_revision"),
  slackBotScopeRevision: integer("slack_bot_scope_revision"),
  slackBotMappingObservedAt: timestamp("slack_bot_mapping_observed_at", { withTimezone: true }),
  slackBotMappingExpiresAt: timestamp("slack_bot_mapping_expires_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_actor_provider_identity").on(
    t.provider,
    t.appRegistrationId,
    t.installId,
    t.workspaceId,
    t.externalActorId,
  ),
  uniqueIndex("idx_external_actor_projection_revision").on(t.id, t.projectionRevision),
  index("idx_external_actor_workspace_state").on(t.provider, t.workspaceId, t.state),
  check("external_actor_projection_revision_positive", sql`${t.projectionRevision} > 0`),
  check("external_actor_slack_bot_mapping_revision", sql`${t.slackBotMappingRevision} >= 0`),
  check("external_actor_slack_bot_mapping_valid", sql`
    (${t.slackBotMappingConflict} = false AND ${t.slackBotUserId} IS NULL AND ${t.slackBotConnectionEpoch} IS NULL AND ${t.slackBotCredentialRevision} IS NULL
      AND ${t.slackBotScopeRevision} IS NULL AND ${t.slackBotMappingObservedAt} IS NULL AND ${t.slackBotMappingExpiresAt} IS NULL)
    OR (${t.provider} = 'slack' AND ${t.actorKind} = 'bot' AND ${t.slackBotUserId} IS NOT NULL
      AND ${t.slackBotMappingRevision} > 0 AND ${t.slackBotUserId} ~ '^[UW][A-Z0-9]{2,159}$'
      AND ${t.slackBotConnectionEpoch} IS NOT NULL AND ${t.slackBotConnectionEpoch} > 0
      AND ${t.slackBotCredentialRevision} IS NOT NULL AND ${t.slackBotCredentialRevision} > 0
      AND ${t.slackBotScopeRevision} IS NOT NULL AND ${t.slackBotScopeRevision} > 0
      AND ${t.slackBotMappingObservedAt} IS NOT NULL AND ${t.slackBotMappingExpiresAt} IS NOT NULL
      AND ${t.slackBotMappingExpiresAt} > ${t.slackBotMappingObservedAt})`),
  check(
    "external_actor_projection_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND ((${t.identityKind} = 'provider_actor' AND length(btrim(${t.externalActorId})) > 0)
        OR (${t.identityKind} = 'anonymous' AND ${t.provider} = 'slack' AND ${t.externalActorId} = ''
          AND ${t.actorKind} = 'unknown' AND ${t.handles} = '[]'::jsonb AND ${t.avatarArtifactId} IS NULL))
      AND length(btrim(${t.displayName})) > 0
      AND ${t.actorKind} IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND ${t.state} IN ('active', 'tombstoned')`,
  ),
]);

// Public raster artifacts are separately revocable so a frozen author/message
// fact can retain its digest/revision without continuing to expose an unsafe
// or deleted URL. Provider adapters may use the explicit emoji fallback only
// when no current artifact exists.
export const externalProjectionAvatarArtifacts = pgTable("external_projection_avatar_artifacts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  ownerType: text("owner_type", { enum: ["external_projection"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  sourceDigest: text("source_digest").notNull(),
  sourceLocatorDigest: text("source_locator_digest"),
  storageKey: text("storage_key"),
  publicUrl: text("public_url").notNull(),
  mimeType: text("mime_type", { enum: ["image/png", "image/jpeg", "image/webp"] }).notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  artifactRevision: integer("artifact_revision").notNull(),
  state: text("state", { enum: ["pending", "active", "revoked"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_avatar_owner_revision").on(t.ownerType, t.ownerId, t.artifactRevision),
  uniqueIndex("idx_external_avatar_owner_pending")
    .on(t.ownerType, t.ownerId)
    .where(sql`${t.state} = 'pending'`),
  index("idx_external_avatar_digest").on(t.sourceDigest),
  index("idx_external_avatar_owner_state").on(t.ownerType, t.ownerId, t.state),
  check(
    "external_avatar_shape_valid",
    sql`${t.ownerType} = 'external_projection'
      AND length(btrim(${t.ownerId})) > 0
      AND ${t.sourceDigest} ~ '^[0-9a-f]{64}$'
      AND (${t.sourceLocatorDigest} IS NULL OR ${t.sourceLocatorDigest} ~ '^[0-9a-f]{64}$')
      AND (${t.storageKey} IS NULL OR (
        length(btrim(${t.storageKey})) > 0 AND length(${t.storageKey}) <= 1024
      ))
      AND ((${t.sourceLocatorDigest} IS NULL AND ${t.storageKey} IS NULL)
        OR (${t.sourceLocatorDigest} IS NOT NULL AND ${t.storageKey} IS NOT NULL))
      AND ${t.publicUrl} ~ '^https://'
      AND ${t.mimeType} IN ('image/png', 'image/jpeg', 'image/webp')
      AND ${t.byteSize} > 0 AND ${t.byteSize} <= 5242880
      AND ${t.width} > 0 AND ${t.width} <= 4096
      AND ${t.height} > 0 AND ${t.height} <= 4096
      AND ${t.artifactRevision} > 0
      AND ${t.state} IN ('pending', 'active', 'revoked')
      AND (${t.state} <> 'pending' OR (${t.sourceLocatorDigest} IS NOT NULL AND ${t.storageKey} IS NOT NULL))`,
  ),
]);

// One exact external conversation context grants addressability only while all
// authority/freshness coordinates remain current. It never grants Raft access.
export const externalAddressabilityProjections = pgTable("external_addressability_projections", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  projectionId: uuid("projection_id").notNull().references(() => externalActorProjections.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  conversationId: text("conversation_id").notNull(),
  slackMemberEventClock: text("slack_member_event_clock").$type<SlackLifecycleClock>(),
  memberRevision: integer("member_revision").notNull(),
  contextRevision: integer("context_revision").notNull(),
  state: text("state", { enum: ["active", "removed", "stale", "revoked", "quarantined"] }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_addressability_context_actor").on(
    t.projectionId,
    t.bindingId,
    t.bindingEpoch,
    t.conversationId,
    t.contextRevision,
  ),
  index("idx_external_addressability_context_lookup").on(
    t.provider,
    t.workspaceId,
    t.bindingId,
    t.bindingEpoch,
    t.conversationId,
    t.state,
  ),
  check(
    "external_addressability_revisions_positive",
    sql`${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0
      AND ${t.memberRevision} > 0 AND ${t.contextRevision} > 0`,
  ),
  check(
    "external_addressability_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND length(btrim(${t.bindingId})) > 0
      AND length(btrim(${t.conversationId})) > 0
      AND ${t.state} IN ('active', 'removed', 'stale', 'revoked', 'quarantined')
      AND ${t.expiresAt} > ${t.observedAt}`,
  ),
]);

// Immutable author fact for a canonical external-origin message. Reads never
// resolve senderId through Raft users/agents; tombstoning the mutable actor
// projection does not rewrite historical attribution.
export const externalMessageAuthorFacts = pgTable("external_message_author_facts", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  projectionId: uuid("projection_id").notNull().references(() => externalActorProjections.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  workspaceName: text("workspace_name"),
  externalActorId: text("external_actor_id").notNull(),
  identityKind: text("identity_kind", { enum: ["provider_actor", "anonymous"] }).notNull().default("provider_actor"),
  anonymousDisplayId: text("anonymous_display_id"),
  profileFallback: text("profile_fallback", { enum: ["unresolved"] }),
  externalConversationId: text("external_conversation_id").notNull(),
  externalMessageId: text("external_message_id").notNull(),
  displayName: text("display_name").notNull(),
  actorKind: text("actor_kind", { enum: ["human", "guest", "remote", "bot", "unknown"] }).notNull(),
  avatarArtifactId: uuid("avatar_artifact_id").references(() => externalProjectionAvatarArtifacts.id, { onDelete: "restrict" }),
  avatarUrl: text("avatar_url"),
  avatarDigest: text("avatar_digest"),
  contentDigest: text("content_digest").notNull(),
  actorProjectionRevision: integer("actor_projection_revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_message_provider_identity").on(
    t.provider,
    t.installId,
    t.workspaceId,
    t.externalConversationId,
    t.externalMessageId,
  ),
  index("idx_external_message_author_projection").on(t.projectionId),
  check("external_message_author_fallback_valid", sql`${t.profileFallback} IS NULL OR
    (${t.profileFallback} = 'unresolved' AND ${t.provider} = 'slack' AND ${t.actorKind} = 'unknown')`),
  check(
    "external_message_author_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND ((${t.identityKind} = 'provider_actor' AND length(btrim(${t.externalActorId})) > 0 AND ${t.anonymousDisplayId} IS NULL)
        OR (${t.identityKind} = 'anonymous' AND ${t.provider} = 'slack' AND ${t.externalActorId} = '' AND ${t.actorKind} = 'unknown'
          AND ${t.anonymousDisplayId} IS NOT NULL AND ${t.anonymousDisplayId} ~ '^slack-anonymous:[0-9a-f]{64}$'))
      AND length(btrim(${t.externalConversationId})) > 0
      AND length(btrim(${t.externalMessageId})) > 0
      AND length(btrim(${t.displayName})) > 0
      AND ${t.contentDigest} ~ '^[0-9a-f]{64}$'
      AND ${t.actorKind} IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND ${t.actorProjectionRevision} > 0
      AND ((${t.avatarArtifactId} IS NULL AND ${t.avatarUrl} IS NULL AND ${t.avatarDigest} IS NULL)
        OR (${t.avatarArtifactId} IS NOT NULL AND ${t.avatarUrl} ~ '^https://' AND ${t.avatarDigest} ~ '^[0-9a-f]{64}$'))`,
  ),
]);

// Structured send-time mention facts are inert storage until task #7 couples
// them to the ordinary-message transaction and provider dispatch recheck.
export const externalMentionFacts = pgTable("external_mention_facts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  projectionId: uuid("projection_id").notNull().references(() => externalActorProjections.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  externalActorId: text("external_actor_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  conversationId: text("conversation_id").notNull(),
  memberRevision: integer("member_revision").notNull(),
  contextRevision: integer("context_revision").notNull(),
  freshnessObservedAt: timestamp("freshness_observed_at", { withTimezone: true }).notNull(),
  freshnessExpiresAt: timestamp("freshness_expires_at", { withTimezone: true }).notNull(),
  handleAtSendTime: text("handle_at_send_time").notNull(),
  // Frozen for bot-target mentions; absent for legacy and human mentions.
  slackBotMappingRevision: integer("slack_bot_mapping_revision"),
  resolutionReason: text("resolution_reason", { enum: ["explicit_projection", "unique_dangling_handle"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_mention_message_projection").on(t.messageId, t.projectionId),
  index("idx_external_mention_binding_epoch").on(t.bindingId, t.bindingEpoch, t.messageId),
  check(
    "external_mention_fact_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND length(btrim(${t.externalActorId})) > 0
      AND length(btrim(${t.bindingId})) > 0
      AND length(btrim(${t.conversationId})) > 0
      AND length(btrim(${t.handleAtSendTime})) > 0
      AND (${t.slackBotMappingRevision} IS NULL OR ${t.slackBotMappingRevision} > 0)
      AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0
      AND ${t.memberRevision} > 0 AND ${t.contextRevision} > 0
      AND ${t.freshnessExpiresAt} > ${t.freshnessObservedAt}
      AND ${t.resolutionReason} IN ('explicit_projection', 'unique_dangling_handle')`,
  ),
]);

// Provider-neutral custody and processing state for one verified inbound
// envelope. Provider adapters may only enqueue sealed normalized payloads;
// the bounded worker decrypts through an injected opaque seam and atomically
// commits the canonical message, immutable author fact, provider link, inbox
// facts, crypto-erasure tombstone, and terminal event state.
export const externalIngressDiscardReceipts = pgTable("external_ingress_discard_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  provider: text("provider").notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  appRegistrationId: uuid("app_registration_id").notNull()
    .references(() => externalAppRegistrations.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull()
    .references(() => externalAppIngressEndpoints.id, { onDelete: "cascade" }),
  endpointRevision: integer("endpoint_revision").notNull(),
  signingSecretRevision: integer("signing_secret_revision").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerConversationId: text("provider_conversation_id"),
  providerEventId: text("provider_event_id").notNull(),
  outcomeReason: text("outcome_reason").notNull(),
  slackRetryNum: text("slack_retry_num"),
  slackRetryReason: text("slack_retry_reason"),
  payloadDigest: text("payload_digest").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_external_ingress_discard_event").on(
    t.provider,
    t.appRegistrationId,
    t.providerEventId,
    t.receivedAt,
  ),
  check(
    "external_ingress_discard_coordinates_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(${t.provider}) <= 80
      AND ${t.provider} = 'slack'
      AND ${t.environment} IN ('test', 'production')
      AND ${t.endpointRevision} > 0
      AND ${t.signingSecretRevision} > 0
      AND length(btrim(${t.providerAuthorityId})) > 0
      AND length(${t.providerAuthorityId}) <= 160
      AND (${t.providerConversationId} IS NULL OR (
        length(btrim(${t.providerConversationId})) > 0
        AND length(${t.providerConversationId}) <= 160
      ))
      AND length(btrim(${t.providerEventId})) > 0
      AND length(${t.providerEventId}) <= 320
      AND length(btrim(${t.outcomeReason})) > 0
      AND length(${t.outcomeReason}) <= 160
      AND ${t.outcomeReason} IN (
        'unsupported_event',
        'lifecycle_metadata_processed',
        'lifecycle_metadata_stale_authority',
        'lifecycle_metadata_unpaired',
        'provider_tokens_unrelated',
        'provider_loop_suppressed',
        'unsupported_message_subtype',
        'capability_disabled'
      )
      AND (${t.slackRetryNum} IS NULL OR (
        length(btrim(${t.slackRetryNum})) > 0
        AND length(${t.slackRetryNum}) <= 32
      ))
      AND (${t.slackRetryReason} IS NULL OR (
        length(btrim(${t.slackRetryReason})) > 0
        AND length(${t.slackRetryReason}) <= 160
      ))
      AND ${t.payloadDigest} ~ '^[0-9a-f]{64}$'`,
  ),
]);

// Verified Slack callbacks are kept separately from normalized inbound events:
// early receipt cannot invent an installation, binding or channel authority.
// A partition row serializes admission and head claiming for one conversation.
// Default-off administrative switch. A pause never lowers the writer protocol
// or sends requests back through the lossy legacy admission path.
export const slackVerifiedIngressRollout = pgTable("slack_verified_ingress_rollout", {
  id: integer("id").primaryKey().default(1),
  minimumWriterProtocol: integer("minimum_writer_protocol").notNull().default(0),
  consumersEnabled: boolean("consumers_enabled").notNull().default(false),
  generation: bigint("generation", { mode: "number" }).notNull().default(1),
  configGeneration: integer("config_generation").notNull().default(0),
  configDigest: text("config_digest"),
  releaseRecord: text("release_record").$type<SlackIngressReleaseRecord>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("slack_verified_ingress_rollout_shape", sql`
    ${t.id} = 1 AND ${t.minimumWriterProtocol} BETWEEN 0 AND 65535
    AND ${t.generation} BETWEEN 1 AND 9007199254740991
    AND ${t.configGeneration} >= 0
    AND ((${t.configGeneration} = 0 AND ${t.configDigest} IS NULL)
      OR (${t.configGeneration} > 0 AND ${t.configDigest} IS NOT NULL AND ${t.configDigest} ~ '^[0-9a-f]{64}$'))
    AND (NOT ${t.consumersEnabled} OR ${t.minimumWriterProtocol} > 0)
    AND (${t.releaseRecord} IS NULL OR ${t.releaseRecord} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND (${t.minimumWriterProtocol} = 0 OR ${t.releaseRecord} IS NOT NULL)`),
]);

export const slackVerifiedIngressServedSequence = pgSequence("slack_verified_ingress_served_seq", {
  maxValue: "9007199254740991",
  cycle: false,
});

// Compact, durable duplicate evidence after a terminal raw receipt ages out.
// It carries no message content or ciphertext and is retained independently of
// the operational queue so a delayed provider retry cannot create a duplicate.
export const slackVerifiedIngressDedupe = pgTable("slack_verified_ingress_dedupe", {
  id: uuid("id").primaryKey(),
  appRegistrationId: text("app_registration_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  providerAppId: text("provider_app_id").notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerConversationId: text("provider_conversation_id").notNull(),
  rawDigest: text("raw_digest").notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("uq_slack_verified_ingress_dedupe_identity").on(t.appRegistrationId, t.providerEventId),
  index("idx_slack_verified_ingress_dedupe_retention").on(t.appRegistrationId, t.environment, t.finishedAt, t.id),
  check("slack_verified_ingress_dedupe_digest", sql`${t.rawDigest} ~ '^[0-9a-f]{64}$'`),
]);
export const slackVerifiedIngressPartitions = pgTable("slack_verified_ingress_partitions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  appRegistrationId: text("app_registration_id").notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  partitionKind: text("partition_kind", { enum: ["conversation", "authority"] }).notNull(),
  // Empty only for authority-wide callbacks; never overload a channel ID as a sentinel.
  providerConversationId: text("provider_conversation_id").notNull(),
  lastPosition: bigint("last_position", { mode: "number" }).notNull().default(0),
  lastServedAt: timestamp("last_served_at", { withTimezone: true }),
  // Assigned from a database sequence when claimed; unlike wall time it gives
  // a strict fair rotation even when many workers claim in the same tick.
  lastServedOrdinal: bigint("last_served_ordinal", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_slack_verified_ingress_partition").on(
    t.appRegistrationId, t.environment, t.providerAuthorityId, t.partitionKind, t.providerConversationId,
  ),
  uniqueIndex("uq_slack_verified_ingress_partition_registration").on(t.id, t.appRegistrationId),
  index("idx_slack_verified_ingress_partition_fairness").on(t.lastServedOrdinal, t.id),
  check("slack_verified_ingress_partition_coordinates", sql`
    length(btrim(${t.appRegistrationId})) BETWEEN 1 AND 320
    AND length(btrim(${t.providerAuthorityId})) BETWEEN 1 AND 160
    AND ${t.environment} IN ('test', 'production')
    AND ((${t.partitionKind} = 'authority' AND ${t.providerConversationId} = '')
      OR (${t.partitionKind} = 'conversation' AND length(btrim(${t.providerConversationId})) BETWEEN 1 AND 160))
    AND ${t.lastPosition} BETWEEN 0 AND 9007199254740991
    AND (${t.lastServedOrdinal} IS NULL OR ${t.lastServedOrdinal} BETWEEN 1 AND 9007199254740991)`),
]);

export const slackVerifiedIngressEvents = pgTable("slack_verified_ingress_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  partitionId: uuid("partition_id").notNull(),
  position: bigint("position", { mode: "number" }).notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  providerAppId: text("provider_app_id").notNull(),
  rawDigest: text("raw_digest").notNull(),
  encryptedPayload: text("encrypted_payload"),
  envelopeKeyId: text("envelope_key_id"),
  state: text("state", { enum: ["queued", "processing", "materialized", "held", "quarantined", "review_required", "completed", "discarded"] }).notNull().default("queued"),
  parseFailureCount: integer("parse_failure_count").notNull().default(0),
  firstParseFailureAt: timestamp("first_parse_failure_at", { withTimezone: true }),
  heldAt: timestamp("held_at", { withTimezone: true }),
  // Identifiers only, derived from a verified receipt and its current pair.
  // Message content and display names remain solely in the encrypted payload.
  pendingAuthorInstallId: text("pending_author_install_id"),
  pendingAuthorWorkspaceId: text("pending_author_workspace_id"),
  pendingAuthorBindingId: text("pending_author_binding_id"),
  pendingAuthorActorId: text("pending_author_actor_id"),
  // An operator replay is appended behind already-admitted events, while the
  // provider's original event time stays in the encrypted payload.
  replayCount: integer("replay_count").notNull().default(0),
  lastReplayedAt: timestamp("last_replayed_at", { withTimezone: true }),
  lastIsolationReason: text("last_isolation_reason"),
  lastIsolatedAt: timestamp("last_isolated_at", { withTimezone: true }),
  lastIsolatedNormalizedId: uuid("last_isolated_normalized_id"),
  lastIsolatedNormalizedDigest: text("last_isolated_normalized_digest"),
  outcomeReason: text("outcome_reason"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  materializedInboundEventId: uuid("materialized_inbound_event_id")
    .references((): AnyPgColumn => externalInboundEvents.id, { onDelete: "restrict" }),
  // Legacy links are never proof that a normalized file set came from raw.
  normalizationSource: text("normalization_source", { enum: ["verified_raw"] }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_slack_verified_ingress_identity").on(t.appRegistrationId, t.providerEventId),
  uniqueIndex("uq_slack_verified_ingress_event_partition").on(t.id, t.partitionId),
  uniqueIndex("uq_slack_verified_ingress_position").on(t.partitionId, t.position),
  index("idx_slack_verified_ingress_work").on(t.partitionId, t.position, t.state),
  index("idx_slack_verified_ingress_active_head").on(t.partitionId, t.position)
    .where(sql`${t.state} IN ('queued', 'processing', 'materialized')`),
  index("idx_slack_verified_ingress_terminal_retention").on(t.updatedAt, t.id)
    .where(sql`${t.state} IN ('completed', 'discarded')`),
  index("idx_slack_verified_ingress_isolation_retention").on(t.heldAt, t.id)
    .where(sql`${t.state} IN ('quarantined', 'review_required')`),
  index("idx_slack_ingress_pending_author").on(t.appRegistrationId, t.pendingAuthorBindingId, t.pendingAuthorInstallId,
    t.pendingAuthorWorkspaceId, t.pendingAuthorActorId, t.partitionId, t.position)
    .where(sql`${t.state} = 'held' AND ${t.outcomeReason} = 'actor_identity_pending'`),
  check("slack_ingress_pending_author_shape", sql`
    (${t.pendingAuthorInstallId} IS NULL AND ${t.pendingAuthorWorkspaceId} IS NULL AND ${t.pendingAuthorBindingId} IS NULL AND ${t.pendingAuthorActorId} IS NULL)
    OR (${t.pendingAuthorInstallId} IS NOT NULL AND ${t.pendingAuthorWorkspaceId} IS NOT NULL
      AND ${t.pendingAuthorBindingId} IS NOT NULL AND ${t.pendingAuthorActorId} IS NOT NULL
      AND length(btrim(${t.pendingAuthorInstallId})) BETWEEN 1 AND 160 AND length(btrim(${t.pendingAuthorWorkspaceId})) BETWEEN 1 AND 320
      AND length(btrim(${t.pendingAuthorBindingId})) BETWEEN 1 AND 160 AND length(btrim(${t.pendingAuthorActorId})) BETWEEN 1 AND 160)`),
  foreignKey({
    name: "slack_verified_ingress_partition_registration_fk",
    columns: [t.partitionId, t.appRegistrationId],
    foreignColumns: [slackVerifiedIngressPartitions.id, slackVerifiedIngressPartitions.appRegistrationId],
  }).onDelete("restrict"),
  check("slack_verified_ingress_event_coordinates", sql`
    ${t.position} BETWEEN 1 AND 9007199254740991
    AND ${t.leaseGeneration} BETWEEN 0 AND 9007199254740991
    AND length(btrim(${t.appRegistrationId})) BETWEEN 1 AND 320
    AND length(btrim(${t.providerEventId})) BETWEEN 1 AND 320
    AND length(btrim(${t.providerAppId})) BETWEEN 1 AND 160
    AND ${t.rawDigest} ~ '^[0-9a-f]{64}$'
    AND (${t.outcomeReason} IS NULL OR ${t.outcomeReason} ~ '^[a-z][a-z0-9_]{0,159}$')`),
  check("slack_verified_ingress_event_custody", sql`
    ${t.state} IN ('queued', 'processing', 'materialized', 'held', 'quarantined', 'review_required', 'completed', 'discarded')
    AND ((${t.state} IN ('queued', 'processing', 'materialized', 'held', 'quarantined', 'review_required') AND ${t.encryptedPayload} IS NOT NULL
      AND octet_length(${t.encryptedPayload}) BETWEEN 1 AND 1500000
      AND ${t.envelopeKeyId} IS NOT NULL AND length(btrim(${t.envelopeKeyId})) BETWEEN 1 AND 320)
      OR (${t.state} IN ('completed', 'discarded') AND ${t.encryptedPayload} IS NULL
        AND ${t.envelopeKeyId} IS NULL AND ${t.outcomeReason} IS NOT NULL
        AND length(btrim(${t.outcomeReason})) BETWEEN 1 AND 160))
    AND ((${t.state} IN ('materialized', 'completed') AND ${t.materializedInboundEventId} IS NOT NULL)
      OR (${t.state} IN ('queued', 'processing', 'held', 'quarantined', 'review_required') AND ${t.materializedInboundEventId} IS NULL)
      OR ${t.state} = 'discarded')
    AND ${t.parseFailureCount} BETWEEN 0 AND 3
    AND ${t.replayCount} >= 0
    AND ((${t.replayCount} = 0 AND ${t.lastReplayedAt} IS NULL)
      OR (${t.replayCount} > 0 AND ${t.lastReplayedAt} IS NOT NULL))
    AND ((${t.lastIsolationReason} IS NULL AND ${t.lastIsolatedAt} IS NULL)
      OR (${t.lastIsolationReason} IS NOT NULL AND ${t.lastIsolationReason} ~ '^[a-z][a-z0-9_]{0,159}$' AND ${t.lastIsolatedAt} IS NOT NULL))
    AND ((${t.lastIsolatedNormalizedId} IS NULL AND ${t.lastIsolatedNormalizedDigest} IS NULL)
      OR (${t.lastIsolatedNormalizedId} IS NOT NULL AND ${t.lastIsolatedNormalizedDigest} IS NOT NULL
        AND ${t.lastIsolatedNormalizedDigest} ~ '^[0-9a-f]{64}$'))
    AND ((${t.parseFailureCount} = 0 AND ${t.firstParseFailureAt} IS NULL)
      OR (${t.parseFailureCount} > 0 AND ${t.firstParseFailureAt} IS NOT NULL))
    AND ((${t.state} IN ('held', 'quarantined', 'review_required') AND ${t.heldAt} IS NOT NULL AND ${t.parseFailureCount} = 3
      AND ${t.outcomeReason} IS NOT NULL) OR (${t.state} NOT IN ('held', 'quarantined', 'review_required') AND ${t.heldAt} IS NULL))`),
  check("slack_verified_ingress_event_lease", sql`
    ((${t.state} = 'processing' AND ${t.leaseOwner} IS NOT NULL AND length(btrim(${t.leaseOwner})) BETWEEN 1 AND 160
      AND ${t.leaseExpiresAt} IS NOT NULL AND ${t.leaseGeneration} > 0)
      OR (${t.state} <> 'processing' AND ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL))`),
]);

// Durable signal written in the fallback commit without reversing the raw
// worker's partition -> receipt -> normalized-event lock order.
export const slackIngressAuthorWakeSignals = pgTable("slack_ingress_author_wake_signals", {
  registrationId: text("registration_id").notNull(),
  bindingId: text("binding_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id").notNull(),
  signaledAt: timestamp("signaled_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("uq_slack_ingress_author_wake").on(t.registrationId, t.bindingId, t.installId, t.workspaceId, t.actorId),
  index("idx_slack_ingress_author_wake_expiry").on(t.expiresAt),
  check("slack_ingress_author_wake_shape", sql`length(btrim(${t.registrationId})) BETWEEN 1 AND 320
    AND length(btrim(${t.bindingId})) BETWEEN 1 AND 160 AND length(btrim(${t.installId})) BETWEEN 1 AND 160
    AND length(btrim(${t.workspaceId})) BETWEEN 1 AND 320 AND length(btrim(${t.actorId})) BETWEEN 1 AND 160
    AND ${t.expiresAt} > ${t.signaledAt}`),
]);

// One order-exception record per authorized replay. The raw event
// still contains the original provider time; replay position only controls
// processing order after other events have proceeded.
export const slackVerifiedIngressReplayAudits = pgTable("slack_verified_ingress_replay_audits", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  eventId: uuid("event_id").notNull().references(() => slackVerifiedIngressEvents.id, { onDelete: "restrict" }),
  partitionId: uuid("partition_id").notNull().references(() => slackVerifiedIngressPartitions.id, { onDelete: "restrict" }),
  previousPosition: bigint("previous_position", { mode: "number" }).notNull(),
  replayPosition: bigint("replay_position", { mode: "number" }).notNull(),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  isolationReason: text("isolation_reason").notNull(),
  replayedAt: timestamp("replayed_at", { withTimezone: true }).notNull(),
}, (t) => [
  foreignKey({ name: "slack_verified_ingress_replay_event_partition_fk", columns: [t.eventId, t.partitionId],
    foreignColumns: [slackVerifiedIngressEvents.id, slackVerifiedIngressEvents.partitionId] }).onDelete("restrict"),
  uniqueIndex("uq_slack_verified_ingress_replay_position").on(t.eventId, t.replayPosition),
  index("idx_slack_verified_ingress_replay_event").on(t.eventId, t.replayedAt),
  check("slack_verified_ingress_replay_valid", sql`${t.previousPosition} > 0 AND ${t.replayPosition} > ${t.previousPosition}
    AND ${t.actorKind} IN ('human','system') AND length(btrim(${t.actorId})) BETWEEN 1 AND 160
    AND ${t.isolationReason} ~ '^[a-z][a-z0-9_]{0,159}$'`),
]);

export const externalInboundEvents = pgTable("external_inbound_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  provider: text("provider").notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerConversationId: text("provider_conversation_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  runtimeRevision: text("runtime_revision").notNull(),
  raftChannelId: uuid("raft_channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
  privacyClass: text("privacy_class", { enum: ["public", "private"] }).notNull(),
  status: text("status", {
    enum: ["queued", "processing", "committed", "duplicate", "echo", "quarantined", "dead", "revoked"],
  }).notNull().default("queued"),
  normalizedPayloadDigest: text("normalized_payload_digest").notNull(),
  encryptedPayload: text("encrypted_payload"),
  envelopeKeyId: text("envelope_key_id"),
  payloadAadPurpose: text("payload_aad_purpose").notNull().default("external-inbound-normalized-event"),
  payloadAadVersion: integer("payload_aad_version").notNull().default(1),
  payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
  payloadExpiresAt: timestamp("payload_expires_at", { withTimezone: true }),
  payloadErasedAt: timestamp("payload_erased_at", { withTimezone: true }),
  payloadTombstoneDigest: text("payload_tombstone_digest"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  committedMessageId: uuid("committed_message_id").references(() => messages.id, { onDelete: "restrict" }),
  outcomeReason: text("outcome_reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_inbound_event_identity").on(t.provider, t.appRegistrationId, t.providerEventId),
  index("idx_external_inbound_event_work").on(t.status, t.receivedAt),
  index("idx_external_inbound_event_lease").on(t.status, t.leaseExpiresAt),
  // Deployed by the post-migration concurrent-index step, never built under
  // the migration transaction's table lock on an existing production table.
  index("idx_slack_bot_wake_window").on(t.appRegistrationId, t.installId, t.bindingId,
    t.providerConversationId, t.payloadErasedAt)
    .where(sql`${t.provider} = 'slack' AND ${t.status} = 'committed'`),
  index("idx_external_inbound_event_conversation_head").on(
    t.provider, t.environment, t.appRegistrationId, t.providerAuthorityId,
    t.providerConversationId, t.raftChannelId, t.receivedAt, t.id,
  ).where(sql`${t.status} IN ('queued', 'processing')`),
  check(
    "external_inbound_event_coordinates_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND length(btrim(${t.providerAuthorityId})) > 0
      AND length(btrim(${t.providerConversationId})) > 0
      AND length(btrim(${t.providerEventId})) > 0
      AND length(btrim(${t.bindingId})) > 0
      AND length(btrim(${t.runtimeRevision})) > 0
      AND length(${t.provider}) <= 80
      AND length(${t.appRegistrationId}) <= 320
      AND length(${t.installId}) <= 160
      AND length(${t.workspaceId}) <= 320
      AND length(${t.providerAuthorityId}) <= 160
      AND length(${t.providerConversationId}) <= 160
      AND length(${t.providerEventId}) <= 320
      AND length(${t.bindingId}) <= 160
      AND length(${t.runtimeRevision}) <= 320
      AND ${t.bindingEpoch} > 0 AND ${t.connectionEpoch} > 0
      AND ${t.privacyClass} IN ('public', 'private')
      AND ${t.environment} IN ('test', 'production')
      AND ${t.normalizedPayloadDigest} ~ '^[0-9a-f]{64}$'
      AND ${t.payloadAadPurpose} = 'external-inbound-normalized-event'
      AND ${t.payloadAadVersion} = 1 AND ${t.payloadSchemaVersion} IN (1, 2, 3, 4)`,
  ),
  check(
    "external_inbound_event_status_valid",
    sql`${t.status} IN (
      'queued', 'processing', 'committed', 'duplicate', 'echo', 'quarantined', 'dead', 'revoked'
    )`,
  ),
  check(
    "external_inbound_event_lease_shape",
    sql`(${t.status} = 'processing'
        AND ${t.leaseOwner} IS NOT NULL
        AND length(btrim(${t.leaseOwner})) > 0
        AND length(${t.leaseOwner}) <= 160
        AND ${t.leaseExpiresAt} IS NOT NULL
        AND ${t.leaseGeneration} > 0)
      OR (${t.status} <> 'processing'
        AND ${t.leaseOwner} IS NULL
        AND ${t.leaseExpiresAt} IS NULL
        AND ${t.leaseGeneration} >= 0)`,
  ),
  check(
    "external_inbound_event_custody_shape",
    sql`(${t.status} IN ('queued', 'processing')
        AND ${t.encryptedPayload} IS NOT NULL
        AND length(btrim(${t.encryptedPayload})) > 0
        AND octet_length(${t.encryptedPayload}) <= 1048576
        AND ${t.envelopeKeyId} IS NOT NULL
        AND length(btrim(${t.envelopeKeyId})) > 0
        AND length(${t.envelopeKeyId}) <= 320
        AND ${t.payloadExpiresAt} IS NOT NULL
        AND ${t.payloadExpiresAt} > ${t.receivedAt}
        AND ${t.payloadErasedAt} IS NULL
        AND ${t.payloadTombstoneDigest} IS NULL
        AND ${t.committedMessageId} IS NULL)
      OR (${t.status} NOT IN ('queued', 'processing')
        AND ${t.encryptedPayload} IS NULL
        AND ${t.envelopeKeyId} IS NULL
        AND ${t.payloadExpiresAt} IS NULL
        AND ${t.payloadErasedAt} IS NOT NULL
        AND ${t.payloadTombstoneDigest} ~ '^[0-9a-f]{64}$')`,
  ),
  check(
    "external_inbound_event_terminal_shape",
    sql`(${t.status} IN ('committed', 'duplicate', 'echo') AND ${t.committedMessageId} IS NOT NULL)
      OR (${t.status} NOT IN ('committed', 'duplicate', 'echo') AND ${t.committedMessageId} IS NULL)`,
  ),
  check(
    "external_inbound_event_reason_bounded",
    sql`${t.outcomeReason} IS NULL
      OR (length(btrim(${t.outcomeReason})) > 0 AND length(${t.outcomeReason}) <= 160)`,
  ),
]);

// One immutable provider-neutral binding epoch is one strict FIFO partition.
// Enqueue advances lastEnqueuedPosition in the source-message transaction;
// deferred migration-owned constraint triggers require the committed delivery
// positions to be the complete set 1..lastEnqueuedPosition. Only an accepted
// receipt or an exact audited skip advances cursorPosition.
// A signed Slack channel-deletion fact outlives every binding/install epoch.
// There is no expiry or administrative update path; absence is not evidence.
export const slackChannelDeletions = pgTable("slack_channel_deletions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  registrationId: uuid("registration_id").notNull(),
  environment: text("environment", { enum: ["test", "production"] }).notNull(),
  providerAppId: text("provider_app_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerConversationId: text("provider_conversation_id").notNull(),
  sourceInstallId: uuid("source_install_id").notNull(),
  sourceKind: text("source_kind", { enum: ["signed_event", "legacy_binding"] }).notNull(),
  sourceKey: text("source_key").notNull(),
  sourceBindingId: uuid("source_binding_id"),
  providerEventId: text("provider_event_id"),
  providerEventType: text("provider_event_type", { enum: ["channel_deleted", "group_deleted"] }),
  signingSecretRevision: integer("signing_secret_revision"),
  payloadSha256: text("payload_sha256"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("idx_slack_channel_deletion_source").on(t.registrationId, t.environment,
    t.providerAppId, t.providerAuthorityId, t.providerConversationId, t.sourceKey),
  index("idx_slack_channel_deletion_scope").on(t.registrationId, t.environment,
    t.providerAppId, t.providerAuthorityId, t.providerConversationId),
  check("slack_channel_deletion_evidence_valid", sql`
    ${t.environment} IN ('test', 'production')
    AND length(btrim(${t.sourceKey})) BETWEEN 1 AND 400
    AND ((${t.sourceKind} = 'signed_event' AND ${t.providerEventType} IS NOT NULL AND ${t.providerEventType} IN ('channel_deleted', 'group_deleted')
      AND ${t.providerEventId} IS NOT NULL AND length(btrim(${t.providerEventId})) BETWEEN 1 AND 320
      AND ${t.signingSecretRevision} IS NOT NULL AND ${t.signingSecretRevision} > 0
      AND ${t.payloadSha256} IS NOT NULL AND ${t.payloadSha256} ~ '^[0-9a-f]{64}$')
      OR (${t.sourceKind} = 'legacy_binding' AND ${t.sourceBindingId} IS NOT NULL
        AND ${t.providerEventId} IS NULL AND ${t.providerEventType} IS NULL
        AND ${t.signingSecretRevision} IS NULL AND ${t.payloadSha256} IS NULL))
    AND length(btrim(${t.providerAppId})) BETWEEN 1 AND 160
    AND length(btrim(${t.providerAuthorityId})) BETWEEN 1 AND 160
    AND length(btrim(${t.providerConversationId})) BETWEEN 1 AND 160`),
]);

export const externalDeliveryPartitions = pgTable("external_delivery_partitions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  lastEnqueuedPosition: bigint("last_enqueued_position", { mode: "number" }).notNull().default(0),
  cursorPosition: bigint("cursor_position", { mode: "number" }).notNull().default(0),
  // Pair queue health, independent of a particular message's retry age.
  authorityBlockedAt: timestamp("authority_blocked_at", { withTimezone: true }),
  authorityBlockedReason: text("authority_blocked_reason"),
  authorityRetryAt: timestamp("authority_retry_at", { withTimezone: true }),
  authorityOverdueAlertedAt: timestamp("authority_overdue_alerted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("external_delivery_partition_epoch_unique").on(t.bindingId, t.bindingEpoch),
  check(
    "external_delivery_partition_positions_valid",
    sql`length(btrim(${t.bindingId})) > 0
      AND length(${t.bindingId}) <= 160
      AND ${t.bindingEpoch} > 0
      AND ${t.lastEnqueuedPosition} >= 0
      AND ${t.cursorPosition} >= 0
      AND ${t.cursorPosition} <= ${t.lastEnqueuedPosition}`,
  ),
]);

// Provider-neutral durable outbound work. The render snapshot and purpose-
// bound reconciliation marker are frozen at source-message commit time;
// credentials, tokens and provider free-form errors never enter this row.
export const externalOutboundDeliveries = pgTable("external_outbound_deliveries", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  sourceMessageId: uuid("source_message_id").notNull().references(() => messages.id, { onDelete: "restrict" }),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  partitionPosition: bigint("partition_position", { mode: "number" }).notNull(),
  deliveryContractVersion: text("delivery_contract_version").notNull().default("slack-bridge-delivery.v1"),
  enqueueRuntimeRevision: text("enqueue_runtime_revision").notNull(),
  state: text("state", {
    enum: [
      "not_queued",
      "queued",
      "dispatching",
      "accepted",
      "retry_wait",
      "outcome_unknown",
      "dead",
      "skipped",
      "revoked",
      "quarantined",
    ],
  }).notNull().default("queued"),
  renderSnapshotSchema: text("render_snapshot_schema").notNull().default("slack-bridge-render-snapshot.v5"),
  renderSnapshot: jsonb("render_snapshot").$type<Record<string, unknown>>().notNull(),
  renderSnapshotDigest: text("render_snapshot_digest").notNull(),
  // Points at an immutable plan revision only after the old-worker fence is
  // enforced. The original snapshot and reconciliation marker never change.
  attachmentFallbackPlanRevision: integer("attachment_fallback_plan_revision"),
  reconciliationMarker: text("reconciliation_marker").notNull(),
  reconciliationScan: jsonb("reconciliation_scan").$type<SlackReconciliationScan>(),
  providerAttempts: integer("provider_attempts").notNull().default(0),
  ambiguityBudgetProviderAttempts: integer("ambiguity_budget_provider_attempts").notNull().default(0),
  dispatchedFailureAttempts: integer("dispatched_failure_attempts").notNull().default(0),
  firstDispatchedAt: timestamp("first_dispatched_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  leaseOriginState: text("lease_origin_state", {
    enum: ["queued", "retry_wait", "outcome_unknown", "dead"],
  }),
  leaseOriginNextAttemptAt: timestamp("lease_origin_next_attempt_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  stateReason: text("state_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("external_outbound_delivery_exact_coordinates_unique")
    .on(t.id, t.bindingId, t.bindingEpoch, t.partitionPosition),
  unique("external_outbound_delivery_exact_source_unique")
    .on(t.id, t.bindingId, t.bindingEpoch, t.sourceMessageId),
  uniqueIndex("idx_external_outbound_delivery_source_epoch")
    .on(t.sourceMessageId, t.bindingId, t.bindingEpoch),
  uniqueIndex("idx_external_outbound_delivery_partition_position")
    .on(t.bindingId, t.bindingEpoch, t.partitionPosition),
  uniqueIndex("idx_external_outbound_delivery_reconciliation_marker")
    .on(t.reconciliationMarker),
  index("idx_external_outbound_delivery_head")
    .on(t.bindingId, t.bindingEpoch, t.state, t.partitionPosition),
  index("idx_external_outbound_delivery_retry")
    .on(t.state, t.nextAttemptAt),
  index("idx_external_outbound_delivery_lease")
    .on(t.state, t.leaseExpiresAt),
  foreignKey({
    columns: [t.bindingId, t.bindingEpoch],
    foreignColumns: [externalDeliveryPartitions.bindingId, externalDeliveryPartitions.bindingEpoch],
    name: "external_outbound_deliveries_partition_fk",
  }).onDelete("restrict"),
  check(
    "external_outbound_delivery_contract_valid",
    sql`${t.deliveryContractVersion} = 'slack-bridge-delivery.v1'
      AND ${t.renderSnapshotSchema} IN ('slack-bridge-render-snapshot.v3', 'slack-bridge-render-snapshot.v4', 'slack-bridge-render-snapshot.v5')`,
  ),
  check(
    "external_outbound_delivery_state_valid",
    sql`${t.state} IN (
      'not_queued', 'queued', 'dispatching', 'accepted', 'retry_wait',
      'outcome_unknown', 'dead', 'skipped', 'revoked', 'quarantined'
    )`,
  ),
  check(
    "external_outbound_delivery_coordinates_valid",
    sql`length(btrim(${t.bindingId})) > 0
      AND length(${t.bindingId}) <= 160
      AND ${t.bindingEpoch} > 0
      AND ${t.partitionPosition} > 0
      AND length(btrim(${t.enqueueRuntimeRevision})) > 0
      AND length(${t.enqueueRuntimeRevision}) <= 160
      AND ${t.renderSnapshotDigest} ~ '^[0-9a-f]{64}$'
      AND ${t.reconciliationMarker} ~ '^[A-Za-z0-9_-]{43}$'`,
  ),
  check("slack_attachment_fallback_revision_valid", sql`${t.attachmentFallbackPlanRevision} IS NULL
    OR ${t.attachmentFallbackPlanRevision} > 0`),
  check(
    "external_outbound_delivery_attempts_valid",
    sql`${t.providerAttempts} >= 0
      AND ${t.ambiguityBudgetProviderAttempts} >= 0
      AND ${t.ambiguityBudgetProviderAttempts} <= ${t.providerAttempts}
      AND ${t.dispatchedFailureAttempts} >= 0
      AND ${t.dispatchedFailureAttempts} <= 24
      AND ${t.dispatchedFailureAttempts} <= ${t.providerAttempts}
      AND ((${t.providerAttempts} = 0 AND ${t.firstDispatchedAt} IS NULL)
        OR (${t.providerAttempts} > 0 AND ${t.firstDispatchedAt} IS NOT NULL))
      AND (${t.state} NOT IN ('accepted', 'retry_wait', 'outcome_unknown', 'dead')
        OR ${t.providerAttempts} > 0)`,
  ),
  check(
    "external_outbound_delivery_retry_shape",
    sql`(${t.state} = 'retry_wait' AND ${t.nextAttemptAt} IS NOT NULL)
      OR (${t.state} <> 'retry_wait' AND ${t.nextAttemptAt} IS NULL)`,
  ),
  check(
    "external_outbound_delivery_lease_shape",
    sql`(${t.state} = 'dispatching'
        AND ${t.leaseOwner} IS NOT NULL
        AND length(btrim(${t.leaseOwner})) > 0
        AND length(${t.leaseOwner}) <= 160
        AND ${t.leaseExpiresAt} IS NOT NULL
        AND ${t.leaseGeneration} > 0
        AND ${t.leaseOriginState} IN ('queued', 'retry_wait', 'outcome_unknown', 'dead')
        AND ((${t.leaseOriginState} = 'retry_wait' AND ${t.leaseOriginNextAttemptAt} IS NOT NULL)
          OR (${t.leaseOriginState} <> 'retry_wait' AND ${t.leaseOriginNextAttemptAt} IS NULL)))
      OR (${t.state} <> 'dispatching'
        AND ${t.leaseOwner} IS NULL
        AND ${t.leaseExpiresAt} IS NULL
        AND ${t.leaseOriginState} IS NULL
        AND ${t.leaseOriginNextAttemptAt} IS NULL
        AND ${t.leaseGeneration} >= 0)`,
  ),
  check(
    "external_outbound_delivery_acceptance_shape",
    sql`(${t.state} = 'accepted'
        AND ${t.providerMessageId} IS NOT NULL
        AND length(btrim(${t.providerMessageId})) > 0
        AND length(${t.providerMessageId}) <= 160
        AND ${t.acceptedAt} IS NOT NULL)
      OR (${t.state} <> 'accepted' AND ${t.providerMessageId} IS NULL AND ${t.acceptedAt} IS NULL)`,
  ),
  check(
    "external_outbound_delivery_reason_bounded",
    sql`${t.stateReason} IS NULL
      OR (length(btrim(${t.stateReason})) > 0 AND length(${t.stateReason}) <= 160)`,
  ),
]);

// Manager decisions are immutable, exact-coordinate one-shot authorities.
// Consumption is coupled to either attempt start or cursor-advancing skip.
export const externalDeliveryOperatorDecisions = pgTable("external_delivery_operator_decisions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  partitionPosition: bigint("partition_position", { mode: "number" }).notNull(),
  action: text("action", { enum: ["retry_in_place", "skip"] }).notNull(),
  actorType: text("actor_type", { enum: ["user", "agent"] }).notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  duplicateRiskAcknowledged: boolean("duplicate_risk_acknowledged").notNull().default(false),
  dataLossAcknowledged: boolean("data_loss_acknowledged").notNull().default(false),
  decisionRevision: integer("decision_revision").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedLeaseGeneration: bigint("consumed_lease_generation", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("external_delivery_operator_decision_retry_authority_unique")
    .on(t.id, t.deliveryId, t.action),
  index("idx_external_delivery_operator_decision_delivery").on(t.deliveryId, t.createdAt),
  foreignKey({
    columns: [t.deliveryId, t.bindingId, t.bindingEpoch, t.partitionPosition],
    foreignColumns: [
      externalOutboundDeliveries.id,
      externalOutboundDeliveries.bindingId,
      externalOutboundDeliveries.bindingEpoch,
      externalOutboundDeliveries.partitionPosition,
    ],
    name: "external_delivery_operator_decisions_exact_delivery_fk",
  }).onDelete("restrict"),
  check(
    "external_delivery_operator_decision_coordinates_valid",
    sql`length(btrim(${t.bindingId})) > 0
      AND length(${t.bindingId}) <= 160
      AND ${t.bindingEpoch} > 0
      AND ${t.partitionPosition} > 0
      AND ${t.decisionRevision} > 0
      AND length(btrim(${t.actorId})) > 0
      AND length(${t.actorId}) <= 160
      AND length(btrim(${t.reason})) > 0
      AND length(${t.reason}) <= 320`,
  ),
  check(
    "external_delivery_operator_decision_closed_values",
    sql`${t.action} IN ('retry_in_place', 'skip')
      AND ${t.actorType} IN ('user', 'agent')`,
  ),
  check(
    "external_delivery_operator_decision_ack_valid",
    sql`(${t.action} = 'retry_in_place'
        AND ${t.duplicateRiskAcknowledged} = true
        AND ${t.dataLossAcknowledged} = false)
      OR (${t.action} = 'skip'
        AND ${t.duplicateRiskAcknowledged} = false
        AND ${t.dataLossAcknowledged} = true)`,
  ),
  check(
    "external_delivery_operator_decision_consumption_shape",
    sql`(${t.consumedAt} IS NULL AND ${t.consumedLeaseGeneration} IS NULL)
      OR (${t.consumedAt} IS NOT NULL
        AND ${t.consumedLeaseGeneration} IS NOT NULL
        AND ${t.consumedLeaseGeneration} > 0)`,
  ),
]);

// A row is inserted and parent counters advance in the same transaction
// immediately before provider I/O. It is durable evidence, not authorization.
export const externalDeliveryAttempts = pgTable("external_delivery_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id").notNull().references(() => externalOutboundDeliveries.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull(),
  runtimeRevision: text("runtime_revision").notNull(),
  credentialRevision: integer("credential_revision").notNull(),
  dispatchAuthorization: text("dispatch_authorization", { enum: ["automatic", "audited_retry_in_place"] }).notNull(),
  operatorDecisionId: uuid("operator_decision_id"),
  operatorDecisionAction: text("operator_decision_action", { enum: ["retry_in_place"] }),
  providerIoStartedAt: timestamp("provider_io_started_at", { withTimezone: true }).notNull(),
  outcome: text("outcome", {
    enum: [
      "provider_io_started",
      "accepted",
      "rate_limited",
      "transient_failure",
      "deterministic_failure",
      "outcome_unknown",
    ],
  }).notNull().default("provider_io_started"),
  outcomeReason: text("outcome_reason"),
  retryAfterMs: integer("retry_after_ms"),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_delivery_attempt_number").on(t.deliveryId, t.attemptNumber),
  uniqueIndex("idx_external_delivery_attempt_lease_generation").on(t.deliveryId, t.leaseGeneration),
  index("idx_external_delivery_attempt_started").on(t.outcome, t.providerIoStartedAt),
  foreignKey({
    columns: [t.operatorDecisionId, t.deliveryId, t.operatorDecisionAction],
    foreignColumns: [
      externalDeliveryOperatorDecisions.id,
      externalDeliveryOperatorDecisions.deliveryId,
      externalDeliveryOperatorDecisions.action,
    ],
    name: "external_delivery_attempts_retry_decision_fk",
  }).onDelete("restrict"),
  check(
    "external_delivery_attempt_coordinates_valid",
    sql`${t.attemptNumber} > 0
      AND ${t.leaseGeneration} > 0
      AND ${t.credentialRevision} > 0
      AND length(btrim(${t.runtimeRevision})) > 0
      AND length(${t.runtimeRevision}) <= 160`,
  ),
  check(
    "external_delivery_attempt_authorization_valid",
    sql`(${t.dispatchAuthorization} = 'automatic'
        AND ${t.operatorDecisionId} IS NULL
        AND ${t.operatorDecisionAction} IS NULL)
      OR (${t.dispatchAuthorization} = 'audited_retry_in_place'
        AND ${t.operatorDecisionId} IS NOT NULL
        AND ${t.operatorDecisionAction} = 'retry_in_place')`,
  ),
  check(
    "external_delivery_attempt_closed_values",
    sql`${t.dispatchAuthorization} IN ('automatic', 'audited_retry_in_place')
      AND ${t.outcome} IN (
        'provider_io_started', 'accepted', 'rate_limited', 'transient_failure',
        'deterministic_failure', 'outcome_unknown'
      )`,
  ),
  check(
    "external_delivery_attempt_outcome_shape",
    sql`(${t.outcome} = 'provider_io_started'
        AND ${t.terminalAt} IS NULL
        AND ${t.outcomeReason} IS NULL
        AND ${t.retryAfterMs} IS NULL)
      OR (${t.outcome} <> 'provider_io_started'
        AND ${t.terminalAt} IS NOT NULL
        AND ${t.outcomeReason} IS NOT NULL
        AND length(btrim(${t.outcomeReason})) > 0
        AND length(${t.outcomeReason}) <= 160
        AND ((${t.outcome} = 'rate_limited'
            AND ${t.retryAfterMs} IS NOT NULL
            AND ${t.retryAfterMs} >= 0)
          OR (${t.outcome} <> 'rate_limited' AND ${t.retryAfterMs} IS NULL)))`,
  ),
]);

// One current-epoch Raft identity maps to at most one provider identity.
// Unknown outbound placeholders keep providerMessageId null until accepted
// delivery or reconciliation proves the provider identity.
export const externalMessageLinks = pgTable("external_message_links", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id"),
  provider: text("provider").notNull(),
  installId: text("install_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerConversationId: text("provider_conversation_id").notNull(),
  providerMessageId: text("provider_message_id"),
  providerThreadId: text("provider_thread_id"),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  raftMessageId: uuid("raft_message_id").notNull().references(() => messages.id, { onDelete: "restrict" }),
  raftCanonicalRootMessageId: uuid("raft_canonical_root_message_id").references(() => messages.id, { onDelete: "restrict" }),
  firstDirection: text("first_direction", { enum: ["raft_outbound", "provider_inbound"] }).notNull(),
  // Exact provider edit ordering, independent of local commit time.
  lastProviderEditTs: text("last_provider_edit_ts"),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  outcomeState: text("outcome_state", { enum: ["unknown", "accepted"] }).notNull(),
  authorityState: text("authority_state", { enum: ["active", "stale"] }).notNull().default("active"),
  stateReason: text("state_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_message_link_delivery")
    .on(t.deliveryId)
    .where(sql`${t.deliveryId} IS NOT NULL`),
  uniqueIndex("idx_external_message_link_provider_identity")
    .on(t.provider, t.installId, t.providerAuthorityId, t.providerConversationId, t.providerMessageId)
    .where(sql`${t.providerMessageId} IS NOT NULL`),
  uniqueIndex("idx_external_message_link_raft_identity")
    .on(t.bindingId, t.bindingEpoch, t.raftMessageId),
  foreignKey({
    columns: [t.deliveryId, t.bindingId, t.bindingEpoch, t.raftMessageId],
    foreignColumns: [
      externalOutboundDeliveries.id,
      externalOutboundDeliveries.bindingId,
      externalOutboundDeliveries.bindingEpoch,
      externalOutboundDeliveries.sourceMessageId,
    ],
    name: "external_message_links_exact_delivery_fk",
  }).onDelete("restrict"),
  check(
    "external_message_link_coordinates_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(${t.provider}) <= 80
      AND length(btrim(${t.installId})) > 0
      AND length(${t.installId}) <= 160
      AND length(btrim(${t.providerAuthorityId})) > 0
      AND length(${t.providerAuthorityId}) <= 160
      AND length(btrim(${t.providerConversationId})) > 0
      AND length(${t.providerConversationId}) <= 160
      AND length(btrim(${t.bindingId})) > 0
      AND length(${t.bindingId}) <= 160
      AND ${t.bindingEpoch} > 0
      AND ${t.connectionEpoch} > 0
      AND (${t.providerMessageId} IS NULL
        OR (length(btrim(${t.providerMessageId})) > 0 AND length(${t.providerMessageId}) <= 160))
      AND (${t.providerThreadId} IS NULL
        OR (length(btrim(${t.providerThreadId})) > 0 AND length(${t.providerThreadId}) <= 160))
      AND ${t.payloadFingerprint} ~ '^[0-9a-f]{64}$'
      AND (${t.stateReason} IS NULL
        OR (length(btrim(${t.stateReason})) > 0 AND length(${t.stateReason}) <= 160))`,
  ),
  check(
    "external_message_link_closed_values",
    sql`${t.firstDirection} IN ('raft_outbound', 'provider_inbound')
      AND ${t.outcomeState} IN ('unknown', 'accepted')
      AND ${t.authorityState} IN ('active', 'stale')`,
  ),
  check(
    "external_message_link_outcome_shape",
    sql`(${t.outcomeState} = 'unknown' AND ${t.providerMessageId} IS NULL)
      OR (${t.outcomeState} = 'accepted' AND ${t.providerMessageId} IS NOT NULL)`,
  ),
]);

/** Why a card's Slack sync ended (RFC 082 §4.6); nothing is posted or edited after it. */
export const EXTERNAL_CARD_EDIT_END_REASONS = [
  // The original ended without a Slack id (it belongs to its delivery and ends with it):
  "original_not_sent", // known never sent: refused or ended before dispatch
  "original_unknown_skipped", // its outcome was unknown, then an admin skipped it
  "original_unknown_ended", // its outcome was unknown, then its target was deleted
  "message_not_found", // Slack answered message_not_found for the stored ts
  "identity_changed", // the pair epoch, installation or bot identity is not the original's
  "source_deleted", // the Raft message was deleted or retracted: no new edit starts
  "card_has_files", // a stored card message with files anyway (never a normal case): its updates can't be shown in Slack
  "sender_removed", // the card's sender is no longer allowed to post
] as const;

/** A card message's Slack notices, one per pair (binding epoch) and kind (RFC 082 §4.6). */
export const EXTERNAL_CARD_EDIT_NOTICE_KINDS = [
  "not_confirmed", // "not confirmed in Slack": a sync's uncertainty latch is at least T old
  "latest_update_not_shown", // Slack definitely refused a sync's current latest revision (msg_too_long)
  // The safe fallback for a stored card message that has files anyway (a send
  // with both is refused, RFC 082 §4.1; only a row stored before the refusal,
  // or by a path that skipped it, has them): its updates are never edited.
  "updates_cannot_be_shown",
  "edit_waiting", // a sync is held (a kept failure, an unmatched audience, a pause): edits wait
] as const;

// RFC 082 §4.6: a card message's updates edit its bridged Slack copy. One row
// per original outbound delivery (one message at one pair epoch), written in
// the card update's own transaction: the latest revision to sync. The frozen
// send snapshot on the delivery is never rewritten. The row holds three
// independent facts: `uncertain_at` (a latch, set by the first unknown
// outcome, never cleared), the latest result (`succeeded_revision` /
// `refused_revision` compared with `latest_revision`), and pending work (a
// revision Slack is not known to show, or an attempt in flight). The lease
// fences Raft's own writes; it cannot cancel a request Slack already received.
export const externalCardEditSyncs = pgTable("external_card_edit_syncs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id").notNull(),
  sourceMessageId: uuid("source_message_id").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  latestRevision: integer("latest_revision").notNull(),
  // What Slack is believed to show: the last definite success, or what a
  // read-back found (an older revision there means: send the latest again).
  shownRevision: integer("shown_revision"),
  succeededRevision: integer("succeeded_revision"),
  refusedRevision: integer("refused_revision"),
  refusedReason: text("refused_reason"),
  uncertainAt: timestamp("uncertain_at", { withTimezone: true }),
  state: text("state", { enum: ["open", "ended"] }).notNull().default("open"),
  endReason: text("end_reason", { enum: EXTERNAL_CARD_EDIT_END_REASONS }),
  // A kept failure or wait that holds the next edit (shown to the pair's admins).
  holdReason: text("hold_reason"),
  retryCount: integer("retry_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  // After an unknown outcome nothing more is sent before this.
  quietUntil: timestamp("quiet_until", { withTimezone: true }),
  // 0: no read-back planned; 1: the first read-back after the quiet period; 2: the later recheck.
  readbackStage: smallint("readback_stage").notNull().default(0),
  readbackDueAt: timestamp("readback_due_at", { withTimezone: true }),
  // First time a read-back after an unknown outcome could not read the message
  // or found an older revision it cannot replace: "not confirmed" at once.
  readbackProblemAt: timestamp("readback_problem_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  // Start of the current not-confirmed stretch; the pair notice follows after T.
  notConfirmedSince: timestamp("not_confirmed_since", { withTimezone: true }),
  noticeKind: text("notice_kind", { enum: EXTERNAL_CARD_EDIT_NOTICE_KINDS }),
  noticeAt: timestamp("notice_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_card_edit_sync_delivery").on(t.deliveryId),
  uniqueIndex("idx_external_card_edit_sync_source_epoch").on(t.sourceMessageId, t.bindingId, t.bindingEpoch),
  index("idx_external_card_edit_sync_due").on(t.state, t.nextAttemptAt),
  index("idx_external_card_edit_sync_lease").on(t.state, t.leaseExpiresAt),
  index("idx_external_card_edit_sync_not_confirmed").on(t.state, t.notConfirmedSince),
  // The pair's notices are recomputed from its syncs in every transaction that changes one.
  index("idx_external_card_edit_sync_pair").on(t.bindingId, t.bindingEpoch, t.state),
  foreignKey({
    columns: [t.deliveryId, t.bindingId, t.bindingEpoch, t.sourceMessageId],
    foreignColumns: [
      externalOutboundDeliveries.id,
      externalOutboundDeliveries.bindingId,
      externalOutboundDeliveries.bindingEpoch,
      externalOutboundDeliveries.sourceMessageId,
    ],
    name: "external_card_edit_syncs_exact_delivery_fk",
  }).onDelete("restrict"),
  check(
    "external_card_edit_sync_revisions_valid",
    sql`${t.latestRevision} >= 2
      AND (${t.shownRevision} IS NULL OR (${t.shownRevision} >= 1 AND ${t.shownRevision} <= ${t.latestRevision}))
      AND (${t.succeededRevision} IS NULL OR (${t.succeededRevision} >= 2 AND ${t.succeededRevision} <= ${t.latestRevision}))
      AND (${t.refusedRevision} IS NULL OR (${t.refusedRevision} >= 2 AND ${t.refusedRevision} <= ${t.latestRevision}))
      AND ((${t.refusedRevision} IS NULL) = (${t.refusedReason} IS NULL))
      AND (${t.refusedReason} IS NULL OR (length(btrim(${t.refusedReason})) > 0 AND length(${t.refusedReason}) <= 160))
      AND (${t.holdReason} IS NULL OR (length(btrim(${t.holdReason})) > 0 AND length(${t.holdReason}) <= 160))
      AND ${t.retryCount} >= 0 AND ${t.leaseGeneration} >= 0 AND ${t.bindingEpoch} > 0
      AND length(btrim(${t.bindingId})) > 0 AND length(${t.bindingId}) <= 160`,
  ),
  check(
    "external_card_edit_sync_state_shape",
    sql`((${t.state} = 'open' AND ${t.endReason} IS NULL) OR (${t.state} = 'ended' AND ${t.endReason} IS NOT NULL))
      AND ((${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL)
        OR (${t.state} = 'open' AND ${t.leaseOwner} IS NOT NULL AND length(btrim(${t.leaseOwner})) > 0
          AND length(${t.leaseOwner}) <= 160 AND ${t.leaseExpiresAt} IS NOT NULL AND ${t.leaseGeneration} > 0))
      AND ${t.readbackStage} IN (0, 1, 2)
      AND ((${t.readbackStage} = 0) = (${t.readbackDueAt} IS NULL))
      AND ((${t.noticeKind} IS NULL) = (${t.noticeAt} IS NULL))`,
  ),
]);

// One row per edit attempt, committed in its own transaction before the
// network call (`sending`). Only the sync lease's current holder, at its
// current generation and before it expires, records the outcome; an attempt
// left `sending` after a restart or lease loss is recovered as `unknown`.
export const externalCardEditAttempts = pgTable("external_card_edit_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  syncId: uuid("sync_id").notNull().references(() => externalCardEditSyncs.id, { onDelete: "restrict" }),
  deliveryId: uuid("delivery_id").notNull(),
  sourceMessageId: uuid("source_message_id").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  cardRevision: integer("card_revision").notNull(),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull(),
  state: text("state", { enum: ["sending", "succeeded", "failed", "unknown"] }).notNull().default("sending"),
  outcomeReason: text("outcome_reason"),
  providerIoStartedAt: timestamp("provider_io_started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_card_edit_attempt_lease").on(t.syncId, t.leaseGeneration),
  index("idx_external_card_edit_attempt_state").on(t.state, t.providerIoStartedAt),
  check(
    "external_card_edit_attempt_shape",
    sql`${t.cardRevision} >= 2 AND ${t.leaseGeneration} > 0 AND ${t.bindingEpoch} > 0
      AND ${t.state} IN ('sending', 'succeeded', 'failed', 'unknown')
      AND ((${t.state} = 'sending' AND ${t.completedAt} IS NULL AND ${t.outcomeReason} IS NULL)
        OR (${t.state} <> 'sending' AND ${t.completedAt} IS NOT NULL AND ${t.outcomeReason} IS NOT NULL
          AND length(btrim(${t.outcomeReason})) > 0 AND length(${t.outcomeReason}) <= 160))`,
  ),
]);

// A card's Slack notice to the pair's admins, deduplicated across that pair's
// messages: one row per pair epoch and kind. Operators read it here; the setup
// health shows it to the admins who can see the channel.
export const externalCardEditPairNotices = pgTable("external_card_edit_pair_notices", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  kind: text("kind", { enum: EXTERNAL_CARD_EDIT_NOTICE_KINDS }).notNull(),
  // edit_waiting: the kept failure (a pair block reason such as slack_not_in_channel).
  reason: text("reason"),
  lastSyncId: uuid("last_sync_id").notNull(),
  firstRaisedAt: timestamp("first_raised_at", { withTimezone: true }).notNull(),
  lastRaisedAt: timestamp("last_raised_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("idx_external_card_edit_pair_notice").on(t.bindingId, t.bindingEpoch, t.kind),
  check(
    "external_card_edit_pair_notice_valid",
    sql`${t.bindingEpoch} > 0 AND length(btrim(${t.bindingId})) > 0 AND length(${t.bindingId}) <= 160
      AND ${t.kind} IN ('not_confirmed', 'latest_update_not_shown', 'updates_cannot_be_shown', 'edit_waiting')
      AND (${t.reason} IS NULL OR (length(btrim(${t.reason})) > 0 AND length(${t.reason}) <= 160))
      AND ${t.lastRaisedAt} >= ${t.firstRaisedAt}`,
  ),
]);

// Provider reactions remain external identity facts rather than pretending an
// external actor is a Raft user/agent. Current presence is materialized from
// ordered provider observations and joins the canonical reaction read model.
export const externalReactionStates = pgTable("external_reaction_states", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  messageLinkId: uuid("message_link_id").notNull().references(() => externalMessageLinks.id, { onDelete: "cascade" }),
  raftMessageId: uuid("raft_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  projectionId: uuid("projection_id").notNull().references(() => externalActorProjections.id, { onDelete: "restrict" }),
  providerReactionKey: text("provider_reaction_key").notNull(),
  canonicalEmoji: text("canonical_emoji").notNull(),
  mappingRevision: integer("mapping_revision").notNull(),
  present: boolean("present").notNull(),
  lastProviderEventId: text("last_provider_event_id").notNull(),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
  lastEventSequence: bigint("last_event_sequence", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_reaction_state_identity").on(
    t.bindingId,
    t.bindingEpoch,
    t.messageLinkId,
    t.projectionId,
    t.providerReactionKey,
  ),
  index("idx_external_reaction_state_message").on(t.raftMessageId, t.canonicalEmoji, t.present),
  check(
    "external_reaction_state_valid",
    sql`length(btrim(${t.provider})) > 0 AND length(${t.provider}) <= 80
      AND length(btrim(${t.appRegistrationId})) > 0 AND length(${t.appRegistrationId}) <= 320
      AND length(btrim(${t.installId})) > 0 AND length(${t.installId}) <= 160
      AND length(btrim(${t.workspaceId})) > 0 AND length(${t.workspaceId}) <= 320
      AND length(btrim(${t.bindingId})) > 0 AND length(${t.bindingId}) <= 160
      AND length(btrim(${t.providerReactionKey})) > 0 AND length(${t.providerReactionKey}) <= 160
      AND length(btrim(${t.canonicalEmoji})) > 0 AND length(${t.canonicalEmoji}) <= 32
      AND length(btrim(${t.lastProviderEventId})) > 0 AND length(${t.lastProviderEventId}) <= 320
      AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0 AND ${t.mappingRevision} > 0
      AND ${t.lastEventSequence} > 0`,
  ),
]);

export const externalReactionFacts = pgTable("external_reaction_facts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  inboundEventId: uuid("inbound_event_id").notNull().references(() => externalInboundEvents.id, { onDelete: "cascade" }),
  providerEventId: text("provider_event_id").notNull(),
  operation: text("operation", { enum: ["add", "remove"] }).notNull(),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  messageLinkId: uuid("message_link_id").notNull().references(() => externalMessageLinks.id, { onDelete: "restrict" }),
  raftMessageId: uuid("raft_message_id").notNull().references(() => messages.id, { onDelete: "restrict" }),
  projectionId: uuid("projection_id").references(() => externalActorProjections.id, { onDelete: "restrict" }),
  externalActorId: text("external_actor_id").notNull(),
  providerReactionKey: text("provider_reaction_key").notNull(),
  canonicalEmoji: text("canonical_emoji"),
  mappingRevision: integer("mapping_revision").notNull(),
  eventOccurredAt: timestamp("event_occurred_at", { withTimezone: true }).notNull(),
  eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
  outcome: text("outcome", {
    enum: ["applied", "noop", "stale", "quarantined", "bot_echo", "unsupported"],
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_reaction_fact_event").on(t.provider, t.appRegistrationId, t.providerEventId),
  index("idx_external_reaction_fact_message").on(t.raftMessageId, t.eventOccurredAt),
  check(
    "external_reaction_fact_valid",
    sql`${t.operation} IN ('add', 'remove')
      AND ${t.outcome} IN ('applied', 'noop', 'stale', 'quarantined', 'bot_echo', 'unsupported')
      AND length(btrim(${t.providerEventId})) > 0 AND length(${t.providerEventId}) <= 320
      AND length(btrim(${t.providerReactionKey})) > 0 AND length(${t.providerReactionKey}) <= 160
      AND length(btrim(${t.externalActorId})) > 0 AND length(${t.externalActorId}) <= 160
      AND (${t.canonicalEmoji} IS NULL OR (
        length(btrim(${t.canonicalEmoji})) > 0 AND length(${t.canonicalEmoji}) <= 32
      ))
      AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0 AND ${t.mappingRevision} > 0
      AND ${t.eventSequence} > 0
      AND ((${t.outcome} IN ('bot_echo', 'unsupported') AND ${t.projectionId} IS NULL)
        OR (${t.outcome} NOT IN ('bot_echo', 'unsupported') AND ${t.projectionId} IS NOT NULL))`,
  ),
]);

export const externalReactionCommands = pgTable("external_reaction_commands", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  messageLinkId: uuid("message_link_id").notNull().references(() => externalMessageLinks.id, { onDelete: "cascade" }),
  raftMessageId: uuid("raft_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  providerConversationId: text("provider_conversation_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  providerReactionKey: text("provider_reaction_key").notNull(),
  canonicalEmoji: text("canonical_emoji").notNull(),
  mappingRevision: integer("mapping_revision").notNull(),
  desiredRevision: integer("desired_revision").notNull(),
  desiredPresent: boolean("desired_present").notNull(),
  localDiscussionVersion: bigint("local_discussion_version", { mode: "number" }).notNull(),
  localAggregateCount: integer("local_aggregate_count").notNull(),
  sourceSnapshotDigest: text("source_snapshot_digest").notNull(),
  state: text("state", {
    enum: [
      "queued", "dispatching", "retry_wait", "outcome_unknown", "accepted", "superseded",
      "deterministic_failure", "revoked", "quarantined",
    ],
  }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: integer("lease_generation").notNull().default(0),
  lastErrorClass: text("last_error_class"),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_reaction_command_revision")
    .on(t.messageLinkId, t.providerReactionKey, t.desiredRevision),
  index("idx_external_reaction_command_due").on(t.state, t.nextAttemptAt),
  check(
    "external_reaction_command_valid",
    sql`length(btrim(${t.provider})) > 0 AND length(${t.provider}) <= 80
      AND length(btrim(${t.providerReactionKey})) > 0 AND length(${t.providerReactionKey}) <= 160
      AND length(btrim(${t.canonicalEmoji})) > 0 AND length(${t.canonicalEmoji}) <= 32
      AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0 AND ${t.mappingRevision} > 0
      AND ${t.desiredRevision} > 0 AND ${t.localDiscussionVersion} >= 0 AND ${t.localAggregateCount} >= 0
      AND ${t.sourceSnapshotDigest} ~ '^[0-9a-f]{64}$'
      AND ${t.state} IN (
        'queued', 'dispatching', 'retry_wait', 'outcome_unknown', 'accepted', 'superseded',
        'deterministic_failure', 'revoked', 'quarantined'
      )
      AND ${t.attempts} >= 0 AND ${t.leaseGeneration} >= 0
      AND (${t.state} = 'dispatching') = (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)
      AND (${t.state} IN ('accepted', 'superseded', 'deterministic_failure', 'revoked', 'quarantined'))
        = (${t.terminalAt} IS NOT NULL)
      AND (${t.lastErrorClass} IS NULL OR (
        length(btrim(${t.lastErrorClass})) > 0 AND length(${t.lastErrorClass}) <= 160
      ))`,
  ),
]);

export const externalReactionCommandAttempts = pgTable("external_reaction_command_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  commandId: uuid("command_id").notNull().references(() => externalReactionCommands.id, { onDelete: "cascade" }),
  desiredRevision: integer("desired_revision").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  ioPhase: text("io_phase", { enum: ["before_send", "after_send", "unknown"] }).notNull(),
  outcome: text("outcome", {
    enum: [
      "accepted", "already_satisfied", "rate_limited", "transient_failure", "deterministic_failure",
      "outcome_unknown", "reconciled_present", "reconciled_absent", "superseded", "revoked", "quarantined",
    ],
  }).notNull(),
  safeReasonCode: text("safe_reason_code").notNull(),
  retryAfterMs: integer("retry_after_ms"),
  observedBotPresence: boolean("observed_bot_presence"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_reaction_attempt_number").on(t.commandId, t.attemptNumber),
  check(
    "external_reaction_attempt_valid",
    sql`${t.desiredRevision} > 0 AND ${t.attemptNumber} > 0
      AND ${t.ioPhase} IN ('before_send', 'after_send', 'unknown')
      AND ${t.outcome} IN (
        'accepted', 'already_satisfied', 'rate_limited', 'transient_failure', 'deterministic_failure',
        'outcome_unknown', 'reconciled_present', 'reconciled_absent', 'superseded', 'revoked', 'quarantined'
      )
      AND length(btrim(${t.safeReasonCode})) > 0 AND length(${t.safeReasonCode}) <= 160
      AND (${t.retryAfterMs} IS NULL OR ${t.retryAfterMs} >= 0)
      AND ((${t.observedBotPresence} IS NULL AND ${t.observedAt} IS NULL)
        OR (${t.observedBotPresence} IS NOT NULL AND ${t.observedAt} IS NOT NULL))`,
  ),
]);

// Reactions are polymorphic by design: users and agents share the same emoji
// aggregate and differ only by (reactorType, reactorId).
export const messageReactions = pgTable("message_reactions", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  reactorType: text("reactor_type", { enum: ["user", "agent"] }).notNull(),
  reactorId: uuid("reactor_id").notNull(),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.messageId, t.reactorType, t.reactorId, t.emoji] }),
  index("idx_message_reactions_message").on(t.messageId),
  index("idx_message_reactions_reactor").on(t.reactorType, t.reactorId),
]);

// ReadCache pages are version-bound per typed reaction discussion. The row is
// created lazily on the first route-owned mutation; pre-existing reaction rows
// therefore remain readable at version zero during rollout.
export const messageReactionDiscussionVersions = pgTable("message_reaction_discussion_versions", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.messageId, t.emoji] }),
  check("message_reaction_discussion_versions_nonnegative", sql`${t.version} >= 0`),
]);

// Viewer reaction state is recovered as one versioned set per user/message.
// It is intentionally separate from shared discussion versions and is only
// exposed through requester-private HTTP responses and user-room events.
export const messageReactionViewerVersions = pgTable("message_reaction_viewer_versions", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.messageId, t.userId] }),
  index("idx_message_reaction_viewer_versions_user").on(t.userId),
  check("message_reaction_viewer_versions_nonnegative", sql`${t.version} >= 0`),
]);

export const messageTranslations = pgTable("message_translations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  sourceLang: text("source_lang").notNull(),
  sourceConfidence: integer("source_confidence").notNull().default(0),
  targetLang: text("target_lang").notNull(),
  provider: text("provider").notNull(),
  providerVersion: text("provider_version").notNull(),
  placeholderPolicyVersion: text("placeholder_policy_version").notNull(),
  status: text("status", { enum: ["pending", "translated", "skipped", "failed"] }).notNull(),
  skipReason: text("skip_reason", {
    enum: [
      "server_disabled",
      "same_language",
      "own_message",
      "system_message",
      "code_or_link_only",
      "low_confidence",
      "quota_exceeded",
      "provider_unavailable",
      "content_invalid",
      "placeholder_mismatch",
    ],
  }),
  quotaReason: text("quota_reason", { enum: ["server_disabled", "user_quota_exceeded", "server_quota_exceeded"] }),
  translatedContent: text("translated_content"),
  protectedEntities: jsonb("protected_entities").$type<Array<{ id: string; kind: string; value: string }>>().notNull().default([]),
  requestedChars: integer("requested_chars").notNull().default(0),
  providerBilledChars: integer("provider_billed_chars").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_message_translations_cache_key").on(
    t.messageId,
    t.contentHash,
    t.sourceLang,
    t.targetLang,
    t.providerVersion,
    t.placeholderPolicyVersion,
  ),
  index("idx_message_translations_server_accessed").on(t.serverId, t.lastAccessedAt),
  index("idx_message_translations_server_created").on(t.serverId, t.createdAt),
]);

export const translationQuotaBuckets = pgTable("translation_quota_buckets", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["user", "server"] }).notNull(),
  actorId: text("actor_id").notNull(),
  bucketDate: text("bucket_date").notNull(),
  mode: text("mode", { enum: ["auto", "manual"] }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
  requestedChars: integer("requested_chars").notNull().default(0),
  providerBilledChars: integer("provider_billed_chars").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_translation_quota_bucket").on(t.serverId, t.actorType, t.actorId, t.bucketDate, t.mode),
  index("idx_translation_quota_server_date").on(t.serverId, t.bucketDate),
]);

// Machines — physical compute nodes connected via daemon process
// NOTE: SQL table name is still "daemons" for backward compat; use migration to rename
export const machines = pgTable("daemons", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  apiKeyHash: text("api_key_hash").notNull(),
  apiKeyPrefix: text("api_key_prefix"),
  // sha256(apiKey).slice(0,16) — stable identity shared with on-disk
  // daemon owner.json. Used as the intersection key for §X.2 migration
  // picker (RFC v9.9). Sensitive: SELECT-whitelist only, scoped responses.
  apiKeyFingerprint: text("api_key_fingerprint"),
  runtimes: json("runtimes").$type<string[]>(),
  hostname: text("hostname"),
  os: text("os"),
  // Coarse machine kind for the Computer icon (shared DEVICE_CLASSES), from
  // the daemon's `ready`; null when unknown or reported by an older daemon.
  deviceClass: text("device_class"),
  // Cloud / VM platform id (shared HOST_PROVIDER_LABELS) and OS release
  // ("Ubuntu 26.04") from the daemon's `ready`; null when unknown or older.
  hostProvider: text("host_provider"),
  osRelease: text("os_release"),
  // os-release ID / ID_LIKE ("ubuntu"; ["rhel", "fedora"]) for a distribution icon.
  osId: text("os_id"),
  osIdLike: json("os_id_like").$type<string[]>(),
  // How the daemon itself runs (shared DAEMON_INSTALL_KINDS: sea / node /
  // electron) and whether an executable `node` is on its PATH, from `ready`;
  // null when unknown or reported by an older daemon. For choosing how a
  // runtime host starts child processes, and the web-upgrade policy
  // (electron = Raft Desktop's bundled Computer, never web-upgraded); not
  // shown in the web.
  installKind: text("install_kind"),
  nodeOnPath: boolean("node_on_path"),
  daemonVersion: text("daemon_version"),
  computerVersion: text("computer_version"),
  computerVersionReportedAt: timestamp("computer_version_reported_at", { withTimezone: true }),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  // When this Computer first came online (onboarding funnel, T3). The row is
  // created when its key is minted and `last_heartbeat` is overwritten, so
  // nothing else records it. Set once on `machine:online`; null for machines
  // that never connected or that last connected before the column existed.
  firstConnectedAt: timestamp("first_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  legacyKeyMigratedAt: timestamp("legacy_key_migrated_at", { withTimezone: true }),
  // #proj-raft-computer task #38: when this machine's daemon found its CURRENT
  // `sk_machine_*` key in a legacy file inside an agent workspace (the key an
  // agent may have read). Set from `ready` only while that key is still the
  // stored one; cleared when the key is retired by the move to a Computer
  // credential (`legacyKeyMigratedAt`). Shown to the machine's owner only.
  credentialExposureFoundAt: timestamp("credential_exposure_found_at", { withTimezone: true }),
  // The person's web (full) session family that issued the current
  // `sk_machine_*` key (POST /api/servers/:id/machines, .../rotate-key), so a
  // security revoke of that session (a password change or reset, the
  // account's retirement) discards the key (webSessionIssuedKeys.ts). A plain
  // logout never does. NULL for keys issued before this column, by a legacy
  // token with no family, or by an attach (whose machine key is discarded);
  // cleared when the cascade discards the key. Distinct from the device-session
  // columns, which follow any revoke.
  keyIssuedByWebSessionFamilyId: uuid("key_issued_by_web_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  // Who Raft records as this Computer's owner (#wg-rbac:#32, Computer owner
  // v1). NULL = a Public Computer: the default for every row, existing and
  // new; connecting one never sets it. Not the connector (`user_id` here,
  // `computers.attached_by_user_id`), which a transfer never changes. It
  // stays on this row across a re-adoption (a new `computers` row for the
  // same machine), is cleared when the owner leaves the server
  // (serverService.removeMemberInTransaction) or deletes their account, and
  // carries no rights in v1: display and transfer only
  // (services/computerOwnerService.ts).
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  index("idx_daemons_server").on(t.serverId),
  // The cascade's lookup by family, and the FK's ON DELETE SET NULL.
  index("idx_daemons_key_issued_by_web_session_family").on(t.keyIssuedByWebSessionFamilyId).where(sql`key_issued_by_web_session_family_id is not null`),
  index("idx_daemons_api_key_prefix").on(t.apiKeyPrefix),
  index("idx_daemons_api_key_fingerprint").on(t.apiKeyFingerprint),
]);

// Same-machine grouping (computer_host_identity_v0): the daemon's per-server
// HMAC(hardware ID, serverId). Its own table, not a `daemons` column, so no
// machine-row read can return it; it leaves the Server only as an opaque
// per-response group label. Deleted with the machine.
export const computerHostIdentities = pgTable("computer_host_identities", {
  machineId: uuid("daemon_id").primaryKey().references(() => machines.id, { onDelete: "cascade" }),
  hostIdHash: text("host_id_hash").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
});

// #proj-raft-computer:#68: the latest `machine:runtime_readiness` report per
// Computer: the readiness facts only its daemon observes (login holds such as
// `verification_required`), as {resource, code, behaviour, since} without
// text, paths or accounts. Its own table because the runtime-auth KV has a
// TTL and a fact must last until the daemon reports it gone. `seq` is the
// daemon's own, only growing: a report not above the stored one is dropped.
// `notified`: when each (login key, code) was last told to its owner (epoch
// ms), so a fact that comes back within 24 h is not told again. Deleted with
// the machine.
export const computerReadinessReports = pgTable("computer_readiness_reports", {
  machineId: uuid("daemon_id").primaryKey().references(() => machines.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  facts: jsonb("facts").$type<ReadinessFact[]>().notNull(),
  notified: jsonb("notified").$type<Record<string, number>>().notNull().default({}),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
});

// Tasks — THE CANONICAL TASK TABLE (v1.4).
//
// The comment that used to sit here said the opposite ("DEPRECATED ... tasks are
// now a property of messages"). That described the pre-v1.4 world and was left
// stale by the storage move; v1.4 made this table canonical for new tasks and
// P3 collapsed all reads onto it. Reading the old comment now would invert the
// design, so it is replaced rather than amended.
//
// A task's association to its host message is `message_id` (nullable: task v0
// rows predate host messages entirely). `messages.task_*` is dead storage kept
// only as a rollback snapshot until P4 drops it.
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  taskNumber: integer("task_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  // text, no CHECK: the enum is TypeScript only, adding a status needs no migration.
  status: text("status", { enum: ["backlog", "todo", "in_progress", "in_review", "done", "closed"] }).notNull().default("todo"),
  createdByType: text("created_by_type", { enum: ["user", "agent"] }).notNull(),
  createdById: text("created_by_id").notNull(),
  claimedByType: text("claimed_by_type", { enum: ["user", "agent"] }),
  claimedById: text("claimed_by_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Terminal-close tracking (closed = non-success terminal, distinct from done).
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByType: text("closed_by_type", { enum: ["user", "agent"] }),
  closedById: text("closed_by_id"),
  // Explicit marker + structured receipt for tasks that create/own external
  // resources. Free-form thread prose is never authority for this gate.
  requiresResourceReceipt: boolean("requires_resource_receipt").notNull().default(false),
  resourceReceipt: jsonb("resource_receipt").$type<TaskResourceReceipt>(),
  resourceReceiptRecordedAt: timestamp("resource_receipt_recorded_at", { withTimezone: true }),
  resourceReceiptRecordedByType: text("resource_receipt_recorded_by_type", { enum: ["user", "agent"] }),
  resourceReceiptRecordedById: text("resource_receipt_recorded_by_id"),
  resourceTeardownOwnerAgentId: uuid("resource_teardown_owner_agent_id").references(() => agents.id),
  resourceExpiryFollowupId: uuid("resource_expiry_followup_id").references(() => scheduledFollowups.id),
  // Optimistic-concurrency token; bumped on every mutation, CAS via expectedRevision.
  revision: integer("revision").notNull().default(0),
  // Pre-task-v2 host message: the visible chat line whose THREAD was the
  // task's discussion. NULL for tasks created with task v2 conversations on
  // (they have `conversation_channel_id` instead); pre-v2 rows keep it, and
  // their old discussion stays in that thread ("Earlier discussion").
  messageId: uuid("message_id").references(() => messages.id),
  // Task v2: the task's canonical conversation (channels.type = 'task'),
  // created lazily, like a thread, by the first action that needs it (task v2
  // and pre-v2 tasks alike).
  conversationChannelId: uuid("conversation_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
  // Task v2: created with task v2 conversations on — the task's discussion is
  // its own conversation even before that conversation exists (it has no host
  // message). False for pre-v2 rows, whose discussion without a conversation
  // is their host message's thread (or none: an orphan).
  ownConversation: boolean("own_conversation").notNull().default(false),
  // Task v2: the visible chat message this task hangs under, if any. Not
  // unique — one message can carry many tasks. Distinct from `message_id`.
  sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // The Tasks page's "activity" time: set to now() when the task is created,
  // when its status, assignee, title or description changes, and when a chat
  // message is posted in its own conversation (at most once a minute per
  // task; taskService.TASK_ACTIVITY_MESSAGE_THROTTLE). Unlike updated_at it
  // skips bookkeeping writes (conversation link, resource receipt). NULL for
  // rows written before the column (no backfill: a large table); every reader
  // orders by COALESCE(last_activity_at, updated_at) (taskService.taskActivityAt).
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_tasks_channel_number").on(t.channelId, t.taskNumber),
  index("idx_tasks_channel_status").on(t.channelId, t.status),
  uniqueIndex("idx_tasks_message_id").on(t.messageId),
  index("idx_tasks_source_message_id").on(t.sourceMessageId),
  // Deleting an agent releases the tasks it claimed (agentService deleteAgent).
  index("idx_tasks_claimed_by_agent").on(t.claimedById).where(sql`claimed_by_type = 'agent'`),
  // The server task board's Creator / Assignee filters and relation tabs
  // (taskService.countServerTasks / listServerTasksPage): one person's or
  // agent's tasks across every visible channel. Unclaimed rows are left out
  // of the claimer index; "unassigned" reads through the channel indexes.
  index("idx_tasks_created_by").on(t.createdByType, t.createdById),
  index("idx_tasks_claimed_by").on(t.claimedByType, t.claimedById).where(sql`claimed_by_id IS NOT NULL`),
  // The closed-server purge deletes the reminders this key names (migration
  // closed_server_purge_fk_indexes; built CONCURRENTLY on a large table by
  // db:create-device-session-key-indexes).
  index("idx_tasks_resource_expiry_followup").on(t.resourceExpiryFollowupId).where(sql`resource_expiry_followup_id IS NOT NULL`),
  // The server task board's activity sort (GET /api/tasks/server?sort=activity;
  // taskService.selectSortedServerTaskRows): each channel's tasks newest
  // activity first, the keyset's (activity, id) in index order.
  index("idx_tasks_channel_activity").on(t.channelId, sql`COALESCE(${t.lastActivityAt}, ${t.updatedAt}) DESC`, sql`${t.id} DESC`),
  // The same walk by creation time (GET /api/tasks/server?sort=created).
  index("idx_tasks_channel_created").on(t.channelId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
  uniqueIndex("idx_tasks_conversation_channel_id").on(t.conversationChannelId),
  check(
    "tasks_resource_receipt_shape_check",
    sql`${t.resourceReceipt} IS NULL OR (
      jsonb_typeof(${t.resourceReceipt}) = 'object'
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'object', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'purpose', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'teardown_owner', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'security_privacy', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'expiry', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'runbook', '')) <> ''
      AND btrim(COALESCE(${t.resourceReceipt} ->> 'tracking', '')) <> ''
    )`,
  ),
  check(
    "tasks_resource_receipt_state_check",
    sql`(
      ${t.resourceReceipt} IS NULL
      AND ${t.resourceReceiptRecordedAt} IS NULL
      AND ${t.resourceReceiptRecordedByType} IS NULL
      AND ${t.resourceReceiptRecordedById} IS NULL
      AND ${t.resourceTeardownOwnerAgentId} IS NULL
      AND ${t.resourceExpiryFollowupId} IS NULL
    ) OR (
      ${t.requiresResourceReceipt} = true
      AND ${t.resourceReceipt} IS NOT NULL
      AND ${t.resourceReceiptRecordedAt} IS NOT NULL
      AND ${t.resourceReceiptRecordedByType} IS NOT NULL
      AND ${t.resourceReceiptRecordedById} IS NOT NULL
      AND ${t.resourceTeardownOwnerAgentId} IS NOT NULL
      AND ${t.resourceExpiryFollowupId} IS NOT NULL
    )`,
  ),
  // Database-level completion invariant: even a future direct writer, script,
  // or migration cannot bypass the task service's user-facing guard.
  check(
    "tasks_resource_receipt_completion_check",
    sql`${t.status} <> 'done' OR ${t.requiresResourceReceipt} = false OR (
      ${t.resourceReceipt} IS NOT NULL
      AND ${t.resourceReceiptRecordedAt} IS NOT NULL
      AND ${t.resourceReceiptRecordedByType} IS NOT NULL
      AND ${t.resourceReceiptRecordedById} IS NOT NULL
      AND ${t.resourceTeardownOwnerAgentId} IS NOT NULL
      AND ${t.resourceExpiryFollowupId} IS NOT NULL
    )`,
  ),
]);

// Task audit trail — every task lifecycle state change is recorded here so the
// timeline is never lost even if not displayed. Events + host-message thread
// comments together form the complete task timeline. See v1.4 tasks-table-
// canonical migration (tasks table is the source of truth; task↔message is an
// association via tasks.messageId, not storage in messages.task_*).
export const taskEvents = pgTable("task_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // Global monotonic sequence (same idiom as messages.seq) — gives a
  // deterministic happens-before for timeline replay. created_at is wall-clock
  // only and can collide within a transaction, so ordering keys on seq, not time.
  seq: bigserial("seq", { mode: "number" }).notNull(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  eventType: text("event_type", {
    enum: ["created", "status_changed", "assignee_changed", "reopened", "closed", "resource_receipt_recorded", "amended"],
  }).notNull(),
  actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
  actorId: text("actor_id"), // nullable for system events
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_task_events_task").on(t.taskId, t.seq),
  // RFC-067 product-data derivation reads task events by a seq watermark.
  index("idx_task_events_seq").on(t.seq),
]);

// Idle task reminder (#wg-task-v2:#9, services/idleTaskReminderService.ts):
// what an agent was last reminded of for one task assigned to it (or with no
// assignee, which it created), so the next idle lists the task again only when
// something changed. Written in the
// same transaction that decides a reminder (a lost response skips at most
// one). Server-side so a restart or a move to another Computer repeats nothing.
export const agentTaskNudges = pgTable("agent_task_nudges", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  /** Why it was last listed: new_session | newly_assigned | others_acted | stale. */
  lastReason: text("last_reason", { enum: ["new_session", "newly_assigned", "others_acted", "stale"] }).notNull(),
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }).notNull(),
  /**
   * The latest action by someone else (status / assignee / card change, or a
   * message in its conversation) the agent has been reminded of. Only an
   * action after this one lists the task again for that reason.
   */
  seenOthersActionAt: timestamp("seen_others_action_at", { withTimezone: true }),
  /** Where the "untouched" clock started when last recorded (the agent's last action, or the assignment or release). */
  staleSinceAt: timestamp("stale_since_at", { withTimezone: true }),
  /** How many "untouched" thresholds since `staleSinceAt` were already reminded of (30m/2h, 8h, then daily). */
  staleStep: integer("stale_step").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.taskId] }),
  index("idx_agent_task_nudges_task").on(t.taskId),
]);

// Idle task reminder: one row per reminder sent to an agent, for the
// "at most 3 an hour" cap. Rows older than the window are pruned when the
// agent is next asked about, so an agent keeps at most a few.
export const agentTaskNudgeSends = pgTable("agent_task_nudge_sends", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  itemCount: integer("item_count").notNull(),
}, (t) => [
  index("idx_agent_task_nudge_sends_agent_sent").on(t.agentId, t.sentAt),
]);

export type PersistableJsonValue =
  | string
  | number
  | boolean
  | null
  | PersistableJsonValue[]
  | { [key: string]: PersistableJsonValue };

export type WorkflowStepOutput = { [key: string]: PersistableJsonValue };

export type WorkflowTemplateStep = {
  key: string;
  title: string;
  description?: string;
};

export const workflowTemplates = pgTable("workflow_templates", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  steps: jsonb("steps").$type<WorkflowTemplateStep[]>().notNull(),
  createdByType: text("created_by_type", { enum: ["user", "agent"] }).notNull(),
  createdById: text("created_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_workflow_templates_server").on(t.serverId),
]);

export const workflowInstances = pgTable("workflow_instances", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  templateId: uuid("template_id").notNull().references(() => workflowTemplates.id, { onDelete: "restrict" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["active", "done", "canceled"] }).notNull().default("active"),
  currentStepIndex: integer("current_step_index").notNull().default(0),
  startedByType: text("started_by_type", { enum: ["user", "agent"] }).notNull(),
  startedById: text("started_by_id").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_workflow_instances_server").on(t.serverId, t.status),
  index("idx_workflow_instances_channel").on(t.channelId, t.status),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_fk_indexes; built CONCURRENTLY on a large table by
  // db:create-device-session-key-indexes).
  index("idx_workflow_instances_template").on(t.templateId),
]);

export const workflowStepInstances = pgTable("workflow_step_instances", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  instanceId: uuid("instance_id").notNull().references(() => workflowInstances.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  stepKey: text("step_key").notNull(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["active", "done", "canceled"] }).notNull().default("active"),
  output: jsonb("output").$type<WorkflowStepOutput>(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_workflow_steps_instance_index").on(t.instanceId, t.stepIndex),
  index("idx_workflow_steps_task").on(t.taskId),
]);

// task #1357 item 1: model limits reports, one row per (agent, Computer,
// daemon instance): the newest report that daemon process sent
// (`agent:model_limits`): the values a Pi session registered for a Built-in
// custom gateway model, each with its source, and that session's identity.
// A frame only ever writes its own instance's row, ordered within it by
// (config_revision, seq), so no process can overwrite another's result; the
// agent detail reads the row of the Computer's current instance
// (agentModelLimitsService). Rows accumulate per instance until the agent or
// Computer is deleted (retention: follow-up).
export const agentModelLimitsReports = pgTable("agent_model_limits_reports", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  machineId: uuid("machine_id").notNull().references(() => machines.id, { onDelete: "cascade" }),
  daemonInstanceId: text("daemon_instance_id").notNull(),
  launchId: text("launch_id"),
  sessionId: text("session_id").notNull(),
  configRevision: bigint("config_revision", { mode: "number" }).notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  /** The daemon's clock: display and diagnostics only, never ordering. */
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  runtime: text("runtime").notNull(),
  modelLimits: jsonb("model_limits").$type<import("@botiverse/raft-shared").ModelLimits>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.machineId, t.daemonInstanceId] }),
  // The FK to machines, read when a Computer is deleted.
  index("idx_agent_model_limits_reports_machine").on(t.machineId),
]);

// Agent Runtime Profile — one current restart-time migration state per agent.
// Only machine/runtime/model/reasoning/execution feed the fingerprint.
// Daemon version is a first-class release-policy field, but not identity.
export const agentRuntimeProfiles = pgTable("agent_runtime_profiles", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),

  machineId: uuid("machine_id").notNull().references(() => machines.id, { onDelete: "restrict" }),
  runtimeProfileFingerprint: text("runtime_profile_fingerprint").notNull(),
  runtime: text("runtime").notNull(),
  model: text("model").notNull(),
  reasoningEffort: text("reasoning_effort"),
  executionMode: text("execution_mode").notNull(),
  daemonVersion: text("daemon_version"),

  workspaceRefLabel: text("workspace_ref_label"),
  workspaceRefPath: text("workspace_ref_path"),
  workspaceRefMachineId: text("workspace_ref_machine_id"),
  workspaceRefRuntime: text("workspace_ref_runtime"),
  workspaceRefReachable: boolean("workspace_ref_reachable"),
  workspaceRefReason: text("workspace_ref_reason"),
  workspacePathRefLabel: text("workspace_path_ref_label"),
  workspacePathRefPath: text("workspace_path_ref_path"),
  workspacePathRefMachineId: text("workspace_path_ref_machine_id"),
  workspacePathRefRuntime: text("workspace_path_ref_runtime"),
  workspacePathRefReachable: boolean("workspace_path_ref_reachable"),
  workspacePathRefReason: text("workspace_path_ref_reason"),
  sessionRefLabel: text("session_ref_label"),
  sessionRefPath: text("session_ref_path"),
  sessionRefMachineId: text("session_ref_machine_id"),
  sessionRefRuntime: text("session_ref_runtime"),
  sessionRefReachable: boolean("session_ref_reachable"),
  sessionRefReason: text("session_ref_reason"),

  baselineRuntimeProfileFingerprint: text("baseline_runtime_profile_fingerprint").notNull(),
  baselineMachineId: uuid("baseline_machine_id").notNull().references(() => machines.id, { onDelete: "restrict" }),
  baselineRuntime: text("baseline_runtime").notNull(),
  baselineModel: text("baseline_model").notNull(),
  baselineReasoningEffort: text("baseline_reasoning_effort"),
  baselineExecutionMode: text("baseline_execution_mode").notNull(),
  baselineDaemonVersion: text("baseline_daemon_version"),

  migrationStatus: text("migration_status", { enum: ["stable", "pending", "migrating"] }).notNull().default("stable"),
  pendingKind: text("pending_kind", { enum: ["migration", "daemon_release_notice"] }),
  pendingKey: text("pending_key"),
  pendingBeforeRuntimeProfileFingerprint: text("pending_before_runtime_profile_fingerprint"),
  pendingAfterRuntimeProfileFingerprint: text("pending_after_runtime_profile_fingerprint"),
  pendingBeforeMachineId: uuid("pending_before_machine_id").references(() => machines.id, { onDelete: "restrict" }),
  pendingAfterMachineId: uuid("pending_after_machine_id").references(() => machines.id, { onDelete: "restrict" }),
  pendingBeforeRuntime: text("pending_before_runtime"),
  pendingAfterRuntime: text("pending_after_runtime"),
  pendingBeforeModel: text("pending_before_model"),
  pendingAfterModel: text("pending_after_model"),
  pendingBeforeReasoningEffort: text("pending_before_reasoning_effort"),
  pendingAfterReasoningEffort: text("pending_after_reasoning_effort"),
  pendingBeforeExecutionMode: text("pending_before_execution_mode"),
  pendingAfterExecutionMode: text("pending_after_execution_mode"),
  pendingBeforeDaemonVersion: text("pending_before_daemon_version"),
  pendingAfterDaemonVersion: text("pending_after_daemon_version"),
  pendingPreviousSessionLabel: text("pending_previous_session_label"),
  pendingPreviousSessionPath: text("pending_previous_session_path"),
  pendingPreviousSessionMachineId: text("pending_previous_session_machine_id"),
  pendingPreviousSessionRuntime: text("pending_previous_session_runtime"),
  pendingPreviousSessionReachable: boolean("pending_previous_session_reachable"),
  pendingPreviousSessionReason: text("pending_previous_session_reason"),
  pendingReleaseNotesUrl: text("pending_release_notes_url"),
  migrationDeliveredAt: timestamp("migration_delivered_at", { withTimezone: true }),
  migrationDeliveredLaunchId: text("migration_delivered_launch_id"),
  migratingSince: timestamp("migrating_since", { withTimezone: true }),
  lastMigrationNudgeAt: timestamp("last_migration_nudge_at", { withTimezone: true }),
  migrationNudgeCount: integer("migration_nudge_count").notNull().default(0),
  migrationHandledAt: timestamp("migration_handled_at", { withTimezone: true }),
  migrationHandledLaunchId: text("migration_handled_launch_id"),

  revision: integer("revision").notNull().default(1),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_runtime_profiles_server").on(t.serverId),
  index("idx_agent_runtime_profiles_machine").on(t.machineId),
  // The RESTRICT foreign keys to machines, read when a Computer is deleted.
  index("idx_agent_runtime_profiles_baseline_machine").on(t.baselineMachineId),
  index("idx_agent_runtime_profiles_pending_before_machine").on(t.pendingBeforeMachineId).where(sql`pending_before_machine_id is not null`),
  index("idx_agent_runtime_profiles_pending_after_machine").on(t.pendingAfterMachineId).where(sql`pending_after_machine_id is not null`),
  uniqueIndex("idx_agent_runtime_profiles_pending_key").on(t.pendingKey),
  index("idx_agent_runtime_profiles_pending").on(t.serverId, t.updatedAt).where(sql`pending_kind is not null`),
]);

// User-channel read cursor for unread counts
export const userChannelReadCursors = pgTable("user_channel_read_cursors", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  lastReadSeq: integer("last_read_seq").notNull().default(0),
  // RFC 057 phase-A shadow of last_read_seq (int8 domain). Nullable, no default,
  // populated only by the mirror trigger / phase-B backfill; NOT authority until
  // the phase ledger reads 'cutover'. Values travel as text at the app boundary.
  lastReadSeq8: bigint("last_read_seq8", { mode: "bigint" }),
  readStateVersion: integer("read_state_version").notNull().default(0),
  // The server-authoritative read-mutation order that most recently changed
  // this scope. This is a replay defence/frontier aid, not the primary
  // mutation-id dedupe key (the permanent tombstone is authoritative).
  lastAppliedAuthoritySeq: bigint("last_applied_authority_seq", { mode: "number" }).notNull().default(0),
  // Mark as Unread found nothing others wrote past the cursor, so the person's
  // "come back to this" is kept here instead of in the cursor. Set only by a
  // row_unread with nothing countable; every read write of the scope clears it.
  // Counts never include it: readers show the scope unread without a number.
  markedUnread: boolean("marked_unread").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.channelId] }),
  // A person's marked conversations (sidebar summary, Activity), read on every
  // load: only the few marked rows, not every cursor of the person
  // (migration read_cursor_marked_unread_index; built CONCURRENTLY on a large
  // table by db:create-read-cursor-marked-unread-index).
  index("idx_user_channel_read_cursors_marked_unread").on(t.userId).where(sql`marked_unread`),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_user_channel_read_cursors_channel").on(t.channelId),
]);


// RFC 057: singleton phase ledger for the read-cursor int4->int8 widen program.
// Singleton by CONSTRAINT (boolean PK + CHECK), not convention. The table is
// owned by the migration identity, so only that identity (and the phase-A
// transition function it owns, whose PUBLIC EXECUTE is revoked in-migration)
// writes it; the singleton/epoch/enum invariants are enforced by the CHECKs.
export const readCursorWidenPhase = pgTable("read_cursor_widen_phase", {
  id: boolean("id").primaryKey().default(true),
  phase: text("phase", {
    enum: ["shadow_widen", "backfilling", "cutover", "rolled_back", "retired"],
  }).notNull(),
  epoch: integer("epoch").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
}, (t) => [
  check("read_cursor_widen_phase_singleton", sql`${t.id}`),
  check("read_cursor_widen_phase_epoch_min", sql`${t.epoch} >= 1`),
  check(
    "read_cursor_widen_phase_phase_enum",
    sql`${t.phase} IN ('shadow_widen', 'backfilling', 'cutover', 'rolled_back', 'retired')`,
  ),
]);

// RFC 057: append-only audit of every phase transition (written atomically by the
// transition function in the same transaction as the CAS).
export const readCursorWidenPhaseAudit = pgTable("read_cursor_widen_phase_audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  phaseFrom: text("phase_from"),
  phaseTo: text("phase_to").notNull(),
  epoch: integer("epoch").notNull(),
  operator: text("operator").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** What an account deletion's cleanup did with one server the person owned (user_retirement_receipts.server_handoffs). */
export type AccountDeletionServerHandoff =
  | { serverId: string; outcome: "owner_reassigned"; newOwnerUserId: string }
  | { serverId: string; outcome: "owner_promoted"; newOwnerUserId: string; previousRole: "admin" | "member" }
  | { serverId: string; outcome: "server_deleted" };

/**
 * What an account deletion's cleanup did with one of the person's agents
 * (user_retirement_receipts.agent_dispositions): handed to the server's owner
 * (stopped; `machineCleared` when it was bound to the person's own Computer),
 * archived (a personal assistant, or its server was deleted with the
 * account), or left as it was (being migrated or managed by an App).
 */
export type AccountDeletionAgentDisposition =
  | { agentId: string; serverId: string; outcome: "transferred"; toUserId: string; machineCleared: boolean; hosted: boolean }
  | { agentId: string; serverId: string; outcome: "archived"; reason: "personal_assistant" | "server_deleted" | "no_owner" }
  | { agentId: string; serverId: string; outcome: "skipped"; reason: "migrating" | "app_managed" };

export const userRetirementReceipts = pgTable("user_retirement_receipts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  environment: text("environment", { enum: ["staging", "production"] }).notNull(),
  terminalState: text("terminal_state", { enum: ["retired"] }).notNull(),
  sessionsRevoked: integer("sessions_revoked").notNull(),
  // An account deletion's cleanup (services/accountDeletion/cleanup.ts): what
  // became of each server the person owned (who was made owner, or that it
  // was deleted). Null for other retirements.
  serverHandoffs: jsonb("server_handoffs").$type<AccountDeletionServerHandoff[]>(),
  // ...and what became of each of the person's agents. Null for other retirements.
  agentDispositions: jsonb("agent_dispositions").$type<AccountDeletionAgentDisposition[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("user_retirement_receipts_sessions_revoked_nonnegative", sql`${t.sessionsRevoked} >= 0`),
]);

// Account deletion requests (services/accountDeletion). A person (or, later,
// ops for them) asks to delete the account: every sign-in, device login,
// Computer and agent key is revoked at once and the account waits `pending`
// until `scheduled_for`; signing in during that grace period gives a session
// that can only read or cancel the request (middleware/auth.ts). At most one
// `pending` row per person. "Pending deletion" is read from this table only:
// nothing on `users` changes until the cleanup retires the account.
/** A deletion request's own cancellation. Null time means no confirmed Stripe response yet. */
export type SubscriptionRestorationResult = "restored" | "not_restored" | "unknown";

export interface AccountDeletionSubscriptionSnapshot {
  stripeSubscriptionId: string;
  canceledAt: number | null;
}

export const accountDeletionRequests = pgTable("account_deletion_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // `self`: the person, from a re-authenticated session; `ops`: an operator
  // acting on a support ticket (`actor_user_id`, `ticket_ref`).
  source: text("source", { enum: ["self", "ops"] }).notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  ticketRef: text("ticket_ref"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  state: text("state", { enum: ["pending", "cancelled", "completed"] }).notNull(),
  // The cleanup (services/accountDeletion/cleanup.ts) runs in two phases: the
  // first, one transaction, retires and scrubs the account and sets this; the
  // second deletes the person's data in bounded batches over as many
  // maintenance runs as it takes, and only then is the request `completed`.
  accountRetiredAt: timestamp("account_retired_at", { withTimezone: true }),
  // The second phase's lease: one replica works on a request at a time; a
  // lease that ran out (a replica that died) is taken over.
  cleanupLeaseUntil: timestamp("cleanup_lease_until", { withTimezone: true }),
  // Legacy requests only: the Server ids whose subscriptions were scheduled
  // to cancel. New requests leave this empty and bind the exact subscription below.
  cancelledSubscriptionServerIds: jsonb("cancelled_subscription_server_ids").$type<string[]>(),
  // Null only on legacy requests. A non-null map never falls back to the
  // legacy Server ids, even when a provider response could not be recorded.
  cancelledSubscriptionSnapshots: jsonb("cancelled_subscription_snapshots").$type<Record<string, AccountDeletionSubscriptionSnapshot>>(),
  // Per-Server provider outcome, persisted so a lost HTTP response can be re-read.
  subscriptionRestorationResults: jsonb("subscription_restoration_results").$type<Record<string, SubscriptionRestorationResult>>(),
  // The HMAC lookup hash (computeTokenLookupHash) of the one-time link in the
  // "requested" email that cancels this request (requests.ts
  // cancelAccountDeletionByLink); the raw token is never stored. Cleared when
  // the request is cancelled (by the link or not) or completed. Null on
  // requests from before it.
  cancelTokenHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("cancel_token_hash"),
}, (t) => [
  // One pending request per person; also the per-request lookup of auth.
  uniqueIndex("idx_account_deletion_requests_user_pending").on(t.userId).where(sql`state = 'pending'`),
  // The cancel link's lookup.
  uniqueIndex("idx_account_deletion_requests_cancel_token").on(t.cancelTokenHash).where(sql`cancel_token_hash IS NOT NULL`),
  // The cleanup's due scan.
  index("idx_account_deletion_requests_pending_due").on(t.scheduledFor).where(sql`state = 'pending'`),
  check("account_deletion_requests_source_valid", sql`${t.source} IN ('self', 'ops')`),
  check("account_deletion_requests_state_valid", sql`${t.state} IN ('pending', 'cancelled', 'completed')`),
  check("account_deletion_requests_ops_ticket", sql`${t.source} <> 'ops' OR ${t.ticketRef} IS NOT NULL`),
  check("account_deletion_requests_state_times", sql`(${t.state} = 'pending' AND ${t.cancelledAt} IS NULL AND ${t.completedAt} IS NULL) OR (${t.state} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.completedAt} IS NULL) OR (${t.state} = 'completed' AND ${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL)`),
]);

// One serialized ordering frontier per authenticated human/agent authority. The row
// itself is locked FOR UPDATE by admission, workers, frontier reads and
// compaction so every path shares the same cross-replica linearization point.
export const readMutationAuthorities = pgTable("read_mutation_authorities", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["human", "agent"] }).notNull().default("human"),
  principalId: uuid("principal_id").notNull(),
  nextAuthoritySeq: bigint("next_authority_seq", { mode: "number" }).notNull().default(1),
  lastTerminalAuthoritySeq: bigint("last_terminal_authority_seq", { mode: "number" }).notNull().default(0),
  // Durable fairness cursor for the production worker. It advances only when
  // this authority actually wins a claim attempt; admission/frontier/terminal
  // writes must not perturb the scheduling order.
  workerLastScheduledAt: timestamp("worker_last_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalType, t.principalId] }),
  index("read_mutation_authorities_worker_schedule_idx").on(t.workerLastScheduledAt, t.serverId, t.principalType, t.principalId),
  check("read_mutation_authorities_next_positive", sql`${t.nextAuthoritySeq} > 0`),
  check("read_mutation_authorities_terminal_nonnegative", sql`${t.lastTerminalAuthoritySeq} >= 0`),
]);

export const readMutations = pgTable("read_mutations", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["human", "agent"] }).notNull().default("human"),
  principalId: uuid("principal_id").notNull(),
  mutationId: uuid("mutation_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  authoritySeq: bigint("authority_seq", { mode: "number" }).notNull(),
  kind: text("kind", { enum: ["row_read", "row_unread", "channel_read_all", "conversation_read_all", "global_read_all", "done"] }).notNull(),
  scopeId: uuid("scope_id"),
  requestedThroughSeq: integer("requested_through_seq"),
  // RFC 057 phase-A shadow of requested_through_seq (nullable like its authority).
  requestedThroughSeq8: bigint("requested_through_seq8", { mode: "bigint" }),
  // Gate B2 composite Done metadata is deliberately separate from the RFC 057
  // read-cursor authority pair. `requested_through_seq` remains int4-authority
  // until the widen reaches its irreversible retired phase; this new frontier
  // is born int8 so B2 never revives the reverted in-place widen assumption.
  doneTargetKind: text("done_target_kind", { enum: ["channel", "thread"] }),
  doneThroughSeq: bigint("done_through_seq", { mode: "bigint" }),
  state: text("state", { enum: ["admitted", "executing", "applied", "retired_no_effect"] }).notNull().default("admitted"),
  leaseOwner: text("lease_owner"),
  leaseGeneration: integer("lease_generation").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  capturedBoundary: jsonb("captured_boundary").$type<Array<{ scopeId: string; throughSeq: number | string }>>(),
  ack: jsonb("ack").$type<Record<string, unknown>>(),
  terminalReason: text("terminal_reason", {
    enum: ["effect_applied", "already_satisfied", "authorization_revoked", "done_frontier_beyond_latest"],
  }),
  terminalDigest: text("terminal_digest"),
  // Timing semantics (PR #8256, 2026-09-24):
  //   queue     = admitted_at -> executing_at  (valid for all rows)
  //   execution = executing_at -> terminal_at  (claim to finish; valid only for
  //               rows terminalized after #8256 deployed)
  // Before #8256, terminal_at reused the clock captured at executor entry, so
  // executing_at -> terminal_at was only the claim-to-entry gap. Never compare
  // admitted_at -> terminal_at across the deploy: its meaning changed there
  // (queue before, queue + execution after).
  admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
  executingAt: timestamp("executing_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalType, t.principalId, t.mutationId] }),
  uniqueIndex("read_mutations_authority_seq_unique").on(t.serverId, t.principalType, t.principalId, t.authoritySeq),
  index("read_mutations_worker_order_idx").on(t.serverId, t.principalType, t.principalId, t.authoritySeq),
  index("read_mutations_worker_pending_idx")
    .on(t.serverId, t.principalType, t.principalId, t.authoritySeq, t.state, t.leaseExpiresAt)
    .where(sql`${t.state} IN ('admitted', 'executing')`),
  index("read_mutations_terminal_retention_idx").on(t.state, t.terminalAt),
  check("read_mutations_authority_seq_positive", sql`${t.authoritySeq} > 0`),
  check("read_mutations_lease_generation_nonnegative", sql`${t.leaseGeneration} >= 0`),
  check("read_mutations_attempt_count_nonnegative", sql`${t.attemptCount} >= 0`),
  check("read_mutations_scope_shape", sql`
    (${t.kind} = 'global_read_all' AND ${t.scopeId} IS NULL AND ${t.requestedThroughSeq} IS NULL AND ${t.doneTargetKind} IS NULL AND ${t.doneThroughSeq} IS NULL)
    OR (${t.kind} IN ('channel_read_all', 'conversation_read_all') AND ${t.scopeId} IS NOT NULL AND ${t.requestedThroughSeq} IS NULL AND ${t.doneTargetKind} IS NULL AND ${t.doneThroughSeq} IS NULL)
    OR (${t.kind} IN ('row_read', 'row_unread') AND ${t.scopeId} IS NOT NULL AND ${t.requestedThroughSeq} IS NOT NULL AND ${t.requestedThroughSeq} >= 0 AND ${t.doneTargetKind} IS NULL AND ${t.doneThroughSeq} IS NULL)
    OR (${t.kind} = 'done' AND ${t.scopeId} IS NOT NULL AND ${t.requestedThroughSeq} IS NULL AND ${t.doneTargetKind} IN ('channel', 'thread') AND ${t.doneThroughSeq} IS NOT NULL AND ${t.doneThroughSeq} > 0)
  `),
]);

// Permanent exact mutation identity. Detailed live rows may be compacted after
// the recovery horizon, but this table intentionally has no expiry column or
// cascading scope reference so an old client can never reuse an identity.
export const readMutationTombstones = pgTable("read_mutation_tombstones", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["human", "agent"] }).notNull().default("human"),
  principalId: uuid("principal_id").notNull(),
  mutationId: uuid("mutation_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  originalAuthoritySeq: bigint("original_authority_seq", { mode: "number" }).notNull(),
  terminalState: text("terminal_state", { enum: ["applied", "retired_no_effect"] }).notNull(),
  terminalReason: text("terminal_reason", {
    enum: ["effect_applied", "already_satisfied", "authorization_revoked", "done_frontier_beyond_latest"],
  }).notNull(),
  terminalDigest: text("terminal_digest").notNull(),
  compactedAt: timestamp("compacted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalType, t.principalId, t.mutationId] }),
  uniqueIndex("read_mutation_tombstones_authority_seq_unique").on(t.serverId, t.principalType, t.principalId, t.originalAuthoritySeq),
  check("read_mutation_tombstones_authority_seq_positive", sql`${t.originalAuthoritySeq} > 0`),
]);

// Per-user Inbox state for regular channels and DMs.
// Thread Inbox state lives on thread_follows.done_at because threads use
// follow as their attention primitive rather than channel membership.
export const userChannelInboxStates = pgTable("user_channel_inbox_states", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  doneAt: timestamp("done_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.channelId] }),
  index("idx_user_channel_inbox_states_channel").on(t.channelId),
  index("idx_user_channel_inbox_states_done").on(t.userId, t.doneAt),
]);

// Per-receiver channel/DM activity mute boundaries. Mute suppresses future
// Activity/notification promotion but does not move read cursors or affect
// thread follow/done/unfollow state.
export const inboxTargetMuteStates = pgTable("inbox_target_mute_states", {
  receiverType: text("receiver_type", { enum: ["user", "agent"] }).notNull(),
  receiverId: uuid("receiver_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  activityMuted: boolean("activity_muted").notNull().default(true),
  muteFromSeq: bigint("mute_from_seq", { mode: "number" }),
  // False only on the row that keeps an owner's DM with their personal
  // assistant out of Activity (tygg, #proj-assistant a859e8fd): Activity
  // leaves it out, push still fires.
  pushMuted: boolean("push_muted").notNull().default(true),
  prefsVersion: integer("prefs_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.receiverType, t.receiverId, t.sourceChannelId] }),
  index("idx_inbox_target_mute_states_receiver").on(t.serverId, t.receiverType, t.receiverId),
  index("idx_inbox_target_mute_states_source").on(t.sourceChannelId),
]);

// Account-wide notification settings (docs/contracts/notifications.md §2.1).
// No row = the defaults: not paused, no quiet hours, full previews, sound on,
// followed-thread replies on.
// Quiet hours may span midnight (start > end), in `time_zone` (IANA).
export const userNotificationSettings = pgTable("user_notification_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietStartMinute: integer("quiet_start_minute").notNull().default(1320),
  quietEndMinute: integer("quiet_end_minute").notNull().default(480),
  timeZone: text("time_zone").notNull().default("UTC"),
  previewMode: text("preview_mode", { enum: ["full", "sender_only", "hidden"] }).notNull().default("full"),
  soundEnabled: boolean("sound_enabled").notNull().default(true),
  // When a phone alerts while a computer is in use (contract §1.3).
  mobileDelay: text("mobile_delay", { enum: ["always", "inactive", "1m", "2m", "5m", "10m"] }).notNull().default("inactive"),
  // "Replies in threads I follow" (contract §1.2): off = a followed-thread reply alerts only when it @mentions the user.
  followedThreadReplies: boolean("followed_thread_replies").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("user_notification_settings_preview_mode_check", sql`${t.previewMode} IN ('full', 'sender_only', 'hidden')`),
  check("user_notification_settings_mobile_delay_check", sql`${t.mobileDelay} IN ('always', 'inactive', '1m', '2m', '5m', '10m')`),
  check("user_notification_settings_quiet_minutes_check", sql`${t.quietStartMinute} BETWEEN 0 AND 1439 AND ${t.quietEndMinute} BETWEEN 0 AND 1439`),
]);

// Explicit per-user channel (or DM) notification level. No row = 'default'
// (inherit the server level). Cleared with the channel's other per-user state
// on channel conversion (channelConversionAudience).
export const userChannelNotificationPrefs = pgTable("user_channel_notification_prefs", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  level: text("level", { enum: ["all", "mentions", "none"] }).notNull(),
  prefsVersion: integer("prefs_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.channelId] }),
  index("idx_user_channel_notification_prefs_server").on(t.userId, t.serverId),
  index("idx_user_channel_notification_prefs_channel").on(t.channelId),
  check("user_channel_notification_prefs_level_check", sql`${t.level} IN ('all', 'mentions', 'none')`),
]);

// The one notification level counter per (user, server): every level write in
// the server (server / channel / thread scope) bumps it, and it is the
// `prefsVersion` of every level event there (docs/contracts/notifications.md
// §2.3). It replaces server_members.notification_prefs_version as the
// counter so a level write never locks the member row: read-state and
// membership fences hold that row FOR SHARE, and a removal holds it FOR
// UPDATE. Reads take GREATEST(this, the legacy column), so a version handed
// out before this table existed is never reused. No foreign key to
// server_members or servers (an FK check would take a KEY SHARE lock on
// those rows); the users key matches user_notification_settings.
export const userNotificationLevelVersions = pgTable("user_notification_level_versions", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull(),
  version: integer("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.serverId] }),
]);

// Per-user, per-channel message display preferences. collapseLongMessages=true
// folds long messages in this channel behind Show more for this user only
// (the default, and a missing row, render them in full); it
// does not affect other members, read cursors, or any notification state.
export const userChannelDisplayPrefs = pgTable("user_channel_display_prefs", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  collapseLongMessages: boolean("collapse_long_messages").notNull().default(false),
  prefsVersion: integer("prefs_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.channelId] }),
  index("idx_user_channel_display_prefs_user").on(t.serverId, t.userId),
  index("idx_user_channel_display_prefs_channel").on(t.channelId),
]);

// Durable per-receiver done/suppression watermarks consumed by RisingWave Inbox
// v0.3. All writes must go through services/inboxSuppressionWriters.ts so the
// writer registry and source ratchet remain the enforcement point.
export const inboxSuppressionStates = pgTable("inbox_suppression_states", {
  receiverType: text("receiver_type", { enum: ["user", "agent"] }).notNull(),
  receiverId: uuid("receiver_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  targetKind: text("target_kind", {
    enum: ["channel", "dm", "followed_thread", "public_channel_mention", "public_thread_mention"],
  }).notNull(),
  targetChannelId: uuid("target_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  doneThroughSeq: bigint("done_through_seq", { mode: "number" }),
  doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
  writeSite: text("write_site").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.receiverType, t.receiverId, t.targetKind, t.targetChannelId] }),
  index("idx_inbox_suppression_states_lookup").on(t.serverId, t.receiverType, t.receiverId, t.targetKind, t.targetChannelId),
  index("idx_inbox_suppression_states_source").on(t.sourceChannelId),
  index("idx_inbox_suppression_states_updated").on(t.updatedAt),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_inbox_suppression_states_target").on(t.targetChannelId),
]);

// Durable per-receiver notification facts used to project Activity/Inbox rows.
// Each row means this receiver should see this message as part of a target's
// notification history. A row can advance Activity latest without being unread
// eligible, e.g. the receiver's own sent messages.
export const inboxNotificationFacts = pgTable("inbox_notification_facts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  receiverType: text("receiver_type", { enum: ["user", "agent"] }).notNull(),
  receiverId: uuid("receiver_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // `task`: a task conversation (task v2); every semantic is the thread one,
  // only Activity / agent inbox display differ.
  kind: text("kind", { enum: ["channel", "dm", "thread", "task"] }).notNull(),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  messageSeq: bigint("message_seq", { mode: "number" }).notNull(),
  activityAt: timestamp("activity_at", { withTimezone: true }).notNull(),
  personalMention: boolean("personal_mention").notNull().default(false),
  unreadEligible: boolean("unread_eligible").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_inbox_notification_facts_unique").on(t.receiverType, t.receiverId, t.sourceChannelId, t.messageId),
  index("idx_inbox_notification_facts_receiver_target").on(t.receiverType, t.receiverId, t.sourceChannelId, t.messageSeq),
  index("idx_inbox_notification_facts_message").on(t.messageId),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_inbox_notification_facts_source_channel").on(t.sourceChannelId),
]);

// Dedicated, hidden, agent-only receipt surfaces for completed migrations.
// Database triggers installed by the generated migration make this identity and its sole
// channel_agents membership immutable and forbid any channel_humans row.
export const agentMigrationReceiptChannels = pgTable("agent_migration_receipt_channels", {
  channelId: uuid("channel_id").primaryKey().references(() => channels.id, { onDelete: "restrict" }),
  migrationId: uuid("migration_id").notNull().references(() => agentMigrations.id, { onDelete: "restrict" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "restrict" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_migration_receipt_channels_migration").on(t.migrationId),
  index("idx_agent_migration_receipt_channels_agent").on(t.agentId, t.channelId),
]);

// Agent-only private DM surfaces, one per (agent, kind). `reminders` renders as
// `dm:@reminders` for its owning agent only: exactly one agent member, no
// humans, no dm_channel_identities row, never sendable by the agent.
export const agentPrivateSurfaces = pgTable("agent_private_surfaces", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["reminders"] }).notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.kind] }),
  uniqueIndex("idx_agent_private_surfaces_channel").on(t.channelId),
  check("agent_private_surfaces_kind_valid", sql`${t.kind} IN ('reminders')`),
]);

// Idempotency ledger for app-written agent messages: one row per
// (client, agent, idempotency key), pointing at the message it produced.
export const appAgentMessages = pgTable("app_agent_messages", {
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.clientId, t.agentId, t.idempotencyKey] }),
  index("idx_app_agent_messages_message").on(t.messageId),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_fk_indexes; built CONCURRENTLY on a large table by
  // db:create-device-session-key-indexes).
  index("idx_app_agent_messages_agent").on(t.agentId),
]);

// Idempotency ledger for keyed Agent API writes that have no natural
// per-request row to carry the key (task create, action prepare). One row per
// (agent, route, idempotency key), written in the same transaction as the
// write it records: the request fingerprint that bound the key and the exact
// first response, which a same-key same-request retry replays verbatim. A key
// is valid for 24 hours; an older row counts as absent.
// Message send keeps its key on the message row (messages.agent_send_key).
export const agentApiIdempotencyKeys = pgTable("agent_api_idempotency_keys", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  route: text("route").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.route, t.idempotencyKey] }),
  check("agent_api_idempotency_keys_route_valid", sql`${t.route} IN ('taskCreate', 'actionPrepare')`),
  // Keys are valid for 24 hours; the hourly maintenance sweep deletes expired
  // rows oldest-first in bounded batches through this index.
  index("idx_agent_api_idempotency_keys_created_at").on(t.createdAt),
]);

export const agentMigrationReceiptOutbox = pgTable("agent_migration_receipt_outbox", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  migrationId: uuid("migration_id").notNull().references(() => agentMigrations.id, { onDelete: "cascade" }),
  receiptKind: text("receipt_kind", { enum: ["completed", "canceled", "failed", "aborted"] }).notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "processing", "sent"] }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_migration_receipt_outbox_dedupe").on(t.migrationId, t.receiptKind),
  uniqueIndex("idx_agent_migration_receipt_outbox_message").on(t.messageId),
  index("idx_agent_migration_receipt_outbox_pending").on(t.status, t.createdAt),
  check("agent_migration_receipt_outbox_kind_check", sql`${t.receiptKind} IN ('completed', 'canceled', 'failed', 'aborted')`),
  check("agent_migration_receipt_outbox_status_check", sql`${t.status} IN ('pending', 'processing', 'sent')`),
]);

// Retired Activity sync storage: declarations remain for channel-conversion
// privacy cleanup of already-persisted rows. No serving endpoint writes these
// tables. Historical migrations and stored data are not dropped by retirement.
// One exact row/tombstone version allocator per authenticated principal.
// Every filter/window shares this allocator, so a row re-entering any scope
// must receive a version newer than every prior row or tombstone version for
// that principal.
export const activitySyncPrincipalAuthorities = pgTable("activity_sync_principal_authorities", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalId: uuid("principal_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalId] }),
  check("activity_sync_principal_row_version_nonnegative", sql`${t.rowVersion} >= 0`),
]);

// Mechanical proof that every (server, principal, row) observes one monotonic
// authority across filters. Scope projections may carry different membership,
// but no filter owns an independent version sequence for the same row.
export const activitySyncRowAuthorities = pgTable("activity_sync_row_authorities", {
  serverId: uuid("server_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  rowId: uuid("row_id").notNull(),
  lastVersion: bigint("last_version", { mode: "bigint" }).notNull(),
  active: boolean("active").notNull(),
  payloadDigest: text("payload_digest"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalId, t.rowId] }),
  foreignKey({
    columns: [t.serverId, t.principalId],
    foreignColumns: [
      activitySyncPrincipalAuthorities.serverId,
      activitySyncPrincipalAuthorities.principalId,
    ],
    name: "activity_sync_row_authorities_principal_fk",
  }).onDelete("cascade"),
  check("activity_sync_row_authority_version_positive", sql`${t.lastVersion} > 0`),
  check(
    "activity_sync_row_authority_shape",
    sql`(${t.active} AND ${t.payloadDigest} IS NOT NULL)
      OR (NOT ${t.active} AND ${t.payloadDigest} IS NULL)`,
  ),
]);

// Server-authoritative Activity window state.
//
// V1 intentionally exposes one bounded window ("main") per
// (server, principal, filter). The scope owns its dense difference watermark;
// row/tombstone versions come from the cross-filter principal authority above.
export const activitySyncScopes = pgTable("activity_sync_scopes", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalId: uuid("principal_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  filter: text("filter", { enum: ["all", "unread", "mentions"] }).notNull(),
  windowId: text("window_id").notNull().default("main"),
  epoch: bigint("epoch", { mode: "bigint" }).notNull().default(sql`1`),
  watermark: bigint("watermark", { mode: "bigint" }).notNull().default(sql`0`),
  windowSize: integer("window_size").notNull().default(30),
  scopeDigest: text("scope_digest"),
  metadata: jsonb("metadata").$type<{
    nextCursor: string | null;
    hasMore: boolean;
    complete: boolean;
    totalCount: number;
    totalUnreadCount: number;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalId, t.filter, t.windowId] }),
  index("idx_activity_sync_scopes_principal").on(t.serverId, t.principalId),
  check("activity_sync_scopes_main_window", sql`${t.windowId} = 'main'`),
  check("activity_sync_scopes_epoch_positive", sql`${t.epoch} > 0`),
  check("activity_sync_scopes_watermark_nonnegative", sql`${t.watermark} >= 0`),
  check("activity_sync_scopes_window_size_bounded", sql`${t.windowSize} BETWEEN 1 AND 500`),
]);

// Current rows and retained tombstones for one Activity window. Payload is the
// exact normalized ActivityRow without rowVersion; the version is stored as an
// exact bigint and encoded as a decimal string at the HTTP boundary.
export const activitySyncRows = pgTable("activity_sync_rows", {
  serverId: uuid("server_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  filter: text("filter", { enum: ["all", "unread", "mentions"] }).notNull(),
  windowId: text("window_id").notNull().default("main"),
  rowId: uuid("row_id").notNull(),
  rowVersion: bigint("row_version", { mode: "bigint" }).notNull(),
  active: boolean("active").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  payloadDigest: text("payload_digest"),
  tombstoneReason: text("tombstone_reason", {
    enum: ["done", "deleted", "outOfWindow"],
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalId, t.filter, t.windowId, t.rowId] }),
  foreignKey({
    columns: [t.serverId, t.principalId, t.filter, t.windowId],
    foreignColumns: [
      activitySyncScopes.serverId,
      activitySyncScopes.principalId,
      activitySyncScopes.filter,
      activitySyncScopes.windowId,
    ],
    name: "activity_sync_rows_scope_fk",
  }).onDelete("cascade"),
  index("idx_activity_sync_rows_scope_active").on(t.serverId, t.principalId, t.filter, t.windowId, t.active),
  check(
    "activity_sync_rows_shape",
    sql`(${t.active} AND ${t.payload} IS NOT NULL AND ${t.payloadDigest} IS NOT NULL AND ${t.tombstoneReason} IS NULL)
      OR (NOT ${t.active} AND ${t.payload} IS NULL AND ${t.payloadDigest} IS NULL AND ${t.tombstoneReason} IS NOT NULL)`,
  ),
  check("activity_sync_rows_version_positive", sql`${t.rowVersion} > 0`),
]);

// Bounded dense repair log. A row-version change owns exactly one scope seq.
// When the log reaches its retention bound, the writer rolls the epoch before
// accepting further changes; old clients then receive snapshotRequired rather
// than a fabricated gap-free difference.
export const activitySyncChanges = pgTable("activity_sync_changes", {
  serverId: uuid("server_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  filter: text("filter", { enum: ["all", "unread", "mentions"] }).notNull(),
  windowId: text("window_id").notNull().default("main"),
  seq: bigint("seq", { mode: "bigint" }).notNull(),
  rowId: uuid("row_id"),
  rowVersion: bigint("row_version", { mode: "bigint" }),
  kind: text("kind", { enum: ["upsert", "tombstone", "scope"] }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  tombstoneReason: text("tombstone_reason", {
    enum: ["done", "deleted", "outOfWindow"],
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.principalId, t.filter, t.windowId, t.seq] }),
  foreignKey({
    columns: [t.serverId, t.principalId, t.filter, t.windowId],
    foreignColumns: [
      activitySyncScopes.serverId,
      activitySyncScopes.principalId,
      activitySyncScopes.filter,
      activitySyncScopes.windowId,
    ],
    name: "activity_sync_changes_scope_fk",
  }).onDelete("cascade"),
  index("idx_activity_sync_changes_scope_row").on(t.serverId, t.principalId, t.filter, t.windowId, t.rowId),
  check(
    "activity_sync_changes_shape",
    sql`(${t.kind} = 'upsert' AND ${t.rowId} IS NOT NULL AND ${t.rowVersion} IS NOT NULL
          AND ${t.payload} IS NOT NULL AND ${t.tombstoneReason} IS NULL)
      OR (${t.kind} = 'tombstone' AND ${t.rowId} IS NOT NULL AND ${t.rowVersion} IS NOT NULL
          AND ${t.payload} IS NULL AND ${t.tombstoneReason} IS NOT NULL)
      OR (${t.kind} = 'scope' AND ${t.rowId} IS NULL AND ${t.rowVersion} IS NULL
          AND ${t.payload} IS NOT NULL AND ${t.tombstoneReason} IS NULL)`,
  ),
  check("activity_sync_changes_seq_positive", sql`${t.seq} > 0`),
  check(
    "activity_sync_changes_row_version_positive",
    sql`${t.rowVersion} IS NULL OR ${t.rowVersion} > 0`,
  ),
]);

// Agent-channel read cursor for agent unread tracking
export const agentChannelReadCursors = pgTable("agent_channel_read_cursors", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  lastReadSeq: integer("last_read_seq").notNull().default(0),
  // RFC 057 phase-A shadow; see user_channel_read_cursors.last_read_seq8.
  lastReadSeq8: bigint("last_read_seq8", { mode: "bigint" }),
  readStateVersion: integer("read_state_version").notNull().default(0),
  lastAppliedAuthoritySeq: bigint("last_applied_authority_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.channelId] }),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_agent_channel_read_cursors_channel").on(t.channelId),
]);

// Email verification tokens
export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email"),
  tokenHash: text("token_hash").notNull(),
  otpHash: text("otp_hash"),
  otpExpiresAt: timestamp("otp_expires_at", { withTimezone: true }),
  otpAttempts: integer("otp_attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_email_verifications_user").on(t.userId),
  index("idx_email_verifications_email").on(t.email),
]);

// Password reset tokens
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_password_resets_user").on(t.userId),
]);

// Checkout creation reserves custody before provider I/O. An ambiguous create
// is not erased on timeout: it may still have produced a payable session.
export const billingCheckoutAttempts = pgTable("billing_checkout_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  state: text("state", { enum: ["creating", "known", "ambiguous"] }).notNull(),
  stripeSessionId: text("stripe_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_billing_checkout_attempt_server").on(t.serverId),
  uniqueIndex("idx_billing_checkout_attempt_session").on(t.stripeSessionId),
  check("billing_checkout_attempt_state_valid", sql`(${t.state} = 'known' AND ${t.stripeSessionId} IS NOT NULL)
    OR (${t.state} IN ('creating', 'ambiguous') AND ${t.stripeSessionId} IS NULL)`),
]);

// A short lease only protects a read-only provider scan. It cannot make an
// unresolved checkout safe, and an expired lease never settles an attempt.
export const billingSourceGuards = pgTable("billing_source_guards", {
  serverId: uuid("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  bindLeaseToken: uuid("bind_lease_token"),
  bindLeaseExpiresAt: timestamp("bind_lease_expires_at", { withTimezone: true }),
}, (t) => [check("billing_source_guard_lease_valid", sql`(${t.bindLeaseToken} IS NULL) = (${t.bindLeaseExpiresAt} IS NULL)`)]);

// Subscriptions — Stripe billing records (one per server)
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }).unique(),
  plan: text("plan", { enum: ["pro"] }).notNull().default("pro"),
  provider: text("provider", { enum: ["stripe"] }).notNull().default("stripe"),
  billingInterval: text("billing_interval", { enum: ["monthly", "annual"] }).notNull().default("annual"),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  stripeProPackItemId: text("stripe_pro_pack_item_id"),
  stripeExtraAgentItemId: text("stripe_extra_agent_item_id"), // [UNUSED] legacy extra-agent billing disabled
  status: text("status", { enum: ["active", "past_due", "canceled", "incomplete"] }).notNull(),
  provisionedHumanSeats: integer("provisioned_human_seats").notNull().default(0),
  provisionedAgentSeats: integer("provisioned_agent_seats").notNull().default(0),
  proPackQuantity: integer("pro_pack_quantity").notNull().default(1),
  trialFreePackQuantity: integer("trial_free_pack_quantity").notNull().default(0),
  firstPackTrialEndsAt: timestamp("first_pack_trial_ends_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  lastProviderEventId: text("last_provider_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_subscriptions_server").on(t.serverId),
  index("idx_subscriptions_plan").on(t.plan),
  index("idx_subscriptions_stripe_customer").on(t.stripeCustomerId),
  index("idx_subscriptions_stripe_sub").on(t.stripeSubscriptionId),
]);

// Prepaid Pro (task #19, #proj-commercial; docs/billing/prepaid-pro.md): one
// row per paid one-time Checkout (Alipay), never a subscription. `period` buys
// months of Pro at a seat count; `seats` adds seats to the time already paid.
// Rows are appended by the Stripe webhook; afterwards only `status` and the
// refund columns change. A payment record: a deleted Server only clears
// `server_id`, so refunds and reconciliation can still find it. Grants are
// derived on read (prepaidProService.ts); `servers.plan` is the only stored
// projection.
export const prepaidProPurchases = pgTable("prepaid_pro_purchases", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["period", "seats"] }).notNull(),
  months: integer("months"),
  seatQuantity: integer("seat_quantity").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["paid", "refunded", "conflict"] }).notNull(),
  /** Why a paid Checkout granted nothing (and was refunded): another paid source was already on the Server, the amount did not match the Price, or the Server was gone. */
  conflictReason: text("conflict_reason", { enum: ["paid_source", "amount_mismatch", "server_unavailable"] }),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull().unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeCustomerId: text("stripe_customer_id"),
  /** Set when Raft refunded it (a conflict) or when Stripe reported a full refund. */
  stripeRefundId: text("stripe_refund_id"),
  amountTotal: integer("amount_total").notNull(),
  currency: text("currency").notNull(),
  purchasedByUserId: uuid("purchased_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_prepaid_pro_purchases_server_ends").on(t.serverId, t.endsAt),
  index("idx_prepaid_pro_purchases_payment_intent").on(t.stripePaymentIntentId),
  // The hourly lapse sweep and reminders scan paid periods by end date across Servers.
  index("idx_prepaid_pro_purchases_period_ends").on(t.endsAt).where(sql`${t.kind} = 'period'`),
  check("prepaid_pro_purchase_months_valid", sql`(${t.kind} = 'period' AND ${t.months} IN (1, 3, 12))
    OR (${t.kind} = 'seats' AND ${t.months} IS NULL)`),
  check("prepaid_pro_purchase_seats_positive", sql`${t.seatQuantity} > 0`),
  check("prepaid_pro_purchase_window_valid", sql`${t.endsAt} > ${t.startsAt}`),
  check("prepaid_pro_purchase_amount_valid", sql`${t.amountTotal} >= 0`),
  check("prepaid_pro_purchase_conflict_reason", sql`(${t.status} = 'conflict') = (${t.conflictReason} IS NOT NULL)`),
]);

// Prepaid Pro reminders (task #19): one row per reminder email before or at
// the end of prepaid time (7 days, 1 day, ended). Keyed to the last purchase
// of the paid chain, so a renewal (a newer last purchase) starts fresh and
// each reminder goes once per purchase. The hourly job claims the row first
// (insert ... on conflict do nothing) and sends only when it won; `sent_at`
// stays null until the provider accepted it, and a claim left unsent for 15
// minutes is sent again (the provider's idempotency key absorbs a send that
// did go out).
export const prepaidProReminders = pgTable("prepaid_pro_reminders", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  purchaseId: uuid("purchase_id").notNull().references(() => prepaidProPurchases.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["ends_in_7_days", "ends_in_1_day", "ended"] }).notNull(),
  recipientUserId: uuid("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set once the provider accepted the email. */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Resend's id for the email, when the provider returned one. */
  emailId: text("email_id"),
}, (t) => [
  uniqueIndex("uq_prepaid_pro_reminders_purchase_kind").on(t.purchaseId, t.kind),
  check("prepaid_pro_reminder_kind_valid", sql`${t.kind} IN ('ends_in_7_days', 'ends_in_1_day', 'ended')`),
]);

// Paid lifecycle email: durable User identity, dirty-only property sync, and
// actual-dispatch receipts. Native Resend owns the 35-day wait/preferences.
export const paidLifecycleJourneys = pgTable("paid_lifecycle_journeys", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  id: uuid("id").notNull().unique().$defaultFn(() => randomUUID()),
  firstPaidAt: timestamp("first_paid_at", { withTimezone: true }).notNull(),
  contactId: text("contact_id").unique(),
  contactEmail: text("contact_email"),
  revision: integer("revision").notNull().default(1),
  needsSync: boolean("needs_sync").notNull().default(true),
  // Retained migration column; no runtime writer/reader or expiry scheduler.
  refreshAfter: timestamp("refresh_after", { withTimezone: true }),
  triggerState: text("trigger_state", { enum: ["pending", "attempted", "accepted", "unknown", "suppressed"] }).notNull().default("pending"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("idx_paid_lifecycle_dirty").on(t.needsSync, t.leaseUntil, t.userId), index("idx_paid_lifecycle_expiry").on(t.refreshAfter), check("paid_lifecycle_trigger_state", sql`${t.triggerState} IN ('pending','attempted','accepted','unknown','suppressed')`)]);

export const paidLifecyclePayments = pgTable("paid_lifecycle_payments", {
  invoiceId: text("invoice_id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  payerUserId: uuid("payer_user_id").references(() => users.id, { onDelete: "set null" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  paymentId: text("payment_id").notNull(),
  chargeId: text("charge_id").notNull(),
  amount: integer("amount").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
}, t => [index("idx_paid_lifecycle_payment_server").on(t.serverId), index("idx_paid_lifecycle_payment_charge").on(t.chargeId), check("paid_lifecycle_payment_positive", sql`${t.amount} > 0`)]);

export const paidLifecycleReceipts = pgTable("paid_lifecycle_receipts", {
  emailId: uuid("email_id").primaryKey(),
  journeyId: uuid("journey_id").notNull().references(() => paidLifecycleJourneys.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["welcome", "checkin"] }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  needsSync: boolean("needs_sync").notNull().default(true),
}, t => [index("idx_paid_lifecycle_receipt_pending").on(t.needsSync, t.emailId), uniqueIndex("idx_paid_lifecycle_receipt_step").on(t.journeyId, t.kind), check("paid_lifecycle_receipt_kind", sql`${t.kind} IN ('welcome','checkin')`)]);

// AppSumo licenses are a separate entitlement source; never synthetic Stripe subscriptions.
// Provider key history survives replacements. Only a verified current license
// selected by an owner binding can project paid access.
export const appSumoLicenses = pgTable("appsumo_licenses", {
  productId: text("product_id").notNull(),
  licenseKey: uuid("license_key").$type<AppSumoLicenseKey>().notNull(),
  previousLicenseKey: uuid("previous_license_key").$type<AppSumoLicenseKey>(),
  tier: integer("tier"),
  status: text("status", { enum: ["pending", "inactive", "active", "deactivated"] }).notNull().default("pending"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(0),
  expectedStatus: text("expected_status", { enum: ["active", "deactivated"] }),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  checkLeaseToken: uuid("check_lease_token"),
  checkLeaseExpiresAt: timestamp("check_lease_expires_at", { withTimezone: true }),
  checkAttempts: integer("check_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.productId, t.licenseKey] }),
  index("appsumo_license_due_idx").on(t.productId, t.nextCheckAt).where(sql`${t.nextCheckAt} is not null`),
  unique("appsumo_license_successor_unique").on(t.productId, t.previousLicenseKey),
  check("appsumo_license_product_check", sql`length(${t.productId}) between 1 and 80`),
  check("appsumo_license_tier_check", sql`${t.tier} is null or ${t.tier} between 1 and 4`),
  check("appsumo_license_status_check", sql`${t.status} in ('pending', 'inactive', 'active', 'deactivated')`),
  check("appsumo_license_verified_check", sql`${t.status} <> 'active' or (${t.verifiedAt} is not null and ${t.tier} is not null)`),
  check("appsumo_license_previous_check", sql`${t.previousLicenseKey} is null or ${t.previousLicenseKey} <> ${t.licenseKey}`),
  check("appsumo_license_revision_check", sql`${t.revision} >= 0`),
  check("appsumo_license_check_state", sql`(${t.expectedStatus} is null or ${t.expectedStatus} in ('active', 'deactivated')) and ${t.checkAttempts} >= 0`),
  check("appsumo_license_check_lease", sql`(${t.checkLeaseToken} is null) = (${t.checkLeaseExpiresAt} is null)`),
]);

export const appSumoLicenseBindings = pgTable("appsumo_license_bindings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // Keep the license claimed even when its server is deleted; no silent transfer.
  serverId: uuid("server_id").unique().references(() => servers.id, { onDelete: "set null" }),
  productId: text("product_id").notNull(),
  originalLicenseKey: uuid("original_license_key").$type<AppSumoLicenseKey>().notNull(),
  currentLicenseKey: uuid("current_license_key").$type<AppSumoLicenseKey>().notNull(),
  boundByUserId: uuid("bound_by_user_id").references(() => users.id, { onDelete: "set null" }),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("appsumo_binding_original_unique").on(t.productId, t.originalLicenseKey),
  unique("appsumo_binding_current_unique").on(t.productId, t.currentLicenseKey),
  foreignKey({ columns: [t.productId, t.originalLicenseKey], foreignColumns: [appSumoLicenses.productId, appSumoLicenses.licenseKey], name: "appsumo_binding_original_fk" }),
  foreignKey({ columns: [t.productId, t.currentLicenseKey], foreignColumns: [appSumoLicenses.productId, appSumoLicenses.licenseKey], name: "appsumo_binding_current_fk" }),
]);

// A product-scoped mutex also reserves the provider's 20/minute API budget
// across replicas. Network calls happen after committing this reservation.
export const appSumoProducts = pgTable("appsumo_products", {
  productId: text("product_id").primaryKey(),
  nextApiRequestAt: timestamp("next_api_request_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSumoWebhookReceipts = pgTable("appsumo_webhook_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  productId: text("product_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  licenseKey: uuid("license_key").$type<AppSumoLicenseKey>().notNull(),
  event: text("event", { enum: ["purchase", "activate", "upgrade", "downgrade", "deactivate"] }).notNull(),
  previousLicenseKey: uuid("previous_license_key").$type<AppSumoLicenseKey>(),
  tier: integer("tier"),
  providerEventTimestamp: bigint("provider_event_timestamp", { mode: "number" }).notNull(),
  providerCreatedAt: bigint("provider_created_at", { mode: "number" }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("appsumo_webhook_receipt_unique").on(t.productId, t.requestDigest),
  index("appsumo_webhook_license_idx").on(t.productId, t.licenseKey),
  check("appsumo_webhook_digest_check", sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("appsumo_webhook_event_check", sql`${t.event} in ('purchase', 'activate', 'upgrade', 'downgrade', 'deactivate')`),
]);

export const appSumoRedemptionClaims = pgTable("appsumo_redemption_claims", {
  id: uuid("id").$type<AppSumoClaimId>().notNull().unique().$defaultFn(createAppSumoClaimId),
  tokenHash: text("token_hash").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  productId: text("product_id").notNull(),
  licenseKey: uuid("license_key").$type<AppSumoLicenseKey>(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  boundServerId: uuid("bound_server_id").references(() => servers.id, { onDelete: "set null" }),
  state: text("state", { enum: ["exchanging", "ready", "consumed", "failed"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("appsumo_claim_expiry_idx").on(t.productId, t.expiresAt),
  check("appsumo_claim_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$' and ${t.codeHash} ~ '^[0-9a-f]{64}$'`),
  check("appsumo_claim_state_check", sql`${t.state} in ('exchanging', 'ready', 'consumed', 'failed')`),
  check("appsumo_claim_key_check", sql`${t.state} not in ('ready', 'consumed') or ${t.licenseKey} is not null`),
]);

// Webhook events — idempotency tracking for Stripe webhooks
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // Stripe event ID (evt_...)
  type: text("type").notNull(),
  status: text("status", { enum: ["processing", "processed"] }).notNull().default("processed"),
  processingToken: text("processing_token"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Attachment objects — immutable stored bytes and their physical metadata
// (RFC 049). The only home of that metadata: every `attachments` projection
// names one object and reads it from here.
export const attachmentUploaderTypes = ["user", "agent", "external_projection"] as const;
export type AttachmentUploaderType = typeof attachmentUploaderTypes[number];

export const attachmentObjects = pgTable("attachment_objects", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // Immutable attribution snapshot, deliberately not a live-server FK.
  originServerId: uuid("origin_server_id").notNull(),
  uploaderId: text("uploader_id").notNull(),
  uploaderType: text("uploader_type", { enum: attachmentUploaderTypes }).notNull(),
  storageKey: text("storage_key").notNull(),
  thumbnailKey: text("thumbnail_key"),
  contentHash: text("content_hash"),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  lifecycleState: text("lifecycle_state", { enum: ["active", "gc_pending", "deleted"] })
    .notNull().default("active"),
  gcToken: uuid("gc_token"),
  gcStartedAt: timestamp("gc_started_at", { withTimezone: true }),
  // When the last row in attachment_object_holds for this object was removed;
  // NULL while any hold exists. NULL with no hold means "never tracked" (the
  // object predates the holds backfill). Meaningful only while active.
  unheldSince: timestamp("unheld_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_objects_storage_key").on(t.storageKey),
  index("idx_attachment_objects_gc").on(t.lifecycleState, t.gcStartedAt),
  check("attachment_objects_uploader_type", sql`${t.uploaderType} IN ('user', 'agent', 'external_projection')`),
  check("attachment_objects_lifecycle_state", sql`${t.lifecycleState} IN ('active', 'gc_pending', 'deleted')`),
  check(
    "attachment_objects_gc_consistency",
    sql`(${t.lifecycleState} = 'active' AND ${t.gcToken} IS NULL AND ${t.gcStartedAt} IS NULL)
      OR (${t.lifecycleState} = 'gc_pending' AND ${t.gcToken} IS NOT NULL AND ${t.gcStartedAt} IS NOT NULL)
      OR (${t.lifecycleState} = 'deleted' AND ${t.gcToken} IS NOT NULL AND ${t.gcStartedAt} IS NOT NULL)`,
  ),
]);

// Platform holds: one row says "this holder keeps these bytes alive". Bytes are
// collectable only while an object has no hold (proposal "platform file
// storage" step 2a). Holders are added and removed only through
// services/attachmentObjectHoldService.ts inside the holder's own transaction;
// adding requires the object to be `active` under FOR NO KEY UPDATE. holder_id
// is text so app holders (Artifacts version files) need not be uuids;
// registering a new holder type widens the CHECK below.
export const attachmentObjectHolderTypes = ["attachment", "upload_reservation"] as const;
export type AttachmentObjectHolderType = typeof attachmentObjectHolderTypes[number];

export const attachmentObjectHolds = pgTable("attachment_object_holds", {
  holderType: text("holder_type", { enum: attachmentObjectHolderTypes }).notNull(),
  holderId: text("holder_id").notNull(),
  objectId: uuid("object_id").notNull().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.holderType, t.holderId, t.objectId] }),
  index("idx_attachment_object_holds_object").on(t.objectId),
  check("attachment_object_holds_holder_type", sql`${t.holderType} IN ('attachment', 'upload_reservation')`),
]);

// Immutable exactly-once charge identity for upload-created logical objects.
// Backfill and future projection-only writes intentionally create no row here.
export const attachmentObjectCharges = pgTable("attachment_object_charges", {
  objectId: uuid("object_id").primaryKey().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  originServerId: uuid("origin_server_id").notNull(),
  chargeMonth: date("charge_month").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_object_charges_server_month").on(t.originServerId, t.chargeMonth),
  check("attachment_object_charges_size_nonnegative", sql`${t.sizeBytes} >= 0`),
]);

// Completed uploads waiting to be consumed by their first message. The
// reservation id is also the public projection id used when consumption wins,
// so retries never need to translate a transient upload handle into a new id.
// Terminal rows are retained for stable replay and audit.
export const attachmentUploadReservations = pgTable("attachment_upload_reservations", {
  id: uuid("id").primaryKey(),
  objectId: uuid("object_id").notNull().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  originServerId: uuid("origin_server_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  creatorId: text("creator_id").notNull(),
  creatorType: text("creator_type", { enum: attachmentUploaderTypes }).notNull(),
  filename: text("filename").notNull(),
  state: text("state", { enum: ["pending", "consumed", "canceled", "expired"] })
    .notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
  consumedMessageId: uuid("consumed_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_upload_reservations_object").on(t.objectId),
  index("idx_attachment_upload_reservations_expiry").on(t.state, t.expiresAt),
  index("idx_attachment_upload_reservations_creator").on(t.originServerId, t.creatorType, t.creatorId),
  check(
    "attachment_upload_reservations_creator_type",
    sql`${t.creatorType} IN ('user', 'agent', 'external_projection')`,
  ),
  check("attachment_upload_reservations_state", sql`${t.state} IN ('pending', 'consumed', 'canceled', 'expired')`),
  check(
    "attachment_upload_reservations_terminal_consistency",
    sql`(${t.state} = 'pending' AND ${t.terminalAt} IS NULL AND ${t.terminalReason} IS NULL AND ${t.consumedMessageId} IS NULL)
      OR (${t.state} = 'consumed' AND ${t.terminalAt} IS NOT NULL AND ${t.consumedMessageId} IS NOT NULL)
      OR (${t.state} IN ('canceled', 'expired') AND ${t.terminalAt} IS NOT NULL AND ${t.terminalReason} IS NOT NULL AND ${t.consumedMessageId} IS NULL)`,
  ),
]);

// Physical storage identities. Historical objects may share one artifact;
// every new upload creates unique keys and therefore unique artifact rows.
// Availability is inventory evidence, never lifecycle authority.
export const attachmentStorageArtifacts = pgTable("attachment_storage_artifacts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  backend: text("backend", { enum: ["attachment", "cdn"] }).notNull(),
  storageKey: text("storage_key").notNull(),
  lifecycleState: text("lifecycle_state", { enum: ["active", "delete_pending", "deleted"] })
    .notNull().default("active"),
  availabilityState: text("availability_state", { enum: ["unverified", "verified", "missing"] })
    .notNull().default("unverified"),
  availabilityObservedAt: timestamp("availability_observed_at", { withTimezone: true }),
  deleteToken: uuid("delete_token"),
  deleteLeaseId: uuid("delete_lease_id"),
  deleteLeaseExpiresAt: timestamp("delete_lease_expires_at", { withTimezone: true }),
  deleteAttempts: integer("delete_attempts").notNull().default(0),
  lastErrorClass: text("last_error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_attachment_storage_artifacts_backend_key").on(t.backend, t.storageKey),
  index("idx_attachment_storage_artifacts_delete").on(t.lifecycleState, t.deleteLeaseExpiresAt),
  check("attachment_storage_artifacts_backend", sql`${t.backend} IN ('attachment', 'cdn')`),
  check("attachment_storage_artifacts_lifecycle", sql`${t.lifecycleState} IN ('active', 'delete_pending', 'deleted')`),
  check("attachment_storage_artifacts_availability", sql`${t.availabilityState} IN ('unverified', 'verified', 'missing')`),
  check(
    "attachment_storage_artifacts_delete_consistency",
    sql`(${t.lifecycleState} = 'active' AND ${t.deleteToken} IS NULL AND ${t.deleteLeaseId} IS NULL AND ${t.deleteLeaseExpiresAt} IS NULL)
      OR (${t.lifecycleState} = 'delete_pending' AND ${t.deleteToken} IS NOT NULL)
      OR (${t.lifecycleState} = 'deleted' AND ${t.deleteToken} IS NOT NULL AND ${t.deleteLeaseId} IS NULL AND ${t.deleteLeaseExpiresAt} IS NULL)`,
  ),
]);

export const attachmentObjectArtifacts = pgTable("attachment_object_artifacts", {
  objectId: uuid("object_id").notNull().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  artifactId: uuid("artifact_id").notNull().references(() => attachmentStorageArtifacts.id, { onDelete: "restrict" }),
  role: text("role", { enum: ["original", "thumbnail", "svg_raster_preview", "future_derived"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.objectId, t.role] }),
  index("idx_attachment_object_artifacts_artifact").on(t.artifactId),
  check("attachment_object_artifacts_role", sql`${t.role} IN ('original', 'thumbnail', 'svg_raster_preview', 'future_derived')`),
]);

// Immutable receipts for one external-byte inventory. A completed run records
// the exact database candidate set it observed; it is evidence only and grants
// no lifecycle or deletion authority.
export const attachmentArtifactInventoryRuns = pgTable("attachment_artifact_inventory_runs", {
  id: uuid("id").primaryKey(),
  evidenceSource: text("evidence_source").notNull(),
  sourceRevision: text("source_revision").notNull(),
  inventoryDigest: text("inventory_digest").notNull(),
  scopeServerId: uuid("scope_server_id"),
  objectCount: integer("object_count").notNull(),
  artifactCount: integer("artifact_count").notNull(),
  observationCount: integer("observation_count").notNull(),
  classificationCount: integer("classification_count").notNull(),
  legacyObjectlessProjectionCount: integer("legacy_objectless_projection_count").notNull(),
  danglingProjectionCount: integer("dangling_projection_count").notNull(),
  metadataMismatchCount: integer("metadata_mismatch_count").notNull(),
  deletedOriginServerObjectCount: integer("deleted_origin_server_object_count").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_artifact_inventory_runs_observed").on(t.observedAt),
  index("idx_attachment_artifact_inventory_runs_scope").on(t.scopeServerId, t.observedAt),
  check("attachment_artifact_inventory_runs_counts_nonnegative", sql`${t.objectCount} >= 0
    AND ${t.artifactCount} >= 0
    AND ${t.observationCount} >= 0
    AND ${t.classificationCount} >= 0
    AND ${t.legacyObjectlessProjectionCount} >= 0
    AND ${t.danglingProjectionCount} >= 0
    AND ${t.metadataMismatchCount} >= 0
    AND ${t.deletedOriginServerObjectCount} >= 0`),
]);

// One immutable, auditable HEAD result per physical artifact per inventory.
// `unverified` is a first-class failed-closed result, never an alias for exists.
export const attachmentArtifactInventoryObservations = pgTable("attachment_artifact_inventory_observations", {
  runId: uuid("run_id").notNull().references(() => attachmentArtifactInventoryRuns.id, { onDelete: "restrict" }),
  artifactId: uuid("artifact_id").notNull().references(() => attachmentStorageArtifacts.id, { onDelete: "restrict" }),
  result: text("result", { enum: ["exists", "missing", "unverified"] }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  errorClass: text("error_class"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.artifactId] }),
  index("idx_attachment_artifact_inventory_observations_artifact").on(t.artifactId, t.observedAt),
  check("attachment_artifact_inventory_observations_result", sql`${t.result} IN ('exists', 'missing', 'unverified')`),
  check(
    "attachment_artifact_inventory_observations_consistency",
    sql`(${t.result} = 'exists' AND ${t.sizeBytes} IS NOT NULL AND ${t.sizeBytes} >= 0 AND ${t.errorClass} IS NULL)
      OR (${t.result} = 'missing' AND ${t.sizeBytes} IS NULL AND ${t.errorClass} IS NULL)
      OR (${t.result} = 'unverified' AND ${t.sizeBytes} IS NULL AND ${t.errorClass} IS NOT NULL)`,
  ),
]);

// Per-run semantic and byte-evidence classification. This is diagnosis only:
// no category authorizes repair, refund, reservation synthesis, or deletion.
export const attachmentObjectInventoryClassifications = pgTable("attachment_object_inventory_classifications", {
  runId: uuid("run_id").notNull().references(() => attachmentArtifactInventoryRuns.id, { onDelete: "restrict" }),
  objectId: uuid("object_id").notNull().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  semanticClass: text("semantic_class", {
    enum: ["live", "pending_migratable", "terminal_proven", "shared_artifact_blocked", "legacy_unknown"],
  }).notNull(),
  bytesEvidence: text("bytes_evidence", {
    enum: ["bytes_verified", "bytes_missing", "bytes_unverified"],
  }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.objectId] }),
  index("idx_attachment_object_inventory_classifications_object").on(t.objectId, t.observedAt),
  check(
    "attachment_object_inventory_classifications_semantic",
    sql`${t.semanticClass} IN ('live', 'pending_migratable', 'terminal_proven', 'shared_artifact_blocked', 'legacy_unknown')`,
  ),
  check(
    "attachment_object_inventory_classifications_bytes",
    sql`${t.bytesEvidence} IN ('bytes_verified', 'bytes_missing', 'bytes_unverified')`,
  ),
]);

// Every upload writer persists this intent and its complete physical-artifact
// plan before the first external PUT. The future reservation/object ids are
// allocated here so storage success can never create an ownerless blob.
export const attachmentTransferIntents = pgTable("attachment_transfer_intents", {
  id: uuid("id").primaryKey(),
  reservationId: uuid("reservation_id").notNull(),
  objectId: uuid("object_id").notNull(),
  serverId: uuid("server_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  uploaderId: text("uploader_id").notNull(),
  uploaderType: text("uploader_type", { enum: attachmentUploaderTypes }).notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }).notNull(),
  state: text("state", { enum: ["planned", "completed", "canceled", "expired", "failed"] })
    .notNull().default("planned"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_attachment_transfer_intents_reservation").on(t.reservationId),
  uniqueIndex("uq_attachment_transfer_intents_object").on(t.objectId),
  index("idx_attachment_transfer_intents_expiry").on(t.state, t.expiresAt),
  check(
    "attachment_transfer_intents_uploader_type",
    sql`${t.uploaderType} IN ('user', 'agent', 'external_projection')`,
  ),
  check("attachment_transfer_intents_size_positive", sql`${t.declaredSizeBytes} > 0`),
  check("attachment_transfer_intents_state", sql`${t.state} IN ('planned', 'completed', 'canceled', 'expired', 'failed')`),
  check(
    "attachment_transfer_intents_terminal_consistency",
    sql`(${t.state} = 'planned' AND ${t.completedAt} IS NULL AND ${t.terminalReason} IS NULL)
      OR (${t.state} = 'completed' AND ${t.completedAt} IS NOT NULL AND ${t.terminalReason} IS NULL)
      OR (${t.state} IN ('canceled', 'expired', 'failed') AND ${t.completedAt} IS NULL AND ${t.terminalReason} IS NOT NULL)`,
  ),
]);

// Planned rows remain deletion obligations even when a process dies after PUT
// but before it can acknowledge byte creation. Adoption is atomic with object
// publication; every other terminal/expired plan is idempotently deleted.
export const attachmentTransferArtifacts = pgTable("attachment_transfer_artifacts", {
  intentId: uuid("intent_id").notNull().references(() => attachmentTransferIntents.id, { onDelete: "restrict" }),
  role: text("role", { enum: ["original", "thumbnail", "svg_raster_preview"] }).notNull(),
  backend: text("backend", { enum: ["attachment", "cdn"] }).notNull(),
  storageKey: text("storage_key").notNull(),
  state: text("state", { enum: ["planned", "adopted", "deleting", "deleted"] })
    .notNull().default("planned"),
  adoptedArtifactId: uuid("adopted_artifact_id").references(() => attachmentStorageArtifacts.id, { onDelete: "restrict" }),
  deleteLeaseId: uuid("delete_lease_id"),
  deleteLeaseExpiresAt: timestamp("delete_lease_expires_at", { withTimezone: true }),
  deleteAttempts: integer("delete_attempts").notNull().default(0),
  lastErrorClass: text("last_error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.intentId, t.role] }),
  uniqueIndex("uq_attachment_transfer_artifacts_backend_key").on(t.backend, t.storageKey),
  index("idx_attachment_transfer_artifacts_cleanup").on(t.state, t.deleteLeaseExpiresAt),
  check("attachment_transfer_artifacts_role", sql`${t.role} IN ('original', 'thumbnail', 'svg_raster_preview')`),
  check("attachment_transfer_artifacts_backend", sql`${t.backend} IN ('attachment', 'cdn')`),
  check("attachment_transfer_artifacts_state", sql`${t.state} IN ('planned', 'adopted', 'deleting', 'deleted')`),
  check("attachment_transfer_artifacts_attempts_nonnegative", sql`${t.deleteAttempts} >= 0`),
  check(
    "attachment_transfer_artifacts_state_consistency",
    sql`(${t.state} = 'planned' AND ${t.adoptedArtifactId} IS NULL AND ${t.deleteLeaseId} IS NULL AND ${t.deleteLeaseExpiresAt} IS NULL)
      OR (${t.state} = 'adopted' AND ${t.adoptedArtifactId} IS NOT NULL AND ${t.deleteLeaseId} IS NULL AND ${t.deleteLeaseExpiresAt} IS NULL)
      OR (${t.state} = 'deleting' AND ${t.adoptedArtifactId} IS NULL AND ${t.deleteLeaseId} IS NOT NULL AND ${t.deleteLeaseExpiresAt} IS NOT NULL)
      OR (${t.state} = 'deleted' AND ${t.adoptedArtifactId} IS NULL AND ${t.deleteLeaseId} IS NULL AND ${t.deleteLeaseExpiresAt} IS NULL)`,
  ),
]);

// Durable object-GC outbox. A committed ready/retry row is sufficient for a
// scanner to recover work after process death; no volatile enqueue is needed.
export const attachmentObjectGcJobs = pgTable("attachment_object_gc_jobs", {
  objectId: uuid("object_id").primaryKey().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  gcToken: uuid("gc_token").notNull(),
  state: text("state", { enum: ["ready", "leased", "retry", "blocked", "completed", "dead_letter"] })
    .notNull().default("ready"),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lastErrorClass: text("last_error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_object_gc_jobs_claim").on(t.state, t.nextAttemptAt, t.leaseExpiresAt),
  check("attachment_object_gc_jobs_state", sql`${t.state} IN ('ready', 'leased', 'retry', 'blocked', 'completed', 'dead_letter')`),
  check("attachment_object_gc_jobs_attempts_nonnegative", sql`${t.attempts} >= 0`),
  check(
    "attachment_object_gc_jobs_lease_consistency",
    sql`(${t.state} = 'leased' AND ${t.leaseId} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)
      OR (${t.state} <> 'leased' AND ${t.leaseId} IS NULL AND ${t.leaseExpiresAt} IS NULL)`,
  ),
]);

// Attachments — public projection IDs linked to messages. Every projection
// names its immutable attachment_objects row, which alone carries the physical
// metadata (storage and thumbnail keys, content hash, MIME type, size,
// dimensions). The legacy physical copies (mime_type, size_bytes, storage_key,
// thumbnail_key, content_hash, width, height) are gone: storage step 2c
// stopped writing them and dropped them one release later.
export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  objectId: uuid("object_id").notNull().references(() => attachmentObjects.id, { onDelete: "restrict" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
  pendingChannelId: uuid("pending_channel_id").references(() => channels.id, { onDelete: "cascade" }),
  createdById: text("created_by_id"),
  createdByType: text("created_by_type", { enum: attachmentUploaderTypes }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedById: text("revoked_by_id"),
  revokedByType: text("revoked_by_type", { enum: ["user", "agent", "machine", "system"] }),
  revokeReason: text("revoke_reason"),
  // Phase 1 of the rolling attachment-order rollout keeps this nullable while
  // legacy writers are still possible. A later migration may enforce linked
  // positions after every writer has moved to the ordered transactional helper.
  messagePosition: integer("message_position"),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull(),
  uploaderType: text("uploader_type", { enum: attachmentUploaderTypes }).notNull(),
  filename: text("filename").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachments_message").on(t.messageId),
  index("idx_attachments_object").on(t.objectId),
  index("idx_attachments_pending_channel").on(t.pendingChannelId),
  index("idx_attachments_channel").on(t.channelId),
  index("idx_attachments_channel_created_linked")
    .on(t.channelId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`)
    .where(sql`message_id is not null`),
  check(
    "attachments_created_by_consistency",
    sql`(${t.createdById} IS NULL AND ${t.createdByType} IS NULL)
      OR (${t.createdById} IS NOT NULL AND ${t.createdByType} IN ('user', 'agent', 'external_projection'))`,
  ),
  check(
    "attachments_uploader_type",
    sql`${t.uploaderType} IN ('user', 'agent', 'external_projection')`,
  ),
  check(
    "attachments_revocation_consistency",
    sql`(${t.revokedAt} IS NULL AND ${t.revokedById} IS NULL AND ${t.revokedByType} IS NULL)
      OR (${t.revokedAt} IS NOT NULL AND ${t.revokedById} IS NOT NULL
        AND ${t.revokedByType} IN ('user', 'agent', 'machine', 'system'))`,
  ),
]);

// Cache for expensive on-demand document previews (GET /attachments/:id/preview,
// services/attachmentPreviews/previewCache.ts). Only results that were slow or
// came from a heavy provider are stored; cheap text/markdown previews are
// recomputed. A row is reused only while `content_key` (the original's storage
// identity) and `provider_version` still match. Read access is checked before
// the cache is consulted, so a row grants nothing on its own. `last_hit_at` is
// kept for a future eviction sweep.
export const attachmentPreviewCache = pgTable("attachment_preview_cache", {
  attachmentId: uuid("attachment_id").primaryKey().references(() => attachments.id, { onDelete: "cascade" }),
  contentKey: text("content_key").notNull(),
  providerVersion: integer("provider_version").notNull(),
  preview: jsonb("preview").notNull(),
  computeMs: integer("compute_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }).notNull().defaultNow(),
});

// Provider-neutral identity for one external file. Private provider locators
// and credentials never enter this table; adapters persist only stable IDs and
// bounded metadata before a leased transfer performs any network or storage I/O.
export const externalAttachmentAssets = pgTable("external_attachment_assets", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  originDirection: text("origin_direction", { enum: ["provider_inbound", "raft_outbound"] }).notNull(),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  providerAuthorityId: text("provider_authority_id").notNull(),
  providerFileId: text("provider_file_id").notNull(),
  filename: text("filename"),
  declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }),
  mimeType: text("mime_type"),
  providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
  // Stable single-writer fence for provider bytes. This is deliberately an
  // opaque job identity rather than a relational FK because transfer jobs
  // already reference the asset, and a circular FK would make bootstrap and
  // terminal recovery depend on insertion order.
  materializationOwnerJobId: uuid("materialization_owner_job_id"),
  sourceContentDigest: text("source_content_digest"),
  raftObjectId: uuid("raft_object_id").references(() => attachmentObjects.id, { onDelete: "restrict" }),
  state: text("state", {
    enum: ["observed", "metadata_ready", "transferring", "stored", "linked", "failed", "revoked"],
  }).notNull().default("observed"),
  terminalFailureClass: text("terminal_failure_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_attachment_provider_file").on(
    t.provider,
    t.appRegistrationId,
    t.installId,
    t.workspaceId,
    t.providerFileId,
  ),
  index("idx_external_attachment_asset_state").on(t.state, t.updatedAt),
  index("idx_external_attachment_asset_object").on(t.raftObjectId),
  check(
    "external_attachment_asset_coordinates",
    sql`length(btrim(${t.provider})) > 0 AND length(${t.provider}) <= 80
      AND length(btrim(${t.appRegistrationId})) > 0 AND length(${t.appRegistrationId}) <= 320
      AND length(btrim(${t.installId})) > 0 AND length(${t.installId}) <= 160
      AND length(btrim(${t.workspaceId})) > 0 AND length(${t.workspaceId}) <= 320
      AND length(btrim(${t.providerAuthorityId})) > 0 AND length(${t.providerAuthorityId}) <= 160
      AND length(btrim(${t.providerFileId})) > 0 AND length(${t.providerFileId}) <= 320`,
  ),
  check(
    "external_attachment_asset_origin",
    sql`${t.originDirection} = 'provider_inbound'
      OR (${t.originDirection} = 'raft_outbound' AND ${t.raftObjectId} IS NOT NULL)`,
  ),
  check(
    "external_attachment_asset_materialization",
    sql`(${t.originDirection} = 'raft_outbound' AND ${t.materializationOwnerJobId} IS NULL)
      OR (${t.originDirection} = 'provider_inbound' AND (
        (${t.state} = 'observed' AND ${t.materializationOwnerJobId} IS NULL)
        OR ${t.state} = 'metadata_ready'
        OR (${t.state} IN ('transferring', 'stored', 'linked')
          AND ${t.materializationOwnerJobId} IS NOT NULL)
        OR ${t.state} IN ('failed', 'revoked')
      ))`,
  ),
  check(
    "external_attachment_asset_metadata",
    sql`(${t.declaredSizeBytes} IS NULL OR ${t.declaredSizeBytes} > 0)
      AND (${t.filename} IS NULL OR (length(btrim(${t.filename})) > 0 AND length(${t.filename}) <= 1024))
      AND (${t.mimeType} IS NULL OR (length(btrim(${t.mimeType})) > 0 AND length(${t.mimeType}) <= 255))
      AND (${t.sourceContentDigest} IS NULL OR ${t.sourceContentDigest} ~ '^[0-9a-f]{64}$')
      AND (${t.state} = 'observed' OR ${t.state} IN ('failed', 'revoked') OR (
        ${t.filename} IS NOT NULL AND ${t.declaredSizeBytes} IS NOT NULL AND ${t.mimeType} IS NOT NULL
      ))
      AND (${t.state} NOT IN ('stored', 'linked') OR (
        ${t.raftObjectId} IS NOT NULL AND ${t.sourceContentDigest} IS NOT NULL
      ))`,
  ),
  check(
    "external_attachment_asset_state",
    sql`${t.state} IN ('observed', 'metadata_ready', 'transferring', 'stored', 'linked', 'failed', 'revoked')
      AND ((${t.state} IN ('failed', 'revoked')
        AND ${t.terminalFailureClass} IS NOT NULL
        AND length(btrim(${t.terminalFailureClass})) > 0
        AND length(${t.terminalFailureClass}) <= 160)
      OR (${t.state} NOT IN ('failed', 'revoked') AND ${t.terminalFailureClass} IS NULL))`,
  ),
]);

// Exact file ordering and message identity are separate from provider-file
// identity because one provider file may be re-shared without duplicating its
// bytes. A linked fact owns one canonical Raft attachment projection.
export const externalAttachmentMessageFacts = pgTable("external_attachment_message_facts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  direction: text("direction", { enum: ["provider_inbound", "raft_outbound"] }).notNull(),
  inboundEventId: uuid("inbound_event_id")
    .references(() => externalInboundEvents.id, { onDelete: "restrict" }),
  messageLinkId: uuid("message_link_id")
    .references(() => externalMessageLinks.id, { onDelete: "restrict" }),
  assetId: uuid("asset_id").notNull()
    .references(() => externalAttachmentAssets.id, { onDelete: "restrict" }),
  sourceActorProjectionId: uuid("source_actor_projection_id")
    .references(() => externalActorProjections.id, { onDelete: "restrict" }),
  providerAuthorityId: text("provider_authority_id").notNull(),
  connectionEpoch: integer("connection_epoch").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  attachmentProjectionId: uuid("attachment_projection_id")
    .references(() => attachments.id, { onDelete: "restrict" }),
  orderedPosition: integer("ordered_position").notNull(),
  state: text("state", { enum: ["pending", "stored", "linked", "unavailable", "revoked"] })
    .notNull().default("pending"),
  terminalFailureClass: text("terminal_failure_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_attachment_inbound_event_asset")
    .on(t.inboundEventId, t.assetId)
    .where(sql`${t.direction} = 'provider_inbound'`),
  uniqueIndex("uq_external_attachment_inbound_event_position")
    .on(t.inboundEventId, t.orderedPosition)
    .where(sql`${t.direction} = 'provider_inbound'`),
  uniqueIndex("uq_external_attachment_outbound_message_asset")
    .on(t.messageLinkId, t.assetId)
    .where(sql`${t.direction} = 'raft_outbound'`),
  uniqueIndex("uq_external_attachment_outbound_message_position")
    .on(t.messageLinkId, t.orderedPosition)
    .where(sql`${t.direction} = 'raft_outbound'`),
  uniqueIndex("uq_external_attachment_inbound_projection")
    .on(t.attachmentProjectionId)
    .where(sql`${t.direction} = 'provider_inbound' AND ${t.attachmentProjectionId} IS NOT NULL`),
  uniqueIndex("uq_external_attachment_outbound_projection")
    .on(t.messageLinkId, t.attachmentProjectionId)
    .where(sql`${t.direction} = 'raft_outbound' AND ${t.attachmentProjectionId} IS NOT NULL`),
  index("idx_external_attachment_message_state").on(t.state, t.updatedAt),
  check(
    "external_attachment_message_coordinates",
    sql`${t.orderedPosition} >= 0
      AND length(btrim(${t.providerAuthorityId})) > 0 AND length(${t.providerAuthorityId}) <= 160
      AND length(btrim(${t.bindingId})) > 0 AND length(${t.bindingId}) <= 160
      AND ${t.connectionEpoch} > 0 AND ${t.bindingEpoch} > 0
      AND ((${t.direction} = 'provider_inbound' AND ${t.inboundEventId} IS NOT NULL
          AND ${t.sourceActorProjectionId} IS NOT NULL)
        OR (${t.direction} = 'raft_outbound' AND ${t.inboundEventId} IS NULL
          AND ${t.sourceActorProjectionId} IS NULL AND ${t.messageLinkId} IS NOT NULL))`,
  ),
  check(
    "external_attachment_message_state",
    sql`${t.direction} IN ('provider_inbound', 'raft_outbound')
      AND ${t.state} IN ('pending', 'stored', 'linked', 'unavailable', 'revoked')
      AND (${t.state} IN ('stored', 'linked')) = (${t.attachmentProjectionId} IS NOT NULL)
      AND (${t.state} <> 'linked' OR ${t.messageLinkId} IS NOT NULL)
      AND ((${t.state} IN ('unavailable', 'revoked')
        AND ${t.terminalFailureClass} IS NOT NULL
        AND length(btrim(${t.terminalFailureClass})) > 0
        AND length(${t.terminalFailureClass}) <= 160)
      OR (${t.state} IN ('pending', 'stored', 'linked') AND ${t.terminalFailureClass} IS NULL))`,
  ),
]);

// Independently leased file work. Inbound jobs own one provider asset/message
// fact; outbound jobs own one frozen Raft attachment under one delivery. Raw
// private URLs, upload URLs, tokens, and provider error bodies are forbidden.
// A file occurrence may outlive the sender's membership only when the exact
// normalized file set was authenticated from a retained signed Slack receipt.
// Legacy attachment facts never imply this provenance by themselves.
export const slackVerifiedIngressFileFacts = pgTable("slack_verified_ingress_file_facts", {
  factId: uuid("fact_id").primaryKey().references(() => externalAttachmentMessageFacts.id, { onDelete: "cascade" }),
  rawEventId: uuid("raw_event_id").notNull().references(() => slackVerifiedIngressEvents.id, { onDelete: "cascade" }),
  normalizedPayloadDigest: text("normalized_payload_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("slack_verified_ingress_file_digest_valid", sql`${t.normalizedPayloadDigest} ~ '^[0-9a-f]{64}$'`)]);


export const externalAttachmentTransferJobs = pgTable("external_attachment_transfer_jobs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  direction: text("direction", { enum: ["provider_inbound", "raft_outbound"] }).notNull(),
  assetId: uuid("asset_id").references(() => externalAttachmentAssets.id, { onDelete: "restrict" }),
  messageFactId: uuid("message_fact_id")
    .references(() => externalAttachmentMessageFacts.id, { onDelete: "restrict" }),
  outboundDeliveryId: uuid("outbound_delivery_id")
    .references(() => externalOutboundDeliveries.id, { onDelete: "restrict" }),
  sourceAttachmentId: uuid("source_attachment_id")
    .references(() => attachments.id, { onDelete: "restrict" }),
  frozenObjectId: uuid("frozen_object_id")
    .references(() => attachmentObjects.id, { onDelete: "restrict" }),
  frozenOriginServerId: uuid("frozen_origin_server_id"),
  frozenStorageKey: text("frozen_storage_key"),
  frozenFilename: text("frozen_filename"),
  frozenMimeType: text("frozen_mime_type"),
  frozenSizeBytes: bigint("frozen_size_bytes", { mode: "number" }),
  frozenContentDigest: text("frozen_content_digest"),
  phase: text("phase", {
    enum: ["metadata", "download", "store", "ticket", "upload", "complete", "correlate", "link"],
  }).notNull(),
  state: text("state", {
    enum: ["queued", "leased", "retry_wait", "outcome_unknown", "completed", "failed", "revoked", "quarantined"],
  }).notNull().default("queued"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  leaseId: uuid("lease_id"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: bigint("lease_generation", { mode: "number" }).notNull().default(0),
  lastErrorClass: text("last_error_class"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_external_attachment_transfer_inbound")
    .on(t.messageFactId)
    .where(sql`${t.direction} = 'provider_inbound'`),
  uniqueIndex("uq_external_attachment_transfer_outbound")
    .on(t.outboundDeliveryId, t.sourceAttachmentId)
    .where(sql`${t.direction} = 'raft_outbound'`),
  index("idx_external_attachment_transfer_claim")
    .on(t.state, t.nextAttemptAt, t.leaseExpiresAt),
  check(
    "external_attachment_transfer_coordinates",
    sql`(${t.direction} = 'provider_inbound'
        AND ${t.assetId} IS NOT NULL AND ${t.messageFactId} IS NOT NULL
        AND ${t.outboundDeliveryId} IS NULL AND ${t.sourceAttachmentId} IS NULL)
      OR (${t.direction} = 'raft_outbound'
        AND ${t.messageFactId} IS NULL
        AND ${t.outboundDeliveryId} IS NOT NULL AND ${t.sourceAttachmentId} IS NOT NULL
        AND ${t.frozenObjectId} IS NOT NULL
        AND ${t.frozenOriginServerId} IS NOT NULL
        AND ${t.frozenStorageKey} IS NOT NULL
        AND ${t.frozenFilename} IS NOT NULL
        AND ${t.frozenMimeType} IS NOT NULL
        AND ${t.frozenSizeBytes} IS NOT NULL
        AND (${t.frozenContentDigest} IS NOT NULL OR ${t.phase} = 'ticket'))`,
  ),
  check(
    "external_attachment_transfer_snapshot",
    sql`(${t.direction} = 'provider_inbound'
        AND ${t.frozenObjectId} IS NULL
        AND ${t.frozenOriginServerId} IS NULL
        AND ${t.frozenStorageKey} IS NULL
        AND ${t.frozenFilename} IS NULL
        AND ${t.frozenMimeType} IS NULL
        AND ${t.frozenSizeBytes} IS NULL
        AND ${t.frozenContentDigest} IS NULL)
      OR (${t.direction} = 'raft_outbound'
        AND length(btrim(${t.frozenStorageKey})) > 0 AND length(${t.frozenStorageKey}) <= 1024
        AND length(btrim(${t.frozenFilename})) > 0 AND length(${t.frozenFilename}) <= 1024
        AND length(btrim(${t.frozenMimeType})) > 0 AND length(${t.frozenMimeType}) <= 255
        AND ${t.frozenSizeBytes} > 0
        AND (${t.frozenContentDigest} IS NULL OR ${t.frozenContentDigest} ~ '^[0-9a-f]{64}$'))`,
  ),
  check(
    "external_attachment_transfer_state",
    sql`${t.phase} IN ('metadata', 'download', 'store', 'ticket', 'upload', 'complete', 'correlate', 'link')
      AND ${t.state} IN ('queued', 'leased', 'retry_wait', 'outcome_unknown', 'completed', 'failed', 'revoked', 'quarantined')
      AND ${t.attempts} >= 0
      AND (${t.lastErrorClass} IS NULL OR (
        length(btrim(${t.lastErrorClass})) > 0 AND length(${t.lastErrorClass}) <= 160
      ))
      AND (${t.direction} = 'provider_inbound' AND ${t.phase} IN ('metadata', 'download', 'store', 'link')
        OR ${t.direction} = 'raft_outbound' AND ${t.phase} IN ('ticket', 'upload', 'complete', 'correlate', 'link'))
      AND (${t.state} IN ('retry_wait', 'outcome_unknown', 'failed', 'revoked', 'quarantined'))
        = (${t.lastErrorClass} IS NOT NULL)
      AND (${t.state} <> 'outcome_unknown' OR ${t.phase} IN ('upload', 'complete', 'correlate'))
      AND (${t.state} <> 'completed' OR ${t.phase} = 'link')`,
  ),
  check(
    "external_attachment_transfer_lease",
    sql`(${t.state} = 'leased'
        AND ${t.leaseId} IS NOT NULL
        AND ${t.leaseOwner} IS NOT NULL
        AND length(btrim(${t.leaseOwner})) > 0
        AND length(${t.leaseOwner}) <= 160
        AND ${t.leaseExpiresAt} IS NOT NULL
        AND ${t.leaseGeneration} > 0)
      OR (${t.state} <> 'leased'
        AND ${t.leaseId} IS NULL
        AND ${t.leaseOwner} IS NULL
        AND ${t.leaseExpiresAt} IS NULL
        AND ${t.leaseGeneration} >= 0)`,
  ),
  check(
    "external_attachment_transfer_terminal",
    sql`(${t.state} IN ('completed', 'failed', 'revoked', 'quarantined')
        AND ${t.terminalAt} IS NOT NULL)
      OR (${t.state} NOT IN ('completed', 'failed', 'revoked', 'quarantined')
        AND ${t.terminalAt} IS NULL)`,
  ),
]);

export type SlackAttachmentPlanItem = {
  transferJobId: string;
  sourceAttachmentId: string;
  frozenObjectId: string;
  decision: "include" | "omit";
  evidence: "object_deleted" | "storage_object_missing" | null;
};

export const SLACK_ATTACHMENT_FALLBACK_MARKER = "[One or more attachments unavailable]";

/** No source bytes, file names, storage keys or provider credentials. */
export const slackAttachmentFallbackPlans = pgTable("slack_attachment_fallback_plans", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deliveryId: uuid("delivery_id").notNull()
    .references(() => externalOutboundDeliveries.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  snapshotDigest: text("snapshot_digest").notNull(),
  transport: text("transport", { enum: ["text", "files"] }).notNull(),
  unavailableMarker: text("unavailable_marker").notNull().default(SLACK_ATTACHMENT_FALLBACK_MARKER),
  items: jsonb("items").$type<SlackAttachmentPlanItem[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_slack_attachment_fallback_plan_revision").on(t.deliveryId, t.revision),
  index("idx_slack_attachment_fallback_plan_created").on(t.createdAt),
  check("slack_attachment_fallback_plan_shape", sql`
    ${t.revision} > 0 AND ${t.snapshotDigest} ~ '^[0-9a-f]{64}$'
    AND ${t.transport} IN ('text', 'files')
    AND ${t.unavailableMarker} = '[One or more attachments unavailable]'
    AND jsonb_typeof(${t.items}) = 'array'
    AND jsonb_array_length(${t.items}) BETWEEN 1 AND 10
    AND octet_length(${t.items}::text) <= 10000`),
]);

/** Operator attestation of a fully upgraded reader/writer fleet; default is absent/off. */
export const slackAttachmentPlanRollout = pgTable("slack_attachment_plan_rollout", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  minimumWriterVersion: integer("minimum_writer_version").notNull().default(0),
  configGeneration: integer("config_generation").notNull().default(0),
  configDigest: text("config_digest"),
  verifiedRelease: text("verified_release"),
  verifiedBy: text("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("slack_attachment_plan_rollout_shape", sql`
  ${t.id} = 'slack-attachment-plan-v1'
  AND ${t.minimumWriterVersion} IN (0, 1)
  AND ${t.configGeneration} >= 0
  AND ((${t.configGeneration} = 0 AND ${t.configDigest} IS NULL)
    OR (${t.configGeneration} > 0 AND ${t.configDigest} IS NOT NULL AND ${t.configDigest} ~ '^[0-9a-f]{64}$'))
  AND (NOT ${t.enabled} OR (${t.minimumWriterVersion} = 1 AND ${t.verifiedRelease} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL AND ${t.verifiedRelease} ~ '^[0-9a-f]{40}$'
    AND length(${t.verifiedBy}) BETWEEN 1 AND 160 AND ${t.verifiedAt} IS NOT NULL))`)]);

// Immutable audit snapshots for projection-level revocation. Projection and
// message IDs intentionally are not foreign keys so audit history survives
// later message/projection deletion and can never become read authority.
export const attachmentProjectionRevocations = pgTable("attachment_projection_revocations", {
  projectionId: uuid("projection_id").primaryKey(),
  objectId: uuid("object_id").notNull(),
  hostMessageId: uuid("host_message_id").notNull(),
  requestServerId: uuid("request_server_id").notNull(),
  revokedById: text("revoked_by_id").notNull(),
  revokedByType: text("revoked_by_type", { enum: ["user", "agent", "machine", "system"] }).notNull(),
  reason: text("reason"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("idx_attachment_projection_revocations_object").on(t.objectId),
  index("idx_attachment_projection_revocations_message").on(t.hostMessageId),
  check(
    "attachment_projection_revocations_actor_type",
    sql`${t.revokedByType} IN ('user', 'agent', 'machine', 'system')`,
  ),
]);

// Monthly file-upload quota ledger. Counts successful attachment records, not unique storage bytes.
export const serverFileUploadUsageMonths = pgTable("server_file_upload_usage_months", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.month] }),
  index("idx_server_file_upload_usage_months_server").on(t.serverId),
]);

// Durable cross-request ledger for browser/CLI uploads written directly to R2.
// A session is deliberately separate from attachments: until the object has
// been HEAD-verified and quota has been finalized, its reserved attachment id
// must not be readable or attachable to a message.
export const attachmentUploadSessions = pgTable("attachment_upload_sessions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull(),
  uploaderType: text("uploader_type", { enum: ["user", "agent"] }).notNull(),
  attachmentId: uuid("attachment_id").notNull(),
  objectId: uuid("object_id"),
  transferIntentId: uuid("transfer_intent_id").references(() => attachmentTransferIntents.id, { onDelete: "restrict" }),
  clientRequestId: uuid("client_request_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(),
  state: text("state", {
    enum: ["pending", "verifying", "completed", "canceled", "expired", "failed"],
  }).notNull().default("pending"),
  quotaMonth: text("quota_month").notNull(),
  quotaReservedBytes: bigint("quota_reserved_bytes", { mode: "number" }).notNull(),
  quotaLimited: boolean("quota_limited").notNull(),
  quotaState: text("quota_state", { enum: ["reserved", "finalized", "released"] }).notNull().default("reserved"),
  verificationLeaseId: uuid("verification_lease_id"),
  verificationLeaseExpiresAt: timestamp("verification_lease_expires_at", { withTimezone: true }),
  objectEtag: text("object_etag"),
  verifiedSizeBytes: bigint("verified_size_bytes", { mode: "number" }),
  verifiedContentType: text("verified_content_type"),
  objectCleanupState: text("object_cleanup_state", { enum: ["not_required", "pending", "deleting", "deleted"] })
    .notNull().default("not_required"),
  objectCleanupLeaseId: uuid("object_cleanup_lease_id"),
  terminalReason: text("terminal_reason"),
  // The preview a direct upload gets after completion (task #57): the
  // multipart path writes its thumbnail while uploading; a direct upload goes
  // straight to object storage, so a worker generates it afterwards. Null for
  // sessions from before this column and for uncompleted ones.
  thumbnailState: text("thumbnail_state", { enum: ["pending", "done", "failed", "skipped"] }),
  thumbnailAttempts: integer("thumbnail_attempts").notNull().default(0),
  thumbnailLeaseExpiresAt: timestamp("thumbnail_lease_expires_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_attachment_upload_sessions_actor_request")
    .on(t.serverId, t.uploaderType, t.uploaderId, t.clientRequestId),
  uniqueIndex("uq_attachment_upload_sessions_attachment").on(t.attachmentId),
  uniqueIndex("uq_attachment_upload_sessions_transfer_intent").on(t.transferIntentId),
  uniqueIndex("uq_attachment_upload_sessions_storage_key").on(t.storageKey),
  index("idx_attachment_upload_sessions_sweep").on(t.state, t.expiresAt),
  index("idx_attachment_upload_sessions_channel").on(t.channelId),
  index("idx_attachment_upload_sessions_thumbnail_pending")
    .on(t.thumbnailLeaseExpiresAt, t.completedAt)
    .where(sql`${t.thumbnailState} = 'pending'`),
  check("attachment_upload_sessions_size_positive", sql`${t.declaredSizeBytes} > 0`),
  check("attachment_upload_sessions_reserved_bytes_nonnegative", sql`${t.quotaReservedBytes} >= 0`),
  check(
    "attachment_upload_sessions_cleanup_consistency",
    sql`(${t.state} IN ('canceled', 'expired', 'failed') AND (
        (${t.objectCleanupState} = 'deleting' AND ${t.objectCleanupLeaseId} IS NOT NULL)
        OR (${t.objectCleanupState} IN ('pending', 'deleted') AND ${t.objectCleanupLeaseId} IS NULL)
      )) OR (${t.state} IN ('pending', 'verifying', 'completed')
        AND ${t.objectCleanupState} = 'not_required' AND ${t.objectCleanupLeaseId} IS NULL)`,
  ),
  check(
    "attachment_upload_sessions_terminal_consistency",
    sql`(${t.state} = 'completed' AND ${t.quotaState} = 'finalized' AND ${t.completedAt} IS NOT NULL)
      OR (${t.state} IN ('canceled', 'expired', 'failed') AND ${t.quotaState} = 'released')
      OR (${t.state} IN ('pending', 'verifying') AND ${t.quotaState} = 'reserved')`,
  ),
]);

// Attachment comment refs — scopes a thread message to one attachment.
// A "comment on an attachment" IS a normal message in the attachment's
// parent-message thread; this narrow ref row makes it scoped (drives the
// per-attachment filter/count). PK = comment_message_id: a message comments on
// at most one attachment. Cascades are future-proofing only — Slock currently
// has no message hard-delete operation and channel deletion is soft, so refs
// are effectively append-only today (attachment-comments MVP spec §3).
export const attachmentCommentRefs = pgTable("attachment_comment_refs", {
  commentMessageId: uuid("comment_message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: uuid("attachment_id").notNull().references(() => attachments.id, { onDelete: "cascade" }),
  // Structural anchor (spec §3 reserved evolution, enabled per cindyz 6/10):
  // where inside the attachment the comment points. Both null = unanchored
  // comment (still valid — anchors are optional). anchor_type is an
  // app-validated discriminator ("md-section" | "lines" | "csv-rows" for
  // native renderers; HTML overlay types arrive with comment mode);
  // anchor_data is the type-shaped payload incl. a human/agent-readable quote.
  anchorType: text("anchor_type"),
  anchorData: jsonb("anchor_data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_comment_refs_attachment").on(t.attachmentId),
]);

// Public-unlisted share artifacts. Creation is auth/member-gated; reads are
// capability URLs with random UUIDs so external crawlers can fetch OG images.
export const shareArtifacts = pgTable("share_artifacts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  source: text("source", { enum: ["selected_messages"] }).notNull().default("selected_messages"),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull().default("image/png"),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_share_artifacts_server_created").on(t.serverId, sql`${t.createdAt} DESC`),
  index("idx_share_artifacts_channel_created").on(t.channelId, sql`${t.createdAt} DESC`),
]);

// Agent activity events — durable recent trajectory log for UI hydration
export const agentActivityEvents = pgTable("agent_activity_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  activity: text("activity", { enum: ["online", "thinking", "working", "error", "offline"] }).notNull(),
  detail: text("detail").notNull().default(""),
  entries: json("entries").$type<TrajectoryEntry[]>().notNull(),
  // Optional semantic idempotency key for user-visible Activity Log projections.
  //
  // This is not a lifecycle event id, trace id, or correlation id. It is only
  // set when multiple server observations may project the same user-visible
  // activity row for the same agent, e.g. repeated ready-reconcile observations
  // inside one daemon restart/disconnect window. The projection writer inserts
  // the first row and treats later `(agent_id, dedupe_key)` conflicts as an
  // idempotent "already projected" outcome.
  //
  // Writers must use a stable semantic key for the projection window/operation.
  // Do not use random lifecycle event ids, trace/span ids, or request ids: those
  // change across retries/reconciles and would defeat dedupe. The unique scope
  // is per agent, not global; one daemon restart window may affect many agents,
  // and each affected agent is allowed one visible row for that window.
  //
  // Null deliberately preserves legacy behavior: historical rows and ordinary
  // non-idempotent activity events remain append-only and are not constrained by
  // the partial unique index.
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_activity_events_agent_created").on(t.agentId, t.createdAt),
  uniqueIndex("idx_agent_activity_events_agent_dedupe").on(t.agentId, t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
]);

/**
 * One row per finished agent turn (RFC 069 §6 `agent_activity_summary_v2`;
 * task #17 Activity overview). `summary` is `ActivityTurnSummary`: times,
 * outcome, trigger, action counts, problem steps, last reply id; never tool
 * input/output or message bodies. Written by the daemon (a `turn_summary`
 * trajectory entry) or rebuilt by the server for agents without a daemon;
 * `turn_key` makes the write an upsert, so a late event rebuilds its turn.
 * Additive table: nothing else reads or writes it.
 */
export const agentActivitySummaryV2 = pgTable("agent_activity_summary_v2", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  turnKey: text("turn_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  outcome: text("outcome").notNull(),
  summary: jsonb("summary").$type<ActivityTurnSummary>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_activity_summary_v2_agent_turn").on(t.agentId, t.turnKey),
  index("idx_agent_activity_summary_v2_agent_ended").on(t.agentId, t.endedAt),
]);

/**
 * Agent token usage per agent, model and UTC day (#proj-o11y:42f2af5c), added
 * from each finished turn's `tokens` (ActivityTurnSummary) in the same
 * transaction that writes the turn's agent_activity_summary_v2 row, and only
 * the change against what that row held before: a replayed or rebuilt turn
 * adds nothing twice (agentUsageService). Only while agent_usage_v0 is on for
 * the agent's server. A count stays null until some turn of the row reports
 * it. Numbers and model names only.
 */
export const agentUsageDaily = pgTable("agent_usage_daily", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  /** As the runtime named it; "" when the turn did not say. */
  model: text("model").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  runtime: text("runtime"),
  inputNew: bigint("input_new", { mode: "number" }),
  cacheRead: bigint("cache_read", { mode: "number" }),
  cacheWrite: bigint("cache_write", { mode: "number" }),
  output: bigint("output", { mode: "number" }),
  reasoningOutput: bigint("reasoning_output", { mode: "number" }),
  turns: integer("turns").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.day, t.model] }),
  index("idx_agent_usage_daily_server_day").on(t.serverId, t.day),
]);

/** Each agent's context use at the end of its latest turn that reported it (the Usage tab's "context now"). */
export const agentUsageContext = pgTable("agent_usage_context", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  contextUsed: bigint("context_used", { mode: "number" }),
  contextWindow: bigint("context_window", { mode: "number" }),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [
  index("idx_agent_usage_context_server").on(t.serverId),
]);

/**
 * Thread contract (authoritative).
 * =============================================================================
 * Thread channels split two authorities that regular channels conflate:
 *
 *   join/membership  → permission to POST  (from parent channel/DM)
 *   follow           → attention / notifications / unread / done (this table)
 *
 * A thread has no channel_humans / channel_agents rows of its own. Its post
 * authority is delegated to the parent channel (for channel threads) or the
 * parent DM (for DM threads). Following a thread grants listen access only —
 * never send permission.
 *
 * ── Data model ───────────────────────────────────────────────────────────────
 *   followerType ∈ {user, agent}          polymorphic follower
 *   reason       ∈ {replied, authored,    why the row was created
 *                   mentioned, manual,
 *                   assigned, saved}
 *   doneAt       nullable                 Inbox-Done marker; cleared by new activity
 *   unfollowedAt nullable                 Explicit opt-out marker; not cleared by
 *                                         ordinary activity; direct mention,
 *                                         manual follow, or self-reply may
 *                                         reactivate attention
 *   PK           (threadChannelId, followerType, followerId)
 *
 * ── Join / post authority (channelService.canUserPostToChannel /
 *     canAgentPostToChannel recurse for threads) ──────────────────────────────
 *   Thread post authority == parent channel/DM membership.
 *   Following a thread never grants post permission.
 *   Enforced at:
 *     - POST /api/messages            (user send)
 *     - /internal/agent/:id/send      (agent send, incl. `#channel:shortid`
 *                                      target resolution in
 *                                      resolveOrCreateThreadTarget)
 *     - /internal/agent/:id/upload    (agent upload)
 *   The legacy thread member-mutation routes (join/leave/add/remove) all
 *   return 400 — thread membership is managed via follow/unfollow.
 *
 * ── Follow / notification authority (this table) ────────────────────────────
 *   getChannelMembers(threadId) delegates to the parent channel — it is the
 *   source of truth for "who is in the room".
 *   This table is the source of truth
 *   for "who gets notified, who has unread, who can mark done".
 *
 * ── Auto-follow sources ─────────────────────────────────────────────────────
 *   Opening a thread panel or calling getOrCreateThread NEVER writes a follow
 *   row. The Threads list must only show threads the user actually participated
 *   in — view-only opens must not pollute it.
 *
 *   A. Reply on a thread      — sender        → reason = 'replied'
 *      (includes the first      parent author → reason = 'authored' (if not sender)
 *      reply that creates the
 *      thread)
 *   B. Mention in a thread    — target added with reason = 'mentioned'
 *                              Scope depends on parent channel type:
 *                                public channel thread → server-wide scope
 *                                                        (any server member
 *                                                         or any server agent
 *                                                         may be pulled in)
 *                                DM thread            → private scope
 *                                                        (only existing DM
 *                                                         participants; never
 *                                                         outsiders)
 *      Direct @mention of a user who explicitly unfollowed reactivates the
 *      thread, with the mention message as the new unread-count starting point.
 *   C. Manual follow/unfollow — reason = 'manual' via
 *                               POST /api/channels/threads/follow | unfollow.
 *                               Unfollow keeps a suppressed row so later
 *                               ordinary activity cannot reactivate attention.
 *   D. Saving a message      — the saver follows the message's thread (a
 *                              reply's own; for a top-level message the
 *                              thread rooted at it) with reason = 'saved'
 *                              unless a follow is already active, which is
 *                              kept as it is. user_saved.thread_channel_id
 *                              links the save to that thread. Unsaving the
 *                              thread's last linked save deletes the row
 *                              only while its reason is still 'saved' (a
 *                              reply, mention or manual follow since then
 *                              replaced it); see savedService.
 *
 * ── Done / unread reactivation ──────────────────────────────────────────────
 *   POST /api/channels/threads/done   sets doneAt for the caller's follow row.
 *   POST /api/channels/threads/undone clears doneAt for the caller.
 *   New activity on the thread clears doneAt for existing non-unfollowed rows —
 *   a thread that receives a new message is unread again for everyone who
 *   had marked it done, but explicit unfollow remains suppressed.
 *
 * ── Legacy compat ───────────────────────────────────────────────────────────
 *   Migration 0041 backfills pre-existing thread channel_humans / channel_agents
 *   rows into thread_follows (reason='manual') without deleting the legacy
 *   rows. Runtime MUST NOT write new channel_humans / channel_agents rows for
 *   thread-type channels.
 *
 * Contract is fenced by black-box tests in
 *   packages/server/src/routes/channels.api.test.ts
 * =============================================================================
 */
export const threadFollows = pgTable("thread_follows", {
  threadChannelId: uuid("thread_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  followerType: text("follower_type", { enum: ["user", "agent"] }).notNull(),
  followerId: uuid("follower_id").notNull(),
  // The followed sub-conversation's parent: a message (thread) or a task
  // (task conversation, `parent_task_id`). Exactly one is set.
  parentMessageId: uuid("parent_message_id"),
  parentTaskId: uuid("parent_task_id").references(() => tasks.id, { onDelete: "cascade" }),
  // `assigned`: task v2 — handed the task by someone else. `saved`: started
  // by saving a message in it (and only that, until another reason replaces it).
  reason: text("reason", { enum: ["replied", "authored", "mentioned", "manual", "assigned", "saved"] }).notNull(),
  // Start of the CURRENT follow period, not "row created": reset when a thread
  // is re-followed after an unfollow, never when an active follow is
  // re-confirmed (reply, mention). Readers (agent `thread list` followedAt,
  // follower order, o11y rule 12b) want "since when is this followed now".
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  doneAt: timestamp("done_at", { withTimezone: true }),
  unfollowedAt: timestamp("unfollowed_at", { withTimezone: true }),
  // The thread's notification level (docs/contracts/notifications.md): an
  // explicit 'default' / 'all' / 'mentions' / 'none' written by
  // PUT /notification-levels. NULL = never set: derived from the follow state
  // (reason 'manual' and still followed = 'all', unfollowed = 'mentions',
  // otherwise 'default'), so no existing row needed a backfill.
  notificationLevel: text("notification_level", { enum: ["default", "all", "mentions", "none"] }),
}, (t) => [
  primaryKey({ columns: [t.threadChannelId, t.followerType, t.followerId] }),
  index("idx_thread_follows_follower").on(t.followerType, t.followerId),
  // The cascade from tasks (parent_task_id ON DELETE cascade).
  index("idx_thread_follows_parent_task_id").on(t.parentTaskId).where(sql`parent_task_id IS NOT NULL`),
  check("thread_follows_parent_present", sql`${t.parentMessageId} IS NOT NULL OR ${t.parentTaskId} IS NOT NULL`),
  check("thread_follows_notification_level_check", sql`${t.notificationLevel} IS NULL OR ${t.notificationLevel} IN ('default', 'all', 'mentions', 'none')`),
]);

export const pushRegistrations = pgTable("push_registrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installationId: text("installation_id").notNull(),
  provider: text("provider", { enum: ["apns", "fcm"] }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  sessionFamilyId: uuid("session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  deviceToken: text("device_token").notNull(),
  topic: text("topic").notNull(),
  env: text("env", { enum: ["sandbox", "production"] }).notNull(),
  appVersion: text("app_version"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  // Diagnostics only: the user_id a revoke/unbind cleared. Not a foreign key and
  // never matched by delivery; cleared when the row is bound again (migration 0380).
  revokedUserId: uuid("revoked_user_id"),
  // What a push to this device may show: full (sender + preview), sender_only,
  // or hidden (no sender, channel or server). Set by the device (migration 0383).
  // Since the unified notification settings this is only the value the device
  // last reported (older apps still send it); the account setting
  // (user_notification_settings.preview_mode) decides what is shown.
  previewMode: text("preview_mode", { enum: ["full", "sender_only", "hidden"] }).notNull().default("full"),
  // The device's own "receive notifications here" switch. false: only sync /
  // retract pushes (docs/contracts/notifications.md §3.1).
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  // OS notification permission the device reported; 'denied' gets only sync / retract.
  osPermission: text("os_permission", { enum: ["granted", "denied", "provisional", "unknown"] }),
  // Last POST /push/registrations for this row; NULL on rows from before the
  // column (read as updated_at). Registrations older than 30 days are revoked.
  lastRegisteredAt: timestamp("last_registered_at", { withTimezone: true }),
  // Which redacted-preview loc-key set the app knows (POST /push/registrations
  // previewKeySet; docs/contracts/notifications.md §3.1). NULL = 1, the keys
  // every app has; the APNs transport sends newer keys only to a device that
  // reported their set.
  previewKeySet: integer("preview_key_set"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_push_registrations_installation_provider").on(t.installationId, t.provider),
  index("idx_push_registrations_binding").on(t.userId, t.serverId),
  index("idx_push_registrations_family").on(t.sessionFamilyId),
  index("idx_push_registrations_provider_env").on(t.provider, t.env),
  check("push_registrations_provider_check", sql`${t.provider} IN ('apns', 'fcm')`),
  check("push_registrations_env_check", sql`${t.env} IN ('sandbox', 'production')`),
  check("push_registrations_preview_mode_check", sql`${t.previewMode} IN ('full', 'sender_only', 'hidden')`),
  check("push_registrations_os_permission_check", sql`${t.osPermission} IS NULL OR ${t.osPermission} IN ('granted', 'denied', 'provisional', 'unknown')`),
]);

/**
 * One row per (receiver, notification event): the single audience of every
 * notification transport (desktop socket, Web Push, mobile socket, APNs, FCM).
 * Written in the sending transaction from the inbox facts (and the few
 * events without a message: reminders, account notices), drained by
 * services/notifications/dispatcher.ts. Renamed from mobile_push_outbox;
 * migration notification_outbox_contract dropped the mobile_push_outbox
 * compatibility view; contract step 2 dropped dispatcher_version and the
 * legacy *_count columns (notification_outbox_legacy_columns_drop) and
 * replaced the old unique key (notification_outbox_fk_indexes). Terminal rows from before the unified dispatcher keep a NULL
 * event_key / category and the legacy statuses (sent / skipped / dropped).
 */
export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  receiverType: text("receiver_type", { enum: ["user"] }).notNull(),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // `task`: a task conversation (task v2); every semantic is the thread one,
  // only Activity / agent inbox display differ. NULL for events without a
  // conversation (reminder, system_notice).
  kind: text("kind", { enum: ["channel", "dm", "thread", "task"] }),
  sourceChannelId: uuid("source_channel_id").references(() => channels.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
  messageSeq: bigint("message_seq", { mode: "number" }),
  activityAt: timestamp("activity_at", { withTimezone: true }).notNull(),
  personalMention: boolean("personal_mention").notNull().default(false),
  unreadEligible: boolean("unread_eligible").notNull().default(true),
  // `message:<messageId>`, `reminder:<id>:<firedAt>`, `migration:<id>`.
  // NULL only on terminal rows from before the unified dispatcher.
  eventKey: text("event_key"),
  // NotificationCategory (packages/shared/src/notifications.ts); NULL only on
  // terminal rows from before the unified dispatcher.
  category: text("category"),
  // Event data the envelope needs when there is no message (reminder text,
  // notice text); never read for message events.
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  status: text("status", {
    enum: ["pending", "processing", "sent", "skipped", "revoked", "dropped", "delivered", "suppressed", "quiet", "failed"],
  }).notNull().default("pending"),
  // `notify`, or `suppressed:<reason>` (server_none, channel_level, muted, stale, no_device), or `quiet`.
  decision: text("decision"),
  // Per-transport counts, e.g. {"desktop":1,"web":0,"apns":1,"fcm":0,"mobileSocket":1,"skippedByPresence":["web"]}.
  transports: jsonb("transports").$type<Record<string, unknown>>(),
  // First failure: provider, reason code, HTTP status. Never content.
  firstFailure: jsonb("first_failure").$type<Record<string, unknown>>(),
  // activity_at -> last transport accepted.
  latencyMs: integer("latency_ms"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Index names keep their mobile_push_outbox prefix: renaming a 7M-row
  // table's indexes buys nothing, and the post-migration index check matches
  // on table and columns, not names.
  // The dedupe key, (receiver, event); built CONCURRENTLY by
  // db:create-notification-outbox-event-key-index on a large table. It
  // replaced idx_mobile_push_outbox_unique_fact (retired by
  // db:create-notification-outbox-fk-indexes once the two below exist).
  uniqueIndex("idx_notification_outbox_receiver_event").on(t.receiverId, t.eventKey).where(sql`${t.eventKey} IS NOT NULL`),
  // The ON DELETE CASCADE checks from channels and users (the event-key index
  // is partial, so it never serves them); built CONCURRENTLY by
  // db:create-notification-outbox-fk-indexes on a large table
  // (src/db/notificationOutboxIndexContract.ts NOTIFICATION_OUTBOX_FK_INDEXES).
  index("idx_notification_outbox_source_channel").on(t.sourceChannelId),
  index("idx_notification_outbox_receiver").on(t.receiverId),
  index("idx_mobile_push_outbox_pending").on(t.status, t.createdAt),
  // The drain's candidate read (migration 0359); built CONCURRENTLY in
  // staging/prod by db:create-mobile-push-outbox-active-index first.
  index("idx_mobile_push_outbox_active_created").on(t.createdAt).where(sql`${t.status} IN ('pending', 'processing')`),
  index("idx_mobile_push_outbox_message").on(t.messageId),
  check("mobile_push_outbox_receiver_type_check", sql`${t.receiverType} IN ('user')`),
  // `task` (migration task_conversation_push_kind): a task conversation fact (task v2).
  check("mobile_push_outbox_kind_check", sql`${t.kind} IN ('channel', 'dm', 'thread', 'task')`),
  // 'sent' / 'skipped' / 'dropped' are kept: the terminal rows from before the
  // unified dispatcher (millions, retained) carry them.
  check("mobile_push_outbox_status_check", sql`${t.status} IN ('pending', 'processing', 'sent', 'skipped', 'revoked', 'dropped', 'delivered', 'suppressed', 'quiet', 'failed')`),
]);

// A phone alert held back while the person is on a computer (account setting
// mobileDelay `1m`-`10m`, contract §1.3). One row per outbox row whose phone
// alert waits; the outbox row itself is delivered at once to every other
// device, and its phones get the badge sync then. At `due_at` the dispatcher
// re-checks (read, mute, level, pause, computer active again: moved to the new
// last input + delay, never past `deadline_at`) and alerts the phones or
// gives up. Terminal rows are swept after 7 days.
export const notificationMobileDeferrals = pgTable("notification_mobile_deferrals", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  outboxId: uuid("outbox_id").notNull().references(() => notificationOutbox.id, { onDelete: "cascade" }),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  // activity_at + delay + 20 minutes, at most activity_at + 30 minutes.
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["pending", "processing", "sent", "skipped", "failed"] }).notNull().default("pending"),
  // sent, read, muted, suppressed:<reason>, quiet, still_active_deadline, no_device, presence_unknown_sent.
  outcome: text("outcome"),
  // Times the due time moved because a computer was active again.
  extensions: integer("extensions").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_notification_mobile_deferrals_outbox").on(t.outboxId),
  index("idx_notification_mobile_deferrals_due").on(t.dueAt).where(sql`${t.status} IN ('pending', 'processing')`),
  index("idx_notification_mobile_deferrals_receiver").on(t.receiverId),
  index("idx_notification_mobile_deferrals_processed").on(t.processedAt).where(sql`${t.processedAt} IS NOT NULL`),
  check("notification_mobile_deferrals_status_check", sql`${t.status} IN ('pending', 'processing', 'sent', 'skipped', 'failed')`),
  check("notification_mobile_deferrals_window_check", sql`${t.dueAt} <= ${t.deadlineAt}`),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_push_subscriptions_user_endpoint").on(t.userId, t.endpoint),
  index("idx_push_subscriptions_user").on(t.userId),
]);

export const webPushPromptEvents = pgTable("web_push_prompt_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  trigger: text("trigger").notNull(),
  result: text("result"),
  permissionBefore: text("permission_before"),
  permissionAfter: text("permission_after"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_web_push_prompt_events_user_created").on(t.userId, t.createdAt),
  index("idx_web_push_prompt_events_server_created").on(t.serverId, t.createdAt),
]);

// User saved messages. Saving also follows the message's thread (thread
// contract D on thread_follows).
export const userSaved = pgTable("user_saved", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // The saver's thread (their server's sub-conversation) this save followed:
  // what Activity's Saved filter lists and what unsaving may release. NULL for
  // saves from before it (no backfill) and for messages with no thread here.
  // No foreign key: a deleted thread cascades its follow rows away, so a
  // dangling id matches nothing.
  threadChannelId: uuid("thread_channel_id"),
}, (t) => [
  primaryKey({ columns: [t.userId, t.messageId] }),
  index("idx_user_saved_user_server").on(t.userId, t.serverId),
]);

export const serverInvites = pgTable("server_invites", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  invitedEmail: text("invited_email").notNull(),
  invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The role this invite grants on acceptance. Only member and guest are
  // invitable: admin/owner are deliberately not reachable by email invite, so
  // escalation always stays an explicit in-server action by someone who is
  // already privileged.
  role: text("role", { enum: ["member", "guest"] }).notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: ["pending", "accepted", "expired"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_server_invites_server").on(t.serverId),
  index("idx_server_invites_email").on(t.invitedEmail),
]);

/**
 * Announcements — account-level popup messages.
 *
 * Every user only ever sees the SINGLE most recently published announcement,
 * and only if it is still active and they have not dismissed it. This keeps
 * the operator's mental model trivial — there is no per-user backlog to reason
 * about, and expiring a newer announcement never resurrects an older one.
 *
 * Drafts are edited through the platform-operator API, then atomically
 * published. `startsAt` / `endsAt` define a non-overlapping visibility window;
 * a future start is discovered on the next client bootstrap rather than pushed
 * into an already-open tab. Localized content is keyed by Raft display locale,
 * while `title` / `pages` mirror the selected default for legacy readers.
 * `status=expired` supports an immediate operator withdrawal without deleting
 * audit history.
 *
 * Not server-scoped: announcements follow the user across every server they
 * belong to, so the table holds no serverId.
 */
export const announcementImageAssets = pgTable("announcement_image_assets", {
  id: uuid("id").primaryKey(),
  storageKey: text("storage_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  unreferencedSince: timestamp("unreferenced_since", { withTimezone: true }),
  deletingAt: timestamp("deleting_at", { withTimezone: true }),
});


export const announcements = pgTable("announcements", {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  priority: integer("priority").notNull().default(0),
  audience: jsonb("audience").$type<AnnouncementAudience>().notNull().default({ type: "all" }),
  deliveryVersion: integer("delivery_version").notNull().default(1),
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  title: text("title").notNull(),
  pages: json("pages").$type<Array<{ title?: string; body: string }>>().notNull(),
  defaultLocale: text("default_locale", { enum: DISPLAY_LOCALES }).notNull().default("en"),
  localizedContent: json("localized_content")
    .$type<Partial<Record<DisplayLocale, AnnouncementContent>>>()
    .notNull()
    .default({}),
  status: text("status", { enum: ["draft", "published", "expired"] }).notNull().default("draft"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Keep the legacy default during the expand phase so an old server that is
  // still draining can continue to create a published row safely. V2 draft
  // writers always set this column to null explicitly.
  publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_announcements_status_starts_at_desc").on(t.status, t.startsAt),
  check("announcements_deleted_draft_only", sql`${t.deletedAt} is null or ${t.status} = 'draft'`),
  check("announcements_priority_range", sql`${t.priority} >= 0 and ${t.priority} <= 100`),
]);

export const userAnnouncementDismissals = pgTable("user_announcement_dismissals", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.announcementId] }),
]);

export const announcementAuditEvents = pgTable("announcement_audit_events", {
  oldPriority: integer("old_priority"),
  newPriority: integer("new_priority"),
  audienceSnapshot: jsonb("audience_snapshot").$type<AnnouncementAudienceSnapshot>(),
  reachCount: integer("reach_count"),
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
  action: text("action", {
    enum: [
      "deleted",
      "created",
      "updated",
      "published",
      "scheduled",
      "schedule_updated",
      "priority_updated",
      "schedule_cancelled",
      "activated",
      "expired",
    ],
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_announcement_audit_events_announcement_created").on(t.announcementId, t.createdAt),
]);

// Server join links — multi-use invite links for self-serve server joins
export const serverJoinLinks = pgTable("server_join_links", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  maxUses: integer("max_uses"),
  useCount: integer("use_count").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_server_join_links_token").on(t.token),
  index("idx_server_join_links_server").on(t.serverId),
]);

// SSO v1 (rfcs/083-server-sso.md §4): a Server's connection to its company's
// identity provider. One per Server in v1. `config` is the live, non-secret
// configuration; an edit is saved as `draft_config` and replaces it only
// after a test sign-in succeeds, so a broken edit never locks anyone out.
// The OIDC client secret is sealed (services/sso/ssoConnectionSecret.ts),
// never stored in `config`. The rules (`auto_join`, `required`,
// `session_max_age_days`) live here, not on `servers`: they mean nothing
// without a connection.
export const serverSsoConnections = pgTable("server_sso_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  protocol: text("protocol", { enum: ["oidc", "saml"] }).notNull(),
  // draft: never passed a test sign-in; active: signs people in; disabled:
  // kept, signs no one in, enforces nothing.
  status: text("status", { enum: ["draft", "active", "disabled"] }).notNull().default("draft"),
  // What the sign-in page shows ("Continue with <display name>").
  displayName: text("display_name").notNull(),
  config: jsonb("config").$type<SsoConnectionConfig>().notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext"),
  draftConfig: jsonb("draft_config").$type<SsoConnectionConfig>(),
  draftClientSecretCiphertext: text("draft_client_secret_ciphertext"),
  autoJoin: boolean("auto_join").notNull().default(false),
  required: boolean("required").notNull().default(false),
  sessionMaxAgeDays: integer("session_max_age_days").notNull().default(7),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_server_sso_connections_server").on(t.serverId),
  // "Require SSO" candidates (RFC 083 §6.2): the active, required connections.
  index("idx_server_sso_connections_required").on(t.serverId).where(sql`${t.status} = 'active' AND ${t.required}`),
  check("server_sso_connections_max_age", sql`${t.sessionMaxAgeDays} BETWEEN 1 AND 30`),
  // A Server cannot require SSO from a connection that signs no one in, so
  // whatever disables a connection clears `required` in the same UPDATE.
  check("server_sso_connections_required_active", sql`NOT ${t.required} OR ${t.status} = 'active'`),
]);

// A company email domain a Server proved by DNS TXT (RFC 083 §4, §5.5).
// Several Servers may verify the same domain, each with its own token.
// `verified_at` is null until proven and again once the record is
// confirmed gone; `last_check_result` / `absent_since` / `failing_since`
// tell a confirmed absence from a lookup that failed.
export const serverSsoDomains = pgTable("server_sso_domains", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Lowercase ASCII (IDNs in punycode), no trailing dot.
  domain: text("domain").notNull(),
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastCheckResult: text("last_check_result", { enum: ["present", "absent", "lookup_failed"] }),
  absentSince: timestamp("absent_since", { withTimezone: true }),
  failingSince: timestamp("failing_since", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_server_sso_domains_server_domain").on(t.serverId, t.domain),
  // Discovery looks a domain up across Servers.
  index("idx_server_sso_domains_domain").on(t.domain).where(sql`${t.verifiedAt} IS NOT NULL`),
]);

// A person as a Server's identity provider knows them (RFC 083 §4, D2): the
// IdP's immutable subject (OIDC `sub`, SAML persistent NameID) under one
// connection, never the email. One per person per connection.
export const ssoIdentities = pgTable("sso_identities", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  connectionId: uuid("connection_id").notNull().references(() => serverSsoConnections.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The email the IdP asserted when the identity was linked (audit only).
  emailAtLink: text("email_at_link").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_sso_identities_connection_subject").on(t.connectionId, t.subject),
  uniqueIndex("idx_sso_identities_connection_user").on(t.connectionId, t.userId),
  index("idx_sso_identities_user").on(t.userId),
]);

// One SSO sign-in in flight (RFC 083 §5.1, §5.2): created when it starts,
// given the IdP-verified profile and a one-time completion code at the
// callback, and gone once completed or after 10 minutes. `state` and the
// completion code are stored hashed; the PKCE verifier and nonce only live
// for the leg. `kind` test is an owner's test sign-in: it writes no person.
export const ssoAuthTransactions = pgTable("sso_auth_transactions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  connectionId: uuid("connection_id").notNull().references(() => serverSsoConnections.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["web", "app", "test"] }).notNull(),
  stateHash: text("state_hash").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  // Whether the test uses the connection's draft config (an edit of an active connection).
  usesDraft: boolean("uses_draft").notNull().default(false),
  returnTo: text("return_to"),
  appReturnUri: text("app_return_uri"),
  appCodeChallenge: text("app_code_challenge"),
  testUserId: uuid("test_user_id").references(() => users.id, { onDelete: "cascade" }),
  // SAML: the AuthnRequest ID the response must answer (InResponseTo); taken once.
  samlRequestId: text("saml_request_id"),
  // started → exchanging (claimed by its one callback; the IdP is asked outside any transaction) →
  // profile_ready → completing (claimed by one /complete; back to profile_ready only to ask for legal acceptance).
  status: text("status", { enum: ["started", "exchanging", "profile_ready", "completing"] }).notNull().default("started"),
  profile: jsonb("profile").$type<{ subject: string; email: string; emailVerified: boolean; displayName: string | null; linkByEmail?: "link_and_move" | "link" | "none" }>(),
  completionCodeHash: text("completion_code_hash"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("idx_sso_auth_transactions_state").on(t.stateHash),
  uniqueIndex("idx_sso_auth_transactions_completion").on(t.completionCodeHash),
  index("idx_sso_auth_transactions_expires").on(t.expiresAt),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_fk_indexes; built CONCURRENTLY on a large table by
  // db:create-device-session-key-indexes).
  index("idx_sso_auth_transactions_connection").on(t.connectionId),
]);

// SAML assertions already accepted (RFC 083 §7): an assertion ID is accepted
// once per connection, kept until the assertion could no longer be valid.
export const samlAssertionReplay = pgTable("saml_assertion_replay", {
  connectionId: uuid("connection_id").notNull().references(() => serverSsoConnections.id, { onDelete: "cascade" }),
  assertionId: text("assertion_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.assertionId] }),
  index("idx_saml_assertion_replay_expires").on(t.expiresAt),
]);

// Someone a full invite or join link turned away (task #10 #proj-commercial,
// behind pro_seat_add): recorded when their signed-in page says the seats are
// full (POST /api/invites/seat-blocked), so the server's owners, admins and
// the link's creator see it in the notification center. One active row per
// person and server: through a second link the first row stays. Resolved when
// they join, when there's a seat again, or after 7 days
// (services/seatJoinBlockService.ts).
export const seatJoinBlocks = pgTable("seat_join_blocks", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Who made the link or sent the invite: from the token, never from the request.
  inviterUserId: uuid("inviter_user_id").references(() => users.id, { onDelete: "set null" }),
  state: text("state", { enum: ["active", "resolved"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedReason: text("resolved_reason", { enum: ["joined", "room", "expired"] }),
}, (t) => [
  uniqueIndex("idx_seat_join_blocks_active").on(t.serverId, t.userId).where(sql`${t.state} = 'active'`),
  check(
    "seat_join_blocks_state_shape",
    sql`(${t.state} = 'active' AND ${t.resolvedAt} IS NULL AND ${t.resolvedReason} IS NULL)
      OR (${t.state} = 'resolved' AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedReason} IN ('joined', 'room', 'expired'))`,
  ),
]);

// Generic durable RAP App config. Defaults remain in each App manifest; rows
// contain only owner-scoped overrides plus a monotonic optimistic-concurrency
// revision. The service verifies that subject_agent_id belongs to server_id
// before every read/write, while both independent FKs provide lifecycle cleanup.
export const rapAppConfigs = pgTable("rap_app_configs", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  subjectAgentId: uuid("subject_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  overrides: jsonb("overrides").$type<Record<string, boolean | number>>().notNull().default({}),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({
    name: "rap_app_configs_server_app_subject_pk",
    columns: [t.serverId, t.appId, t.subjectAgentId],
  }),
]);

// Reminders — Server owns lifecycle/recurrence while the target Computer owns
// the durable schedule mirror, due timer, typed local Inbox item, and wake.
const scheduledFollowups = pgTable("reminders", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // Optional explicit fire surface. When set, this wins over msg_id's channel:
  // msg_id remains the conversational/audit anchor, while target_channel_id
  // pins delivery to the caller-selected top-level channel/DM/thread.
  targetChannelId: uuid("target_channel_id").references(() => channels.id, { onDelete: "set null" }),
  // Anchor to a message. Not a FK — msg deletion must not cascade the reminder
  // away, since ACL/visibility is re-evaluated at fire time anyway.
  msgId: uuid("msg_id"),
  title: text("title").notNull(),
  fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
  payload: json("payload"),
  // Optional recurrence. When present, fire transition re-queues a new fire_at
  // instead of marking the row completed. Stored as a versioned discriminated
  // union (see services/recurrence.ts). Unknown kinds at read time are
  // skip-fired + forward-advanced 5 min so newer variants written by a newer
  // server don't crash an older reader.
  recurrence: jsonb("recurrence"),
  status: text("status", { enum: ["scheduled", "fired", "canceled", "migrated"] }).notNull().default("scheduled"),
  // Bumped on every mutation; used as the idempotency / ordering key for
  // server→Computer push and Computer→server fire receipt.
  version: integer("version").notNull().default(1),
  // Business-state proof that the target Computer durably installed this
  // exact revision. Trace/log presence is not an arm receipt.
  armState: text("arm_state", { enum: ["pending", "armed", "not_armed"] }).notNull().default("pending"),
  armedVersion: integer("armed_version"),
  armUpdatedAt: timestamp("arm_updated_at", { withTimezone: true }),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  createdByType: text("created_by_type", { enum: ["agent", "human"] }).notNull(),
  createdById: uuid("created_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Fallback scanner path: WHERE status='scheduled' AND fire_at <= now()
  index("idx_reminders_due").on(t.status, t.fireAt),
  // Owner listings (sidebar pending list, daemon snapshot rebuild)
  index("idx_reminders_owner").on(t.ownerAgentId, t.status, t.fireAt),
  index("idx_reminders_server").on(t.serverId),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_reminders_target_channel").on(t.targetChannelId).where(sql`target_channel_id is not null`),
]);

export { scheduledFollowups as reminders };

// One legacy-reminder migration per Reminder App installation on a server: the
// server's recurring legacy reminders (and its overdue one-time ones a Computer
// never fired) are imported into the Reminder App and marked `migrated`.
// Re-installing is a new installation, so it migrates what was created in the
// meantime. `completed` is what turns the server's reminders over to the app
// (`reminderAppActiveForServer`); until then the legacy commands keep working.
export const reminderAppMigrations = pgTable("reminder_app_migrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Not a FK: uninstalling deletes the install row, and this record outlives it.
  installId: uuid("install_id").notNull(),
  state: text("state", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
  attempts: integer("attempts").notNull().default(0),
  // The report: candidates, imported, duplicate, conflict, rejected, skipped by reason.
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  lastErrorCode: text("last_error_code"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_reminder_app_migrations_install").on(t.serverId, t.installId),
  index("idx_reminder_app_migrations_state").on(t.state, t.nextAttemptAt),
]);

export const reminderEvents = pgTable("reminder_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  reminderId: uuid("reminder_id").notNull().references(() => scheduledFollowups.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["agent", "human", "system"] }).notNull(),
  actorId: uuid("actor_id"),
  eventType: text("event_type", { enum: ["scheduled", "fired", "snoozed", "updated", "canceled", "migrated"] }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
}, (t) => [
  index("idx_reminder_events_reminder").on(t.reminderId, t.occurredAt),
  index("idx_reminder_events_owner").on(t.ownerAgentId, t.occurredAt),
  index("idx_reminder_events_server").on(t.serverId),
]);

// Action cards: agent-prepared form-style messages that a human admin
// commits ("Create Channel", "Create Agent", "Add Members"). Anchored to a
// carrier message; the message body renders the card from this row.
//
// State machine:
//   prepared → frozen → reconfirm_required → ready → executed
//   prepared → ready (explicit cancellation only)
// Both stored as text (not pg enum) so future states (e.g. cancelled) can
// land without a schema migration. Migration-friendly per stdrc/tygg
// 2026-05-10 #proj-approval msg=174b7e16: minimum schema, jsonb where
// flexibility helps.
export const actionCards = pgTable("action_cards", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Carrier message — the message whose body renders this card. Cascade
  // delete: if the message goes (e.g. channel deleted), the card is moot.
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  // Who asked: an agent (every agent-prepared card), or a person (a member asking an
  // owner for seats or for Pro, task #10 #proj-commercial). Exactly one is set
  // (action_cards_one_requester). A person-requested card can exist only while the
  // server flag pro_seat_add is on; rolling back past this release means turning
  // the flag off and voiding those cards first.
  requesterAgentId: uuid("requester_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  requesterUserId: uuid("requester_user_id").references(() => users.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(),
  // Frozen at prepare time. Mutated only when the human commits with
  // overrides (e.g. picked a different runtime than the agent suggested);
  // in that case we store the merged action so audit reflects what was
  // actually committed.
  payload: jsonb("payload").notNull(),
  /**
   * Stable identity for "the open card that already represents this request" (task #21).
   *
   * Producers that must not raise two cards for the same pending thing set it; everyone else leaves
   * it NULL. Paired with the partial unique index below, "at most one UNRESOLVED card per request"
   * becomes a database guarantee instead of a read-then-insert that two concurrent callers can both
   * win (@Huarong). A code-level check could not hold it: the SELECT and the INSERT were in
   * different transactions, so both callers saw no card and both created one.
   *
   * NULL means "no dedupe" and is the default, so no existing card type changes behaviour.
   */
  dedupeKey: text("dedupe_key"),
  state: text("state").notNull().default("prepared"),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  executedByUserId: uuid("executed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  result: jsonb("result"),
  /**
   * What the executor typed into the card's form sheet (form.v1), as
   * `{ form, values }` (actionCardForms.ts), written when execute runs a form
   * handler. User content: never copied into `messages.action_metadata` (what
   * the channel and every realtime update carry; the card shows its `result`
   * instead), never returned to agents, never logged; read only to tell an
   * idempotent retry (same executor, same values) from a second submitter.
   * Cleared when the carrier message is retracted. NULL for every card executed
   * without a form.
   */
  submittedInput: jsonb("submitted_input"),
  // Conversion binding is durable authority for action-card credentials. A
  // prepared card is frozen while this job's source fence is active; after a
  // successful cutover it must be explicitly reconfirmed in Joint visibility.
  conversionJobId: uuid("conversion_job_id").references(() => channelConversionJobs.id, { onDelete: "set null" }),
  conversionSourceChannelId: uuid("conversion_source_channel_id").references(() => channels.id, { onDelete: "set null" }),
  conversionEpoch: uuid("conversion_epoch"),
  freezeState: text("freeze_state", { enum: ["ready", "frozen", "reconfirm_required"] }).notNull().default("ready"),
  confirmationVersion: integer("confirmation_version").notNull().default(1),
  reconfirmedAt: timestamp("reconfirmed_at", { withTimezone: true }),
  reconfirmedByUserId: uuid("reconfirmed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_action_cards_message").on(t.messageId),
  // At most one UNRESOLVED card per dedupe key. Scoped to `prepared` on purpose: once a card is
  // executed or dismissed it no longer represents a pending request, so the next genuine refusal
  // must be free to raise a fresh one.
  uniqueIndex("idx_action_cards_open_dedupe")
    .on(t.dedupeKey)
    .where(sql`${t.dedupeKey} is not null and ${t.state} = 'prepared'`),
  index("idx_action_cards_server_state").on(t.serverId, t.state),
  index("idx_action_cards_requester").on(t.requesterAgentId, t.createdAt),
  index("idx_action_cards_conversion_job").on(t.conversionJobId, t.freezeState),
  index("idx_action_cards_requester_user").on(t.requesterUserId, t.createdAt).where(sql`${t.requesterUserId} is not null`),
  // Deleting a channel checks its foreign key here (migration channel_fk_indexes;
  // built CONCURRENTLY on a large table by db:create-device-session-key-indexes).
  index("idx_action_cards_conversion_source_channel").on(t.conversionSourceChannelId).where(sql`conversion_source_channel_id is not null`),
  check("action_cards_freeze_state_check", sql`${t.freezeState} IN ('ready', 'frozen', 'reconfirm_required')`),
  check("action_cards_one_requester", sql`num_nonnulls(${t.requesterAgentId}, ${t.requesterUserId}) = 1`),
]);

// Product events — append-only product-funnel / UX-interaction event log.
//
// **Scope (owned by @Dozy + @meichen, decided 2026-05-13 #proj-permission:13b42cc0):**
// This table holds *product analytics / funnel* events for in-product objects
// (action cards today; reactions, onboarding step, permission card etc. in the
// future). It is NOT a global event sink — explicitly out of scope:
//
//   - audit / permission / credential events  → separate audit table later
//   - runtime / lifecycle / tracing events    → agent_activity_events / OTLP
//   - logging / debug events                  → external log infra
//
// **Boundary**: product event families are accepted only after an explicit
// subject_type / event_type whitelist expansion, gated by DB check
// constraints on both `subject_type` and `event_type`. New
// product objects must (a) propose a typed helper analogous to
// `recordActionCardEvent`, (b) extend the check constraints via migration,
// and (c) document their event shape with @Dozy + @meichen before INSERT
// becomes possible. This keeps the table from degenerating into a JSON
// dumping ground.
//
// **Field shape**: chosen to match a future generic `product_events` envelope
// (Leiysky/Dozy/meichen converged 2026-05-13). The table is named generically
// from day 1 to avoid a future rename — but the check constraints enforce a
// per-feature whitelist that widens through review.
//
// **No FK on subject_id**: deliberate — keeps the table polymorphic-ready
// without coupling to one source-of-truth table. Funnel queries join via
// `subject_id` directly.
//
// **subject_id grain (per subject_type)**:
//   - `action_card` → `action_cards.id` (canonical product entity).
//     Funnel SQL joins as `product_events.subject_id = action_cards.id`.
//     The carrier message id is reachable via `action_cards.message_id`
//     when message/channel context is needed. Decided 2026-05-13 in
//     #proj-permission:13b42cc0 (Dozy msg=9d0f10bd + meichen msg=174ba78c
//     reversal): `subject_id` must be the product entity, NOT its
//     message surface — message id is implementation detail of the
//     current carrier and would carry stale semantics if rendering
//     changes (forward / migrate / detach card from message).
//   - `onboarding_wizard` → `servers.id`. Wizard events are scoped to the
//     current server + human actor; metadata carries the step/session/version
//     dimensions. Do not use `subject_id=user_id` here because the wizard is
//     a server onboarding surface and the same user can onboard multiple
//     workspaces.
//
// **No PII / raw content** in metadata. metadata is for low-cardinality,
// aggregable signals (error_class, error_code, dismiss_reason).
// Free-text, message bodies, channel names, prompts, raw caught error
// messages / stack traces must NOT land here. Enforced by code review,
// not the DB. Per Leiysky/Dozy/meichen 2026-05-13 review: even
// length-truncated `error_message` is rejected because caught text can
// carry user input, payload fragments or DB error strings — boundary is
// "categorical buckets only, never a thing readable as a sentence".
export const productEvents = pgTable("product_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  eventType: text("event_type").notNull(),
  // actor_type/id is null for system-emitted events (e.g. `expired` from a
  // future TTL job). For action_card.* events, actor is always the human
  // clicking, except `expired` which has no actor.
  actorType: text("actor_type"),
  actorId: uuid("actor_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
  // Schema version of the metadata shape for *this* event_type. Increment
  // when an event_type's metadata contract changes in a non-additive way.
  // Defaults to 1 — bump only with explicit Dozy/meichen sign-off.
  schemaVersion: integer("schema_version").notNull().default(1),
  // Where the event came from — 'web' for client-emitted, 'server' for
  // server-side hookpoints, 'cron' for batch jobs. Optional but useful for
  // debugging duplicate/missing events.
  source: text("source"),
  // Optional client-supplied idempotency key — at-most-once write within a
  // (subject_id, event_type) when set. Enforced via partial unique index.
  idempotencyKey: text("idempotency_key"),
}, (t) => [
  index("idx_product_events_subject").on(t.subjectId, t.occurredAt),
  index("idx_product_events_type").on(t.eventType, t.occurredAt),
  uniqueIndex("idx_product_events_idempotency")
    .on(t.subjectId, t.eventType, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} IS NOT NULL`),
  // Day-1 whitelist. Widening this requires a migration + Dozy/meichen review.
  check(
    "product_events_subject_type_whitelist",
    sql`${t.subjectType} IN ('action_card', 'onboarding_wizard', 'server')`,
  ),
  check(
    "product_events_event_type_whitelist",
    sql`${t.eventType} IN (
      'action_card.open',
      'action_card.dismiss',
      'action_card.execute_attempt',
      'action_card.execute_success',
      'action_card.execute_fail',
      'action_card.expired',
      'onboarding_wizard.step_shown',
      'onboarding_wizard.primary_clicked',
      'onboarding_wizard.skip_clicked',
      'onboarding_wizard.dismissed',
      'onboarding_wizard.completed',
      'onboarding_wizard.error',
      'agent.second_created'
    )`,
  ),
  // actor_type, when set, must be one of the recognised principals.
  check(
    "product_events_actor_type_valid",
    sql`${t.actorType} IS NULL OR ${t.actorType} IN ('human', 'agent', 'system')`,
  ),
]);

// Agent manual request events — metadata-only audit/readout for authenticated
// operating-manual retrieval. Do not store raw doc content,
// prompt/context, user-message excerpts, or private-channel quotes here.
export const agentKnowledgeEvents = pgTable("agent_knowledge_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  computerId: uuid("computer_id"),
  docId: text("doc_id"),
  topicOrPath: text("topic_or_path").notNull(),
  docVersion: text("doc_version"),
  docState: text("doc_state", { enum: ["draft", "published", "deprecated", "retired"] }),
  // `cli`: the raft CLI (or a Computer's agent proxy); `sdk`: the raft SDK,
  // or a request naming no client (the cloud runtime). See resolveKnowledgeSource.
  source: text("source", { enum: ["cli", "sdk"] }).notNull(),
  status: text("status", { enum: ["success", "not_found", "denied", "error"] }).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  latencyMs: integer("latency_ms"),
  responseBytes: integer("response_bytes"),
  turnId: text("turn_id"),
  traceId: text("trace_id"),
  intent: text("intent"),
  reason: text("reason"),
  // Nullable rollout marker. `manual-context-v1` means the caller explicitly
  // advertised the required intent/reason contract; null is a legacy client.
  contextContractVersion: text("context_contract_version"),
  // Route-owned operation marker. Null is a legacy row; callers cannot choose
  // this value because get/search handlers emit it at the execution boundary.
  operation: text("operation", { enum: ["get", "search"] }),
  // Nullable retrieval-branch marker. Successful get/search rows identify the
  // branch that produced the result. `language_gate` is the one deliberate
  // non-success branch: status remains `not_found` for wire compatibility, but
  // telemetry can exclude a language-policy reject from ordinary content miss.
  // Null is reserved for legacy rows and ordinary miss/denied/error events.
  resolution: text("resolution", { enum: [
    "exact_id",
    "alias",
    "token_route",
    "lexical",
    "concept_expansion",
    "typo_correction",
    "mixed",
    "language_gate",
  ] }),
}, (t) => [
  index("idx_agent_knowledge_events_agent_requested").on(t.agentId, t.requestedAt),
  index("idx_agent_knowledge_events_server_requested").on(t.serverId, t.requestedAt),
  index("idx_agent_knowledge_events_doc_requested").on(t.docId, t.requestedAt),
  index("idx_agent_knowledge_events_status_requested").on(t.status, t.requestedAt),
  check(
    "agent_knowledge_events_source_valid",
    sql`${t.source} IN ('cli', 'sdk')`,
  ),
  check(
    "agent_knowledge_events_status_valid",
    sql`${t.status} IN ('success', 'not_found', 'denied', 'error')`,
  ),
  check(
    "agent_knowledge_events_doc_state_valid",
    sql`${t.docState} IS NULL OR ${t.docState} IN ('draft', 'published', 'deprecated', 'retired')`,
  ),
  check(
    "agent_knowledge_events_operation_valid",
    sql`${t.operation} IS NULL OR ${t.operation} IN ('get', 'search')`,
  ),
  check(
    "agent_knowledge_events_resolution_valid",
    sql`${t.resolution} IS NULL OR ${t.resolution} IN ('exact_id', 'alias', 'token_route', 'lexical', 'concept_expansion', 'typo_correction', 'mixed', 'language_gate')`,
  ),
  check(
    "agent_knowledge_events_success_doc_version",
    sql`${t.status} <> 'success' OR (${t.docId} IS NOT NULL AND ${t.docVersion} IS NOT NULL AND ${t.docState} IS NOT NULL)`,
  ),
]);

// Message mentions — send-time resolved mention intent/fact.
// Each row records a single @mention resolved at write time. The lexical
// fields are immutable; projection/action fields gate when the row is visible
// to the target-side inbox, push, and "who mentioned me" consumers.
// messageSeq is denormalized from messages.seq so Inbox can probe unread mentions
// without joining back to the messages table (aligns with read cursor authority).
export const messageMentions = pgTable("message_mentions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  messageSeq: bigint("message_seq", { mode: "number" }).notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  targetType: text("target_type", { enum: ["user", "agent"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  handleAtSendTime: text("handle_at_send_time").notNull(),
  source: text("source", { enum: ["send_path", "backfill"] }).notNull().default("send_path"),
  confidence: text("confidence", { enum: ["exact", "backfill"] }).notNull().default("exact"),
  notifiableAtSend: boolean("notifiable_at_send").notNull().default(true),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  notifiedByType: text("notified_by_type", { enum: ["user", "agent"] }),
  notifiedById: uuid("notified_by_id"),
  notifiedAction: text("notified_action", { enum: ["notify_only", "add"] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_message_mentions_unique").on(t.messageId, t.targetType, t.targetId),
  index("idx_message_mentions_target").on(t.targetType, t.targetId, t.serverId, sql`${t.createdAt} DESC`),
  index("idx_message_mentions_channel").on(t.channelId, t.messageId),
  index("idx_message_mentions_inbox").on(t.targetType, t.targetId, t.channelId, t.messageSeq),
  // A sender's pending mention actions (mentionActionService
  // listPendingMentionActionsForSender): the mentions that reached nobody at
  // send, newest first per server; ~2.5% of rows.
  index("idx_message_mentions_pending_actions").on(t.serverId, sql`${t.createdAt} DESC`).where(sql`source = 'send_path' and not notifiable_at_send`),
]);

// One authoritative recovery row for an agent mention delivery occurrence.
// The PK is the immutable message_mentions id: retries, daemon reconnects, and
// operator redrives all reuse this identity. The payload/snapshots are the
// durable source used to rebuild task #166's in-memory ACK obligation; this
// table never runs a second retry loop of its own.
export const mentionDeliveryOccurrences = pgTable("mention_delivery_occurrences", {
  occurrenceId: uuid("occurrence_id").primaryKey().references(() => messageMentions.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  deliveryPayload: jsonb("delivery_payload").$type<AgentMessage>(),
  state: text("state", {
    enum: [
      "recorded",
      "server_decided",
      "daemon_received",
      "daemon_pending",
      "daemon_drained",
      "acked",
      "terminal_error",
    ],
  }).notNull().default("recorded"),
  deliveryPath: text("delivery_path", { enum: ["unknown", "immediate", "busy"] }).notNull().default("unknown"),
  machineIdSnapshot: uuid("machine_id_snapshot"),
  launchIdSnapshot: text("launch_id_snapshot"),
  sessionIdSnapshot: text("session_id_snapshot"),
  mentionRecordedAt: timestamp("mention_recorded_at", { withTimezone: true }).notNull().defaultNow(),
  serverDecidedAt: timestamp("server_decided_at", { withTimezone: true }),
  daemonReceivedAt: timestamp("daemon_received_at", { withTimezone: true }),
  daemonPendingAt: timestamp("daemon_pending_at", { withTimezone: true }),
  daemonDrainedAt: timestamp("daemon_drained_at", { withTimezone: true }),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  terminalErrorAt: timestamp("terminal_error_at", { withTimezone: true }),
  terminalErrorCode: text("terminal_error_code"),
  terminalDecision: jsonb("terminal_decision").$type<MentionDeliveryTerminalDecision>(),
  pendingCoalescedCount: integer("pending_coalesced_count").notNull().default(0),
  version: integer("version").notNull().default(0),
  redriveCount: integer("redrive_count").notNull().default(0),
  lastRedriveAt: timestamp("last_redrive_at", { withTimezone: true }),
  // task #285: automatic recovery rounds re-sent after the daemon already held the occurrence.
  // Bounds the recovery loop per occurrence; it is not an age and never counts rounds that
  // could not reach the daemon (an offline agent keeps its mention).
  recoveryCount: integer("recovery_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_mention_delivery_occurrences_message_agent").on(t.messageId, t.agentId),
  index("idx_mention_delivery_occurrences_machine_state").on(t.machineIdSnapshot, t.state),
  // Agent-side recovery (listRecoverableMentionDeliveriesForAgent) filters by agent_id over
  // unacked, non-terminal rows that carry a delivery payload (~5% of the table; open rows
  // without a payload are skipped by recovery and would only cost heap rechecks). Built
  // CONCURRENTLY outside the migration first (scripts/create-mention-delivery-agent-open-index.ts).
  index("idx_mention_delivery_occurrences_agent_payload_open")
    .on(t.agentId, t.state)
    .where(sql`${t.ackedAt} IS NULL AND ${t.terminalErrorAt} IS NULL AND ${t.deliveryPayload} IS NOT NULL`),
  // The right-hand side is an AND over TWO columns, and that AND is the hole (@Hipp, PR #6700
  // comment 5359756944, measured on pglite): "right side is false" has two causes — neither column
  // set, or exactly one set — and a biconditional cannot separate them. So a row with
  // terminal_error_at set and terminal_error_code NULL satisfies it for ANY non-terminal state, and
  // the database accepts a row carrying half a terminal receipt. The pairing conjunct closes it by
  // making the two columns move together; legal rows are unaffected, which he verified in BOTH
  // directions rather than only checking that the bad rows now fail.
  check(
    "mention_delivery_occurrences_terminal_error_shape",
    sql`(${t.state} = 'terminal_error') = (${t.terminalErrorAt} IS NOT NULL AND ${t.terminalErrorCode} IS NOT NULL) AND ((${t.terminalErrorAt} IS NULL) = (${t.terminalErrorCode} IS NULL))`,
  ),
  check(
    "mention_delivery_occurrences_ack_shape",
    sql`(${t.state} = 'acked') = (${t.ackedAt} IS NOT NULL)`,
  ),
]);

// Attested send events — lightweight diagnostic ledger for stale-hold /
// continue / silence / E1 exemption funnel tracking.
export const attestedSendEvents = pgTable("attested_send_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  eventType: text("event_type", { enum: ["gate_triggered", "continue", "silence", "e1_exempt"] }).notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  targetType: text("target_type", { enum: ["channel", "dm", "thread"] }).notNull(),
  targetRef: text("target_ref").notNull(),
  draftId: text("draft_id"),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  newMessageCount: integer("new_message_count"),
  result: text("result", { enum: ["committed", "committed_anyway", "reheld", "replaced", "expired", "no_draft"] }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attested_send_events_created").on(t.createdAt),
  index("idx_attested_send_events_agent_created").on(t.agentId, t.createdAt),
  index("idx_attested_send_events_type_created").on(t.eventType, t.createdAt),
  index("idx_attested_send_events_server_created").on(t.serverId, t.createdAt),
  // The messages ON DELETE SET NULL lookup; the table is large in production,
  // so db:migrate:deploy builds it CONCURRENTLY
  // (db:create-attested-send-events-message-index), not the migration.
  index("idx_attested_send_events_message").on(t.messageId).where(sql`${t.messageId} IS NOT NULL`),
]);

export const attestedSendPendingDrafts = pgTable("attested_send_pending_drafts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  targetType: text("target_type", { enum: ["channel", "dm", "thread"] }).notNull(),
  targetRef: text("target_ref").notNull(),
  content: text("content").notNull(),
  attachmentIds: jsonb("attachment_ids").notNull().default(sql`'[]'::jsonb`),
  attestedUpToSeq: bigint("attested_up_to_seq", { mode: "number" }).notNull(),
  attestedUpToMessageId: uuid("attested_up_to_message_id"),
  newMessageCountAtHold: integer("new_message_count_at_hold").notNull(),
  reholdCount: integer("rehold_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("idx_attested_send_pending_drafts_agent_channel").on(t.agentId, t.channelId),
  index("idx_attested_send_pending_drafts_expires_at").on(t.expiresAt),
]);

export const attestedSendDraftOutcomes = pgTable("attested_send_draft_outcomes", {
  draftId: text("draft_id").primaryKey(),
  outcome: text("outcome", { enum: ["expired", "replaced"] }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("idx_attested_send_draft_outcomes_expires_at").on(t.expiresAt),
]);

// Agent permission scopes — single-row-per-agent grant set.
//
// Locked at #proj-permission:10bdc2c9 (2026-05-10). Design decisions:
//
//   • One row per agent — `scopes` is a JSON array of grantable scope
//     literals (see shared/agentScopes.ts). Whole-set updates are atomic
//     and the cache invalidation event payload is just the new array.
//
//   • Intrinsic scopes are NOT stored. They're inherent to "being an
//     agent" — `auth:whoami`, `profile:*`, `reminder:*` — and the
//     server's `hasScope()` check short-circuits them independent of
//     this table. Storing them would invite drift between the literal
//     contract and the runtime check.
//
//   • Absent row = "not yet seeded". The agent service backfills with
//     the default-on set on first read; `revision` starts at 1 then.
//     Treating "no row" as "no scopes" would silently break every agent
//     created before this migration lands.
//
//   • `revision` is a monotonic int bumped on every write, used by the
//     daemon ws cache to short-circuit redundant invalidations on
//     reconnect (no need to re-broadcast if revision matches).
export const agentScopes = pgTable("agent_scopes", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // JSON array of grantable scope literals. Type pinned in service layer
  // via `sanitizeGrantedScopes()`; stored as untyped `text[]`-equivalent
  // JSON for migration-friendliness (additive splits don't need a schema
  // change).
  scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
  // Bumped on every write — daemon-side scope cache uses it to detect
  // out-of-order invalidations on reconnect.
  revision: integer("revision").notNull().default(1),
  // Audit pointer to the human who last edited the grant set. Null when
  // the row was created by the agent service backfill (default seed).
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // default: follows the system default grant set, including future
  // default-enabled capabilities. custom: human edited this agent; future
  // capabilities stay off until explicitly enabled.
  mode: text("mode", { enum: ["default", "custom"] }).notNull().default("default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_scopes_server").on(t.serverId),
]);

// View Context grants (#wg-ax:#15; shared agentContextViewGrant.ts): a
// server owner or admin lets one ordinary agent search and read other agents'
// View Context on the server. Its own table, not agent_scopes. Revoking sets
// revoked_at / revoked_by_user_id. A grant whose granter lost access or left,
// whose grantee is no longer an ordinary agent of the server, or whose target
// is gone is decided unusable each time it is used
// (services/agentContextViewGrantService.ts), never cleaned up. The one
// deletion: the account-deletion cleanup removes the grants a deleted account
// gave (accountDeletion/tableClassification.ts; unusable from retirement on,
// and the grant stays in the server audit). At most one active (unrevoked)
// grant per agent per server.
// Agents and users are never hard-deleted (deleted_at / retired_at), so the
// cascades below fire only with the server's own deletion.
export const agentContextViewGrants = pgTable("agent_context_view_grants", {
  id: uuid("id").primaryKey().$type<AgentContextViewGrantId>(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  granteeAgentId: uuid("grantee_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  granterUserId: uuid("granter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("uq_agent_context_view_grants_active").on(t.serverId, t.granteeAgentId).where(sql`revoked_at is null`),
  // ON DELETE CASCADE from agents finds a grantee's rows without a scan.
  index("idx_agent_context_view_grants_grantee").on(t.granteeAgentId),
  check("agent_context_view_grants_revoked_by_needs_revoked_at", sql`${t.revokedByUserId} IS NULL OR ${t.revokedAt} IS NOT NULL`),
]);

// External agent credentials — `sk_agent_*` runtime principals
// (`rfcs/034-slock-credential-rfc.zh.html#section-credential-model`).
//
// Long-lived bearer keys minted by exchanging a gated agent bootstrap token, or
// minted directly by a `sk_computer_*`-authenticated Computer via
// `/internal/computer/runners/:agentId/credentials`. One row
// per credential, bound to exactly one `agentId` for life. NEVER reassigned
// to a different agent — a fresh credential is issued instead. Revoked rows
// stay, except a Computer's runner keys (`issued_via = 'computer'`, one per
// launch), deleted 30 days after revocation (agentCredentialRetention.ts).
//
// Auth flow (see `authenticateAgentCredential` middleware):
//   1. CLI / Runner presents `Authorization: Bearer sk_agent_*`
//   2. middleware extracts `apiKeyPrefix`
//      → SELECT row WHERE prefix = ? AND revoked_at IS NULL
//        (served by partial index `idx_agent_credentials_prefix_active`)
//   3. constant-time HMAC compare on `apiKeyHmac` when set; otherwise argon2id
//      verify on `apiKeyHash`, then backfill `apiKeyHmac`
//   4. on success: `req.actingAgentId = row.agentId`,
//      `req.principalKind = 'agent_credential'`,
//      `req.agentCredentialId = row.id`,
//      `req.agentCredentialScopes = row.scopes`
//
// v0.8 active surface (route allowlist via `routeAuthPolicy` registry, see
// `internalAgentApiRouter` at `routes/internalAgentApi.ts`):
//   GET    /internal/agent-api                         — whoami
//   GET    /internal/agent-api/context                 — identity bootstrap
//   GET    /internal/agent-api/server
//   POST   /internal/agent-api/send
//   GET    /internal/agent-api/history
//   GET    /internal/agent-api/messages/:msgId/resolve
//   GET    /internal/agent-api/mentions
//   POST   /internal/agent-api/tasks/claim
//   POST   /internal/agent-api/tasks/amend
//   GET    /internal/agent-api/tasks/history
//   POST   /internal/agent-api/messages/:msgId/reactions
//   DELETE /internal/agent-api/messages/:msgId/reactions
//   POST   /internal/agent-api/channels/:channelId/join
//   POST   /internal/agent-api/channels/:channelId/leave
//   POST   /internal/agent-api/channels/:channelId/members
//   GET    /internal/agent-api/events?since=<seq|latest> — catch-up envelope
//   GET|PUT|DELETE /internal/agent-api/push-webhook — inbox push registration
//   POST   /internal/agent-api/credentials/self/revoke — the key revokes itself
//          (`revoked_reason = 'self_revoked'`; person-minted keys only)
//
// Explicitly NOT permitted in v0 (returns 401 `invalid_principal` via the
// auth-policy registry — wrong-principal class, not a 404):
//   /daemon/connect              — legacy server session only (`sk_machine_*`)
//   /internal/machine/*          — legacy server session clientType only
//   /internal/computer/*         — Computer-host scope only
//   /api/agents/:id/credentials/* — admin self-management forbidden for sk_agent_*
//
// Key isolation invariant
// (`rfcs/034-slock-credential-rfc.zh.html#section-credential-isolation`):
// the raw `sk_agent_*` value lives only in the server response at mint time
// and then inside the daemon/server-session worker private boundary. Managed
// runtime env, tool shells, workspace files, and wrapper scripts must not
// contain the raw key or a readable key-file pointer.
//
// Capability enforcement (Computer RFC §7.2):
//   authorized_for(request) := request.capability
//     ∈ (credential.max_capabilities ∩ session.active_capabilities)
// The `scopes` column below is the MAX side of that intersection.
// Per-session active capabilities live on a separate runtime channel and
// are not stored on the credential row.
export const AGENT_CREDENTIAL_ISSUED_VIA_VALUES = ["human", "provision", "computer", "app", "unknown"] as const;
export type AgentCredentialIssuedVia = typeof AGENT_CREDENTIAL_ISSUED_VIA_VALUES[number];

export const agentCredentials = pgTable("agent_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // argon2id of the raw `sk_agent_*` key. Returned exactly once at mint;
  // never persisted in raw form. Verified constant-time post-lookup.
  apiKeyHash: text("api_key_hash").notNull(),
  // HMAC-SHA-256(AGENT_API_KEY_HMAC_SECRET, raw key) as raw bytes. The fast
  // verifier: when set, auth compares it in constant time and skips argon2
  // (the key is 256 random bits, so argon2's stretching adds nothing). NULL on
  // rows minted before it existed or while the secret is unset; those verify
  // with argon2 and backfill it. Not a lookup key — rows are still found by
  // `apiKeyPrefix`, so no index.
  apiKeyHmac: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("api_key_hmac"),
  // First N chars of raw key for O(1) lookup at auth time. Not identity —
  // a `tokenLookupHash`-style HMAC could replace it later, but partial-
  // prefix is enough at v0 scale and matches the existing `sk_machine_*`
  // shape on `machines.api_key_prefix`.
  apiKeyPrefix: text("api_key_prefix").notNull(),
  // Human-readable label set at issue time (e.g. "ci-runner-1",
  // "computer-Maria-runner-claude"). Optional.
  name: text("name"),
  // MAX capability set — the upper bound on what this credential can do.
  // v0.8 active enum: ['send','read','mentions','tasks','reactions','server','channels','knowledge'].
  // ['workspace'] is reserved-not-active in v0. Route allowlist is the
  // actual enforcement; this column is the audit + future-cap stub.
  scopes: text("scopes").array().notNull(),
  // The person who issued it: set only when `issuedVia = 'human'` (a direct
  // mint, or the issuer of the bootstrap token it was exchanged from). Null for
  // every other origin, and after that person's account is deleted.
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Where the credential came from (#wg-rbac):
  //   human     — a person minted it, directly or through a bootstrap token
  //   provision — a cloud runtime's credential, held encrypted by its provider
  //   computer  — a Computer minted it for its runner (`issuedByMachineId`)
  //   app       — an App's managed Bot identity
  //   unknown   — backfilled rows that could not be classified; no live
  //               write path produces it
  // Nullable in the database during the expand phase (0401): existing rows are
  // filled by scripts/backfill-agent-credential-issued-via.ts and the contract
  // migration sets NOT NULL. Every live write path sets it
  // (mintAgentCredential requires it); readers must tolerate NULL until then.
  issuedVia: text("issued_via", { enum: AGENT_CREDENTIAL_ISSUED_VIA_VALUES }),
  // The Machine that minted it; only for `issuedVia = 'computer'`.
  issuedByMachineId: uuid("issued_by_machine_id").references(() => machines.id, { onDelete: "set null" }),
  // The session family of a device login (scope `device`) that minted it, so
  // it is revoked with that session, however the session is revoked
  // (deviceSessionKeys.ts). NULL for every other mint.
  issuedBySessionFamilyId: uuid("issued_by_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  // The person's web (full) session family that minted it (POST
  // /api/agents/:id/credentials, or the bootstrap token it was exchanged
  // from), so a security revoke of that session (a password change or reset,
  // the account's retirement) revokes it (webSessionIssuedKeys.ts). A plain
  // logout or expiry never does. NULL for every other mint, for credentials
  // minted before this column and for a legacy token with no family. Distinct
  // from issued_by_session_family_id, which follows any revoke.
  issuedByWebSessionFamilyId: uuid("issued_by_web_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Last-use observability triple (best-effort; updated post-auth).
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  lastUsedUserAgent: text("last_used_user_agent"),
  // Soft revoke; row stays for audit (a runner key's for 30 days, see the
  // table comment). Revoked rows are skipped at auth
  // time by the partial index `idx_agent_credentials_prefix_active`
  // (added via raw SQL in the migration — drizzle-kit's `WHERE` support
  // on btree indexes is limited, so the partial-index DDL is hand-rolled).
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  // When it stops authenticating (#wg-rbac:#27): from then on auth refuses it
  // with 401 `agent_credential_expired`, distinct from a revoked or unknown
  // key. NULL never expires: every credential before this column, and every
  // one minted since except a runner credential whose daemon declared
  // `runner-credential-renew:v1` (7 days, renewed by its Computer). A renewal
  // pulls the old key's expiry in to at most 5 minutes out. Auth reads it off
  // the row it already found by prefix; only the retention sweep's read of
  // long-expired runner keys has an index (idx_agent_credentials_expired_computer).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // The credential a renewal issued in place of this one
  // (POST /internal/computer/runners/:agentId/credentials/renew): set in the
  // renewal's transaction, so a second renewal of this key is refused (409
  // `runner_credential_already_renewed`) instead of issuing another. No
  // foreign key: adding one would validate across the whole table, and the
  // retention sweep deletes revoked runner rows on its own schedule.
  replacedByCredentialId: uuid("replaced_by_credential_id"),
}, (t) => [
  index("idx_agent_credentials_prefix").on(t.apiKeyPrefix),
  index("idx_agent_credentials_agent").on(t.agentId),
  // The live ones only, by issuer: a person's departure revokes the keys they
  // issued for the server's agents (revokeAgentCredentialsIssuedBy) inside the
  // removal's transaction. Without it that lookup scanned all of
  // agent_credentials and timed out a large server's removal (#wg-rbac:#18).
  index("idx_agent_credentials_live_by_creator").on(t.createdByUserId).where(sql`revoked_at is null`),
  // ON DELETE SET NULL from daemons: without it every machine delete scanned
  // all of agent_credentials and hit the 15 s statement timeout (#triage:67b94880).
  index("idx_agent_credentials_issued_by_machine").on(t.issuedByMachineId).where(sql`issued_by_machine_id is not null`),
  index("idx_agent_credentials_issued_by_session_family").on(t.issuedBySessionFamilyId).where(sql`issued_by_session_family_id is not null`),
  // The live ones only: the hourly sweep of revoked device sessions' keys
  // (deviceSessionKeys.ts) reads these, while revoked runner credentials (one
  // per launch on a device-attached Computer) pile up in the index above.
  index("idx_agent_credentials_live_by_session_family").on(t.issuedBySessionFamilyId).where(sql`issued_by_session_family_id is not null and revoked_at is null`),
  // The web-session cascade's lookup by family and the FK's ON DELETE SET
  // NULL. Only people's own web mints are in it (never runner credentials), so
  // it stays small without a live-only twin.
  index("idx_agent_credentials_issued_by_web_session_family").on(t.issuedByWebSessionFamilyId).where(sql`issued_by_web_session_family_id is not null`),
  // The hourly retention sweep's oldest-first read of revoked runner keys
  // (agentCredentialRetention.ts); built CONCURRENTLY on a large table.
  index("idx_agent_credentials_revoked_computer").on(t.revokedAt).where(sql`revoked_at is not null and issued_via = 'computer'`),
  // The same sweep's oldest-first read of runner keys that were never revoked
  // but expired (a renewal leaves the old key so); built CONCURRENTLY.
  index("idx_agent_credentials_expired_computer").on(t.expiresAt).where(sql`expires_at is not null and revoked_at is null and issued_via = 'computer'`),
  // Runner credential reconcile (revokeRunnerCredentialsNotHeld, #wg-rbac:#27):
  // a Machine's live runner keys only. idx_agent_credentials_issued_by_machine
  // also holds every revoked one (prod: 350k rows for one Machine, 3.18 s);
  // that one stays for the machine-delete SET NULL. Built CONCURRENTLY.
  index("idx_agent_credentials_live_runner_by_machine").on(t.issuedByMachineId).where(sql`revoked_at is null and issued_via = 'computer' and issued_by_machine_id is not null`),
  // Added NOT VALID in 0401 (no scan); validated by the contract migration.
  check("agent_credentials_issued_via_check", sql`${t.issuedVia} IS NULL OR ${t.issuedVia} IN ('human', 'provision', 'computer', 'app', 'unknown')`),
  // Partial index `idx_agent_credentials_prefix_active` is appended to
  // the canonical migration as raw SQL — see drizzle migration
  // `0072_*` step 2.
]);

// External Agent inbox push (raft-agent-inbox.v2). One registration per agent,
// bound to the `sk_agent_*` credential that created it: a revoked credential
// disables the registration at the next delivery. The receiver-supplied signing
// secret is encrypted at rest with the app webhook key and never returned.
//
// The row also carries the per-agent delivery lease: a delivery claims the row
// (lease_token / lease_expires_at) with one conditional UPDATE, so at most one
// delivery per agent is in flight across all replicas. The durable inbox is the
// backlog; nothing here stores message bodies or a separate cursor.
export const agentInboxPushRegistrations = pgTable("agent_inbox_push_registrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  credentialId: uuid("credential_id").notNull().references(() => agentCredentials.id, { onDelete: "cascade" }),
  endpointUrl: text("endpoint_url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: text("secret_iv").notNull(),
  secretAuthTag: text("secret_auth_tag").notNull(),
  // Set when pushes stop: 'endpoint_rejected' (3 consecutive 404/410, or 401s
  // with no other answer for 24 hours), 'credential_revoked' or
  // 'agent_inactive'. A new PUT clears it; so does a 2xx to a recovery probe
  // (endpoint_rejected only).
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  // When the agent's owner was last told its pushes stopped (agentInboxPushService:
  // at most one notice per 24 hours). Claimed in the same UPDATE that sets
  // disabled_at, so concurrent failures send one notice. Kept across a new PUT.
  lastDisabledNoticeAt: timestamp("last_disabled_notice_at", { withTimezone: true }),
  // The current run of 401s: its first 401 and how many in a row (any other
  // outcome or a new PUT clears both). A 401 does not count toward the 3
  // rejections; the run disables once it has at least 3 and lasted 24 hours.
  firstUnauthorizedAt: timestamp("first_unauthorized_at", { withTimezone: true }),
  consecutiveUnauthorized: integer("consecutive_unauthorized").notNull().default(0),
  // Recovery probe of an endpoint_rejected registration: when the next one is
  // due and the backoff it was scheduled with (1 hour, doubling, capped at 24
  // hours). Other disable reasons are never probed. NULL on an endpoint_rejected
  // row (stopped before the probe existed, or by an older replica) is due now.
  nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
  probeBackoffMs: integer("probe_backoff_ms"),
  // Set when probing gave up: 30 days stopped without recovering (the URL may
  // be abandoned, its domain re-registered by someone else). Such a row is
  // never probed again; only a new PUT (which clears it) resumes delivery.
  probeStoppedAt: timestamp("probe_stopped_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  // Last time new inbox work was signalled; a delivery that started before it
  // does not park the row idle.
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  consecutiveRejections: integer("consecutive_rejections").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  lastError: text("last_error"),
  // Max pending seq a sweep reminder was claimed for. One conditional update
  // makes exactly one replica send each reminder; cleared when the inbox is empty.
  remindedMaxSeq: bigint("reminded_max_seq", { mode: "number" }),
  // Who set the endpoint and secret: `agent` (PUT /push-webhook with the agent's
  // own credential) or `provider` (the runtime provider's control route,
  // routes/runtimeProviderControl.ts; the only way for a personal assistant
  // while its WeChat bridge flags are on).
  configuredBy: text("configured_by", { enum: ["agent", "provider"] }).notNull().default("agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_inbox_push_registrations_agent").on(t.agentId),
  index("idx_agent_inbox_push_registrations_due").on(t.nextAttemptAt),
  index("idx_agent_inbox_push_registrations_credential").on(t.credentialId),
  check("agent_inbox_push_registrations_failures_nonnegative", sql`${t.consecutiveFailures} >= 0 AND ${t.consecutiveRejections} >= 0`),
]);

// `GET /internal/agent-api/events?ack=cursor`: the durable inbox seqs handed
// over by the agent's latest cursor-mode response and not yet acknowledged. The
// next cursor-mode request acknowledges those <= its `since`, so a lost response
// is delivered again instead of being acknowledged unseen.
export const agentInboxEventsPendingAcks = pgTable("agent_inbox_events_pending_acks", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  seqs: jsonb("seqs").$type<number[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Skipped rows of an external agent's inbox (services/agentInboxLateRows.ts).
// One record per acknowledged /events batch: per conversation the read
// position moved from `from` to `to`, the rows handed over in that range, and
// the pull's snapshot (pg_snapshot text, taken before it read any row). A row
// in (from, to] that snapshot could not see, and that was not handed over, was
// skipped; it is handed over late once it commits. Deleted once no transaction
// of that snapshot can still be in flight.
export const agentInboxSkipRecords = pgTable("agent_inbox_skip_records", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  snapshot: text("snapshot").notNull(),
  ranges: jsonb("ranges").$type<Array<{ conversationId: string; storageId: string; from: number; to: number; handed: number[] }>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // NOT DECLARED HERE ON PURPOSE: `recorded_xid xid8` (migration
  // 0596_agent_inbox_skip_records_recorded_xid), the writing transaction's id,
  // filled by its column default pg_current_xact_id(); NULL on records written
  // before it. Only the cleanup in services/agentInboxLateRows.ts reads it, by
  // raw SQL. drizzle has no xid8 column type, so the snapshots do not list it.
}, (t) => [
  index("idx_agent_inbox_skip_records_agent").on(t.agentId, t.createdAt),
]);

// Cursor mode: the late rows and snapshot of the batch an external agent has
// not acknowledged yet, and the cursor that batch was handed over with.
export const agentInboxLatePending = pgTable("agent_inbox_late_pending", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  snapshot: text("snapshot").notNull(),
  late: jsonb("late").$type<Array<{ recordId: string; conversationId: string; seq: number }>>().notNull(),
  cursor: bigint("cursor", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // AGENT_INBOX_LATE_MATCH_CAP: at most this many late rows per batch.
  check("agent_inbox_late_pending_late_cap", sql`jsonb_typeof(${t.late}) = 'array' AND jsonb_array_length(${t.late}) <= 100`),
]);

// Agent bootstrap tokens — single-use tokens minted by the web admin UI
// (`rfcs/034-slock-credential-rfc.zh.html#section-credential-model`) and
// exchanged at the gated `POST /api/agent/login` primitive for a long-lived
// `sk_agent_*` credential. #1836 keeps the model and primitive testable, but
// does not publish self-hosted-runner CLI onboarding.
//
// Out-of-scope for v0.8 (no separate `provisioning_mode` column needed):
//   - Internal-trusted rows (born-consumed audit only); the Computer-host
//     mint surface (`POST /internal/computer/runners/:agentId/credentials`)
//     mints directly without going through a bootstrap token row.
//   - External-host-login scope — that belongs to the separate
//     `xx/agent-login-v0` workstream (machine-credential issuance), not the
//     RFC v0.8 agent-runner scope.
//
// Exchange flow (RFC §9.1 step 1, §7 invariants):
//   1. SELECT row WHERE token_lookup_hash = HMAC(pepper, raw_token)
//      AND consumed_at IS NULL AND revoked_at IS NULL
//      AND ttl_expires_at > NOW()
//   2. argon2id verify on token_hash
//   3. mint a new agent_credentials row (apiKey returned once)
//   4. UPDATE consumed_at = NOW(), consumed_credential_id = <new>
//      with a WHERE consumed_at IS NULL guard so concurrent racers see
//      one 200 + one 410 token_consumed
//
// Soft revoke (`revoked_at` / `revoked_by_user_id` / `revoked_reason`):
// admins can void a token before exchange. Rows are NEVER deleted.
//
// Single-purpose: this table mints `sk_agent_*` credentials only. The
// `scope` column from the original `xx/agent-credential-v0` reference branch
// is dropped because v0.8's bootstrap_tokens contract has exactly one
// scope. A future `provisioning_mode` / `scope` axis can be added if the
// internal-trusted or external-host-login paths land later.
export const agentBootstrapTokens = pgTable("agent_bootstrap_tokens", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // HMAC-SHA-256(server_pepper, raw_token) as raw bytes. Deterministic and
  // unique — the row is located by this column at exchange time. The pepper
  // lives in `AGENT_BOOTSTRAP_TOKEN_PEPPER` env (required at boot).
  tokenLookupHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("token_lookup_hash").notNull().unique(),
  // argon2id of raw token. Constant-time secret verifier; only used AFTER
  // the row is located by tokenLookupHash.
  tokenHash: text("token_hash").notNull(),
  // First N chars of raw token for display in admin UI (e.g. "abtk_a1b2...").
  // Not identity — never used for lookup. The raw token itself is shown to
  // the issuer exactly once at mint time.
  tokenPrefix: text("token_prefix").notNull(),
  // Bound at issue time. The minted credential will reference this agent.
  targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // User who issued the token (audit trail; NOT used for ownership decisions
  // — those are evaluated at issue time against the agent row).
  issuedByUserId: uuid("issued_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The issuer's web (full) session family: copied onto the credential the
  // token is exchanged for, and a security revoke of that session revokes a
  // token not yet exchanged (webSessionIssuedKeys.ts). NULL for tokens issued
  // before this column or by a legacy token with no family.
  issuedByWebSessionFamilyId: uuid("issued_by_web_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  // MAX capability set baked into the minted credential. Stored on the
  // bootstrap row so the issuer's choice is preserved across exchange.
// v0.8 active enum: ['send','read','mentions','tasks','reactions','server','channels','knowledge'].
  scopes: text("scopes").array().notNull(),
  // Default TTL is 30 minutes per RFC §7; admin can override at issue time.
  ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
  // NULL until exchange completes successfully. Once set, the token is dead;
  // re-exchange returns 410 token_consumed.
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedCredentialId: uuid("consumed_credential_id"),
  consumedIp: text("consumed_ip"),
  consumedUserAgent: text("consumed_user_agent"),
  // Soft revoke; row stays for audit.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_bootstrap_tokens_agent").on(t.targetAgentId),
  index("idx_agent_bootstrap_tokens_server").on(t.serverId),
  // The web-session cascade's lookup by family, and the FK's ON DELETE SET NULL.
  index("idx_agent_bootstrap_tokens_issued_by_web_session_family").on(t.issuedByWebSessionFamilyId).where(sql`issued_by_web_session_family_id is not null`),
  // Hot-path exchange index: filters out consumed/revoked rows so the
  // exchange query never argon2-verifies against a dead token. drizzle-kit's
  // partial-index support is limited, so this is appended as raw SQL in the
  // migration alongside `idx_agent_credentials_prefix_active`.
]);

// Device-code authorization grants — task #30 PR-A2 (RFC v0.8 contract v3
// §3/§5/§9). The SHARED pre-credential login primitive behind the generic
// `/api/auth/device/*` surface, consumed by BOTH `raft-computer login` AND
// external-agent `slock-cli login`. Deliberately NOT named
// `computer_device_authorizations`: contract v3 §5 forbids a Computer-only
// shaped login path (it cited `computer_device_authorizations` only as an
// illustrative example); a generic name matches the locked shared-primitive
// + generic-namespace requirement. Device-code login is a pre-credential
// grant, NOT a Slock principal: it establishes a user identity/session that
// `attach` (sk_computer_*) or external-agent bootstrap later consumes
// under the proper principal/surface contract — it never mints sk_computer_*
// or sk_agent_* itself.
//
// Lifecycle model is intentionally aligned 1:1 with `agentBootstrapTokens`
// (RFC §9 binding): HMAC lookup-hash for O(1) location, argon2id secret
// verifier, single-consume, soft revoke / NEVER deleted (rows stay for
// audit), stable fail-closed errors, zero existence enumeration.
//
// Principal phases (contract v3 §3 — three distinct phases, NO new
// principal type):
//   POST /api/auth/device/authorize  — unauthenticated public, env/feature
//                                       gated; issues device_code + user_code
//   POST /api/auth/device/describe   — USER-authenticated, read only; what
//                                       the approval page shows, and the
//                                       approval ticket approve needs
//   POST /api/auth/device/approve    — USER-authenticated; binds
//                                       approvedByUserId
//   POST /api/auth/device/token      — unauthenticated public poll; on a
//                                       legitimately approved+unconsumed grant
//                                       issues the user session, single-consume
// These `/api/*` routes are OUT of `routeAuthPolicy` BY DESIGN (pre-credential
// `/api/*`, not claimed `/internal/*`) — documented intentional, not an omission.
export const deviceAuthorizations = pgTable("device_authorizations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // HMAC-SHA-256(server_pepper, raw_device_code) as raw bytes. Deterministic
  // + unique — the row is located by this at poll time. Pepper reuses the
  // existing bootstrap-token pepper env (same lifecycle model).
  deviceCodeLookupHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("device_code_lookup_hash").notNull().unique(),
  // argon2id of the raw device_code. Constant-time verifier; only used AFTER
  // the row is located by deviceCodeLookupHash.
  deviceCodeHash: text("device_code_hash").notNull(),
  // Short human-entered/-displayed code (e.g. "WXYZ-1234"). Unique so the
  // user-authenticated approve phase can locate the pending grant. Never a
  // secret verifier — the device_code is. Shown to the user exactly once.
  userCode: text("user_code").notNull().unique(),
  // pending | approved | denied | expired | consumed. Soft state; row is
  // NEVER deleted (audit). Hot-path poll rejects any non-approved/consumed.
  status: text("status").notNull().default("pending"),
  // Optional requesting-client label for audit ("raft-computer"/"slock-cli").
  // Not identity, not used for any decision.
  clientName: text("client_name"),
  // Set ONLY at the user-authenticated approve phase — the established user
  // identity the later session is issued for. NULL until approved.
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // device_code TTL (RFC-8628-style, default ~10min, set at authorize).
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Minimum client poll interval (seconds); slow_down may raise it.
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // The web session family that approved the login (POST
  // /api/auth/device/approve with a person's own full session). NULL until
  // approved, for approvals before this column, and for a token with no
  // family. Grants keep their own copy (device_login_grants.approver_session_family_id).
  // A code that asks for a device session (no grant) is polled only while
  // that sign-in is live, and a revoke of the family denies it
  // (sessionService.isApprovingSessionLive / denyLoginCodesApprovedBy); an
  // approved one with null is refused.
  approverFamilyId: uuid("approver_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  deniedAt: timestamp("denied_at", { withTimezone: true }),
  // NULL until the token phase issues the user session. Once set the grant
  // is dead; re-poll returns the consumed error. Single-consume guard.
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedSessionId: uuid("consumed_session_id"),
  // The session family the token phase issued, so a revoke link (below) can
  // sign that session out with every refresh it has rotated through.
  consumedSessionFamilyId: uuid("consumed_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  consumedIp: text("consumed_ip"),
  consumedUserAgent: text("consumed_user_agent"),
  // Soft revoke; row stays for audit.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  // Where the login was started from, shown on the approval page so a person
  // can tell a login they started from one someone else sent them. Kept for
  // security only, and cleared with the consumed_* fields 30 days after
  // created_at (scrubDeviceAuthorizationRequesterDetails, hourly maintenance).
  // The visitor's only when the CloudFront viewer headers are trusted
  // (lib/visitorOrigin.ts); otherwise NULL, and the page says so.
  requestedIp: text("requested_ip"),
  requestedLocation: text("requested_location"),
  // The User-Agent the authorize request came with (first 512 chars), for a
  // code that asks for a device session (no grant): which client binary asked.
  // A grant keeps its own (device_login_grants.requested_user_agent) and leaves
  // this NULL. The caller's claim, never used for a decision; cleared with the
  // fields above after 30 days.
  requestedUserAgent: text("requested_user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_device_authorizations_approved_by").on(t.approvedByUserId),
  index("idx_device_authorizations_expires_at").on(t.expiresAt),
  // The grant behind a session family (a device session's notices; the FK's
  // ON DELETE SET NULL when a family goes). Grants are never deleted.
  index("idx_device_authorizations_consumed_session_family").on(t.consumedSessionFamilyId),
  index("idx_device_authorizations_approver_family").on(t.approverFamilyId),
]);

// One-time "this wasn't me" links mailed about a device login: after its
// approval, and (with scoped device sessions) when that session mints an agent
// credential or attaches a computer. A link only revokes: before the token
// phase it cancels the grant (the poll gets access_denied); after it, it
// revokes the session family the grant issued. Used once, valid 24 hours;
// only the HMAC lookup hash of the raw `dvr_*` token is stored.
/** Why a revoke link was mailed: on approval, or (part C) a device session minting an agent credential / attaching a computer. */
export type DeviceLoginRevokeReason = "approved" | "agent_credential" | "computer_attach";

export const deviceAuthorizationRevokeTokens = pgTable("device_authorization_revoke_tokens", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deviceAuthorizationId: uuid("device_authorization_id").notNull().references(() => deviceAuthorizations.id, { onDelete: "cascade" }),
  tokenLookupHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("token_lookup_hash").notNull().unique(),
  reason: text("reason").$type<DeviceLoginRevokeReason>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_device_authorization_revoke_tokens_grant").on(t.deviceAuthorizationId),
]);

// One-time device-login grants (device-auth design v2 §3.1): a device login
// that asks for one thing instead of a session. A row is written with its
// device authorization when the client sends `grant` to /authorize; without
// it the login stays a device session (the legacy path, unchanged).
//   computer_attach — add machine X to server Y: approve picks the server, the
//                     token phase hands out a single-use `dvat_*` attach token
//                     (only its HMAC lookup hash is stored), and
//                     POST /api/computer/attach redeems it as the approver;
//                     the Computer row records this grant (key_issued_by_grant_id).
//   agent_key       — a key for agent Z: approve picks the agent, the token
//                     phase mints the `sk_agent_*` and returns it once.
//   computer_migrate — move this user's old Raft daemon on server Y over to a
//                     Computer (`raft-computer setup`'s legacy migration):
//                     approve picks the server, the token phase hands out a
//                     `dvmt_*` migrate token (lookup hash in the same column),
//                     which reads only the approver's own legacy-machine roster
//                     and adopts one legacy machine there: their own, or by
//                     its id another member's while they hold registerMachines
//                     (POST /api/computer/adopt-legacy consumes it); the
//                     Computer row records this grant (key_issued_by_grant_id).
// pending → approved (10 minutes to use it) → consumed; or denied / expired.
// Never deleted (audit): who asked (IP, location, user agent, cleared after
// 30 days with the device authorization's), who approved, for which server
// or agent, and what it issued.
export type DeviceLoginGrantKind = "computer_attach" | "computer_migrate" | "agent_key";
export type DeviceLoginGrantStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export const deviceLoginGrants = pgTable("device_login_grants", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  // No cascade: a grant is an audit record that per-Computer revoke follows
  // (computers.key_issued_by_grant_id), so deleting its authorization must fail.
  deviceAuthorizationId: uuid("device_authorization_id").notNull().unique().references(() => deviceAuthorizations.id),
  kind: text("kind").$type<DeviceLoginGrantKind>().notNull(),
  status: text("status").$type<DeviceLoginGrantStatus>().notNull().default("pending"),
  // What the requesting machine says about itself (sanitized, display only).
  machineName: text("machine_name"),
  hostname: text("hostname"),
  os: text("os"),
  // The agent the client asked for (agent_key): a hint the page may show,
  // never the selection. Not a foreign key: requester-chosen.
  requestedAgentId: uuid("requested_agent_id"),
  requestedUserAgent: text("requested_user_agent"),
  // Set at approve, from the person's explicit choice, permission checked.
  approverUserId: uuid("approver_user_id").references(() => users.id, { onDelete: "set null" }),
  // The web session family that approved it (POST /api/auth/device/approve),
  // so a security revoke of that session (a password change or reset, the
  // account's retirement, a device login's revoke link) also revokes what the
  // grant issued (approverSessionGrants.ts). A plain logout or expiry never
  // does. NULL for grants approved before this column and for a legacy token
  // with no family: those never cascade. SET NULL like the other family
  // pointers: a family row goes only with its user (ON DELETE CASCADE).
  approverSessionFamilyId: uuid("approver_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // 10 minutes after approval; NULL until then.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // computer_attach / computer_migrate: HMAC lookup hash of the `dvat_*` /
  // `dvmt_*` token the token phase handed out (once; the raw token is never
  // stored).
  attachTokenLookupHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("attach_token_lookup_hash").unique(),
  attachTokenIssuedAt: timestamp("attach_token_issued_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  // What it issued. Plain ids (audit pointers): computers references this
  // table, and a row here outlives what it points at.
  consumedComputerId: uuid("consumed_computer_id"),
  consumedAgentCredentialId: uuid("consumed_agent_credential_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The FKs' ON DELETE SET NULL.
  index("idx_device_login_grants_approver").on(t.approverUserId),
  // The cascade's lookup by family, and the FK's ON DELETE SET NULL.
  index("idx_device_login_grants_approver_session_family").on(t.approverSessionFamilyId),
  index("idx_device_login_grants_server").on(t.serverId),
  index("idx_device_login_grants_agent").on(t.agentId),
]);

// Computer host attachments — `sk_computer_*` runtime principals
// (`rfcs/034-slock-credential-rfc.zh.html#section-credential-model`).
//
// Slice-1 minimal stub: just enough surface area to authenticate the
// Computer-host that calls `POST /internal/computer/runners/:agentId/credentials`
// (Computer RFC §9.1 step 2 — Computer-requested runner credential mint).
//
// Tao's Phase 1 work owns the canonical Computer attachment lifecycle
// (attach/detach UX flow, ScopeDB triple-sink, credential-replace path on
// re-attach). Slice-1 reconciles with that shape when Phase 1 lands —
// expect column additions (host_machine_id FK, attach_token_id reference,
// last_seen_at observability) but the core (id, server_id, api_key_hash,
// api_key_prefix, revoked_at) is contract-stable.
//
// Auth flow (see `requireComputerAuth` middleware, RFC §6.2):
//   1. Computer host presents `Authorization: Bearer sk_computer_*`
//   2. middleware extracts `api_key_prefix`
//      → SELECT row WHERE prefix = ? AND revoked_at IS NULL
//        (served by partial index `idx_computers_prefix_active`)
//   3. argon2id verify on `api_key_hash`
//   4. on success: `req.computerId = row.id`,
//      `req.principalKind = 'computer'`,
//      `req.serverId = row.serverId`
//
// v0 active surface (route allowlist via `routeAuthPolicy` registry):
//   POST   /internal/computer/runners/:agentId/credentials  — runner mint
//
// Cross-principal rejection (RFC §5.6): an `sk_computer_*` key presented
// at any non-`/internal/computer/*` path returns 401 `invalid_principal`.
// Reciprocal on `/internal/computer/*` for sk_machine_*/sk_agent_*.
//
// Soft revoke (`revoked_at` / `revoked_by_user_id` / `revoked_reason`):
// rows are NEVER deleted; revoked rows stay for audit and are skipped at
// auth time by the partial index.
export const computers = pgTable("computers", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Human-readable display label (e.g. "Maria-laptop"). Not identity proof;
  // attach never resumes or rotates an existing Computer by name.
  name: text("name").notNull(),
  // argon2id of the raw `sk_computer_*` key. Returned exactly once at
  // attach time; never persisted in raw form.
  apiKeyHash: text("api_key_hash").notNull(),
  // First N chars of raw key for O(1) lookup at auth time.
  apiKeyPrefix: text("api_key_prefix").notNull(),
  // HMAC-SHA-256(AGENT_API_KEY_HMAC_SECRET, raw key) as raw bytes: the fast
  // verifier, same scheme and secret as `agent_credentials.api_key_hmac`.
  // When set (and the secret is configured) auth compares it in constant time
  // and skips argon2. NULL on rows from before it existed or while the secret
  // is unset; those verify with argon2 and backfill it. Written together with
  // `apiKeyHash` on every mint/rotation. Not a lookup key, so no index.
  apiKeyHmac: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("api_key_hmac"),
  // User who attached the Computer (audit trail). May be null for
  // future device-code / bootstrap-token attachment flows.
  attachedByUserId: uuid("attached_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // The session family of a device login (scope `device`) holding this
  // Computer's current key (it attached it, or adopted it into this row), so
  // the key is revoked with that session, however the session is revoked
  // (deviceSessionKeys.ts). NULL otherwise.
  keyIssuedBySessionFamilyId: uuid("key_issued_by_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  // The one-time device-login grant (computer_attach, or computer_migrate for
  // an adopted legacy machine) whose token issued this Computer's key; key_issued_by_session_family_id stays NULL
  // then. NULL for every other attach. Grants are never deleted.
  keyIssuedByGrantId: uuid("key_issued_by_grant_id").references(() => deviceLoginGrants.id, { onDelete: "set null" }),
  // The person's web (full) session family holding this Computer's current
  // key (POST /api/computer/attach or adopt-legacy with that session), so a
  // security revoke of that session (a password change or reset, the
  // account's retirement) revokes the key (webSessionIssuedKeys.ts). A plain
  // logout never does. NULL otherwise. Distinct from
  // key_issued_by_session_family_id, which follows any revoke.
  keyIssuedByWebSessionFamilyId: uuid("key_issued_by_web_session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Last-use observability triple (best-effort).
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  lastUsedUserAgent: text("last_used_user_agent"),
  // Soft revoke; row stays for audit.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  // task #30 PR-F — the `machines` (daemons) row this Computer presents
  // as to the orchestrator. A Computer attaching connects /daemon/connect
  // with its sk_computer_*; the gate resolves Computer → this linked
  // machine and hands the EXISTING machine object to the unchanged
  // WS/orchestrator path (no orchestrator fork, no agent-table change —
  // agents bind to a Computer via the normal agents.machineId = this id).
  // Nullable: backfilled lazily on attach; rows predating PR-F have none.
  machineId: uuid("machine_id").references(() => machines.id, { onDelete: "set null" }),
}, (t) => [
  index("idx_computers_prefix").on(t.apiKeyPrefix),
  index("idx_computers_server").on(t.serverId),
  index("idx_computers_key_issued_by_session_family").on(t.keyIssuedBySessionFamilyId).where(sql`key_issued_by_session_family_id is not null`),
  index("idx_computers_key_issued_by_web_session_family").on(t.keyIssuedByWebSessionFamilyId).where(sql`key_issued_by_web_session_family_id is not null`),
  // Partial index `idx_computers_prefix_active` is appended to the
  // canonical migration as raw SQL — see drizzle migration `0074_*`.
]);

// One-time "this wasn't me" links for ONE Computer (device-auth design v2
// §3.1 step 6), mailed to the person whose one-time grant added it ("You added
// X to Y"). A link only revokes: that Computer's key, every runner credential
// its machine minted, and their connections (computerKeyRevocation.ts); the
// person's other Computers and sessions are untouched. Used once, valid 24
// hours, and only by a click on the page it opens (never by loading it); only
// the HMAC lookup hash of the raw `dvcr_*` token is stored.
export const computerRevokeTokens = pgTable("computer_revoke_tokens", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  computerId: uuid("computer_id").notNull().references(() => computers.id, { onDelete: "cascade" }),
  // The grant whose use the email reported (audit pointer; grants are never deleted).
  deviceLoginGrantId: uuid("device_login_grant_id").references(() => deviceLoginGrants.id, { onDelete: "set null" }),
  tokenLookupHash: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("token_lookup_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The computers FK's ON DELETE CASCADE (a deleted server takes its Computers).
  index("idx_computer_revoke_tokens_computer").on(t.computerId),
]);

// Durable, receiver-independent attention caused by an authoritative runtime
// account usage snapshot. The account key is already a one-way SHA-256 value;
// no provider label, raw response, or error text is retained here.
export const systemAttentionIncidents = pgTable("system_attention_incidents", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  machineId: uuid("machine_id").notNull().references(() => machines.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["usage_limit_reached"] }).notNull(),
  provider: text("provider", { enum: ["claude", "codex", "kimi", "grok", "antigravity"] }).notNull(),
  accountKeyHash: text("account_key_hash").notNull(),
  windowKey: text("window_key").notNull(),
  activationGeneration: integer("activation_generation").notNull(),
  state: text("state", { enum: ["active", "resolved"] }).notNull().default("active"),
  affectedAgentIds: jsonb("affected_agent_ids").$type<string[]>().notNull().default([]),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_system_attention_incidents_generation")
    .on(t.serverId, t.machineId, t.kind, t.provider, t.accountKeyHash, t.windowKey, t.activationGeneration),
  uniqueIndex("idx_system_attention_incidents_active_identity")
    .on(t.serverId, t.machineId, t.kind, t.provider, t.accountKeyHash, t.windowKey)
    .where(sql`${t.state} = 'active'`),
  index("idx_system_attention_incidents_server_state").on(t.serverId, t.state, t.activatedAt),
  check("system_attention_incidents_generation_positive", sql`${t.activationGeneration} > 0`),
  check("system_attention_incidents_account_key_hash", sql`${t.accountKeyHash} ~ '^[0-9a-f]{64}$'`),
  check("system_attention_incidents_window_key", sql`length(btrim(${t.windowKey})) BETWEEN 1 AND 64`),
  check(
    "system_attention_incidents_state_shape",
    sql`(${t.state} = 'active' AND ${t.resolvedAt} IS NULL)
      OR (${t.state} = 'resolved' AND ${t.resolvedAt} IS NOT NULL)`,
  ),
]);

// Seen/dismissed state belongs to each current receiver, so opening or
// dismissing on one device is immediately reflected on every other device.
export const systemAttentionReceipts = pgTable("system_attention_receipts", {
  incidentId: uuid("incident_id").notNull()
    .references(() => systemAttentionIncidents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  seenAt: timestamp("seen_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.incidentId, t.userId] }),
  index("idx_system_attention_receipts_user").on(t.userId, t.updatedAt),
  check(
    "system_attention_receipts_dismiss_implies_seen",
    sql`${t.dismissedAt} IS NULL OR ${t.seenAt} IS NOT NULL`,
  ),
]);

export const computerOutageOccurrences = pgTable("computer_outage_occurrences", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  computerId: uuid("computer_id").notNull().references(() => computers.id, { onDelete: "cascade" }),
  machineId: uuid("machine_id").notNull().references(() => machines.id, { onDelete: "cascade" }),
  connectionEpochId: text("connection_epoch_id").notNull(),
  state: text("state", { enum: ["pending", "notified", "recovered", "suppressed"] }).notNull().default("pending"),
  offlineEventId: uuid("offline_event_id").notNull().$defaultFn(() => randomUUID()),
  onlineEventId: uuid("online_event_id").notNull().$defaultFn(() => randomUUID()),
  firstOfflineAt: timestamp("first_offline_at", { withTimezone: true }).notNull(),
  notifyAfter: timestamp("notify_after", { withTimezone: true }).notNull(),
  offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  suppressReason: text("suppress_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_computer_outage_occurrences_epoch").on(t.serverId, t.machineId, t.connectionEpochId),
  uniqueIndex("idx_computer_outage_occurrences_open_machine").on(t.serverId, t.machineId)
    .where(sql`${t.state} IN ('pending', 'notified')`),
  uniqueIndex("idx_computer_outage_occurrences_offline_event").on(t.offlineEventId),
  uniqueIndex("idx_computer_outage_occurrences_online_event").on(t.onlineEventId),
  index("idx_computer_outage_occurrences_due").on(t.state, t.notifyAfter),
  index("idx_computer_outage_occurrences_computer").on(t.computerId, t.createdAt),
  // ON DELETE CASCADE from daemons (the (server_id, machine_id) indexes do not serve machine_id alone).
  index("idx_computer_outage_occurrences_machine").on(t.machineId),
  check("computer_outage_occurrences_state_check", sql`${t.state} IN ('pending', 'notified', 'recovered', 'suppressed')`),
]);

// User-requested Computer lifecycle operations. The user-authenticated intent
// is durable before local process mutation begins; a machine ready/shutdown
// acknowledgement completes the exact operation later. Activity projection is
// keyed by operation id, so replayed acknowledgements remain idempotent.
export const computerLifecycleOperations = pgTable("computer_lifecycle_operations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  parentOperationId: uuid("parent_operation_id"),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Snapshot identifiers intentionally outlive Computer/machine deletion.
  computerId: uuid("computer_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  action: text("action", { enum: ["start", "stop", "restart", "upgrade"] }).notNull(),
  // user_action: a person, named by actorUserId. machine_local: the machine's
  // own `raft-computer start|stop|restart`, recorded by its key; no person
  // (actorUserId null). Text, no check constraint: adding a value needs no migration.
  cause: text("cause", { enum: ["user_action", "machine_local"] }).notNull().default("user_action"),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "completed", "failed", "unconfirmed", "superseded", "rolled_back"] }).notNull().default("pending"),
  dispatchMode: text("dispatch_mode", { enum: ["local", "server"] }).notNull(),
  dispatchStatus: text("dispatch_status", { enum: ["pending", "sent"] }).notNull().default("pending"),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  dispatchLeaseAt: timestamp("dispatch_lease_at", { withTimezone: true }),
  commandSentAt: timestamp("command_sent_at", { withTimezone: true }),
  targetVersion: text("target_version"),
  // Exact source-aware broadcast decision frozen before any upgrade dispatch.
  // This is audit/receipt evidence, never a mutable policy cache.
  broadcastPolicyDecision: jsonb("broadcast_policy_decision").$type<Record<string, unknown>>(),
  connectionEpochBefore: text("connection_epoch_before"),
  shutdownAckAt: timestamp("shutdown_ack_at", { withTimezone: true }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  readyAckAt: timestamp("ready_ack_at", { withTimezone: true }),
  readyConnectionEpoch: text("ready_connection_epoch"),
  loadedComputerVersion: text("loaded_computer_version"),
  shutdownDeadlineAt: timestamp("shutdown_deadline_at", { withTimezone: true }),
  readyDeadlineAt: timestamp("ready_deadline_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
}, (t) => [
  index("idx_computer_lifecycle_operations_machine_status").on(t.machineId, t.status),
  index("idx_computer_lifecycle_operations_actor").on(t.actorUserId),
  // A Computer can execute only one user intent for a Server at a time,
  // regardless of whether that intent is Restart or Upgrade. terminalAt is
  // the durable slot-release fence; route-level pre-checks are advisory only.
  uniqueIndex("idx_computer_lifecycle_operations_one_pending_machine")
    .on(t.serverId, t.machineId)
    .where(sql`terminal_at IS NULL AND parent_operation_id IS NULL`),
  uniqueIndex("idx_computer_lifecycle_operations_parent_scope").on(t.parentOperationId, t.serverId, t.machineId, t.action),
]);

// Machine acknowledgements and progress are correlated to dispatch identity,
// never directly to the user-visible lifecycle operation. This one-to-one
// child keeps wire action (for example Upgrade) independent from the parent
// user action (for example Restart) so a raw Upgrade acknowledgement cannot
// accidentally complete a Restart intent.
export const computerLifecycleDispatches = pgTable("computer_lifecycle_dispatches", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  parentOperationId: uuid("parent_operation_id").notNull()
    .references(() => computerLifecycleOperations.id, { onDelete: "cascade" }),
  dispatchAction: text("dispatch_action", { enum: ["restart", "upgrade"] }).notNull(),
  targetVersion: text("target_version").notNull(),
  adapter: text("adapter").notNull(),
  originServerId: uuid("origin_server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Snapshot identity deliberately has no machine FK so terminal evidence can
  // outlive Computer detachment/deletion together with its parent operation.
  machineId: uuid("machine_id").notNull(),
  phase: text("phase", { enum: [
    "accepted",
    "mutation_claimed",
    "first_hop_observed",
    "handoff_arming",
    "handoff_armed",
    "old_service_stop_claimed",
    "old_service_dead",
    "target_supervisor_live",
    "managed_set_converged",
    "terminal_outbox",
    "receipt_observed",
    "finalized",
  ] }).notNull().default("accepted"),
  phaseVersion: integer("phase_version").notNull().default(0),
  phaseDeadlineAt: timestamp("phase_deadline_at", { withTimezone: true }).notNull(),
  firstHopProgressOrdinal: integer("first_hop_progress_ordinal").notNull().default(0),
  lastValidEvidenceAt: timestamp("last_valid_evidence_at", { withTimezone: true }).notNull().defaultNow(),
  observedSourceEpoch: text("observed_source_epoch"),
  observedTargetGeneration: text("observed_target_generation"),
  currentManagedSetRevision: text("current_managed_set_revision"),
  terminalEvidence: jsonb("terminal_evidence").$type<Record<string, unknown>>(),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_computer_lifecycle_dispatches_parent").on(t.parentOperationId),
  index("idx_computer_lifecycle_dispatches_machine_phase").on(t.machineId, t.phase),
  index("idx_computer_lifecycle_dispatches_deadline").on(t.phaseDeadlineAt),
]);

export const computerLifecycleOperationTargets = pgTable("computer_lifecycle_operation_targets", {
  operationId: uuid("operation_id").notNull().references(() => computerLifecycleOperations.id, { onDelete: "cascade" }),
  // Deliberately no FK: intent-time projection membership must survive an
  // agent deletion/move so terminal projection can record a bounded skip.
  agentId: uuid("agent_id").notNull(),
  machineIdAtIntent: uuid("machine_id_at_intent").notNull(),
  projectionStatus: text("projection_status", { enum: ["pending", "projected", "skipped"] }).notNull().default("pending"),
  projectionSkipReason: text("projection_skip_reason", { enum: ["target_missing", "no_longer_member"] }),
  projectedAt: timestamp("projected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.operationId, t.agentId] }),
  index("idx_computer_lifecycle_operation_targets_machine").on(t.machineIdAtIntent),
]);

// Remote upgrade v2 (task #873): one request row per web-triggered upgrade.
// The only observation is the version the machine reports on its next
// reconnect; the installer guarantees success-or-rollback, so nothing in
// between is modelled here.
export const computerUpgradeRequests = pgTable("computer_upgrade_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  machineId: uuid("machine_id").notNull(),
  targetVersion: text("target_version").notNull(),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  // No DB check on the values (text): adding one needs no migration.
  // `succeeded_late`: the target version connected only after the deadline
  // (computerUpgradeRequestService settleLateComputerUpgradeRequest).
  outcome: text("outcome", { enum: ["done", "failed", "no_response", "succeeded_late"] }),
  observedVersion: text("observed_version"),
  reason: text("reason"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  index("idx_computer_upgrade_requests_machine_outcome").on(t.machineId, t.outcome),
  index("idx_computer_upgrade_requests_deadline").on(t.deadlineAt),
]);

// Server-managed MCP control plane. Credentials are split from public catalog
// metadata so every read surface can remain secret-free by construction.
// Raft-recommended MCP Apps (task #30). Platform-owned catalog: the admin worker
// (slock-internal-app-admin) maintains rows; the server reads `active` rows for
// GET /api/mcp/app-templates and seeds from config/mcpAppTemplates.json on
// migration. Retired templates stay so existing Apps keep their templateKey.
export const mcpAppTemplates = pgTable("mcp_app_templates", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  logoUrl: text("logo_url"),
  category: text("category").notNull(),
  endpointUrl: text("endpoint_url").notNull(),
  authKind: text("auth_kind", { enum: ["none", "headers", "oauth"] }).notNull(),
  // How an OAuth Connection gets its client: "automatic" registration only, a user-"registered"
  // client only, or "either" (the default, and the behavior before this column existed).
  oauthClientMode: text("oauth_client_mode", { enum: ["automatic", "registered", "either"] }).notNull().default("either"),
  status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_mcp_app_templates_status").on(t.status),
  check("mcp_app_templates_status_valid", sql`${t.status} IN ('active', 'retired')`),
  check("mcp_app_templates_auth_kind_valid", sql`${t.authKind} IN ('none', 'headers', 'oauth')`),
  check("mcp_app_templates_oauth_client_mode_valid", sql`${t.oauthClientMode} IN ('automatic', 'registered', 'either')`),
  check("mcp_app_templates_revision_positive", sql`${t.revision} > 0`),
  check("mcp_app_templates_key_valid", sql`${t.key} ~ '^[a-z][a-z0-9-]{0,62}$'`),
  check("mcp_app_templates_name_valid", sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
  check("mcp_app_templates_description_valid", sql`length(btrim(${t.description})) BETWEEN 1 AND 500`),
  check("mcp_app_templates_homepage_https", sql`${t.homepageUrl} ~ '^https://'`),
  check("mcp_app_templates_endpoint_https", sql`${t.endpointUrl} ~ '^https://'`),
  check("mcp_app_templates_logo_https_or_null", sql`${t.logoUrl} IS NULL OR ${t.logoUrl} ~ '^https://'`),
]);

export const managedMcpServers = pgTable("managed_mcp_servers", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  provider: text("provider", { enum: ["notion", "linear", "custom"] }).notNull().default("custom"),
  authMode: text("auth_mode", { enum: ["oauth", "headers", "none"] }).notNull().default("none"),
  oauthStatus: text("oauth_status", { enum: ["disconnected", "pending", "connected", "error"] }).notNull().default("disconnected"),
  transport: text("transport", { enum: ["streamable_http"] }).notNull().default("streamable_http"),
  endpointUrl: text("endpoint_url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  configVersion: integer("config_version").notNull().default(1),
  catalogVersion: integer("catalog_version").notNull().default(0),
  toolCatalog: jsonb("tool_catalog").$type<ManagedMcpToolCatalogEntry[]>().notNull().default([]),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastCheckError: text("last_check_error"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // App profile and provenance (0408). All nullable with no default, so the migration is
  // metadata-only and an older binary writing this table during a rolling deploy is unaffected.
  // A NULL `sourceKind` is a row that predates MCP Apps: read it as `template` when `provider`
  // names a recommended app and as `url` otherwise.
  sourceKind: text("source_kind", { enum: ["url", "template"] }),
  // Key of the Raft-recommended app this was created from (`notion`, `linear`, ...). Its endpoint
  // and auth kind belong to Raft and are not editable on the App.
  templateKey: text("template_key"),
  homepageUrl: text("homepage_url"),
  logoUrl: text("logo_url"),
  logoStorageKey: text("logo_storage_key"),
  // Same vocabulary as `oauth_clients.category`; validated in the service, not pinned here, so
  // the two lists cannot drift apart through a migration that only touched one of them.
  category: text("category"),
  whenToUse: text("when_to_use"),
  // The API-key header NAMES this App's Connections must supply, as a complete set. Values are
  // never stored here; they live encrypted on the Connection.
  requiredHeaderNames: jsonb("required_header_names").$type<string[]>(),
  // Secret-free results of the last endpoint probe and MCP `initialize`.
  authProbe: jsonb("auth_probe").$type<{ issuer: string | null; registration: "dcr" | "cimd" | "manual_required" | null; scopes: string[] }>(),
  serverInfo: jsonb("server_info").$type<{ protocolVersion: string; name?: string; version?: string }>(),
  lastLatencyMs: integer("last_latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_managed_mcp_servers_server_name").on(t.serverId, t.name),
  index("idx_managed_mcp_servers_server").on(t.serverId),
  check("managed_mcp_servers_source_kind_valid", sql`${t.sourceKind} IS NULL OR ${t.sourceKind} IN ('url', 'template')`),
  check(
    "managed_mcp_servers_when_to_use_valid",
    sql`${t.whenToUse} IS NULL OR (length(${t.whenToUse}) <= 160 AND ${t.whenToUse} !~ '[\\x00-\\x1F\\x7F]')`,
  ),
]);

export const managedMcpCredentials = pgTable("managed_mcp_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  mcpServerId: uuid("mcp_server_id").notNull().references(() => managedMcpServers.id, { onDelete: "cascade" }),
  encryptedHeaders: text("encrypted_headers"),
  encryptedOAuth: text("encrypted_oauth"),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  // A credential row IS an MCP App Connection (0409). An App can have several; each Agent uses the
  // App's server default unless it is granted a specific Connection (managed_mcp_assignments).
  //
  // DEFAULT true is deliberate for the rolling deploy: every pre-existing credential becomes its
  // App's default with no UPDATE, so behaviour is unchanged, and a row an older binary inserts
  // during the deploy gets the same meaning it has today. New code never relies on the default;
  // it always writes this column explicitly.
  isServerDefault: boolean("is_server_default").notNull().default(true),
  name: text("name"),
  // NULL means "derive from managed_mcp_servers.auth_mode" (rows older than 0409).
  authKind: text("auth_kind", { enum: ["headers", "oauth"] }),
  authStatus: text("auth_status", { enum: ["ready", "pending", "needs_auth", "expired", "error"] }).notNull().default("ready"),
  // A display label from the provider (e.g. a workspace name). Never a token.
  accountLabel: text("account_label"),
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  credentialVersion: integer("credential_version").notNull().default(1),
  // The App endpoint this Connection's secret was authorized (OAuth) or validated (API key) against
  // (0412). A fence, checked by admission and before any OAuth refresh: an OAuth Connection is usable
  // only while the App still points at exactly this URL, an API-key Connection only while it points
  // at the same origin. NULL means the row predates the column (or an older binary wrote it) and is
  // trusted as before.
  authorizedEndpointUrl: text("authorized_endpoint_url"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one server default per App. Several Connections per App are allowed (0409 dropped the
  // old one-credential-per-MCP unique index).
  uniqueIndex("idx_managed_mcp_credentials_default")
    .on(t.mcpServerId)
    .where(sql`${t.isServerDefault}`),
  index("idx_managed_mcp_credentials_mcp_server").on(t.mcpServerId),
  index("idx_managed_mcp_credentials_scope").on(t.serverId),
]);

export const managedMcpOAuthAttempts = pgTable("managed_mcp_oauth_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  mcpServerId: uuid("mcp_server_id").notNull().references(() => managedMcpServers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  configVersion: integer("config_version").notNull(),
  stateHash: text("state_hash").notNull(),
  status: text("status", { enum: ["pending", "consumed", "failed"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  // The Connection this sign-in authorizes (0409). NULL for an attempt an older binary started:
  // the callback then resolves the App's single Connection, as that binary assumed.
  connectionId: uuid("connection_id").references(() => managedMcpCredentials.id, { onDelete: "cascade" }),
  // Secret-free context to apply after a successful sign-in, e.g. the Agent or action card it came
  // from and whether to make the Connection the server default.
  intent: jsonb("intent").$type<{ agentId?: string; actionCardMessageId?: string; makeDefault?: boolean; name?: string }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_managed_mcp_oauth_attempts_mcp_server").on(t.mcpServerId),
  uniqueIndex("idx_managed_mcp_oauth_attempts_state").on(t.stateHash),
  index("idx_managed_mcp_oauth_attempts_connection").on(t.connectionId),
  index("idx_managed_mcp_oauth_attempts_expiry").on(t.expiresAt),
  index("idx_managed_mcp_oauth_attempts_server").on(t.serverId, t.mcpServerId),
]);

export const managedMcpAssignments = pgTable("managed_mcp_assignments", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  mcpServerId: uuid("mcp_server_id").notNull().references(() => managedMcpServers.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  allowedTools: jsonb("allowed_tools").$type<string[]>(),
  assignmentVersion: integer("assignment_version").notNull().default(1),
  // Which Connection this Agent uses (0410). `default` follows the App's server default; `pinned`
  // uses `boundConnectionId`. "Off" is `enabled = false`, the column older binaries already honour.
  // A pinned row whose Connection was deleted (FK SET NULL) is denied, never sent to the default.
  connectionMode: text("connection_mode", { enum: ["default", "pinned"] }).notNull().default("default"),
  boundConnectionId: uuid("bound_connection_id").references(() => managedMcpCredentials.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_managed_mcp_assignments_bound_connection").on(t.boundConnectionId).where(sql`bound_connection_id IS NOT NULL`),
  primaryKey({ columns: [t.agentId, t.mcpServerId] }),
  index("idx_managed_mcp_assignments_server_agent").on(t.serverId, t.agentId),
  index("idx_managed_mcp_assignments_mcp_server").on(t.mcpServerId),
  check(
    "managed_mcp_assignments_binding_matches_mode",
    sql`${t.connectionMode} = 'pinned' OR ${t.boundConnectionId} IS NULL`,
  ),
]);

// Reusable, server-scoped AI provider connections. Public reads come only
// from providerConnections; the API key remains isolated in the credential
// table and is materialized only for an exact Agent launch.
export const providerConnections = pgTable("provider_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  providerId: text("provider_id").$type<ProviderConnectionProviderId>().notNull(),
  authMethod: text("auth_method", { enum: ["api_key", "oauth"] }).notNull().default("api_key"),
  endpointUrl: text("endpoint_url"),
  supportsImageInput: boolean("supports_image_input").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status", { enum: ["unchecked", "ready", "error", "pending_auth", "expired"] }).notNull().default("unchecked"),
  configVersion: integer("config_version").notNull().default(1),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastErrorCategory: text("last_error_category"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_provider_connections_server_name").on(t.serverId, t.name),
  index("idx_provider_connections_server").on(t.serverId),
]);

export const providerConnectionCredentials = pgTable("provider_connection_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => providerConnections.id, { onDelete: "cascade" }),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  credentialVersion: integer("credential_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_provider_connection_credentials_connection").on(t.connectionId),
  index("idx_provider_connection_credentials_scope").on(t.serverId),
]);

export const agentProviderConnections = pgTable("agent_provider_connections", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => providerConnections.id, { onDelete: "restrict" }),
  expectedConfigVersion: integer("expected_config_version").notNull(),
  expectedCredentialVersion: integer("expected_credential_version").notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_provider_connections_server").on(t.serverId),
  index("idx_agent_provider_connections_connection").on(t.connectionId),
]);

// One provisioning record per Agent created on a hosted runtime provider.
// It is the worker's outbox row (single executor per Agent via the lease
// columns) and, after the Agent is deleted, the tombstone kept until the
// provider confirms the DELETE. `encrypted_credential` holds the Agent's raw
// sk_agent key only until the provider accepted it (needed for identical
// POST retries); it is nulled on success and on delete.
/**
 * RFC 077: the owner's notes for their assistant, sent after Raft's fixed
 * assistant instructions. Only the owner reads or writes them. A table of its
 * own, not a column on `agents`, so no agent read or broadcast can carry them
 * to other members (the profile description stays public display text).
 */
export const assistantOwnerNotes = pgTable("assistant_owner_notes", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  notes: text("notes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuntimeProvisions = pgTable("agent_runtime_provisions", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["antiproton"] }).notNull(),
  // Frozen at creation: a canary provision never falls back to the official provider.
  providerTarget: text("provider_target", { enum: ["default", "canary"] }).notNull().default("default"),
  state: text("state", { enum: ["provisioning", "active", "failed", "deleting", "deleted"] }).notNull(),
  providerAgentId: text("provider_agent_id"),
  credentialId: uuid("credential_id").references(() => agentCredentials.id, { onDelete: "set null" }),
  encryptedCredential: text("encrypted_credential"),
  // The frozen POST body: a retried POST must be byte-identical (the provider
  // answers 409 to a changed body under the same Idempotency-Key).
  provisionedName: text("provisioned_name").notNull(),
  provisionedInstructions: text("provisioned_instructions").notNull(),
  // The version of Raft's assistant instructions (ASSISTANT_INSTRUCTIONS_VERSION)
  // the provider last received, or null when Raft's instructions were not sent
  // (not an assistant). A live assistant
  // behind the current version gets a PATCH from the worker.
  instructionsVersion: text("instructions_version"),
  // The model the creator picked, sent as `model` on the POST; null = the
  // provider's default (the field is left out). Only a retry after the
  // provider refused the model (422 unknown_model / 409 model_locked) changes it.
  provisionedModel: text("provisioned_model"),
  provisionedProfile: text("provisioned_profile", { enum: ["raftbench_service"] }),
  desiredRevision: integer("desired_revision").notNull().default(0),
  syncedRevision: integer("synced_revision").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseGeneration: integer("lease_generation").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorHttpStatus: integer("last_error_http_status"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  pushRegistered: boolean("push_registered"),
  pushError: text("push_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Workspace import after create (hosted Cindy's seed files, a computer
  // agent's migrated workspace). Set at create; the row is then POSTed with
  // `awaitImport: true` and, once active, imported exactly once. Import
  // errors are kept apart from the POST's: a failed import never re-POSTs.
  importSource: text("import_source"),
  importRef: text("import_ref"),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  importFailedAt: timestamp("import_failed_at", { withTimezone: true }),
  importErrorCode: text("import_error_code"),
  importErrorMessage: text("import_error_message"),
  importErrorHttpStatus: integer("import_error_http_status"),
  importErrorAt: timestamp("import_error_at", { withTimezone: true }),
  // A hosted Cindy that failed or timed out during setup gets one automatic
  // retry; this records it, so the second failure falls back to a computer.
  setupRetryAt: timestamp("setup_retry_at", { withTimezone: true }),
  /** How that retry ended: ok (she became ready) or failed (the fallback is next). */
  setupRetryOutcome: text("setup_retry_outcome", { enum: ["ok", "failed"] }),
}, (t) => [
  check("agent_runtime_provisions_target_check", sql`${t.providerTarget} IN ('default', 'canary')`),
  check("agent_runtime_provisions_canary_profile_check", sql`${t.providerTarget} = 'default' OR ${t.provisionedProfile} IS NOT DISTINCT FROM 'raftbench_service'`),
  index("idx_agent_runtime_provisions_server").on(t.serverId),
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_fk_indexes; built CONCURRENTLY on a large table by
  // db:create-device-session-key-indexes).
  index("idx_agent_runtime_provisions_credential").on(t.credentialId).where(sql`credential_id IS NOT NULL`),
  index("idx_agent_runtime_provisions_due").on(t.nextAttemptAt)
    .where(sql`state IN ('provisioning', 'deleting') OR (state = 'active' AND (desired_revision > synced_revision OR (import_source IS NOT NULL AND imported_at IS NULL AND import_failed_at IS NULL)))`),
]);

// antiproton held-call approvals (docs/contracts/hosted-agent-approvals.md): one
// row per hold of a hosted agent, as antiproton last reported it. antiproton
// is the source of truth; Raft keeps what its cards show and the state they
// show, which only moves forward. `item` is the display fields as parsed
// (agentRuntimeApprovalItem.ts: plain text, bounded); the Raft user id and
// console sign-in behind a decision are never kept, only the role.
export const agentRuntimeApprovals = pgTable("agent_runtime_approvals", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // The agent's provision target when the hold was first seen; holds are read and decided there.
  providerTarget: text("provider_target", { enum: ["default", "canary"] }).notNull(),
  operationId: text("operation_id").notNull(),
  status: text("status", { enum: ["pending", "approved", "executed", "failed", "denied", "expired", "unavailable"] }).notNull(),
  item: jsonb("item").$type<AgentRuntimeApprovalItem>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: jsonb("decided_by").$type<AgentCallApprovalDecidedBy>(),
  // The provider-wide list's `updatedAt` for this row, when it came from there.
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  // Delivery, which only Raft knows (reported to antiproton: the contract's
  // "Delivery reports"). `first_card_at`: when the hold's first card was
  // posted, set once in that card's transaction and never changed (card rows
  // go with their messages; this stays). `no_recipient_at`: when Raft found
  // nobody it could send a pending hold's card to, set once and only while
  // no card was ever posted. `delivery_reported_at` / `delivery_report_result`:
  // antiproton's final answer to the report of the outcome these two give
  // (delivered wins); null while one is owed (the reconcile resends it).
  firstCardAt: timestamp("first_card_at", { withTimezone: true }),
  noRecipientAt: timestamp("no_recipient_at", { withTimezone: true }),
  deliveryReportedAt: timestamp("delivery_reported_at", { withTimezone: true }),
  deliveryReportResult: text("delivery_report_result", { enum: ["accepted", "not_found", "not_pending"] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agent_runtime_approvals_operation").on(t.agentId, t.operationId),
  index("idx_agent_runtime_approvals_server").on(t.serverId),
  // The reconcile's local pass: pending holds, soonest deadline first.
  index("idx_agent_runtime_approvals_pending").on(t.expiresAt).where(sql`status = 'pending'`),
  check("agent_runtime_approvals_status_check", sql`${t.status} IN ('pending', 'approved', 'executed', 'failed', 'denied', 'expired', 'unavailable')`),
  check("agent_runtime_approvals_target_check", sql`${t.providerTarget} IN ('default', 'canary')`),
]);

// The cards of one hold: one per decider, each in that person's DM with the
// agent (the owner's, or every server owner's and admin's once the owner left).
// At most one per person; a card whose message is gone leaves no row, and the
// next sync posts it again while the hold is pending.
export const agentRuntimeApprovalCards = pgTable("agent_runtime_approval_cards", {
  approvalId: uuid("approval_id").notNull().references(() => agentRuntimeApprovals.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.approvalId, t.userId] }),
  uniqueIndex("idx_agent_runtime_approval_cards_message").on(t.messageId),
]);

// The reconcile of antiproton's provider-wide approvals list, per provider
// target: the largest `updatedAt` seen, and a lease so one replica runs it.
export const agentRuntimeApprovalSync = pgTable("agent_runtime_approval_sync", {
  providerTarget: text("provider_target", { enum: ["default", "canary"] }).primaryKey(),
  watermark: timestamp("watermark", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("agent_runtime_approval_sync_target_check", sql`${t.providerTarget} IN ('default', 'canary')`),
]);

/**
 * The plan a hosting provider last confirmed for a server (its daily spend
 * limit tier). The provision worker PUTs the server's current plan whenever it
 * differs, for servers that have a hosted agent.
 */
/**
 * The daily pull of hosted spend from the provider, one row per (UTC day,
 * scope). A scope is `server:<id>` (that server's per-agent spend) or
 * `onboarding` (the platform onboarding budget). A row completes once, so a
 * day's events are written once; `pull_id` tags them for the reader.
 */
export const hostedRuntimeSpendPulls = pgTable("hosted_runtime_spend_pulls", {
  day: date("day").notNull(),
  scope: text("scope").notNull(),
  pullId: uuid("pull_id").notNull().defaultRandom(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
}, (t) => [
  primaryKey({ columns: [t.day, t.scope] }),
]);

export const hostedRuntimeServerPlans = pgTable("hosted_runtime_server_plans", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["antiproton"] }).notNull(),
  /** Last plan the provider acknowledged; null until the first PUT succeeds. */
  syncedPlan: text("synced_plan", { enum: ["free", "pro"] }),
  /** Daily hosted budgets (integer cents) the provider last acknowledged with the plan; null until sent. */
  syncedDailyBudgetCents: integer("synced_daily_budget_cents"),
  syncedOnboardingDailyBudgetCents: integer("synced_onboarding_daily_budget_cents"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  /** Last `antiproton_model_picker` state the provider acknowledged; null until the first PUT succeeds. */
  syncedModelPicker: boolean("synced_model_picker"),
  modelPickerSyncedAt: timestamp("model_picker_synced_at", { withTimezone: true }),
  modelPickerFailedAttempts: integer("model_picker_failed_attempts").notNull().default(0),
  modelPickerNextAttemptAt: timestamp("model_picker_next_attempt_at", { withTimezone: true }),
  modelPickerLastErrorCode: text("model_picker_last_error_code"),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.provider] }),
]);

// Computer-scoped provider probes (Phase 2A foundation). An intent is the
// client-idempotent, at-most-once dispatch record; its claim column group is
// the one-time materialization lease (atomic CAS, no third table). A receipt is
// insert-once per probe and never mutates a terminal state.
export const providerProbeIntents = pgTable("provider_probe_intents", {
  id: uuid("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => providerConnections.id, { onDelete: "cascade" }),
  configVersion: integer("config_version").notNull(),
  credentialVersion: integer("credential_version").notNull(),
  computerId: uuid("computer_id").notNull().references(() => machines.id, { onDelete: "cascade" }),
  runtime: text("runtime").notNull(),
  model: text("model").notNull(),
  probeKind: text("probe_kind").notNull(),
  probeRequestId: text("probe_request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  intentDigest: text("intent_digest").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // null -> set exactly once: the at-most-one-dispatch guard.
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  closeReason: text("close_reason"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Dispatch-time carrier fact, frozen at the dispatch CAS (F1/F7).
  dispatchRequestId: text("dispatch_request_id"),
  dispatchEpochId: text("dispatch_epoch_id"),
  dispatchGeneration: text("dispatch_generation"),
  capabilityObserved: boolean("capability_observed"),
  dispatchDaemonVersion: text("dispatch_daemon_version"),
  dispatchComputerVersion: text("dispatch_computer_version"),
  dispatchRuntimeVersion: text("dispatch_runtime_version"),
  dispatchRuntimes: jsonb("dispatch_runtimes").$type<string[]>(),
  // One-time materialization claim column group. First valid claim wins; the
  // same claimant may retry inside the lease, everyone else is rejected.
  claimMachineId: uuid("claim_machine_id").references(() => machines.id, { onDelete: "cascade" }),
  claimRequestId: text("claim_request_id"),
  claimEpochId: text("claim_epoch_id"),
  claimGeneration: text("claim_generation"),
  claimLeasedAt: timestamp("claim_leased_at", { withTimezone: true }),
  materializationDigest: text("materialization_digest"),
}, (t) => [
  // The closed-server purge deletes the rows this key names (migration
  // closed_server_purge_step_fk_indexes; CONCURRENTLY on a large table).
  index("idx_provider_probe_intents_connection").on(t.connectionId),
  uniqueIndex("idx_provider_probe_intents_server_request").on(t.serverId, t.probeRequestId),
  index("idx_provider_probe_intents_server_connection").on(t.serverId, t.connectionId),
  // Wave-3 exact query: latest valid success for one authority coordinate.
  index("idx_provider_probe_intents_authority_match").on(
    t.serverId, t.connectionId, t.configVersion, t.credentialVersion, t.computerId, t.runtime, t.model, t.probeKind,
  ),
  check("provider_probe_intents_kind_known", sql`${t.probeKind} in ('canary')`),
  check(
    "provider_probe_intents_close_reason_known",
    sql`${t.closeReason} is null or ${t.closeReason} in ('receipt', 'carrier_offline', 'carrier_timeout', 'unsupported_carrier', 'provider_timeout', 'stale_authority', 'intent_expired', 'invalid_carrier_result')`,
  ),
]);

export const providerProbeReceipts = pgTable("provider_probe_receipts", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  probeId: uuid("probe_id").notNull().unique().references(() => providerProbeIntents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  category: text("category"),
  latencyMs: integer("latency_ms"),
  responseSha256: text("response_sha256"),
  responseBytes: integer("response_bytes"),
  resultDigest: text("result_digest").notNull(),
  intentDigest: text("intent_digest").notNull(),
  materializationDigest: text("materialization_digest"),
  // Null for closures that never had a dispatch authority (pre-dispatch).
  authorityIdentity: text("authority_identity"),
  daemonVersion: text("daemon_version"),
  computerVersion: text("computer_version"),
  runtimeVersion: text("runtime_version"),
  dispatchEpochId: text("dispatch_epoch_id"),
  dispatchGeneration: text("dispatch_generation"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("provider_probe_receipts_outcome_known", sql`${t.outcome} in ('success', 'failure')`),
  check(
    "provider_probe_receipts_category_known",
    sql`${t.category} is null or ${t.category} in ('auth', 'model', 'network', 'dns_tls', 'rate_quota', 'invalid_response', 'carrier_offline', 'carrier_timeout', 'unsupported_carrier', 'provider_timeout', 'stale_authority', 'intent_expired', 'invalid_carrier_result')`,
  ),
  check(
    "provider_probe_receipts_bytes_nonneg",
    sql`${t.responseBytes} is null or ${t.responseBytes} >= 0`,
  ),
  check(
    "provider_probe_receipts_success_needs_response",
    sql`${t.outcome} <> 'success' or (${t.responseSha256} is not null and ${t.responseBytes} is not null and ${t.authorityIdentity} is not null)`,
  ),
]);

// Locator-only product feedback ingestion. The payload is kept solely because
// it has already passed the closed consumer schema below the route boundary;
// it cannot contain feedback body/session/transcript data. Query columns are
// duplicated deliberately so triage never needs to treat opaque JSON as an
// index or infer an acceptance receipt from object storage.
export const productFeedbackLocators = pgTable("product_feedback_locators", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  producerAgentId: uuid("producer_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  reportId: uuid("report_id").notNull(),
  receiptId: uuid("receipt_id").notNull().$defaultFn(() => randomUUID()),
  artifactKind: text("artifact_kind").notNull(),
  eventKind: text("event_kind").notNull(),
  schemaVersion: text("schema_version").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  runtime: text("runtime").notNull(),
  nativeStatus: text("native_status").notNull(),
  nativeLookupMethod: text("native_lookup_method").notNull(),
  nativeLocatorKind: text("native_locator_kind").notNull(),
  hasServedExact: boolean("has_served_exact").notNull(),
  servedExactSha256: text("served_exact_sha256").array().notNull().default(sql`ARRAY[]::text[]`),
  routeBasis: text("route_basis"),
  routeTarget: text("route_target"),
  payloadSha256: text("payload_sha256").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_product_feedback_locators_server_report").on(t.serverId, t.reportId),
  uniqueIndex("idx_product_feedback_locators_receipt").on(t.receiptId),
  index("idx_product_feedback_locators_runtime").on(t.serverId, t.runtime),
  index("idx_product_feedback_locators_native").on(t.serverId, t.nativeStatus, t.nativeLookupMethod),
  index("idx_product_feedback_locators_served_exact").on(t.serverId, t.hasServedExact),
  index("idx_product_feedback_locators_served_exact_sha").using("gin", t.servedExactSha256),
  index("idx_product_feedback_locators_route_basis").on(t.serverId, t.routeBasis),
  check("product_feedback_locators_artifact_kind", sql`${t.artifactKind} = 'raft-feedback-locator-v0'`),
  check("product_feedback_locators_event_kind", sql`${t.eventKind} = 'feedback-locator:created'`),
  check("product_feedback_locators_schema_version", sql`${t.schemaVersion} = 'raft.feedback.locator.v0'`),
]);

// Global product release notes; ordinary server ownership grants no write access.
export const releaseNotes = pgTable('release_notes', {
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  releaseKey: text('release_key').notNull().unique(),
  version: text('version').unique(),
  tag: text('tag').unique(),
  date: date('date').notNull(),
  generation: integer('generation').notNull().default(1),
  currentRevision: integer('current_revision'),
  retractedAt: timestamp('retracted_at', { withTimezone: true }),
});
export const releaseNoteRevisions = pgTable('release_note_revisions', {
  releaseId: uuid('release_id').notNull().references(() => releaseNotes.id),
  revision: integer('revision').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({columns: [t.releaseId, t.revision]})]);
export const releaseNoteRevisionItems = pgTable('release_note_revision_items', {
  releaseId: uuid('release_id').notNull(),
  revision: integer('revision').notNull(),
  entryId: uuid('entry_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  type: text('type', {enum: ['feature','fix','improvement','breaking','deprecated']}).notNull(),
  text: text('text').notNull(),
  emphasis: boolean('emphasis').notNull().default(false),
}, t => [primaryKey({columns: [t.releaseId,t.revision,t.entryId]}),
  unique().on(t.releaseId,t.revision,t.ordinal),
  foreignKey({columns: [t.releaseId,t.revision], foreignColumns: [releaseNoteRevisions.releaseId,releaseNoteRevisions.revision]})]);
// One translation per published entry and display locale. Written only through
// public.release_note_translations_write() (migration release_note_translations),
// which the Release App and services/releaseNoteTranslations.ts both call.
// `sourceHash` is the sha256 of the English text it was translated from: the
// public read serves it only while the entry's current text still hashes to it,
// so an edited entry falls back to English instead of showing a translation of
// the old wording.
export const releaseNoteTranslations = pgTable('release_note_translations', {
  releaseId: uuid('release_id').notNull(),
  entryId: uuid('entry_id').notNull(),
  locale: text('locale', {enum: DISPLAY_LOCALES}).notNull(),
  revision: integer('revision').notNull(),
  sourceHash: text('source_hash').notNull(),
  text: text('text').notNull(),
  actorType: text('actor_type', {enum: ['human', 'agent']}).notNull(),
  actorId: text('actor_id').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [primaryKey({columns: [t.releaseId, t.entryId, t.locale]}),
  // The translated entry must exist in the revision it was translated from.
  foreignKey({name: 'release_note_translations_entry_fk', columns: [t.releaseId, t.revision, t.entryId],
    foreignColumns: [releaseNoteRevisionItems.releaseId, releaseNoteRevisionItems.revision, releaseNoteRevisionItems.entryId]}),
  // Every display locale but English (RELEASE_NOTE_TRANSLATION_LOCALES; a test pins the two together).
  check('release_note_translations_locale', sql`${t.locale} in ('es', 'pt-br', 'ru', 'ko', 'ja', 'zh-cn', 'zh-tw')`),
  check('release_note_translations_source_hash', sql`${t.sourceHash} ~ '^[0-9a-f]{64}$'`),
  check('release_note_translations_text', sql`char_length(${t.text}) between 1 and 20000`),
  check('release_note_translations_actor_type', sql`${t.actorType} in ('human', 'agent')`)]);
export const releaseNoteDrafts = pgTable('release_note_drafts', {
  releaseId: uuid('release_id').primaryKey().references(() => releaseNotes.id),
  entries: jsonb('entries').$type<Array<{entryId:string;ordinal:number;type:'feature'|'fix'|'improvement'|'breaking'|'deprecated';text:string;emphasis:boolean}>>().notNull(),
});
export const releaseNoteAudit = pgTable('release_note_audit', {
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  releaseId: uuid('release_id').notNull().references(() => releaseNotes.id),
  actorType: text('actor_type', {enum: ['human', 'agent']}).notNull(),
  actorId: text('actor_id').notNull(),
  clientId: text('client_id').notNull(),
  action: text('action').notNull(),
  revision: integer('revision'),
  reason: text('reason').notNull(),
  entryDeltas: jsonb('entry_deltas').$type<Array<{entryId: string; op: 'add' | 'remove' | 'change'}>>().notNull().default([]),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull().defaultNow(),
});
export const releaseNoteMutationReceipts = pgTable('release_note_mutation_receipts', {
  actorType: text('actor_type', {enum: ['human', 'agent']}).notNull(),
  actorId: text('actor_id').notNull(), clientId: text('client_id').notNull(),
  key: text('key').notNull(), requestDigest: text('request_digest').notNull(),
  releaseId: uuid('release_id').notNull().references(() => releaseNotes.id),
  generation: integer('generation').notNull(), revision: integer('revision'),
}, t => [primaryKey({columns:[t.actorType,t.actorId,t.clientId,t.key]})]);

// RFC 073 durable tasks: follow-up work written in the same transaction as the
// state change that needs it, run inline by the originating request after
// commit, and recovered by any replica once its lease has expired.
export const durableTasks = pgTable("durable_tasks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  payloadVersion: integer("payload_version").notNull(),
  payload: jsonb("payload").notNull(),
  state: text("state", { enum: ["open", "succeeded", "needs_attention"] }).notNull(),
  // The creating request's inline run is attempt 1.
  attempts: integer("attempts").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  // Fencing token of the current attempt; null while waiting for a retry.
  claimedBy: text("claimed_by"),
  // While open: claimed until (running) or the next retry time (waiting).
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  // Code-shaped cause of the last failure; never free text.
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("idx_durable_tasks_open_lease_until").on(t.leaseUntil).where(sql`${t.state} = 'open'`),
  index("idx_durable_tasks_succeeded_finished_at").on(t.finishedAt).where(sql`${t.state} = 'succeeded'`),
  check("durable_tasks_state_check", sql`${t.state} IN ('open', 'succeeded', 'needs_attention')`),
  check("durable_tasks_attempts_check", sql`${t.attempts} >= 1 AND ${t.maxAttempts} >= 1`),
]);

// Staging RaftBench pilot: one configuration and latest run per server, no history library.
/** Dedicated analysis identities remain restricted even while unassigned. */
export const raftbenchServiceAgents = pgTable("raftbench_service_agents", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("idx_raftbench_service_agents_server").on(t.serverId)]);

export const raftbenchConfigs = pgTable("raftbench_configs", {
  configuredByUserId: uuid("configured_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
  readMessages: bigint("read_messages", { mode: "number" }).notNull().default(0),
  readThroughSeq: bigint("read_through_seq", { mode: "number" }).notNull().default(0),
  threadReadMessages: bigint("thread_read_messages", { mode: "number" }).notNull().default(0),
  threadReadThroughSeq: bigint("thread_read_through_seq", { mode: "number" }).notNull().default(0),
  threadScannedThroughAt: timestamp("thread_scanned_through_at", { withTimezone: true }),
  sourceScanVersion: integer("source_scan_version").notNull().default(1),
  completedBatches: integer("completed_batches").notNull().default(0),
  scannedThroughAt: timestamp("scanned_through_at", { withTimezone: true }),
  historyFrom: timestamp("history_from", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("idx_raftbench_configs_agent").on(t.agentId).where(sql`${t.agentId} IS NOT NULL`)]);
export const raftbenchLatestRuns = pgTable("raftbench_latest_runs", {
  sourceKind: text("source_kind", { enum: ["channel", "thread"] }).notNull().default("channel"),
  serverId: uuid("server_id").primaryKey().references(() => raftbenchConfigs.serverId, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().unique().$defaultFn(() => randomUUID()),
  revision: integer("revision").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["queued", "running", "ready", "partial", "failed"] }).notNull(),
  from: timestamp("from_at", { withTimezone: true }).notNull(),
  to: timestamp("to_at", { withTimezone: true }).notNull(),
  // Only source references and page checkpoints. Raw source text is never copied here.
  fetched: jsonb("fetched").$type<Array<{ target: string; messageId: string; channelId: string; sourceVersion?: string }>>().notNull().default([]),
  nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(0),
  startAfterSeq: bigint("start_after_seq", { mode: "number" }).notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  unreadRetries: jsonb("unread_retries").$type<Partial<Record<"channel" | "thread", { from: string; to: string; startAfterSeq: number; failures: number; reason: string | null }>>>().notNull().default({}),
  skippedRanges: jsonb("skipped_ranges").$type<Array<{ from: string; to: string; messages: number | null }>>().notNull().default([]),
  sourceCharacters: integer("source_characters").notNull().default(0),
  stopReason: text("stop_reason", { enum: ["more_pages", "message_limit", "char_limit", "window_end"] }).notNull().default("more_pages"),
  exhausted: boolean("exhausted").notNull().default(false),
  report: jsonb("report").$type<import("@botiverse/raft-shared").RaftbenchReport>(),
  submissionHash: text("submission_hash"),
  receiptId: uuid("receipt_id"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Latest analysis scope only: derived findings survive batch rotation, never source text.
export const raftbenchFindings = pgTable("raftbench_findings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => raftbenchConfigs.serverId, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  pattern: jsonb("pattern").$type<import("@botiverse/raft-shared").RaftbenchReport["patterns"][number]>().notNull(),
  feedback: jsonb("feedback").$type<Record<string, "agree" | "inaccurate">>().notNull().default({}),
  sourceRefs: jsonb("source_refs").$type<Array<{ messageId: string; channelId: string; storageChannelId: string; sourceVersion: string }>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("idx_raftbench_finding_fingerprint").on(t.serverId, t.revision, t.fingerprint)]);

// First-pass triage ledger: leases bound concurrency, token counts bound daily spend.
export const raftbenchTriageBatches = pgTable("raftbench_triage_batches", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => raftbenchConfigs.serverId, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
  messageRefs: jsonb("message_refs").$type<Array<{ messageId: string; channelId: string; storageChannelId: string; target: string; sourceVersion: string }>>().notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  // Budget units: reserved at dispatch, replaced by the actual cost when the call ends.
  weightedTokens: integer("weighted_tokens").notNull().default(0),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, t => [index("idx_raftbench_triage_batch_status").on(t.serverId, t.status, t.startedAt), index("idx_raftbench_triage_batch_started").on(t.startedAt)]);

// One row per triaged message, labeled or not: derived labels and a bounded reason, never source text.
export const raftbenchMessageLabels = pgTable("raftbench_message_labels", {
  serverId: uuid("server_id").notNull().references(() => raftbenchConfigs.serverId, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  messageId: uuid("message_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  storageChannelId: uuid("storage_channel_id").notNull(),
  target: text("target").notNull(),
  sourceVersion: text("source_version").notNull(),
  labels: jsonb("labels").$type<Array<{ label: "frustration" | "correction" | "self_retract" | "failure" | "unclear"; why: string }>>().notNull().default([]),
  ruleVersion: text("rule_version").notNull(),
  triagedAt: timestamp("triaged_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("idx_raftbench_message_label").on(t.serverId, t.revision, t.messageId)]);

// Append-only authorization decisions: latest decision per server/agent wins.
export const raftbenchReaderGrants = pgTable("raftbench_reader_grants", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("idx_raftbench_reader_grant_subject").on(t.serverId, t.agentId, t.seq)]);
