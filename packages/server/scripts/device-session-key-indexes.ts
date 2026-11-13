import type pg from "pg";
import type { TaskConversationIndexSpec } from "./channels-task-conversation-indexes";
import { indexKeysFromDefinition } from "../src/db/postMigrationIndexes";

// Indexes behind the session-family columns a session's revoke follows: a
// device login's (migration device_session_issued_keys, any revoke), a web
// session's (migration web_session_issued_keys, a security revoke) and the
// family that issued a person's Login with Raft code (migration
// oauth_access_requests_approver_session_family, any revoke): the revoke
// cascade's `WHERE <col> = $1` and the ON DELETE SET NULL when a family goes.
// The migrations build them only on small tables; db:migrate:deploy then runs
//   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
// after the migrations and before the post-migration index guard: CREATE INDEX
// CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready (an invalid index left
// by an interrupted build is dropped CONCURRENTLY and built again). Idempotent.
// Run it against the DIRECT (non "-pooler") DATABASE_URL: timeouts are set with
// session-level set_config, which a transaction-mode pooler may not carry over.
export type DeviceSessionKeyIndexSpec = TaskConversationIndexSpec & {
  /**
   * The column whose absence means "nothing to build yet" (indexedColumnExists);
   * default the first of `columns`. Set when an expression key reads a newer
   * column than the plain ones.
   */
  requiredColumn?: string;
  /** As PostMigrationIndexSpec.keys: the key list pg_get_indexdef prints, checked after the build. */
  keys?: string;
};

export const DEVICE_SESSION_KEY_INDEXES: readonly DeviceSessionKeyIndexSpec[] = [
  {
    // ~4.7M rows on production; almost all NULL.
    name: "idx_agent_credentials_issued_by_session_family",
    table: "agent_credentials",
    unique: false,
    columns: ["issued_by_session_family_id"],
    predicate: "(issued_by_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_issued_by_session_family"
  ON "agent_credentials" USING btree ("issued_by_session_family_id")
  WHERE issued_by_session_family_id IS NOT NULL
`,
  },
  {
    // The live ones only (migration device_session_live_key_index): the hourly
    // sweep of revoked device sessions' keys reads these.
    name: "idx_agent_credentials_live_by_session_family",
    table: "agent_credentials",
    unique: false,
    columns: ["issued_by_session_family_id"],
    predicate: "((issued_by_session_family_id IS NOT NULL) AND (revoked_at IS NULL))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_live_by_session_family"
  ON "agent_credentials" USING btree ("issued_by_session_family_id")
  WHERE issued_by_session_family_id IS NOT NULL AND revoked_at IS NULL
`,
  },
  {
    // The live ones only, by issuer (migration agent_credentials_live_by_creator_index):
    // a departure's revoke of the keys the person issued for the server's agents.
    name: "idx_agent_credentials_live_by_creator",
    table: "agent_credentials",
    unique: false,
    columns: ["created_by_user_id"],
    predicate: "(revoked_at IS NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_live_by_creator"
  ON "agent_credentials" USING btree ("created_by_user_id")
  WHERE revoked_at IS NULL
`,
  },
  {
    name: "idx_computers_key_issued_by_session_family",
    table: "computers",
    unique: false,
    columns: ["key_issued_by_session_family_id"],
    predicate: "(key_issued_by_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_computers_key_issued_by_session_family"
  ON "computers" USING btree ("key_issued_by_session_family_id")
  WHERE key_issued_by_session_family_id IS NOT NULL
`,
  },
  {
    // ~4.7M rows on production; only people's own web mints are set.
    name: "idx_agent_credentials_issued_by_web_session_family",
    table: "agent_credentials",
    unique: false,
    columns: ["issued_by_web_session_family_id"],
    predicate: "(issued_by_web_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_issued_by_web_session_family"
  ON "agent_credentials" USING btree ("issued_by_web_session_family_id")
  WHERE issued_by_web_session_family_id IS NOT NULL
`,
  },
  {
    name: "idx_computers_key_issued_by_web_session_family",
    table: "computers",
    unique: false,
    columns: ["key_issued_by_web_session_family_id"],
    predicate: "(key_issued_by_web_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_computers_key_issued_by_web_session_family"
  ON "computers" USING btree ("key_issued_by_web_session_family_id")
  WHERE key_issued_by_web_session_family_id IS NOT NULL
`,
  },
  {
    name: "idx_daemons_key_issued_by_web_session_family",
    table: "daemons",
    unique: false,
    columns: ["key_issued_by_web_session_family_id"],
    predicate: "(key_issued_by_web_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_daemons_key_issued_by_web_session_family"
  ON "daemons" USING btree ("key_issued_by_web_session_family_id")
  WHERE key_issued_by_web_session_family_id IS NOT NULL
`,
  },
  {
    name: "idx_agent_bootstrap_tokens_issued_by_web_session_family",
    table: "agent_bootstrap_tokens",
    unique: false,
    columns: ["issued_by_web_session_family_id"],
    predicate: "(issued_by_web_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_bootstrap_tokens_issued_by_web_session_family"
  ON "agent_bootstrap_tokens" USING btree ("issued_by_web_session_family_id")
  WHERE issued_by_web_session_family_id IS NOT NULL
`,
  },
  {
    // Revoked runner keys, oldest first (migration agent_credentials_revoked_computer_index):
    // the hourly retention sweep deletes those revoked over 30 days ago.
    name: "idx_agent_credentials_revoked_computer",
    table: "agent_credentials",
    unique: false,
    columns: ["revoked_at"],
    predicate: "((revoked_at IS NOT NULL) AND (issued_via = 'computer'::text))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_revoked_computer"
  ON "agent_credentials" USING btree ("revoked_at")
  WHERE revoked_at IS NOT NULL AND issued_via = 'computer'
`,
  },
  {
    // Runner keys never revoked but expired, oldest first (migration
    // agent_credentials_expired_computer_index): a renewal leaves the old key
    // so; the hourly retention sweep deletes those expired over 30 days ago.
    name: "idx_agent_credentials_expired_computer",
    table: "agent_credentials",
    unique: false,
    columns: ["expires_at"],
    predicate: "((expires_at IS NOT NULL) AND (revoked_at IS NULL) AND (issued_via = 'computer'::text))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_expired_computer"
  ON "agent_credentials" USING btree ("expires_at")
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL AND issued_via = 'computer'
`,
  },
  {
    // A Machine's live runner keys (migration agent_credentials_live_runner_by_machine_index):
    // runner credential reconcile on reconnect counts/revokes through it.
    name: "idx_agent_credentials_live_runner_by_machine",
    table: "agent_credentials",
    unique: false,
    columns: ["issued_by_machine_id"],
    predicate: "((revoked_at IS NULL) AND (issued_via = 'computer'::text) AND (issued_by_machine_id IS NOT NULL))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_credentials_live_runner_by_machine"
  ON "agent_credentials" USING btree ("issued_by_machine_id")
  WHERE revoked_at IS NULL AND issued_via = 'computer' AND issued_by_machine_id IS NOT NULL
`,
  },
  {
    // Deleting a session family cascades here (every revoke path), and account deletion deletes by family: ~2.3M rows on production, no index led with family_id. (migration account_deletion_indexes)
    name: "idx_session_token_predecessors_family",
    table: "session_token_predecessors",
    unique: false,
    columns: ["family_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_session_token_predecessors_family"
  ON "session_token_predecessors" USING btree ("family_id")
`,
  },
  {
    // Deleting an agent releases the tasks it claimed (deleteAgent): ~780k rows. (migration account_deletion_indexes)
    name: "idx_tasks_claimed_by_agent",
    table: "tasks",
    unique: false,
    columns: ["claimed_by_id"],
    predicate: "(claimed_by_type = 'agent'::text)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_claimed_by_agent"
  ON "tasks" USING btree ("claimed_by_id")
  WHERE claimed_by_type = 'agent'
`,
  },
  {
    // The server task board's Creator filter and created_by_me tab, across
    // every visible channel (migration tasks_board_filter_indexes).
    name: "idx_tasks_created_by",
    table: "tasks",
    unique: false,
    columns: ["created_by_type", "created_by_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_created_by"
  ON "tasks" USING btree ("created_by_type", "created_by_id")
`,
  },
  {
    // The board's Assignee filter and assigned_to_me tab, claimed rows only
    // (migration tasks_board_filter_indexes).
    name: "idx_tasks_claimed_by",
    table: "tasks",
    unique: false,
    columns: ["claimed_by_type", "claimed_by_id"],
    predicate: "(claimed_by_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_claimed_by"
  ON "tasks" USING btree ("claimed_by_type", "claimed_by_id")
  WHERE claimed_by_id IS NOT NULL
`,
  },
  {
    // The server task board's activity sort, each channel newest activity
    // first (migration tasks_last_activity). Its middle key is an expression,
    // which the pg_index column reads (here and in the post-migration guard)
    // do not list: `columns` holds the plain ones, `keys` the whole key list,
    // and the build waits for last_activity_at itself.
    name: "idx_tasks_channel_activity",
    table: "tasks",
    unique: false,
    columns: ["channel_id", "id"],
    requiredColumn: "last_activity_at",
    predicate: null,
    keys: "channel_id, COALESCE(last_activity_at, updated_at) DESC, id DESC",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_channel_activity"
  ON "tasks" USING btree ("channel_id", COALESCE("last_activity_at", "updated_at") DESC, "id" DESC)
`,
  },
  {
    // The same walk by creation time, sort=created (migration tasks_last_activity).
    name: "idx_tasks_channel_created",
    table: "tasks",
    unique: false,
    columns: ["channel_id", "created_at", "id"],
    predicate: null,
    keys: "channel_id, created_at DESC, id DESC",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_channel_created"
  ON "tasks" USING btree ("channel_id", "created_at" DESC, "id" DESC)
`,
  },
  {
    // A person's agents across servers (account deletion); idx_agents_creator leads with server_id. (migration account_deletion_indexes)
    name: "idx_agents_user_creator",
    table: "agents",
    unique: false,
    columns: ["creator_id"],
    predicate: "(creator_type = 'user'::text)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agents_user_creator"
  ON "agents" USING btree ("creator_id")
  WHERE creator_type = 'user'
`,
  },
  {
    // A person's personal assistants across servers (account deletion). (migration account_deletion_indexes)
    name: "idx_agents_assistant_owner",
    table: "agents",
    unique: false,
    columns: ["assistant_owner_user_id"],
    predicate: "(assistant_owner_user_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agents_assistant_owner"
  ON "agents" USING btree ("assistant_owner_user_id")
  WHERE assistant_owner_user_id IS NOT NULL
`,
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes)
    name: "idx_agent_runtime_profiles_baseline_machine",
    table: "agent_runtime_profiles",
    unique: false,
    columns: ["baseline_machine_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runtime_profiles_baseline_machine"
  ON "agent_runtime_profiles" USING btree ("baseline_machine_id")
`,
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes)
    name: "idx_agent_runtime_profiles_pending_before_machine",
    table: "agent_runtime_profiles",
    unique: false,
    columns: ["pending_before_machine_id"],
    predicate: "(pending_before_machine_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runtime_profiles_pending_before_machine"
  ON "agent_runtime_profiles" USING btree ("pending_before_machine_id")
  WHERE pending_before_machine_id IS NOT NULL
`,
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes)
    name: "idx_agent_runtime_profiles_pending_after_machine",
    table: "agent_runtime_profiles",
    unique: false,
    columns: ["pending_after_machine_id"],
    predicate: "(pending_after_machine_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runtime_profiles_pending_after_machine"
  ON "agent_runtime_profiles" USING btree ("pending_after_machine_id")
  WHERE pending_after_machine_id IS NOT NULL
`,
  },
  {
    // ON DELETE SET NULL from oauth_access_tokens, run per deleted token. (migration account_deletion_indexes)
    name: "idx_third_party_agent_events_access_token",
    table: "third_party_agent_events",
    unique: false,
    columns: ["access_token_id"],
    predicate: "(access_token_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_third_party_agent_events_access_token"
  ON "third_party_agent_events" USING btree ("access_token_id")
  WHERE access_token_id IS NOT NULL
`,
  },
  {
    // A sender's pending mention actions, newest first per server (migration
    // message_mentions_pending_actions_index): ~12M rows on production, ~2.5%
    // in the index; the lookup scanned the whole table for busy senders.
    name: "idx_message_mentions_pending_actions",
    table: "message_mentions",
    unique: false,
    columns: ["server_id", "created_at"],
    predicate: "((source = 'send_path'::text) AND (NOT notifiable_at_send))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_message_mentions_pending_actions"
  ON "message_mentions" USING btree ("server_id", "created_at" DESC)
  WHERE source = 'send_path' AND NOT notifiable_at_send
`,
  },
  {
    // The web session family that issued a person's Login with Raft code
    // (migration oauth_access_requests_approver_session_family): only the ON
    // DELETE SET NULL reads it (a revoke finds the codes by user_id).
    name: "idx_oauth_access_requests_approver_session_family",
    table: "oauth_access_requests",
    unique: false,
    columns: ["approver_session_family_id"],
    predicate: "(approver_session_family_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_access_requests_approver_session_family"
  ON "oauth_access_requests" USING btree ("approver_session_family_id")
  WHERE approver_session_family_id IS NOT NULL
`,
  },
  {
    // What a server is billed for, and each uploader's share of it
    // (migration object_files_billed_uploader_index): putObjectFile's caps.
    name: "idx_object_files_billed_uploader",
    table: "object_files",
    unique: false,
    columns: ["billed_server_id", "uploaded_by_type", "uploaded_by_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_object_files_billed_uploader"
  ON "object_files" USING btree ("billed_server_id", "uploaded_by_type", "uploaded_by_id")
`,
  },
  {
    // RFC 081 inbox items: one agent's unconsumed events by app and object,
    // oldest first: the item list and inbox read (migration inbox_items_object_ref).
    name: "idx_third_party_agent_events_agent_unconsumed_item",
    table: "third_party_agent_events",
    unique: false,
    columns: ["agent_id", "client_id", "system_app", "object_ref", "created_at"],
    predicate: "(status = ANY (ARRAY['queued'::text, 'delivering'::text]))",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_third_party_agent_events_agent_unconsumed_item"
  ON "third_party_agent_events" USING btree ("agent_id", "client_id", "system_app", "object_ref", "created_at")
  WHERE status IN ('queued', 'delivering')
`,
  },
  {
    // The foreign keys a channel delete checks (migration channel_fk_indexes):
    // no index led with the column, so every channel delete scanned the table.
    // ~7.7 GB on production: the largest scan of a channel delete.
    name: "idx_inbox_notification_facts_source_channel",
    table: "inbox_notification_facts",
    unique: false,
    columns: ["source_channel_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_inbox_notification_facts_source_channel"
  ON "inbox_notification_facts" USING btree ("source_channel_id")
`,
  },
  {
    name: "idx_agent_channel_read_cursors_channel",
    table: "agent_channel_read_cursors",
    unique: false,
    columns: ["channel_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_channel_read_cursors_channel"
  ON "agent_channel_read_cursors" USING btree ("channel_id")
`,
  },
  {
    name: "idx_reminders_target_channel",
    table: "reminders",
    unique: false,
    columns: ["target_channel_id"],
    predicate: "(target_channel_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reminders_target_channel"
  ON "reminders" USING btree ("target_channel_id")
  WHERE target_channel_id IS NOT NULL
`,
  },
  {
    name: "idx_user_channel_read_cursors_channel",
    table: "user_channel_read_cursors",
    unique: false,
    columns: ["channel_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_user_channel_read_cursors_channel"
  ON "user_channel_read_cursors" USING btree ("channel_id")
`,
  },
  {
    name: "idx_inbox_suppression_states_target",
    table: "inbox_suppression_states",
    unique: false,
    columns: ["target_channel_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_inbox_suppression_states_target"
  ON "inbox_suppression_states" USING btree ("target_channel_id")
`,
  },
  {
    name: "idx_action_cards_conversion_source_channel",
    table: "action_cards",
    unique: false,
    columns: ["conversion_source_channel_id"],
    predicate: "(conversion_source_channel_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_action_cards_conversion_source_channel"
  ON "action_cards" USING btree ("conversion_source_channel_id")
  WHERE conversion_source_channel_id IS NOT NULL
`,
  },  {
    // The foreign keys the closed-server purge's server_rows step makes Postgres
    // check (migration closed_server_purge_fk_indexes): no index led with them.
    name: "idx_tasks_resource_expiry_followup",
    table: "tasks",
    unique: false,
    columns: ["resource_expiry_followup_id"],
    predicate: "(resource_expiry_followup_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_resource_expiry_followup"
  ON "tasks" USING btree ("resource_expiry_followup_id")
  WHERE resource_expiry_followup_id IS NOT NULL
`,
  },
  {
    name: "idx_workflow_instances_template",
    table: "workflow_instances",
    unique: false,
    columns: ["template_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_workflow_instances_template"
  ON "workflow_instances" USING btree ("template_id")
`,
  },
  {
    name: "idx_reminder_source_acks_reminder",
    table: "reminder_source_acknowledgements",
    unique: false,
    columns: ["reminder_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reminder_source_acks_reminder"
  ON "reminder_source_acknowledgements" USING btree ("reminder_id")
`,
  },
  {
    name: "idx_reminder_source_acks_source_event",
    table: "reminder_source_acknowledgements",
    unique: false,
    columns: ["source_event_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_reminder_source_acks_source_event"
  ON "reminder_source_acknowledgements" USING btree ("source_event_id")
`,
  },
  {
    name: "idx_agent_runtime_provisions_credential",
    table: "agent_runtime_provisions",
    unique: false,
    columns: ["credential_id"],
    predicate: "(credential_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runtime_provisions_credential"
  ON "agent_runtime_provisions" USING btree ("credential_id")
  WHERE credential_id IS NOT NULL
`,
  },
  {
    name: "idx_sso_auth_transactions_connection",
    table: "sso_auth_transactions",
    unique: false,
    columns: ["connection_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_sso_auth_transactions_connection"
  ON "sso_auth_transactions" USING btree ("connection_id")
`,
  },
  {
    name: "idx_app_agent_messages_agent",
    table: "app_agent_messages",
    unique: false,
    columns: ["agent_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_app_agent_messages_agent"
  ON "app_agent_messages" USING btree ("agent_id")
`,
  },  {
    // The foreign keys the closed-server purge's revoke, uninstall and Slack steps
    // make Postgres check (migration closed_server_purge_step_fk_indexes).
    name: "idx_oauth_access_tokens_server",
    table: "oauth_access_tokens",
    unique: false,
    columns: ["server_id"],
    predicate: "(server_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_access_tokens_server"
  ON "oauth_access_tokens" USING btree ("server_id")
  WHERE server_id IS NOT NULL
`,
  },
  {
    name: "idx_oauth_access_tokens_request",
    table: "oauth_access_tokens",
    unique: false,
    columns: ["request_id"],
    predicate: "(request_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_access_tokens_request"
  ON "oauth_access_tokens" USING btree ("request_id")
  WHERE request_id IS NOT NULL
`,
  },
  {
    name: "idx_oauth_access_tokens_grant",
    table: "oauth_access_tokens",
    unique: false,
    columns: ["grant_id"],
    predicate: "(grant_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_access_tokens_grant"
  ON "oauth_access_tokens" USING btree ("grant_id")
  WHERE grant_id IS NOT NULL
`,
  },
  {
    name: "idx_oauth_client_share_links_target_server",
    table: "oauth_client_share_links",
    unique: false,
    columns: ["target_server_id"],
    predicate: "(target_server_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_client_share_links_target_server"
  ON "oauth_client_share_links" USING btree ("target_server_id")
  WHERE target_server_id IS NOT NULL
`,
  },
  {
    name: "idx_oauth_client_share_links_created_by_agent",
    table: "oauth_client_share_links",
    unique: false,
    columns: ["created_by_agent_id"],
    predicate: "(created_by_agent_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_client_share_links_created_by_agent"
  ON "oauth_client_share_links" USING btree ("created_by_agent_id")
  WHERE created_by_agent_id IS NOT NULL
`,
  },
  {
    name: "idx_oauth_link_preview_declines_server",
    table: "oauth_link_preview_declines",
    unique: false,
    columns: ["server_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_link_preview_declines_server"
  ON "oauth_link_preview_declines" USING btree ("server_id")
`,
  },
  {
    name: "idx_oauth_user_consents_server",
    table: "oauth_user_consents",
    unique: false,
    columns: ["server_id"],
    predicate: "(server_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_user_consents_server"
  ON "oauth_user_consents" USING btree ("server_id")
  WHERE server_id IS NOT NULL
`,
  },
  {
    name: "idx_slack_usergroup_identities_server",
    table: "slack_usergroup_identities",
    unique: false,
    columns: ["server_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_slack_usergroup_identities_server"
  ON "slack_usergroup_identities" USING btree ("server_id")
`,
  },
  {
    name: "idx_managed_mcp_assignments_bound_connection",
    table: "managed_mcp_assignments",
    unique: false,
    columns: ["bound_connection_id"],
    predicate: "(bound_connection_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_managed_mcp_assignments_bound_connection"
  ON "managed_mcp_assignments" USING btree ("bound_connection_id")
  WHERE bound_connection_id IS NOT NULL
`,
  },
  {
    name: "idx_managed_mcp_oauth_attempts_mcp_server",
    table: "managed_mcp_oauth_attempts",
    unique: false,
    columns: ["mcp_server_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_managed_mcp_oauth_attempts_mcp_server"
  ON "managed_mcp_oauth_attempts" USING btree ("mcp_server_id")
`,
  },
  {
    name: "idx_provider_probe_intents_connection",
    table: "provider_probe_intents",
    unique: false,
    columns: ["connection_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_provider_probe_intents_connection"
  ON "provider_probe_intents" USING btree ("connection_id")
`,
  },
  {
    name: "idx_official_app_auto_install_transitions_installation",
    table: "official_app_auto_install_transitions",
    unique: false,
    columns: ["installation_id"],
    predicate: "(installation_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_official_app_auto_install_transitions_installation"
  ON "official_app_auto_install_transitions" USING btree ("installation_id")
  WHERE installation_id IS NOT NULL
`,
  },
  {
    name: "idx_agents_managed_by_app_install",
    table: "agents",
    unique: false,
    columns: ["managed_by_app_install_id"],
    predicate: "(managed_by_app_install_id IS NOT NULL)",
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agents_managed_by_app_install"
  ON "agents" USING btree ("managed_by_app_install_id")
  WHERE managed_by_app_install_id IS NOT NULL
`,
  },
  {
    name: "idx_external_oauth_attempts_server_grant",
    table: "external_oauth_attempts",
    unique: false,
    columns: ["server_grant_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_external_oauth_attempts_server_grant"
  ON "external_oauth_attempts" USING btree ("server_grant_id")
`,
  },
  {
    // The foreign keys to oauth_clients the closed-server purge's app delete makes
    // Postgres check (migration closed_server_purge_app_fk_indexes).
    name: "idx_oauth_access_tokens_client",
    table: "oauth_access_tokens",
    unique: false,
    columns: ["client_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_access_tokens_client"
  ON "oauth_access_tokens" USING btree ("client_id")
`,
  },
  {
    name: "idx_oauth_app_installation_tokens_client",
    table: "oauth_app_installation_tokens",
    unique: false,
    columns: ["client_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_app_installation_tokens_client"
  ON "oauth_app_installation_tokens" USING btree ("client_id")
`,
  },
  {
    name: "idx_official_app_auto_install_transitions_client",
    table: "official_app_auto_install_transitions",
    unique: false,
    columns: ["client_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_official_app_auto_install_transitions_client"
  ON "official_app_auto_install_transitions" USING btree ("client_id")
`,
  },
  {
    name: "idx_oauth_agent_auto_grant_blocks_client",
    table: "oauth_agent_auto_grant_blocks",
    unique: false,
    columns: ["client_id"],
    predicate: null,
    createSql: `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_oauth_agent_auto_grant_blocks_client"
  ON "oauth_agent_auto_grant_blocks" USING btree ("client_id")
`,
  },
];

export const DEVICE_SESSION_KEY_INDEX_STATEMENT_TIMEOUT =
  process.env.DEVICE_SESSION_KEY_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const DEVICE_SESSION_KEY_INDEX_LOCK_TIMEOUT =
  process.env.DEVICE_SESSION_KEY_INDEX_LOCK_TIMEOUT?.trim() || "30s";

/**
 * For a spec with `keys`: the built index (by name) must have exactly that key
 * list, as the post-migration guard compares it. Throws otherwise.
 */
export async function assertIndexKeys(client: pg.PoolClient, spec: DeviceSessionKeyIndexSpec): Promise<void> {
  if (spec.keys === undefined) return;
  const result = await client.query<{ definition: string | null }>(
    `SELECT pg_get_indexdef(to_regclass($1)) AS "definition"`,
    [`public."${spec.name}"`],
  );
  const keys = result.rows[0]?.definition ? indexKeysFromDefinition(result.rows[0].definition) : null;
  if (keys?.replace(/\s/g, "") !== spec.keys.replace(/\s/g, "")) {
    throw new Error(`${spec.name} has unexpected keys: ${keys ?? "(unreadable)"}; expected ${spec.keys}`);
  }
}

/**
 * False on a database whose migrations predate the spec's column (a deploy
 * test's own migrations folder): there is nothing to build for it yet.
 */
export async function indexedColumnExists(client: pg.PoolClient, spec: DeviceSessionKeyIndexSpec): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) AS "count" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [spec.table, spec.requiredColumn ?? spec.columns[0]],
  );
  return Number(result.rows[0]?.count) === 1;
}
