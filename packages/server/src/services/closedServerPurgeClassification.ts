import { CLOSED_SERVER_PURGE_BRIDGE_TABLES } from "./closedServerPurgeBridgeBlockers";

/**
 * What the closed-server purge does to every row that names the server or
 * one of its agents (design "Purging closed servers 30 days after closing"
 * v6, Tenny #55: "child rows under the tombstone deleted, except billing and
 * audit"). The `servers` row and the `agents` rows stay as tombstones, so no
 * `ON DELETE` ever fires from them: every foreign key to `servers.id` or
 * `agents.id`, in every schema, is classified here, the way account deletion
 * classifies keys to `users.id` (accountDeletion/tableClassification.ts).
 *
 * - `delete` by an earlier step (`by`): the step named deletes the rows
 *   (closedServerPurgeDelete.ts, closedServerPurgeFinish.ts, an app's own
 *   purgeServer, the hourly object-file sweep).
 * - `delete` by `server_rows`: the finish's server_rows step deletes them,
 *   in this file's order, in batches: by the server (`<column> = server`) or,
 *   for a key to agents, by the server's agents. `unlessReferencedBy` keeps
 *   the rows a kept row still names through a RESTRICT / NO ACTION key.
 *   `scan`: the column has no index leading with it (why that is fine).
 * - `delete` `via` another key of the same table: the rows go with it.
 * - `keep`, with its reason (CLOSED_SERVER_PURGE_KEEP_REASONS).
 *
 * - `delete` `cascadeFrom` a table: the rows go by ON DELETE CASCADE with a
 *   row a step deletes (a table core does not write: an app's).
 *
 * Adding a foreign key to `servers.id` or `agents.id`, in any migration,
 * fails closedServerPurgeClassification.db.test.ts (it reads pg_constraint
 * of the migrated database) until it is classified here, with its ON
 * DELETE; the test also follows every step's cascades (a kept table must
 * never be reached; the rest is deleted too or acknowledged in
 * CLOSED_SERVER_PURGE_CASCADES), holds the delete order to the RESTRICT /
 * NO ACTION keys, requires every channel column of a server_rows table to be
 * named (`channels`: rows naming a kept channel stay), and an index on every
 * column that references a table server_rows clears.
 */

export type ClosedServerPurgeOnDelete = "cascade" | "set null" | "restrict" | "no action";

/** Why a kept row stays. */
export const CLOSED_SERVER_PURGE_KEEP_REASONS = {
  billing: "billing records, kept for their legal period (design: billing kept)",
  audit: "audit and security records, kept for their period (design: audit kept); or a row an audit row names",
  receipt: "migration receipts: kept as they are (design v1, Tenny); a receipt channel names its migration (RESTRICT)",
  agent_tombstone: "the agents rows stay, like the servers row: kept channels' messages and receipt channels (RESTRICT) name them",
  hosted_runtime_tombstone: "the hosted_runtimes step's deletion tombstone: the provision worker deletes the provider's agent from it (deleting the row would cancel that)",
  computer: "the server's Computers: deleted only through machineService.deleteMachine (unbind, revoke, notices), not a plain delete; follow-up",
  membership: "server_members: the joint human membership mirror reads it (retired at close); deleting memberships needs the joint owners' decision; follow-up",
  attribution: "SET NULL: the row belongs elsewhere and only records this server or agent",
  public_route: "the 0347 triggers' public-route row, which records the server's deletion; kept with the reserved slug",
  permanent_identity: "a permanent identity that must never be reused (no expiry by design)",
} as const;
export type ClosedServerPurgeKeepReason = keyof typeof CLOSED_SERVER_PURGE_KEEP_REASONS;

/**
 * The finish's steps that delete classified rows themselves, in the order
 * they run (closedServerPurgeFinish.ts): each deletes its own rows with the
 * same batches and scope, after its external work (an uninstall, a revoke).
 */
export const CLOSED_SERVER_PURGE_ROW_STEPS = ["server_rows", "credential_revoke", "app_installs", "slack_bridge"] as const;
export type ClosedServerPurgeRowStep = (typeof CLOSED_SERVER_PURGE_ROW_STEPS)[number];

/** Steps before server_rows that delete a key's rows. */
export type ClosedServerPurgeEarlierStep = "apps" | "channels" | "object_events" | "agents" | "wechat_bridge" | "object_files_sweep";

export type ClosedServerPurgeKeyClassification =
  | { onDelete: ClosedServerPurgeOnDelete; purge: "delete"; by: ClosedServerPurgeEarlierStep }
  | { onDelete: ClosedServerPurgeOnDelete; purge: "delete"; by: ClosedServerPurgeRowStep; channels?: readonly string[]; channelExempt?: string; scan?: string; unlessReferencedBy?: readonly string[] }
  | { onDelete: ClosedServerPurgeOnDelete; purge: "delete"; via: string }
  /** Deleted by the row step's own code (an uninstall, the Slack step's install delete), never by its row deletes. */
  | { onDelete: ClosedServerPurgeOnDelete; purge: "delete"; ownedBy: Exclude<ClosedServerPurgeRowStep, "server_rows"> }
  | { onDelete: ClosedServerPurgeOnDelete; purge: "delete"; cascadeFrom: string }
  | { onDelete: ClosedServerPurgeOnDelete; purge: "keep"; reason: ClosedServerPurgeKeepReason };

const cascade = "cascade" as const;
const setNull = "set null" as const;
const restrict = "restrict" as const;
const noAction = "no action" as const;
type RowExtra = { channels?: readonly string[]; channelExempt?: string; scan?: string; unlessReferencedBy?: readonly string[] };
const rows = (onDelete: ClosedServerPurgeOnDelete = cascade, extra: RowExtra = {}) =>
  ({ onDelete, purge: "delete", by: "server_rows", ...extra }) as const;
const stepRows = (step: Exclude<ClosedServerPurgeRowStep, "server_rows">, onDelete: ClosedServerPurgeOnDelete = cascade, extra: RowExtra = {}) =>
  ({ onDelete, purge: "delete", by: step, ...extra }) as const;
const by = (step: ClosedServerPurgeEarlierStep, onDelete: ClosedServerPurgeOnDelete = cascade) => ({ onDelete, purge: "delete", by: step }) as const;
const via = (key: string, onDelete: ClosedServerPurgeOnDelete = cascade) => ({ onDelete, purge: "delete", via: key }) as const;
const ownedBy = (step: Exclude<ClosedServerPurgeRowStep, "server_rows">, onDelete: ClosedServerPurgeOnDelete = cascade) => ({ onDelete, purge: "delete", ownedBy: step }) as const;
const cascadeFrom = (table: string, onDelete: ClosedServerPurgeOnDelete = cascade) => ({ onDelete, purge: "delete", cascadeFrom: table }) as const;
const keep = (reason: ClosedServerPurgeKeepReason, onDelete: ClosedServerPurgeOnDelete = cascade) => ({ onDelete, purge: "keep", reason }) as const;

const SMALL = "a small table (a few rows per server or agent); a seq scan per batch is bounded";

/**
 * Every foreign key to `servers.id` or `agents.id`, as `[schema.]table.column`
 * (no schema: public). The `server_rows` entries run in this order.
 */
export const CLOSED_SERVER_PURGE_CLASSIFICATION = {
  // ── Earlier steps ──
  "app_artifacts.items.server_id": by("apps"),
  "app_artifacts.blobs.server_id": by("apps"),
  "app_artifacts.search.server_id": by("apps"),
  "channels.server_id": by("channels"),
  "object_events.server_id": by("object_events"),
  "object_inbox_states.server_id": by("object_events"),
  "object_files.server_id": by("object_files_sweep"),
  "agent_activity_summary_v2.agent_id": by("agents"),
  "wechat_bridge_attempts.server_id": by("wechat_bridge"),
  "wechat_bridge_bindings.server_id": by("wechat_bridge"),
  "wechat_bridge_bindings.agent_id": via("wechat_bridge_bindings.server_id"),

  // ── server_rows, in order: the agents' rows ──
  "agent_activity_events.agent_id": rows(),
  "agent_api_idempotency_keys.agent_id": rows(),
  "agent_archives.server_id": rows(),
  "agent_archives.agent_id": via("agent_archives.server_id"),
  "agent_bootstrap_tokens.server_id": rows(),
  "agent_bootstrap_tokens.target_agent_id": via("agent_bootstrap_tokens.server_id"),
  "agent_channel_read_cursors.agent_id": rows(cascade, { channels: ["channel_id"] }),
  "agent_config_change_events.server_id": rows(),
  "agent_config_change_events.agent_id": via("agent_config_change_events.server_id"),
  "agent_usage_daily.server_id": rows(),
  "agent_usage_daily.agent_id": via("agent_usage_daily.server_id"),
  "agent_usage_context.server_id": rows(),
  "agent_usage_context.agent_id": via("agent_usage_context.server_id"),
  "agent_context_view_grants.server_id": rows(),
  "agent_context_view_grants.grantee_agent_id": via("agent_context_view_grants.server_id"),
  "agent_inbox_push_registrations.agent_id": rows(),
  "agent_inbox_push_registrations.server_id": via("agent_inbox_push_registrations.agent_id"),
  "agent_inbox_events_pending_acks.agent_id": rows(),
  "agent_inbox_late_pending.agent_id": rows(),
  "agent_inbox_skip_records.agent_id": rows(),
  "agent_credentials.agent_id": rows(),
  "agent_knowledge_events.server_id": rows(),
  "agent_knowledge_events.agent_id": via("agent_knowledge_events.server_id"),
  "agent_model_limits_reports.agent_id": rows(),
  "agent_model_limits_reports.server_id": via("agent_model_limits_reports.agent_id"),
  "agent_operator_events.server_id": rows(),
  "agent_operator_events.agent_id": via("agent_operator_events.server_id"),
  "agent_private_surfaces.agent_id": rows(cascade, { channels: ["channel_id"] }),
  "agent_private_surfaces.server_id": via("agent_private_surfaces.agent_id"),
  // Before provider_connections (RESTRICT).
  "agent_provider_connections.server_id": rows(),
  "agent_provider_connections.agent_id": via("agent_provider_connections.server_id"),
  "agent_runtime_approvals.server_id": rows(),
  "agent_runtime_approvals.agent_id": via("agent_runtime_approvals.server_id"),
  "agent_runtime_profiles.server_id": rows(),
  "agent_runtime_profiles.agent_id": via("agent_runtime_profiles.server_id"),
  "agent_scopes.server_id": rows(),
  "agent_scopes.agent_id": via("agent_scopes.server_id"),
  "agent_task_nudge_sends.agent_id": rows(),
  "agent_task_nudges.agent_id": rows(),
  "agent_turn_triggers.agent_id": rows(cascade, { channels: ["wechat_allowed_channel_id"] }),
  "app_agent_messages.agent_id": rows(),
  "assistant_check_state.agent_id": rows(),
  "assistant_checks.agent_id": rows(),
  "assistant_contact_rules.agent_id": rows(),
  "assistant_contact_settings.agent_id": rows(),
  "assistant_doorbell_sources.agent_id": rows(cascade, { channels: ["source_channel_id"] }),
  "assistant_doorbells.agent_id": rows(),
  "assistant_doorbells.server_id": via("assistant_doorbells.agent_id"),
  "assistant_owner_notes.agent_id": rows(),
  "assistant_told.agent_id": rows(cascade, { channels: ["channel_id"] }),
  "assistant_wechat_mirror_marks.agent_id": rows(),
  // Tenny #55 (5): deleted with the server, audit-like or not (billing and the security/integration audit stay).
  "attested_send_events.agent_id": rows(),
  "attested_send_events.server_id": via("attested_send_events.agent_id", setNull),
  "attested_send_pending_drafts.agent_id": rows(cascade, { channels: ["channel_id"] }),
  "attested_send_pending_drafts.server_id": via("attested_send_pending_drafts.agent_id"),
  "mention_delivery_occurrences.agent_id": rows(),
  "mention_delivery_occurrences.server_id": via("mention_delivery_occurrences.agent_id"),
  "third_party_agent_events.agent_id": rows(cascade, { channels: ["related_channel_id"] }),
  "third_party_agent_events.server_id": via("third_party_agent_events.agent_id"),
  "raftbench_latest_runs.agent_id": rows(cascade, { scan: SMALL }),
  "raftbench_reader_grants.server_id": rows(),
  "raftbench_reader_grants.agent_id": via("raftbench_reader_grants.server_id"),
  "raftbench_service_agents.server_id": rows(),
  "raftbench_service_agents.agent_id": via("raftbench_service_agents.server_id"),
  "raftbench_configs.server_id": rows(),
  "raftbench_configs.agent_id": via("raftbench_configs.server_id", setNull),
  "rap_app_configs.server_id": rows(),
  "rap_app_configs.subject_agent_id": via("rap_app_configs.server_id"),
  "server_agent_members.server_id": rows(),
  "server_agent_members.agent_id": via("server_agent_members.server_id"),

  // ── server_rows: the server's own settings, credentials and state ──
  "activity_sync_principal_authorities.server_id": rows(),
  "activity_sync_scopes.server_id": rows(),
  "hosted_runtime_server_plans.server_id": rows(),
  "inbox_target_mute_states.server_id": rows(cascade, { channels: ["source_channel_id"] }),
  "managed_mcp_assignments.server_id": rows(),
  "managed_mcp_assignments.agent_id": via("managed_mcp_assignments.server_id"),
  "managed_mcp_oauth_attempts.server_id": rows(),
  "notification_recipients.server_id": rows(),
  "notification_events.server_id": rows(),
  "product_feedback_locators.server_id": rows(),
  "product_feedback_locators.producer_agent_id": via("product_feedback_locators.server_id"),
  "provider_probe_receipts.server_id": rows(cascade, { scan: SMALL }),
  "provider_probe_intents.server_id": rows(),
  "read_mutations.server_id": rows(),
  "read_mutation_authorities.server_id": rows(),
  "reminder_app_migrations.server_id": rows(),
  // The reminder app's table (apps/reminder/sourceAckSchema.ts): core does not write it; it goes with its reminder.
  "reminder_source_acknowledgements.server_id": cascadeFrom("reminders"),
  "reminder_source_acknowledgements.owner_agent_id": cascadeFrom("reminders"),
  "reminder_source_acknowledgements.acknowledged_by_agent_id": cascadeFrom("reminders"),
  "reminder_events.server_id": rows(),
  "reminder_events.owner_agent_id": via("reminder_events.server_id"),
  // A task in a kept channel may name its follow-up reminder (NO ACTION).
  "reminders.server_id": rows(cascade, { channels: ["target_channel_id"], unlessReferencedBy: ["tasks.resource_expiry_followup_id"] }),
  "reminders.owner_agent_id": via("reminders.server_id"),
  "server_invites.server_id": rows(),
  "server_join_links.server_id": rows(),
  "server_lab_access.server_id": rows(),
  "server_lab_enrollments.server_id": rows(),
  "server_sso_connections.server_id": rows(),
  "server_sso_domains.server_id": rows(),
  "system_attention_incidents.server_id": rows(),
  "user_channel_display_prefs.server_id": rows(cascade, { channels: ["channel_id"] }),
  "user_channel_notification_prefs.server_id": rows(cascade, { channels: ["channel_id"], scan: SMALL }),
  // A kept channel's workflow instance may name its template (RESTRICT).
  "workflow_templates.server_id": rows(cascade, { unlessReferencedBy: ["workflow_instances.template_id"] }),

  // ── Kept: billing ──
  "appsumo_license_bindings.server_id": keep("billing", setNull),
  "appsumo_redemption_claims.bound_server_id": keep("billing", setNull),
  "billing_checkout_attempts.server_id": keep("billing"),
  "billing_source_guards.server_id": keep("billing"),
  "paid_lifecycle_payments.server_id": keep("billing"),
  "prepaid_pro_purchases.server_id": keep("billing", setNull),
  "seat_join_blocks.server_id": keep("billing"),
  "server_file_upload_usage_months.server_id": keep("billing"),
  "subscriptions.server_id": keep("billing"),
  "translation_quota_buckets.server_id": keep("billing"),

  // ── Kept: audit ──
  "channel_membership_role_events.server_id": by("channels"),
  "integration_audit_events.server_id": keep("audit", setNull),
  "server_lab_audit_events.server_id": keep("audit"),
  "server_member_role_audit_events.server_id": keep("audit"),
  "server_membership_agreement_audit.server_id": keep("audit"),
  "server_membership_departures.server_id": keep("audit"),
  // server_membership_agreement_audit names its agreement (NO ACTION).
  "server_agreements.server_id": keep("audit"),

  // ── Kept: with their channel or message ──
  "action_cards.server_id": by("channels"),
  "action_cards.requester_agent_id": by("channels"),
  "agent_lounges.server_id": by("channels"),
  "agent_lounges.agent_id": by("channels", setNull),
  "attachment_upload_sessions.server_id": by("channels"),
  "channel_agents.agent_id": by("channels"),
  "channel_conversion_commands.server_id": by("channels"),
  "channel_conversion_fences.server_id": by("channels"),
  "channel_conversion_jobs.server_id": by("channels"),
  "channel_external_invites.host_server_id": by("channels"),
  "channel_external_invites.accepted_server_id": by("channels", setNull),
  "channel_external_invites.connect_server_id": by("channels", setNull),
  "channel_server_connect_requests.host_server_id": by("channels"),
  "channel_server_connect_requests.target_server_id": by("channels"),
  "channels.archived_by_agent_id": by("channels", setNull),
  "dm_channel_identities.server_id": by("channels"),
  "inbox_notification_facts.server_id": by("channels"),
  "message_card_revisions.sender_agent_id": by("channels"),
  "message_mentions.server_id": by("channels"),
  "message_translations.server_id": by("channels"),
  "notification_outbox.server_id": by("channels"),
  "share_artifacts.server_id": by("channels"),
  "tasks.resource_teardown_owner_agent_id": by("channels", noAction),
  "user_saved.server_id": by("channels"),
  "workflow_instances.server_id": by("channels"),

  // ── Kept: joint channels, receipts ──
  "joint_channel_admissions.server_id": by("channels"),
  "joint_channel_invites.from_server_id": by("channels"),
  "joint_channel_invites.to_server_id": by("channels"),
  "joint_channel_servers.server_id": by("channels"),
  "joint_channels.created_by_server_id": by("channels"),
  "joint_membership_departures.server_id": by("channels"),
  "joint_membership_removals.agent_id": by("channels"),
  "agent_migration_receipt_channels.server_id": keep("receipt", restrict),
  "agent_migration_receipt_channels.agent_id": keep("receipt", restrict),
  "agent_migration_receipt_outbox.server_id": by("channels"),
  "agent_migration_receipt_outbox.agent_id": by("channels"),
  "agent_migrations.server_id": keep("receipt"),
  "agent_migrations.agent_id": keep("receipt"),
  // The agent that ran `raft migration retry` (#14267); the row is kept, so is this.
  "agent_migrations.triggered_by_agent_id": keep("receipt", setNull),

  // ── Kept: tombstones ──
  "agents.server_id": keep("agent_tombstone"),
  "agent_runtime_provisions.agent_id": keep("hosted_runtime_tombstone"),
  "agent_runtime_provisions.server_id": keep("hosted_runtime_tombstone"),
  "server_public_routes.server_id": keep("public_route"),
  "read_mutation_tombstones.server_id": keep("permanent_identity"),

  // ── credential_revoke: revoked at the provider where it can be, then deleted (Tenny #55) ──
  "managed_mcp_credentials.server_id": stepRows("credential_revoke"),
  "managed_mcp_servers.server_id": stepRows("credential_revoke"),
  "provider_connection_credentials.server_id": stepRows("credential_revoke"),
  "provider_connections.server_id": stepRows("credential_revoke"),

  // ── app_installs: every install uninstalled by the system, then the rest of the server's app rows (Tenny #55 (2)) ──
  "oauth_client_installs.server_id": ownedBy("app_installs"),
  "oauth_client_installs.installed_by_agent_id": via("oauth_client_installs.server_id"),
  "oauth_app_installation_tokens.server_id": cascadeFrom("oauth_client_installs"),
  "app_bot_bindings.server_id": stepRows("app_installs"),
  "app_bot_bindings.agent_id": via("app_bot_bindings.server_id", restrict),
  "oauth_access_requests.server_id": stepRows("app_installs"),
  "oauth_access_requests.agent_id": stepRows("app_installs"),
  "oauth_access_tokens.agent_id": stepRows("app_installs"),
  "oauth_access_tokens.server_id": stepRows("app_installs"),
  "oauth_agent_auto_grant_blocks.agent_id": stepRows("app_installs"),
  "oauth_agent_auto_grant_blocks.server_id": via("oauth_agent_auto_grant_blocks.agent_id"),
  "oauth_client_maintainers.agent_id": stepRows("app_installs"),
  "oauth_client_share_links.target_server_id": stepRows("app_installs"),
  "oauth_client_share_links.created_by_agent_id": stepRows("app_installs"),
  "oauth_grants.server_id": stepRows("app_installs"),
  "oauth_grants.agent_id": via("oauth_grants.server_id"),
  "oauth_link_preview_declines.server_id": stepRows("app_installs"),
  "oauth_user_consents.server_id": stepRows("app_installs"),
  "official_app_auto_install_transitions.server_id": stepRows("app_installs"),
  "official_app_auto_install_states.server_id": stepRows("app_installs"),
  // Only an app never shared (closedServerPurgeFinish.ts ownAppNeverSharedSql) and app roots left with no profile; a published or shared app stays.
  "oauth_clients.server_id": ownedBy("app_installs"),
  "oauth_clients.owner_agent_id": via("oauth_clients.server_id", setNull),
  "raft_apps.server_id": ownedBy("app_installs"),

  // ── slack_bridge: the server's bridge records, then each install only it used (its token revoked at Slack first) ──
  "external_channel_bindings.server_id": stepRows("slack_bridge", cascade, { channelExempt: "the binding is this server's Slack connection, not the channel's content: a kept channel's binding goes too, or the install (RESTRICT) and its token would stay" }),
  "external_human_identity_links.server_id": stepRows("slack_bridge"),
  "slack_usergroup_identities.server_id": stepRows("slack_bridge"),
  "external_oauth_attempts.server_id": stepRows("slack_bridge"),
  "external_app_install_server_grants.server_id": stepRows("slack_bridge"),
  // Only an install no other server holds a grant on (the step's own delete); a shared one keeps its legacy owner.
  "external_app_installs.server_id": ownedBy("slack_bridge", restrict),
  "external_app_server_grants.server_id": stepRows("slack_bridge", cascade, { unlessReferencedBy: ["external_app_installs.server_grant_id", "external_app_install_server_grants.server_grant_id"] }),

  // ── Kept: follow-ups through their own paths ──
  "computers.server_id": keep("computer"),
  "daemons.server_id": keep("computer"),
  "computer_lifecycle_dispatches.origin_server_id": keep("computer"),
  "computer_lifecycle_operations.server_id": keep("computer"),
  "computer_outage_occurrences.server_id": keep("computer"),
  "computer_upgrade_requests.server_id": keep("computer"),
  "server_members.server_id": keep("membership"),
  "inbox_suppression_states.server_id": by("channels"),

  // ── Kept: attribution only ──
  "announcement_audit_events.actor_agent_id": keep("attribution", setNull),
  "announcement_image_assets.created_by_agent_id": keep("attribution", setNull),
  "announcements.created_by_agent_id": keep("attribution", setNull),
  "announcements.updated_by_agent_id": keep("attribution", setNull),
  "device_login_grants.server_id": keep("attribution", setNull),
  "device_login_grants.agent_id": keep("attribution", setNull),
  "push_registrations.server_id": keep("attribution", setNull),
  "web_push_prompt_events.server_id": keep("attribution", setNull),
} as const satisfies Record<string, ClosedServerPurgeKeyClassification>;

export type ClosedServerPurgeKey = keyof typeof CLOSED_SERVER_PURGE_CLASSIFICATION;

/**
 * The tables each step deletes from itself (its cascades are the test's to
 * follow): closedServerPurgeDelete.ts's channel step (finishChannel and the
 * message batches), the object-event step, the agents step, the apps' own
 * purge, the WeChat cleanup, the object-file sweep, and server_rows.
 */
export const CLOSED_SERVER_PURGE_STEP_TABLES: Record<ClosedServerPurgeEarlierStep | ClosedServerPurgeRowStep, readonly string[]> = {
  apps: ["app_artifacts.items", "app_artifacts.blobs", "app_artifacts.search"],
  channels: ["channels", "messages", "attachments", "tasks", "workflow_instances", "agent_lounges", "channel_server_connect_requests", "channel_external_invites", ...CLOSED_SERVER_PURGE_BRIDGE_TABLES],
  object_events: ["object_events", "object_inbox_states"],
  agents: ["agent_activity_summary_v2"],
  wechat_bridge: ["wechat_bridge_bindings", "wechat_bridge_attempts"],
  object_files_sweep: ["object_files"],
  get server_rows() {
    return closedServerPurgeRowDeletes("server_rows").map((entry) => entry.table);
  },
  get credential_revoke() {
    return closedServerPurgeRowDeletes("credential_revoke").map((entry) => entry.table);
  },
  // The system uninstall deletes the install rows (oauthService.uninstallOAuthClientInstallsOfClosedServer).
  get app_installs() {
    return ["oauth_client_installs", ...closedServerPurgeRowDeletes("app_installs").map((entry) => entry.table), "oauth_clients", "raft_apps"];
  },
  // The step deletes each install only this server used (closedServerPurgeFinish.ts).
  get slack_bridge() {
    return ["external_app_installs", ...closedServerPurgeRowDeletes("slack_bridge").map((entry) => entry.table)];
  },
};

const ARTIFACTS = "the Artifacts app's own rows, with their item (the app's purgeServer deletes the items)";
const CHANNEL_PEOPLE = "who reads or follows a cleared channel, with the channel";
const MESSAGE_PARTS = "parts of a cleared channel's messages, attachments, tasks and workflows, with them";
const BRIDGE_FACTS = "bridge records of a cleared channel's messages, with them (a channel still bound to a bridge is never cleared: the channel step blocks it)";
const CHANNEL_JOINT = "joint and conversion state of a cleared channel; kept channels (joint projections, canonical channels) are never cleared, so theirs stays";

/**
 * Tables a step's delete reaches through ON DELETE CASCADE that have no key
 * to servers or agents of their own (so no classification), and why that is
 * right. The test follows every step's cascades, through every level.
 */
export const CLOSED_SERVER_PURGE_CASCADES: Record<string, string> = {
  // the Artifacts app's own rows, with their item (the app's purgeServer deletes the items)
  "app_artifacts.versions": ARTIFACTS,
  "app_artifacts.audit": ARTIFACTS,
  "app_artifacts.comments": ARTIFACTS,
  "app_artifacts.pending_notices": ARTIFACTS,
  "app_artifacts.read_positions": ARTIFACTS,
  "app_artifacts.subscriptions": ARTIFACTS,
  "app_artifacts.attachment_saves": ARTIFACTS,
  "app_artifacts.comment_drafts": ARTIFACTS,
  "app_artifacts.reviews": ARTIFACTS,
  "app_artifacts.version_files": ARTIFACTS,
  "app_artifacts.version_texts": ARTIFACTS,
  "app_artifacts.version_checks": ARTIFACTS,
  // who reads or follows a cleared channel, with the channel
  "channel_humans": CHANNEL_PEOPLE,
  "user_channel_read_cursors": CHANNEL_PEOPLE,
  "thread_follows": CHANNEL_PEOPLE,
  "user_channel_inbox_states": CHANNEL_PEOPLE,
  "channel_last_posts": CHANNEL_PEOPLE,
  "notification_mobile_deferrals": CHANNEL_PEOPLE,
  // parts of a cleared channel's messages, attachments, tasks and workflows, with them
  "message_reactions": MESSAGE_PARTS,
  "message_reaction_discussion_versions": MESSAGE_PARTS,
  "message_reaction_viewer_versions": MESSAGE_PARTS,
  "message_server_timeline": MESSAGE_PARTS,
  "attachment_comment_refs": MESSAGE_PARTS,
  "attachment_preview_cache": MESSAGE_PARTS,
  "task_events": MESSAGE_PARTS,
  "workflow_step_instances": MESSAGE_PARTS,
  // bridge records of a cleared channel's messages, with them (a channel still bound to a bridge is never cleared: the channel step blocks it)
  "external_mention_facts": BRIDGE_FACTS,
  "external_message_author_facts": BRIDGE_FACTS,
  "external_reaction_commands": BRIDGE_FACTS,
  "external_reaction_command_attempts": BRIDGE_FACTS,
  "external_reaction_states": BRIDGE_FACTS,
  "wechat_bridge_inbound_messages": BRIDGE_FACTS,
  "wechat_bridge_outbound_messages": BRIDGE_FACTS,
  // joint and conversion state of a cleared channel; kept channels (joint projections, canonical channels) are never cleared, so theirs stays
  "joint_channel_members": CHANNEL_JOINT,
  "joint_membership_generations": CHANNEL_JOINT,
  "joint_admission_recoveries": CHANNEL_JOINT,
  "channel_conversion_phase_ledger": CHANNEL_JOINT,
  channel_public_routes: "a cleared channel's public route (the 0347 triggers'), with the channel",
  slack_verified_ingress_file_facts: "the files of a cleared channel's raw Slack events, with the events",
  oauth_app_webhook_configs: "a never-shared app's webhook config, with the app",
  oauth_app_permission_revisions: "a never-shared app's permission revisions, with the app",
  oauth_app_link_previews: "a never-shared app's link-preview registration, with the app",
  oauth_app_text_revisions: "a never-shared app's text revisions, with the app",
  app_oauth_profiles: "a never-shared app's profile (it links the app root to the app), with the app",
  app_mcp_profiles: "an app's MCP profile bound to this server's managed MCP server: nothing to connect to",
  external_app_credentials: "the Slack install's credential, with the install (its token revoked at Slack first)",
  external_app_install_grant_receipts: "Slack's grant receipts for the install, with the install",
  external_binding_audience_snapshots: "a Slack binding's audience snapshots, with the binding",
  object_event_recipients: "who an object event went to, with the event",
  activity_sync_changes: "the Activity window's changes, with their scope",
  activity_sync_rows: "the Activity window's rows, with their scope",
  activity_sync_row_authorities: "the Activity rows' version authorities, with their principal authority",
  agent_runtime_approval_cards: "the cards of a hosted agent's held approvals, with the approvals",
  notification_delivery_attempts: "the attempts of those deliveries",
  notification_deliveries: "the app notification outbox's deliveries, with their recipients (30 days after close: delivered or dead)",
  raftbench_findings: "RaftBench findings of the server's benchmark config",
  raftbench_message_labels: "RaftBench message labels of the server's benchmark config",
  raftbench_triage_batches: "RaftBench triage batches of the server's benchmark config",
  saml_assertion_replay: "SSO replay guards of the server's SSO connection",
  sso_auth_transactions: "SSO sign-in transactions of the server's SSO connection",
  sso_identities: "who signed in through the server's SSO connection: the connection is gone",
  system_attention_receipts: "receipts of the server's attention incidents",
};

/** One server_rows delete: the table and how its rows are found. */
export interface ClosedServerPurgeRowDelete {
  key: ClosedServerPurgeKey;
  step: ClosedServerPurgeRowStep;
  /** Why rows naming a kept channel go too (no channel columns excluded). */
  channelExempt?: string;
  table: string;
  column: string;
  /** The key is to agents: the rows of the server's agents. */
  agentKey: boolean;
  /** `table.column` keys to this table's `id` whose rows keep a row. */
  unlessReferencedBy: readonly string[];
  /** Channel columns: a row naming a kept channel in any of them stays. */
  channelColumns: readonly string[];
}

const isRowStep = (by: string): by is ClosedServerPurgeRowStep => (CLOSED_SERVER_PURGE_ROW_STEPS as readonly string[]).includes(by);

/**
 * The row deletes of one row step (or, without one, of every row step in the
 * order they run), each step's in this file's order (public tables only: an
 * app's tables are its purgeServer's).
 */
export function closedServerPurgeRowDeletes(only?: ClosedServerPurgeRowStep): ClosedServerPurgeRowDelete[] {
  const steps = only ? [only] : CLOSED_SERVER_PURGE_ROW_STEPS;
  return steps.flatMap((step) => rowDeletesOf(step));
}

function rowDeletesOf(step: ClosedServerPurgeRowStep): ClosedServerPurgeRowDelete[] {
  const deletes: ClosedServerPurgeRowDelete[] = [];
  for (const [key, classification] of Object.entries(CLOSED_SERVER_PURGE_CLASSIFICATION) as Array<[ClosedServerPurgeKey, ClosedServerPurgeKeyClassification]>) {
    if (!("by" in classification) || !isRowStep(classification.by) || classification.by !== step) continue;
    const [table, column] = key.split(".") as [string, string];
    deletes.push({
      key,
      step,
      ...("channelExempt" in classification && classification.channelExempt ? { channelExempt: classification.channelExempt } : {}),
      table,
      column,
      agentKey: /agent_id$/.test(column),
      unlessReferencedBy: ("unlessReferencedBy" in classification && classification.unlessReferencedBy) || [],
      channelColumns: ("channels" in classification && classification.channels) || [],
    });
  }
  return deletes;
}
