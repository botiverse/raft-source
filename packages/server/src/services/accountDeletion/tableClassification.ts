/**
 * What deleting an account does to each row that names the person (design
 * "删除账号：服务端设计 v2" §7.1). The `users` row is never deleted (it is
 * retired and scrubbed), so no `ON DELETE` action ever fires: every foreign
 * key to `users.id` is classified here, and the cleanup
 * (services/accountDeletion/cleanup.ts) does what the classification says.
 *
 * - `delete`: personal or short-lived data; the cleanup deletes the person's
 *   rows (cleanup.ts DELETE_STEP_OVERRIDES says how where a plain
 *   `DELETE ... WHERE column = person` is not enough).
 * - `keep`: shared records others still need (memberships, history, audit, a
 *   server's apps); an optional `action` ends what is still live
 *   (cleanup.ts KEEP_ACTIONS implements each one).
 * - `n/a`: `set null`, `restrict` and `no action` keys only record who did
 *   something; the row stays as it is (an `action` may still apply).
 *
 * Adding a foreign key to `users.id` fails tableClassification.test.ts until
 * it is classified here, with the same `onDelete` as the schema: decide
 * whether the cleanup deletes the rows, keeps them, or ends something first.
 */

export type UserForeignKeyOnDelete = "cascade" | "set null" | "restrict" | "no action";

/** What the cleanup does to a kept row that is still live (cleanup.ts KEEP_ACTIONS). */
export type AccountDeletionKeepAction =
  | "expire_pending_invites"
  | "revoke_active_links"
  | "cancel_pending_connect_requests"
  | "void_pending_action_cards"
  | "revoke_unused_bootstrap_tokens"
  | "revoke_app_maintainer"
  | "revoke_daemons"
  | "clear_computer_ownership"
  | "reset_member_preferences"
  | "revoke_push_registrations";

export type UserForeignKeyClassification =
  | { onDelete: "cascade"; cleanup: "delete" }
  | { onDelete: "cascade"; cleanup: "keep"; action?: AccountDeletionKeepAction }
  | { onDelete: Exclude<UserForeignKeyOnDelete, "cascade">; cleanup: "n/a"; action?: AccountDeletionKeepAction };

const del = { onDelete: "cascade", cleanup: "delete" } as const;
const keep = (action?: AccountDeletionKeepAction) => ({ onDelete: "cascade", cleanup: "keep", ...(action ? { action } : {}) }) as const;
const setNull = { onDelete: "set null", cleanup: "n/a" } as const;
const restrict = { onDelete: "restrict", cleanup: "n/a" } as const;
const noAction = { onDelete: "no action", cleanup: "n/a" } as const;

/** Every foreign key to `users.id`, as `table.column`. */
export const USER_FOREIGN_KEY_CLASSIFICATION = {
  // ── Sign-in and sessions: delete (session_families last: cleanup.ts) ──
  "user_auth_identities.user_id": del,
  "social_auth_completions.user_id": del,
  "app_login_requests.user_id": del,
  "sessions.user_id": del,
  "session_token_predecessors.user_id": del,
  "session_refresh_rotation_receipts.user_id": del,
  "session_families.user_id": del,
  "email_verifications.user_id": del,
  "password_resets.user_id": del,
  // ── Two-step verification: delete ──
  "webauthn_credentials.user_id": del,
  "user_totp.user_id": del,
  "user_backup_codes.user_id": del,
  "auth_challenges.user_id": del,
  "second_factor_attempt_windows.user_id": del,
  "second_factor_recovery_requests.user_id": del,
  "reauth_attempt_windows.user_id": del,
  // ── Third-party authorization: delete ──
  "oauth_access_requests.user_id": del,
  "oauth_access_tokens.user_id": del,
  "oauth_user_consents.user_id": del,
  "oauth_link_preview_declines.user_id": del,
  "external_human_identity_links.user_id": del,
  "external_oauth_attempts.requesting_user_id": del,
  "managed_mcp_oauth_attempts.user_id": del,
  // ── Notifications and email: delete (Resend first for the contacts and journeys) ──
  "notification_outbox.receiver_id": del,
  "notification_mobile_deferrals.receiver_id": del,
  "push_subscriptions.user_id": del,
  "web_push_prompt_events.user_id": del,
  "user_notification_settings.user_id": del,
  "user_channel_notification_prefs.user_id": del,
  "user_notification_level_versions.user_id": del,
  "system_attention_receipts.user_id": del,
  "user_announcement_dismissals.user_id": del,
  "newsletter_audience_contacts.user_id": del,
  "onboarding_email_journeys.user_id": del,
  // ── Personal state in conversations: delete ──
  "user_channel_read_cursors.user_id": del,
  "user_channel_inbox_states.user_id": del,
  "user_channel_display_prefs.user_id": del,
  "user_saved.user_id": del,
  "message_reaction_viewer_versions.user_id": del,
  "activity_sync_principal_authorities.principal_id": del,
  "activity_sync_scopes.principal_id": del,
  // ── Other personal rows: delete ──
  "seat_join_blocks.user_id": del,
  // A View Context grant goes with its granter's account (unusable from the request on: the granter is retired).
  "agent_context_view_grants.granter_user_id": del,
  "agent_runtime_approval_cards.user_id": del,
  "paid_lifecycle_journeys.user_id": del,
  "appsumo_redemption_claims.user_id": del, // only claims not redeemed: a consumed one is the license's audit
  "user_analytics_ids.user_id": del,
  // The WeChat bridge: already removed (and audited) when the deletion is
  // requested (wechatBridgeCleanup); the inbound tags (context tokens) go here.
  "wechat_bridge_bindings.user_id": del,
  "wechat_bridge_attempts.user_id": del,
  "wechat_bridge_inbound_messages.owner_user_id": del,

  // ── Kept: shared records ──
  "server_members.user_id": keep("reset_member_preferences"),
  // SSO (rfcs/083-server-sso.md): who set the Server's connection up or added a domain.
  "server_sso_connections.created_by_user_id": setNull,
  "server_sso_domains.created_by_user_id": setNull,
  // SSO (rfcs/083-server-sso.md §4): how a Server's IdP knows the person; gone with the account.
  "sso_identities.user_id": del,
  "sso_auth_transactions.test_user_id": del,
  "server_membership_departures.user_id": keep(),
  "joint_channel_admissions.user_id": keep(),
  // joint_admission_recoveries has no key to users: it goes with its
  // joint_channel_admissions row (composite key, cascade), so it is kept too.
  "joint_membership_generations.principal_id": keep(),
  "joint_membership_removals.user_id": keep(),
  "raftbench_reader_grants.granted_by": keep(),
  "user_retirement_receipts.user_id": keep(),
  "user_legal_acceptances.user_id": keep(),
  "account_deletion_requests.user_id": keep(),
  "channel_humans.user_id": keep(),
  "joint_channel_members.user_id": keep(),
  "server_invites.invited_by_user_id": keep("expire_pending_invites"),
  "joint_channel_invites.invited_user_id": keep("expire_pending_invites"),
  "server_join_links.created_by_user_id": keep("revoke_active_links"),
  "oauth_client_share_links.created_by_user_id": keep("revoke_active_links"),
  "channel_server_connect_requests.requester_user_id": keep("cancel_pending_connect_requests"),
  "channel_server_connect_requests.approver_user_id": keep("cancel_pending_connect_requests"),
  "action_cards.requester_user_id": keep("void_pending_action_cards"),
  "channel_conversion_commands.requested_by_user_id": keep(),
  "agent_bootstrap_tokens.issued_by_user_id": keep("revoke_unused_bootstrap_tokens"),
  // A server's apps and benchmark: deleting them would uninstall the app for the whole server.
  "oauth_clients.created_by_user_id": keep(),
  "oauth_client_installs.installed_by_user_id": keep(),
  "oauth_grants.granted_by_user_id": keep(),
  "raftbench_configs.configured_by_user_id": keep(),
  "oauth_client_maintainers.user_id": keep("revoke_app_maintainer"),
  // The person's Computers: deleting is blocked by `restrict` keys and would strand agents.
  "daemons.user_id": keep("revoke_daemons"),

  // ── set null / restrict / no action: who did something; rows stay ──
  "account_deletion_requests.actor_user_id": setNull,
  "action_cards.executed_by_user_id": setNull,
  "action_cards.reconfirmed_by_user_id": setNull,
  "agent_archives.archived_by_user_id": setNull,
  "agent_archives.op_requested_by_user_id": setNull,
  "agent_bootstrap_tokens.revoked_by_user_id": setNull,
  "agent_context_view_grants.revoked_by_user_id": setNull,
  "agent_credentials.created_by_user_id": setNull, // revoked when the deletion was requested
  "agent_credentials.revoked_by_user_id": setNull,
  "agent_migrations.cancel_requested_by_user_id": setNull,
  "agent_migrations.initiated_by_user_id": setNull,
  "agent_operator_events.actor_user_id": setNull,
  "agent_provider_connections.updated_by_user_id": setNull,
  "agent_scopes.updated_by_user_id": setNull,
  "agents.assistant_owner_user_id": setNull, // the assistants are disposed of in the first phase
  "agents.assistant_paused_by_user_id": setNull,
  "announcement_audit_events.actor_user_id": setNull,
  "announcement_image_assets.created_by_user_id": setNull,
  "announcements.created_by_user_id": setNull,
  "announcements.published_by_user_id": setNull,
  "announcements.updated_by_user_id": setNull,
  "appsumo_license_bindings.bound_by_user_id": setNull,
  "channel_conversion_jobs.created_by_user_id": setNull,
  "channel_external_invites.accepted_user_id": setNull,
  "channel_external_invites.connect_authorizer_user_id": setNull,
  "channel_external_invites.connect_joiner_user_id": setNull,
  "channel_external_invites.invited_by_user_id": setNull,
  "channel_external_invites.revoked_by_user_id": setNull,
  "channel_membership_role_events.requester_user_id": restrict,
  "channels.archived_by_user_id": setNull,
  "computer_lifecycle_operations.actor_user_id": setNull,
  "computer_upgrade_requests.requested_by_user_id": setNull,
  "computers.attached_by_user_id": setNull,
  "computers.revoked_by_user_id": setNull,
  // Computer owner v1: the person's owned Computers become Public (audited), on every server.
  "daemons.owner_user_id": { ...setNull, action: "clear_computer_ownership" },
  "device_authorizations.approved_by_user_id": setNull,
  "device_authorizations.revoked_by_user_id": setNull,
  "device_login_grants.approver_user_id": setNull,
  "joint_channel_admissions.admitted_by": setNull,
  "joint_channel_invites.accepted_by_user_id": setNull,
  "joint_channel_invites.invited_by_user_id": setNull,
  "joint_channel_servers.disconnected_by_user_id": setNull,
  "joint_channel_servers.joined_by_user_id": setNull,
  "joint_channels.created_by_user_id": setNull,
  "joint_membership_departures.actor_user_id": setNull,
  "managed_mcp_assignments.updated_by_user_id": setNull,
  "managed_mcp_credentials.created_by_user_id": setNull,
  "managed_mcp_servers.created_by_user_id": setNull,
  "managed_mcp_servers.updated_by_user_id": setNull,
  "mcp_app_templates.created_by_user_id": setNull,
  "mcp_app_templates.updated_by_user_id": setNull,
  "oauth_access_requests.resolved_by_user_id": setNull,
  "oauth_agent_auto_grant_blocks.blocked_by_user_id": setNull,
  "oauth_app_permission_revisions.reviewed_by_user_id": setNull,
  "oauth_app_text_revisions.reviewed_by_user_id": setNull,
  "oauth_app_webhook_configs.updated_by_user_id": setNull,
  "oauth_client_installs.text_confirmed_by_user_id": setNull,
  "oauth_clients.publish_reviewed_by_user_id": setNull,
  "oauth_grants.revoked_by_user_id": setNull,
  "official_app_auto_install_transitions.actor_user_id": setNull,
  "official_app_registry.created_by_user_id": setNull,
  "official_app_registry.updated_by_user_id": setNull,
  "paid_lifecycle_payments.payer_user_id": setNull, // payment records are kept
  "provider_connections.created_by_user_id": setNull,
  "provider_connections.updated_by_user_id": setNull,
  "prepaid_pro_purchases.purchased_by_user_id": setNull, // a payment record: kept, only who paid is cleared
  "prepaid_pro_reminders.recipient_user_id": setNull, // a sent-email record: kept, only who got it is cleared
  "provider_probe_intents.created_by_user_id": setNull,
  "push_registrations.user_id": { ...setNull, action: "revoke_push_registrations" },
  "seat_join_blocks.inviter_user_id": setNull,
  "server_agreements.created_by_user_id": noAction,
  "server_member_role_audit_events.actor_user_id": restrict,
  "server_member_role_audit_events.target_user_id": restrict,
  "server_membership_agreement_audit.actor_user_id": noAction,
  "server_membership_departures.actor_user_id": setNull,
  "servers.owner_id": noAction, // handed over (or the server deleted) in the first phase
  "share_artifacts.created_by_user_id": setNull,
  "subscriptions.created_by_user_id": setNull,
  "subscriptions.updated_by_user_id": setNull,
  "user_retirement_receipts.actor_user_id": restrict,
} as const satisfies Record<string, UserForeignKeyClassification>;

export type UserForeignKey = keyof typeof USER_FOREIGN_KEY_CLASSIFICATION;

/**
 * Tables that hold the person's id without a foreign key (design §7.1, "没有外键"):
 * their personal state, deleted by the cleanup. `where` selects the person's
 * rows with `$1` as the person's id; `batched` tables are deleted in bounded
 * batches (an index leads with the person). Content and authorship (messages,
 * mentions, reactions, tasks, reminders, attachments) and audit or analytics
 * rows keep the id and are not listed: the scrubbed `users` row is what they
 * show.
 */
export const USER_NO_FOREIGN_KEY_PERSONAL_TABLES = [
  { table: "inbox_notification_facts", where: "receiver_type = 'user' AND receiver_id = $1", batched: true },
  { table: "thread_follows", where: "follower_type = 'user' AND follower_id = $1", batched: true },
  { table: "object_event_recipients", where: "recipient_type = 'user' AND recipient_id = $1", batched: true },
  { table: "object_inbox_states", where: "user_id = $1", batched: true },
  { table: "inbox_target_mute_states", where: "receiver_type = 'user' AND receiver_id = $1", batched: true },
  { table: "inbox_suppression_states", where: "receiver_type = 'user' AND receiver_id = $1", batched: true },
  // read_mutation_* and translation_quota_buckets lead their keys with the
  // server: scoped to the servers the person is or was a member of.
  { table: "read_mutations", where: "principal_type = 'human' AND principal_id = $1 AND server_id IN (SELECT server_id FROM server_members WHERE user_id = $1 UNION SELECT server_id FROM server_membership_departures WHERE user_id = $1)", batched: true },
  { table: "read_mutation_tombstones", where: "principal_type = 'human' AND principal_id = $1 AND server_id IN (SELECT server_id FROM server_members WHERE user_id = $1 UNION SELECT server_id FROM server_membership_departures WHERE user_id = $1)", batched: true },
  { table: "read_mutation_authorities", where: "principal_type = 'human' AND principal_id = $1 AND server_id IN (SELECT server_id FROM server_members WHERE user_id = $1 UNION SELECT server_id FROM server_membership_departures WHERE user_id = $1)", batched: false },
  { table: "translation_quota_buckets", where: "actor_type = 'user' AND actor_id = $1::text AND server_id IN (SELECT server_id FROM server_members WHERE user_id = $1 UNION SELECT server_id FROM server_membership_departures WHERE user_id = $1)", batched: false },
  // A handful of rows at most (one per assistant); no index on the owner.
  { table: "assistant_doorbells", where: "owner_user_id = $1", batched: false },
  // activity_sync_row_authorities / _rows / _changes go with their
  // activity_sync_principal_authorities / activity_sync_scopes rows (cascade).
] as const;
