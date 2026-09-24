import { pgTable, text, timestamp, integer, bigint, bigserial, uuid, primaryKey, unique, uniqueIndex, index, json, jsonb, boolean, customType, check, date, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentMigrationTransferSummary,
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_users_name_exact_unique").on(table.name),
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
    enum: ["pending_provider", "provider_processing", "provider_completed", "completed", "failed", "expired"],
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
  plan: text("plan", { enum: ["free", "founder", "partner", "pro"] }).notNull().default("free"),
  translationEnabled: boolean("translation_enabled").notNull().default(false),
  planDowngradedAt: timestamp("plan_downgraded_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Server members — user ↔ server relationship
export const serverMembers = pgTable("server_members", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "member", "guest"] }).notNull().default("member"),
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
  serverPushMuted: boolean("server_push_muted").notNull().default(false),
  serverPushMode: text("server_push_mode", { enum: ["all", "mentions", "none"] }).notNull().default("all"),
  notificationPrefsVersion: integer("notification_prefs_version").notNull().default(0),
  onboardingDmSentAt: timestamp("onboarding_dm_sent_at", { withTimezone: true }),
  onboardingDmSentByAgentId: uuid("onboarding_dm_sent_by_agent_id"),
  onboardingOwnerOpenerV2SentAt: timestamp("onboarding_owner_opener_v2_sent_at", { withTimezone: true }),
  onboardingOwnerOpenerV2SentByAgentId: uuid("onboarding_owner_opener_v2_sent_by_agent_id"),
  onboardingOwnerOpenerV2MessageIds: json("onboarding_owner_opener_v2_message_ids").$type<string[]>().notNull().default([]),
  onboardingOwnerOpenerV2Version: text("onboarding_owner_opener_v2_version"),
  onboardingOwnerOpenerV2Topics: json("onboarding_owner_opener_v2_topics").$type<string[]>().notNull().default([]),
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
  stage: text("stage", { enum: ["user", "platform", "server", "audience", "lab", "plan", "percentage"] }).notNull(),
  priority: integer("priority").notNull().default(0),
  decision: text("decision", { enum: ["allow", "deny"] }).notNull(),
  values: jsonb("values").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  percentageBasisPoints: integer("percentage_basis_points"),
  variant: text("variant"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_feature_flag_rules_flag").on(t.flagKey),
  index("idx_feature_flag_rules_flag_stage_priority").on(t.flagKey, t.stage, t.priority),
  check("feature_flag_rules_stage_valid", sql`${t.stage} IN ('user', 'platform', 'server', 'audience', 'lab', 'plan', 'percentage')`),
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
  source: text("source", { enum: ["invite", "join", "request-access", "admin-add"] }).notNull(),
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
export const sessionFamilies = pgTable("session_families", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  revokeCapabilityNonce: text("revoke_capability_nonce"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  capabilityRetainUntil: timestamp("capability_retain_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_session_families_user_active").on(t.userId, t.revokedAt),
  index("idx_session_families_capability_retention").on(t.capabilityRetainUntil),
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
}, (t) => [index("idx_session_token_predecessors_expiry").on(t.expiresAt)]);

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

// Desktop native notifications use a credential class that is intentionally
// isolated from browser sessions and every existing API-key principal.
export const nativeNotificationEnrollmentGrants = pgTable("native_notification_enrollment_grants", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionFamilyId: uuid("session_family_id").notNull().references(() => sessionFamilies.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull(),
  appId: text("app_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  appVersion: text("app_version").notNull(),
  releaseChannel: text("release_channel", { enum: ["development", "staging", "production"] }).notNull(),
  appInstanceId: uuid("app_instance_id").notNull(),
  publicKey: text("public_key").notNull(),
  nonce: text("nonce").notNull(),
  attestationState: text("attestation_state", { enum: ["missing", "observed", "verified", "rejected"] }).notNull(),
  attestationEvidenceHash: text("attestation_evidence_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_native_notification_grants_expiry").on(t.expiresAt),
  index("idx_native_notification_grants_family").on(t.sessionFamilyId),
  check("native_notification_grants_protocol_v1", sql`${t.protocolVersion} = 1`),
]);

export const nativeNotificationDevices = pgTable("native_notification_devices", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originSessionFamilyId: uuid("origin_session_family_id").notNull().references(() => sessionFamilies.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  appVersion: text("app_version").notNull(),
  releaseChannel: text("release_channel", { enum: ["development", "staging", "production"] }).notNull(),
  appInstanceId: uuid("app_instance_id").notNull(),
  publicKey: text("public_key").notNull(),
  attestationState: text("attestation_state", { enum: ["missing", "observed", "verified", "rejected"] }).notNull(),
  attestationEvidenceHash: text("attestation_evidence_hash"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_native_notification_devices_active_binding")
    .on(t.userId, t.appId, t.appInstanceId)
    .where(sql`${t.revokedAt} IS NULL`),
  index("idx_native_notification_devices_user").on(t.userId),
  index("idx_native_notification_devices_family").on(t.originSessionFamilyId),
  check("native_notification_devices_protocol_v1", sql`${t.protocolVersion} = 1`),
]);

export const nativeNotificationCredentials = pgTable("native_notification_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  deviceId: uuid("device_id").notNull().references(() => nativeNotificationDevices.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionFamilyId: uuid("session_family_id").notNull().references(() => sessionFamilies.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull(),
  scope: text("scope", { enum: ["notifications:stream"] }).notNull().default("notifications:stream"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  rotatedFromId: uuid("rotated_from_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_native_notification_credentials_active_device")
    .on(t.deviceId)
    .where(sql`${t.revokedAt} IS NULL`),
  index("idx_native_notification_credentials_user").on(t.userId),
  index("idx_native_notification_credentials_family").on(t.sessionFamilyId),
  index("idx_native_notification_credentials_expiry").on(t.expiresAt),
  check("native_notification_credentials_scope", sql`${t.scope} = 'notifications:stream'`),
]);

export const nativeNotificationEvents = pgTable("native_notification_events", {
  streamSeq: bigserial("stream_seq", { mode: "number" }).primaryKey(),
  eventId: uuid("event_id").notNull().$defaultFn(() => randomUUID()),
  recipientUserId: uuid("recipient_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  // Historical message identity: events retain a bounded replay record even
  // if the message is deleted before the 24-hour ledger expiry.
  messageId: uuid("message_id").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  body: text("body").notNull(),
  targetUri: text("target_uri").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("uq_native_notification_events_event_id").on(t.eventId),
  uniqueIndex("uq_native_notification_events_dedupe_key").on(t.dedupeKey),
  index("idx_native_notification_events_user_stream").on(t.recipientUserId, t.streamSeq),
  index("idx_native_notification_events_expiry").on(t.expiresAt),
  check("native_notification_events_version_v1", sql`${t.version} = 1`),
  check("native_notification_events_title_bounds", sql`char_length(${t.title}) BETWEEN 1 AND 160`),
  check("native_notification_events_body_bounds", sql`char_length(${t.body}) BETWEEN 1 AND 512`),
  check("native_notification_events_target_uri_bounds", sql`char_length(${t.targetUri}) BETWEEN 1 AND 512`),
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
  creatorType: text("creator_type", { enum: ["user", "agent"] }),
  creatorId: uuid("creator_id"),
  machineId: uuid("daemon_id").references(() => machines.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_agents_server_name").on(t.serverId, t.name).where(sql`deleted_at is null`),
  index("idx_agents_server").on(t.serverId),
  index("idx_agents_creator").on(t.serverId, t.creatorType, t.creatorId),
]);

export const agentMigrations = pgTable("agent_migrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // Historical identity snapshots, intentionally not entity FKs. Terminal
  // migration evidence must survive after a Computer is deleted.
  sourceMachineId: uuid("source_machine_id").notNull(),
  targetMachineId: uuid("target_machine_id").notNull(),
  // Frozen names are mandatory durable evidence. The migration backfills
  // historical rows before applying these NOT NULL constraints.
  sourceMachineNameSnapshot: text("source_machine_name_snapshot").notNull(),
  targetMachineNameSnapshot: text("target_machine_name_snapshot").notNull(),
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
  // Durable proof that the source daemon atomically moved the old workspace
  // into its migration-specific archive. Completion must fail closed while
  // this is null; retries close a lost response through the daemon's
  // migrationId-idempotent `already_archived` result.
  sourceWorkspaceArchivedAt: timestamp("source_workspace_archived_at", { withTimezone: true }),
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
  check("agent_migrations_distinct_machines", sql`${t.sourceMachineId} <> ${t.targetMachineId}`),
  check("agent_migrations_contract_version_check", sql`${t.contractVersion} >= 1`),
  check("agent_migrations_receipt_contract_version_check", sql`${t.contractVersion} >= 2`),
]);

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

// OAuth clients — third-party apps that can request agent login
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  clientSecret: text("client_secret"),
  appType: text("app_type", { enum: ["server_local", "slock_builtin", "third_party_global"] }).default("server_local").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  homepageUrl: text("homepage_url"),
  returnUrl: text("return_url"),
  agentManifestUrl: text("agent_manifest_url"),
  allowedScopes: json("allowed_scopes").$type<string[]>(),
  logoUrl: text("logo_url"),
  logoStorageKey: text("logo_storage_key"),
  category: text("category").default("Other").notNull(),
  dataAccessSummary: text("data_access_summary"),
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
  // RFC 051 outbound authority is derived from immutable request revisions.
  // These fields are the closed runtime ceiling; remote manifests are never
  // consulted while authorizing pull or delivery.
  outboundRequestRevision: integer("outbound_request_revision").notNull().default(0),
  outboundCurrentRevisionId: uuid("outbound_current_revision_id"),
  outboundPendingRevisionId: uuid("outbound_pending_revision_id"),
  outboundCurrentGroups: jsonb("outbound_current_groups").$type<string[]>().notNull().default([]),
  outboundCurrentEvents: jsonb("outbound_current_events").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_clients_server").on(t.serverId),
  index("idx_oauth_clients_app_type").on(t.appType),
  index("idx_oauth_clients_owner_agent").on(t.ownerAgentId),
  index("idx_oauth_clients_publish_status").on(t.publishStatus),
  index("idx_oauth_clients_marketplace").on(t.appType, t.publishStatus),
  check(
    "oauth_clients_publish_status_valid",
    sql`${t.publishStatus} IN ('private', 'publish_requested', 'in_review', 'published', 'rejected', 'unpublish_requested')`,
  ),
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

export const oauthClientInstalls = pgTable("oauth_client_installs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  installedByUserId: uuid("installed_by_user_id").references(() => users.id, { onDelete: "cascade" }),
  installedByAgentId: uuid("installed_by_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  approvedRequestRevisionId: uuid("approved_request_revision_id").references(() => oauthAppPermissionRevisions.id, { onDelete: "set null" }),
  approvedGroups: jsonb("approved_groups").$type<string[]>().notNull().default([]),
  subscribedEvents: jsonb("subscribed_events").$type<string[]>().notNull().default([]),
  grantRevision: integer("grant_revision").notNull().default(0),
  subscriptionRevision: integer("subscription_revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_client_installs_server_client").on(t.serverId, t.clientId),
  index("idx_oauth_client_installs_client").on(t.clientId),
  check(
    "oauth_client_installs_actor_valid",
    sql`(${t.installedByUserId} IS NOT NULL AND ${t.installedByAgentId} IS NULL)
      OR (${t.installedByUserId} IS NULL AND ${t.installedByAgentId} IS NOT NULL)`,
  ),
  index("idx_oauth_client_installs_status").on(t.clientId, t.status),
  check("oauth_client_installs_grant_revision_nonnegative", sql`${t.grantRevision} >= 0`),
  check("oauth_client_installs_subscription_revision_nonnegative", sql`${t.subscriptionRevision} >= 0`),
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

export const oauthClientShareLinks = pgTable("oauth_client_share_links", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "cascade" }),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_client_share_links_client").on(t.clientId),
  uniqueIndex("idx_oauth_client_share_links_active_client").on(t.clientId).where(sql`revoked_at is null`),
  check(
    "oauth_client_share_links_actor_valid",
    sql`(${t.createdByUserId} IS NOT NULL AND ${t.createdByAgentId} IS NULL)
      OR (${t.createdByUserId} IS NULL AND ${t.createdByAgentId} IS NOT NULL)`,
  ),
]);

// OAuth access requests — pending/approved/denied login attempts by a client.
// Agent requests are headless service grants; human requests are browser
// authorization codes scoped to one server context.
export const oauthAccessRequests = pgTable("oauth_access_requests", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_access_requests_server_status").on(t.serverId, t.status),
  index("idx_oauth_access_requests_agent").on(t.agentId),
  index("idx_oauth_access_requests_user").on(t.userId),
  index("idx_oauth_access_requests_client").on(t.clientId),
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
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_oauth_grants_server_agent").on(t.serverId, t.agentId),
  index("idx_oauth_grants_client").on(t.clientId),
]);

// Integration audit events — append-only security/product audit trail for
// third-party app, OAuth, and integration action-card mutations.
export const integrationAuditEvents = pgTable("integration_audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => oauthClients.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  eventCategory: text("event_category", { enum: ["registration", "scope", "install", "runtime", "revocation"] }).notNull(),
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
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  principalType: text("principal_type", { enum: ["agent", "human"] }).notNull().default("agent"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").references(() => oauthAccessRequests.id, { onDelete: "set null" }),
  grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull(),
  scopes: json("scopes").$type<string[]>().notNull(),
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_oauth_access_tokens_hash").on(t.tokenHash),
  index("idx_oauth_access_tokens_agent").on(t.agentId),
  index("idx_oauth_access_tokens_user").on(t.userId),
  index("idx_oauth_access_tokens_expires").on(t.expiresAt),
]);

export const thirdPartyAgentEvents = pgTable("third_party_agent_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
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
}, (t) => [
  index("idx_third_party_agent_events_agent_status").on(t.agentId, t.status),
  index("idx_third_party_agent_events_client").on(t.clientId),
  uniqueIndex("idx_third_party_agent_events_dedupe").on(t.clientId, t.agentId, t.externalEventId),
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
  type: text("type", { enum: ["channel", "private", "joint", "dm", "thread"] }).default("channel").notNull(),
  guestVisible: boolean("guest_visible").notNull().default(false),
  guestJoinable: boolean("guest_joinable").notNull().default(false),
  parentMessageId: uuid("parent_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByUserId: uuid("archived_by_user_id").references(() => users.id, { onDelete: "set null" }),
  archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("idx_channels_server").on(t.serverId),
  // Name uniqueness spans archived and active channels: archive must not
  // release the name. The partial index stays gated only on deleted_at.
  uniqueIndex("idx_channels_server_name_type").on(t.serverId, t.name).where(sql`type in ('channel', 'private', 'joint') and deleted_at is null`),
  index("idx_channels_parent_message").on(t.parentMessageId),
  uniqueIndex("idx_channels_active_thread_parent").on(t.parentMessageId).where(sql`type = 'thread' and deleted_at is null`),
  index("idx_channels_archived").on(t.serverId, t.archivedAt),
  check("channels_guest_joinable_requires_visible", sql`NOT ${t.guestJoinable} OR ${t.guestVisible}`),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_joint_channels_canonical").on(t.canonicalChannelId),
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
}, (t) => [
  uniqueIndex("idx_joint_channel_invites_token_hash").on(t.tokenHash),
  uniqueIndex("idx_joint_channel_invites_pending_target_user").on(t.jointChannelId, t.toServerId, t.invitedUserId).where(sql`status = 'pending'`),
  index("idx_joint_channel_invites_to_server").on(t.toServerId, t.status),
  index("idx_joint_channel_invites_invited_user").on(t.invitedUserId, t.status),
  index("idx_joint_channel_invites_from_server").on(t.fromServerId, t.status),
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
  status: text("status", { enum: ["pending", "running", "failed", "done", "canceled"] }).notNull().default("pending"),
  phase: text("phase", {
    enum: [
      "prepare",
      "drop_task_identity",
      "move_parent_messages",
      "prepare_threads",
      "move_thread_messages",
      "verify",
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
  senderType: text("sender_type", { enum: ["user", "agent", "external_projection"] }).notNull(),
  senderId: text("sender_id").notNull(), // user UUID, agent UUID, or external actor projection UUID
  agentSendKey: text("agent_send_key"),
  randomId: text("random_id"),
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
  // Task fields — DEAD STORAGE as of v1.4 P3. These are NOT read by application
  // code any more: `tasks` is the source of truth and a task's link to its host
  // message is `tasks.message_id`, not state stored here. A non-null
  // `taskStatus` therefore does NOT mean "this message is a task" — after the
  // 2026-07-31 prod backfill such a row is inert.
  //
  // Retained deliberately as a frozen rollback snapshot (@stdrc keep-and-observe);
  // P4 drops them. Only three writers remain and all of them clear or terminate:
  // `taskService.deleteTask`, agent soft-delete, and channel delete.
  taskStatus: text("task_status", { enum: ["todo", "in_progress", "in_review", "done", "closed"] }),
  taskNumber: integer("task_number"),
  taskAssigneeType: text("task_assignee_type", { enum: ["user", "agent"] }),
  taskAssigneeId: text("task_assignee_id"),
  taskClaimedAt: timestamp("task_claimed_at", { withTimezone: true }),
  taskCompletedAt: timestamp("task_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
  index("idx_messages_search_vector_gin").using("gin", t.searchVector),
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

export const externalAppInstalls = pgTable("external_app_installs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
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
  privacyClass: text("privacy_class", { enum: ["public", "private"] }).notNull(),
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
  check(
    "external_channel_binding_privacy_valid",
    sql`(${t.privacyClass} = 'public' AND ${t.providerConversationKind} = 'public_channel'
      AND ${t.audienceRevision} IS NULL AND ${t.audienceFreshUntil} IS NULL)
      OR (${t.privacyClass} = 'private' AND ${t.providerConversationKind} = 'private_channel'
      AND ${t.audienceRevision} IS NOT NULL AND ${t.audienceRevision} > 0
      AND ${t.audienceFreshUntil} IS NOT NULL)`,
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
  displayName: text("display_name").notNull(),
  handles: jsonb("handles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  actorKind: text("actor_kind", { enum: ["human", "guest", "remote", "bot", "unknown"] }).notNull(),
  state: text("state", { enum: ["active", "tombstoned"] }).notNull().default("active"),
  deactivated: boolean("deactivated").notNull().default(false),
  projectionRevision: integer("projection_revision").notNull(),
  avatarArtifactId: uuid("avatar_artifact_id").references(() => externalProjectionAvatarArtifacts.id, { onDelete: "restrict" }),
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
  check(
    "external_actor_projection_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND length(btrim(${t.externalActorId})) > 0
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
  ownerType: text("owner_type", { enum: ["user", "agent", "external_projection"] }).notNull(),
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
    sql`${t.ownerType} IN ('user', 'agent', 'external_projection')
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

// Raft authors opt into one exact outbound binding epoch. The immutable
// display/avatar revision is frozen into each delivery later by task #7.
export const externalAuthorPolicies = pgTable("external_author_policies", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  appRegistrationId: text("app_registration_id").notNull(),
  installId: text("install_id").notNull(),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  authorType: text("author_type", { enum: ["user", "agent"] }).notNull(),
  authorId: text("author_id").notNull(),
  displayName: text("display_name").notNull(),
  avatarArtifactId: uuid("avatar_artifact_id").references(() => externalProjectionAvatarArtifacts.id, { onDelete: "restrict" }),
  fallbackKind: text("fallback_kind", { enum: ["human", "agent"] }).notNull(),
  consentRevision: integer("consent_revision").notNull(),
  state: text("state", { enum: ["granted", "revoked"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_external_author_policy_epoch").on(
    t.provider,
    t.installId,
    t.bindingId,
    t.bindingEpoch,
    t.authorType,
    t.authorId,
  ),
  index("idx_external_author_policy_server_state").on(t.serverId, t.state),
  check(
    "external_author_policy_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.bindingId})) > 0
      AND length(btrim(${t.authorId})) > 0
      AND length(btrim(${t.displayName})) > 0
      AND ${t.bindingEpoch} > 0 AND ${t.consentRevision} > 0
      AND ${t.authorType} IN ('user', 'agent')
      AND ${t.fallbackKind} IN ('human', 'agent')
      AND ${t.state} IN ('granted', 'revoked')`,
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
  externalActorId: text("external_actor_id").notNull(),
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
  check(
    "external_message_author_values_valid",
    sql`length(btrim(${t.provider})) > 0
      AND length(btrim(${t.appRegistrationId})) > 0
      AND length(btrim(${t.installId})) > 0
      AND length(btrim(${t.workspaceId})) > 0
      AND length(btrim(${t.externalActorId})) > 0
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
      AND ${t.payloadAadVersion} = 1 AND ${t.payloadSchemaVersion} IN (1, 2, 3)`,
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
export const externalDeliveryPartitions = pgTable("external_delivery_partitions", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  bindingId: text("binding_id").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  lastEnqueuedPosition: bigint("last_enqueued_position", { mode: "number" }).notNull().default(0),
  cursorPosition: bigint("cursor_position", { mode: "number" }).notNull().default(0),
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
  renderSnapshotSchema: text("render_snapshot_schema").notNull().default("slack-bridge-render-snapshot.v1"),
  renderSnapshot: jsonb("render_snapshot").$type<Record<string, unknown>>().notNull(),
  renderSnapshotDigest: text("render_snapshot_digest").notNull(),
  reconciliationMarker: text("reconciliation_marker").notNull(),
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
      AND ${t.renderSnapshotSchema} IN ('slack-bridge-render-snapshot.v1', 'slack-bridge-render-snapshot.v2')`,
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

// Pre-release Wiki control residue. Runtime code must not read or write this
// table; it remains declared only so immutable migration history does not turn
// the owner's manual cleanup into a product migration.
export const legacyWikiSpaces = pgTable("wiki_spaces", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  wikiAgentId: uuid("wiki_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  wikiChannelId: uuid("wiki_channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["ready_uninitialized", "initializing", "active", "error"] }).notNull().default("ready_uninitialized"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_wiki_spaces_server").on(t.serverId),
  index("idx_wiki_spaces_agent").on(t.wikiAgentId),
  index("idx_wiki_spaces_channel").on(t.wikiChannelId),
]);

// Wiki — one server-level binding to the dedicated Agent + Channel.
//
// S3 manifest/revisions are canonical for cursor, documents, provenance, and
// publication receipts. Do not add derived Wiki state here unless it cannot be
// represented safely in the manifest.
export const wikiBindings = pgTable("wiki_bindings", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  wikiAgentId: uuid("wiki_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  wikiChannelId: uuid("wiki_channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["ready_uninitialized", "initializing", "active", "error"] }).notNull().default("ready_uninitialized"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_wiki_bindings_server").on(t.serverId),
  index("idx_wiki_bindings_agent").on(t.wikiAgentId),
  index("idx_wiki_bindings_channel").on(t.wikiChannelId),
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
  daemonVersion: text("daemon_version"),
  computerVersion: text("computer_version"),
  computerVersionReportedAt: timestamp("computer_version_reported_at", { withTimezone: true }),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  legacyKeyMigratedAt: timestamp("legacy_key_migrated_at", { withTimezone: true }),
}, (t) => [
  index("idx_daemons_server").on(t.serverId),
  index("idx_daemons_api_key_prefix").on(t.apiKeyPrefix),
  index("idx_daemons_api_key_fingerprint").on(t.apiKeyFingerprint),
]);

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
  status: text("status", { enum: ["todo", "in_progress", "in_review", "done", "closed"] }).notNull().default("todo"),
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
  messageId: uuid("message_id").references(() => messages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_tasks_channel_number").on(t.channelId, t.taskNumber),
  index("idx_tasks_channel_status").on(t.channelId, t.status),
  uniqueIndex("idx_tasks_message_id").on(t.messageId),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.channelId] }),
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

export const userRetirementReceipts = pgTable("user_retirement_receipts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  environment: text("environment", { enum: ["staging"] }).notNull(),
  terminalState: text("terminal_state", { enum: ["retired"] }).notNull(),
  sessionsRevoked: integer("sessions_revoked").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("user_retirement_receipts_sessions_revoked_nonnegative", sql`${t.sessionsRevoked} >= 0`),
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
  kind: text("kind", { enum: ["row_read", "row_unread", "channel_read_all", "global_read_all", "done"] }).notNull(),
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
    OR (${t.kind} = 'channel_read_all' AND ${t.scopeId} IS NOT NULL AND ${t.requestedThroughSeq} IS NULL AND ${t.doneTargetKind} IS NULL AND ${t.doneThroughSeq} IS NULL)
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
  prefsVersion: integer("prefs_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.receiverType, t.receiverId, t.sourceChannelId] }),
  index("idx_inbox_target_mute_states_receiver").on(t.serverId, t.receiverType, t.receiverId),
  index("idx_inbox_target_mute_states_source").on(t.sourceChannelId),
]);

// Per-user, per-channel message display preferences. collapseLongMessages=false
// renders long messages in this channel fully expanded for this user only; it
// does not affect other members, read cursors, or any notification state.
export const userChannelDisplayPrefs = pgTable("user_channel_display_prefs", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  collapseLongMessages: boolean("collapse_long_messages").notNull().default(true),
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
  kind: text("kind", { enum: ["channel", "dm", "thread"] }).notNull(),
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

export const agentMigrationReceiptOutbox = pgTable("agent_migration_receipt_outbox", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  migrationId: uuid("migration_id").notNull().references(() => agentMigrations.id, { onDelete: "cascade" }),
  receiptKind: text("receipt_kind", { enum: ["completed", "canceled", "failed"] }).notNull(),
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
  check("agent_migration_receipt_outbox_kind_check", sql`${t.receiptKind} IN ('completed', 'canceled', 'failed')`),
  check("agent_migration_receipt_outbox_status_check", sql`${t.status} IN ('pending', 'processing', 'sent')`),
]);

// Materialized serving row for fast Activity/Inbox display. It is derived from
// inbox_notification_facts plus read cursors; facts remain the source of truth.
export const inboxServingRows = pgTable("inbox_serving_rows", {
  receiverType: text("receiver_type", { enum: ["user", "agent"] }).notNull(),
  receiverId: uuid("receiver_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["channel", "dm", "thread"] }).notNull(),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  latestNotifiedMessageId: uuid("latest_notified_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  latestNotifiedSeq: bigint("latest_notified_seq", { mode: "number" }).notNull(),
  latestNotifiedAt: timestamp("latest_notified_at", { withTimezone: true }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  firstUnreadMessageId: uuid("first_unread_message_id").references(() => messages.id, { onDelete: "set null" }),
  firstUnreadSeq: bigint("first_unread_seq", { mode: "number" }),
  unreadCount: integer("unread_count").notNull().default(0),
  latestPersonalMentionMessageId: uuid("latest_personal_mention_message_id").references(() => messages.id, { onDelete: "set null" }),
  latestPersonalMentionSeq: bigint("latest_personal_mention_seq", { mode: "number" }),
  unreadMentionCount: integer("unread_mention_count").notNull().default(0),
  hasAnyMention: boolean("has_any_mention").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.receiverType, t.receiverId, t.sourceChannelId] }),
  index("idx_inbox_serving_rows_receiver_activity").on(t.receiverType, t.receiverId, t.latestNotifiedAt),
  index("idx_inbox_serving_rows_receiver_last_activity").on(t.receiverType, t.receiverId, t.lastActivityAt),
  index("idx_inbox_serving_rows_receiver_server_last_activity").on(
    t.receiverType,
    t.receiverId,
    t.serverId,
    t.lastActivityAt,
  ),
  index("idx_inbox_serving_rows_server").on(t.serverId),
]);

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

// Webhook events — idempotency tracking for Stripe webhooks
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // Stripe event ID (evt_...)
  type: text("type").notNull(),
  status: text("status", { enum: ["processing", "processed"] }).notNull().default("processed"),
  processingToken: text("processing_token"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Attachment objects — immutable stored bytes and their physical metadata.
//
// Phase A of RFC 049 only establishes the additive object/projection boundary.
// Existing attachment readers and writers continue to use the legacy columns
// on `attachments` until the dual-write and joined-read phases are deployed.
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

// Attachments — public projection IDs linked to messages. Legacy physical
// metadata remains authoritative during Phase A; objectId and projection-only
// fields are nullable until every writer dual-writes and existing rows are
// backfilled under the RFC 049 fleet/parity gates.
export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  objectId: uuid("object_id").references(() => attachmentObjects.id, { onDelete: "restrict" }),
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
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  thumbnailKey: text("thumbnail_key"),
  contentHash: text("content_hash"),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachments_message").on(t.messageId),
  index("idx_attachments_object").on(t.objectId),
  index("idx_attachments_pending_channel").on(t.pendingChannelId),
  index("idx_attachments_channel").on(t.channelId),
  index("idx_attachments_channel_created_linked")
    .on(t.channelId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`)
    .where(sql`message_id is not null`),
  index("idx_attachments_content_hash").on(t.contentHash),
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
        AND ${t.frozenContentDigest} IS NOT NULL)`,
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
        AND ${t.frozenContentDigest} ~ '^[0-9a-f]{64}$')`,
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
 *                   mentioned, manual}
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
 *   getThreadFollowers(threadId) reads this table — it is the source of truth
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
  parentMessageId: uuid("parent_message_id").notNull(),
  reason: text("reason", { enum: ["replied", "authored", "mentioned", "manual"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  doneAt: timestamp("done_at", { withTimezone: true }),
  unfollowedAt: timestamp("unfollowed_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.threadChannelId, t.followerType, t.followerId] }),
  index("idx_thread_follows_follower").on(t.followerType, t.followerId),
]);

export const pushRegistrations = pgTable("push_registrations", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  installationId: text("installation_id").notNull(),
  provider: text("provider", { enum: ["apns"] }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
  sessionFamilyId: uuid("session_family_id").references(() => sessionFamilies.id, { onDelete: "set null" }),
  deviceToken: text("device_token").notNull(),
  topic: text("topic").notNull(),
  env: text("env", { enum: ["sandbox", "production"] }).notNull(),
  appVersion: text("app_version"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_push_registrations_installation_provider").on(t.installationId, t.provider),
  index("idx_push_registrations_binding").on(t.userId, t.serverId),
  index("idx_push_registrations_family").on(t.sessionFamilyId),
  index("idx_push_registrations_provider_env").on(t.provider, t.env),
  check("push_registrations_provider_check", sql`${t.provider} IN ('apns')`),
  check("push_registrations_env_check", sql`${t.env} IN ('sandbox', 'production')`),
]);

export const mobilePushOutbox = pgTable("mobile_push_outbox", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  receiverType: text("receiver_type", { enum: ["user"] }).notNull(),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["channel", "dm", "thread"] }).notNull(),
  sourceChannelId: uuid("source_channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  messageSeq: bigint("message_seq", { mode: "number" }).notNull(),
  activityAt: timestamp("activity_at", { withTimezone: true }).notNull(),
  personalMention: boolean("personal_mention").notNull().default(false),
  unreadEligible: boolean("unread_eligible").notNull().default(true),
  status: text("status", { enum: ["pending", "processing", "sent", "skipped", "revoked", "dropped"] }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  attemptedCount: integer("attempted_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  revokedCount: integer("revoked_count").notNull().default(0),
  droppedCount: integer("dropped_count").notNull().default(0),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_mobile_push_outbox_unique_fact").on(t.receiverType, t.receiverId, t.sourceChannelId, t.messageId),
  index("idx_mobile_push_outbox_pending").on(t.status, t.createdAt),
  index("idx_mobile_push_outbox_message").on(t.messageId),
  check("mobile_push_outbox_receiver_type_check", sql`${t.receiverType} IN ('user')`),
  check("mobile_push_outbox_kind_check", sql`${t.kind} IN ('channel', 'dm', 'thread')`),
  check("mobile_push_outbox_status_check", sql`${t.status} IN ('pending', 'processing', 'sent', 'skipped', 'revoked', 'dropped')`),
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

// User saved messages (decoupled from thread follows)
export const userSaved = pgTable("user_saved", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
export const announcements = pgTable("announcements", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  title: text("title").notNull(),
  pages: json("pages").$type<Array<{ title?: string; body: string }>>().notNull(),
  defaultLocale: text("default_locale", { enum: ["en", "zh-cn"] }).notNull().default("en"),
  localizedContent: json("localized_content")
    .$type<Partial<Record<"en" | "zh-cn", { title: string; pages: Array<{ title?: string; body: string }> }>>>()
    .notNull()
    .default({}),
  status: text("status", { enum: ["draft", "published", "expired"] }).notNull().default("draft"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
]);

export const userAnnouncementDismissals = pgTable("user_announcement_dismissals", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.announcementId] }),
]);

export const announcementAuditEvents = pgTable("announcement_audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action", {
    enum: [
      "created",
      "updated",
      "published",
      "scheduled",
      "schedule_updated",
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
  status: text("status", { enum: ["scheduled", "fired", "canceled"] }).notNull().default("scheduled"),
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
]);

export { scheduledFollowups as reminders };

export const reminderEvents = pgTable("reminder_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  reminderId: uuid("reminder_id").notNull().references(() => scheduledFollowups.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["agent", "human", "system"] }).notNull(),
  actorId: uuid("actor_id"),
  eventType: text("event_type", { enum: ["scheduled", "fired", "snoozed", "updated", "canceled"] }).notNull(),
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
//   prepared → executed
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
  requesterAgentId: uuid("requester_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(),
  // Frozen at prepare time. Mutated only when the human commits with
  // overrides (e.g. picked a different runtime than the agent suggested);
  // in that case we store the merged action so audit reflects what was
  // actually committed.
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("prepared"),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  executedByUserId: uuid("executed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_action_cards_message").on(t.messageId),
  index("idx_action_cards_server_state").on(t.serverId, t.state),
  index("idx_action_cards_requester").on(t.requesterAgentId, t.createdAt),
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
  source: text("source", { enum: ["cli"] }).notNull(),
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
    sql`${t.source} IN ('cli')`,
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
  pendingCoalescedCount: integer("pending_coalesced_count").notNull().default(0),
  version: integer("version").notNull().default(0),
  redriveCount: integer("redrive_count").notNull().default(0),
  lastRedriveAt: timestamp("last_redrive_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_mention_delivery_occurrences_message_agent").on(t.messageId, t.agentId),
  index("idx_mention_delivery_occurrences_machine_state").on(t.machineIdSnapshot, t.state),
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

// External agent credentials — `sk_agent_*` runtime principals
// (`rfcs/034-slock-credential-rfc.zh.html#section-credential-model`).
//
// Long-lived bearer keys minted by exchanging a gated agent bootstrap token, or
// minted directly by a `sk_computer_*`-authenticated Computer via
// `/internal/computer/runners/:agentId/credentials`. One row
// per credential, bound to exactly one `agentId` for life. NEVER reassigned
// to a different agent — a fresh credential is issued instead. Rows are
// NEVER deleted; revoked rows stay for audit.
//
// Auth flow (see `authenticateAgentCredential` middleware):
//   1. CLI / Runner presents `Authorization: Bearer sk_agent_*`
//   2. middleware extracts `apiKeyPrefix`
//      → SELECT row WHERE prefix = ? AND revoked_at IS NULL
//        (served by partial index `idx_agent_credentials_prefix_active`)
//   3. argon2id verify on `apiKeyHash`
//   4. on success: `req.actingAgentId = row.agentId`,
//      `req.principalKind = 'agent_credential'`,
//      `req.agentCredentialId = row.id`,
//      `req.agentCredentialScopes = row.scopes`
//
// v0.8 active surface (route allowlist via `routeAuthPolicy` registry, see
// `internalAgentApiRouter` at `routes/internalAgentApi.ts`):
//   GET    /internal/agent-api                         — whoami
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
export const agentCredentials = pgTable("agent_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  // argon2id of the raw `sk_agent_*` key. Returned exactly once at mint;
  // never persisted in raw form. Verified constant-time post-lookup.
  apiKeyHash: text("api_key_hash").notNull(),
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
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Last-use observability triple (best-effort; updated post-auth).
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: text("last_used_ip"),
  lastUsedUserAgent: text("last_used_user_agent"),
  // Soft revoke; row stays for audit. Revoked rows are skipped at auth
  // time by the partial index `idx_agent_credentials_prefix_active`
  // (added via raw SQL in the migration — drizzle-kit's `WHERE` support
  // on btree indexes is limited, so the partial-index DDL is hand-rolled).
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
}, (t) => [
  index("idx_agent_credentials_prefix").on(t.apiKeyPrefix),
  index("idx_agent_credentials_agent").on(t.agentId),
  // Partial index `idx_agent_credentials_prefix_active` is appended to
  // the canonical migration as raw SQL — see drizzle migration
  // `0072_*` step 2.
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
//   POST /api/auth/device/approve    — USER-authenticated (only auth phase);
//                                       binds approvedByUserId
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
  deniedAt: timestamp("denied_at", { withTimezone: true }),
  // NULL until the token phase issues the user session. Once set the grant
  // is dead; re-poll returns the consumed error. Single-consume guard.
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedSessionId: uuid("consumed_session_id"),
  consumedIp: text("consumed_ip"),
  consumedUserAgent: text("consumed_user_agent"),
  // Soft revoke; row stays for audit.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_device_authorizations_approved_by").on(t.approvedByUserId),
  index("idx_device_authorizations_expires_at").on(t.expiresAt),
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
  // User who attached the Computer (audit trail). May be null for
  // future device-code / bootstrap-token attachment flows.
  attachedByUserId: uuid("attached_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
  // Partial index `idx_computers_prefix_active` is appended to the
  // canonical migration as raw SQL — see drizzle migration `0074_*`.
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
  cause: text("cause", { enum: ["user_action"] }).notNull().default("user_action"),
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

// Server-managed MCP control plane. Credentials are split from public catalog
// metadata so every read surface can remain secret-free by construction.
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_managed_mcp_servers_server_name").on(t.serverId, t.name),
  index("idx_managed_mcp_servers_server").on(t.serverId),
]);

export const managedMcpCredentials = pgTable("managed_mcp_credentials", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  mcpServerId: uuid("mcp_server_id").notNull().references(() => managedMcpServers.id, { onDelete: "cascade" }),
  encryptedHeaders: text("encrypted_headers"),
  encryptedOAuth: text("encrypted_oauth"),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  credentialVersion: integer("credential_version").notNull().default(1),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_managed_mcp_credentials_server").on(t.mcpServerId),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_managed_mcp_oauth_attempts_state").on(t.stateHash),
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
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.mcpServerId] }),
  index("idx_managed_mcp_assignments_server_agent").on(t.serverId, t.agentId),
  index("idx_managed_mcp_assignments_mcp_server").on(t.mcpServerId),
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
