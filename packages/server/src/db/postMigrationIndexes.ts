import { SLACK_INBOUND_HEAD_INDEX } from "../services/slackVerifiedIngressIndexContract";
import { SLACK_BOT_WAKE_INDEX } from "../services/slackBotWakeIndexContract";
import { NOTIFICATION_OUTBOX_EVENT_KEY_INDEX, NOTIFICATION_OUTBOX_FK_INDEXES } from "./notificationOutboxIndexContract";
import { ATTESTED_SEND_EVENTS_MESSAGE_INDEX } from "./attestedSendEventsIndexContract";

// Indexes built outside the migrations: a migration that is `SELECT 1` (or a
// no-op `IF NOT EXISTS`) plus a `db:create-*` script that each environment
// runs once, CONCURRENTLY. Nothing re-runs that script, so an environment that
// never ran it silently lacks the index (staging 10-16: no
// idx_messages_sender_created_at, the onboarding funnel query hit its 60 s
// timeout; 26 ms once built). db:migrate:deploy checks this catalog in the
// migrate task it already runs: one pg_index read, no extra ECS task (the
// per-deploy create/verify steps were removed in #8034).
//
// An index matches on table, ordered columns, uniqueness and predicate, never
// on its name: production rebuilt some tables by hand and their indexes carry
// other names. A spec with `keys` also matches its whole key list as
// pg_get_indexdef prints it (expressions and sort order included). A match
// that is not valid and ready (a failed concurrent build) counts as missing.

export interface PostMigrationIndexSpec {
  /** The name the create script uses; only for messages. */
  name: string;
  table: string;
  columns: readonly string[];
  unique: boolean;
  /** pg_get_expr(indpred) as PostgreSQL prints it; null for a full index. */
  predicate: string | null;
  /**
   * The key list as pg_get_indexdef prints it (indexKeysFromDefinition), for
   * an index whose keys `columns` cannot tell apart: an expression key (it
   * has no attname, so `columns` lists the plain columns only) or a DESC one.
   * Compared ignoring whitespace. Absent: columns alone decide.
   */
  keys?: string;
  /** The package script that builds it (CREATE INDEX CONCURRENTLY IF NOT EXISTS). */
  createScript: string;
}

export const POST_MIGRATION_INDEXES: readonly PostMigrationIndexSpec[] = [
  {
    // Joint family preservation includes soft-deleted/detached descendants.
    name: "idx_channels_parent_channel",
    table: "channels",
    columns: ["parent_channel_id"],
    unique: false,
    predicate: "(parent_channel_id IS NOT NULL)",
    createScript: "db:create-channels-parent-channel-index",
  },
  {
    name: "idx_messages_user_random_id",
    table: "messages",
    columns: ["sender_id", "random_id"],
    unique: true,
    predicate: "((sender_type = 'user'::text) AND (random_id IS NOT NULL))",
    createScript: "db:create-message-random-id-index",
  },
  {
    name: "idx_messages_sender_created_at",
    table: "messages",
    columns: ["sender_id", "created_at", "id"],
    unique: false,
    predicate: null,
    createScript: "db:create-messages-sender-index",
  },
  {
    name: "idx_mention_delivery_occurrences_agent_payload_open",
    table: "mention_delivery_occurrences",
    columns: ["agent_id", "state"],
    unique: false,
    predicate: "((acked_at IS NULL) AND (terminal_error_at IS NULL) AND (delivery_payload IS NOT NULL))",
    createScript: "db:create-mention-delivery-agent-open-index",
  },
  {
    name: "idx_channels_thread_parent_channel",
    table: "channels",
    columns: ["parent_channel_id", "id"],
    unique: false,
    predicate: "((type = 'thread'::text) AND (deleted_at IS NULL))",
    createScript: "db:create-channels-thread-parent-channel-index",
  },
  {
    // Task v2 (migration task_conversation_channels): built in the migration only on a small channels table.
    name: "idx_channels_active_task_parent",
    table: "channels",
    columns: ["task_id", "parent_channel_id"],
    unique: true,
    predicate: "((type = 'task'::text) AND (deleted_at IS NULL))",
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    name: "idx_channels_task_parent_channel",
    table: "channels",
    columns: ["parent_channel_id", "id"],
    unique: false,
    predicate: "((type = 'task'::text) AND (deleted_at IS NULL))",
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    // Task v2 (migrations task_source_message_id / task_conversation_tasks): built
    // in the migration only on a small tasks table.
    name: "idx_tasks_source_message_id",
    table: "tasks",
    columns: ["source_message_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    name: "idx_tasks_conversation_channel_id",
    table: "tasks",
    columns: ["conversation_channel_id"],
    unique: true,
    predicate: null,
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    // Task v2 (migration task_conversation_channels): the cascade from tasks.
    name: "idx_channels_task_id",
    table: "channels",
    columns: ["task_id"],
    unique: false,
    predicate: "(task_id IS NOT NULL)",
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    // Task v2 (migration task_conversation_follows): the cascade from tasks.
    name: "idx_thread_follows_parent_task_id",
    table: "thread_follows",
    columns: ["parent_task_id"],
    unique: false,
    predicate: "(parent_task_id IS NOT NULL)",
    createScript: "db:create-channels-task-conversation-indexes",
  },
  {
    // Sync horizon late reads (migration messages_insert_xid adds the column only).
    name: "idx_messages_insert_xid",
    table: "messages",
    columns: ["insert_xid"],
    unique: false,
    predicate: "(insert_xid IS NOT NULL)",
    createScript: "db:create-messages-insert-xid-index",
  },
  {
    // The table is notification_outbox since migration notification_outbox (the index keeps its name).
    name: "idx_mobile_push_outbox_active_created",
    table: "notification_outbox",
    columns: ["created_at"],
    unique: false,
    predicate: "(status = ANY (ARRAY['pending'::text, 'processing'::text]))",
    createScript: "db:create-mobile-push-outbox-active-index",
  },
  {
    // A device login's revoke cascade and ON DELETE SET NULL (migration device_session_issued_keys).
    name: "idx_agent_credentials_issued_by_session_family",
    table: "agent_credentials",
    columns: ["issued_by_session_family_id"],
    unique: false,
    predicate: "(issued_by_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The hourly sweep of revoked device sessions' keys (migration device_session_live_key_index).
    name: "idx_agent_credentials_live_by_session_family",
    table: "agent_credentials",
    columns: ["issued_by_session_family_id"],
    unique: false,
    predicate: "((issued_by_session_family_id IS NOT NULL) AND (revoked_at IS NULL))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // A departure's revoke of the keys the person issued (migration agent_credentials_live_by_creator_index).
    name: "idx_agent_credentials_live_by_creator",
    table: "agent_credentials",
    columns: ["created_by_user_id"],
    unique: false,
    predicate: "(revoked_at IS NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The hourly retention sweep of revoked runner keys (migration agent_credentials_revoked_computer_index).
    name: "idx_agent_credentials_revoked_computer",
    table: "agent_credentials",
    columns: ["revoked_at"],
    unique: false,
    predicate: "((revoked_at IS NOT NULL) AND (issued_via = 'computer'::text))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The hourly retention sweep of expired, never-revoked runner keys (migration agent_credentials_expired_computer_index).
    name: "idx_agent_credentials_expired_computer",
    table: "agent_credentials",
    columns: ["expires_at"],
    unique: false,
    predicate: "((expires_at IS NOT NULL) AND (revoked_at IS NULL) AND (issued_via = 'computer'::text))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // Runner credential reconcile on reconnect (migration agent_credentials_live_runner_by_machine_index).
    name: "idx_agent_credentials_live_runner_by_machine",
    table: "agent_credentials",
    columns: ["issued_by_machine_id"],
    unique: false,
    predicate: "((revoked_at IS NULL) AND (issued_via = 'computer'::text) AND (issued_by_machine_id IS NOT NULL))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // Deleting a session family cascades here (migration account_deletion_indexes).
    name: "idx_session_token_predecessors_family",
    table: "session_token_predecessors",
    columns: ["family_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // Deleting an agent releases the tasks it claimed (migration account_deletion_indexes).
    name: "idx_tasks_claimed_by_agent",
    table: "tasks",
    columns: ["claimed_by_id"],
    unique: false,
    predicate: "(claimed_by_type = 'agent'::text)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The server task board's Creator / Assignee filters (migration tasks_board_filter_indexes).
    name: "idx_tasks_created_by",
    table: "tasks",
    columns: ["created_by_type", "created_by_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_tasks_claimed_by",
    table: "tasks",
    columns: ["claimed_by_type", "claimed_by_id"],
    unique: false,
    predicate: "(claimed_by_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The server task board's activity sort (migration tasks_last_activity).
    // The expression key has no attname, so `columns` lists the plain columns
    // only and `keys` pins the expression and the order.
    name: "idx_tasks_channel_activity",
    table: "tasks",
    columns: ["channel_id", "id"],
    unique: false,
    predicate: null,
    keys: "channel_id, COALESCE(last_activity_at, updated_at) DESC, id DESC",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The server task board's creation-time sort (migration tasks_last_activity).
    name: "idx_tasks_channel_created",
    table: "tasks",
    columns: ["channel_id", "created_at", "id"],
    unique: false,
    predicate: null,
    keys: "channel_id, created_at DESC, id DESC",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // A person's agents across servers (migration account_deletion_indexes).
    name: "idx_agents_user_creator",
    table: "agents",
    columns: ["creator_id"],
    unique: false,
    predicate: "(creator_type = 'user'::text)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // A person's personal assistants across servers (migration account_deletion_indexes).
    name: "idx_agents_assistant_owner",
    table: "agents",
    columns: ["assistant_owner_user_id"],
    unique: false,
    predicate: "(assistant_owner_user_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes).
    name: "idx_agent_runtime_profiles_baseline_machine",
    table: "agent_runtime_profiles",
    columns: ["baseline_machine_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes).
    name: "idx_agent_runtime_profiles_pending_before_machine",
    table: "agent_runtime_profiles",
    columns: ["pending_before_machine_id"],
    unique: false,
    predicate: "(pending_before_machine_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // RESTRICT foreign key to machines, checked when a Computer is deleted. (migration account_deletion_indexes).
    name: "idx_agent_runtime_profiles_pending_after_machine",
    table: "agent_runtime_profiles",
    columns: ["pending_after_machine_id"],
    unique: false,
    predicate: "(pending_after_machine_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // ON DELETE SET NULL from oauth_access_tokens, run per deleted token. (migration account_deletion_indexes).
    name: "idx_third_party_agent_events_access_token",
    table: "third_party_agent_events",
    columns: ["access_token_id"],
    unique: false,
    predicate: "(access_token_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // A sender's pending mention actions (migration message_mentions_pending_actions_index).
    name: "idx_message_mentions_pending_actions",
    table: "message_mentions",
    columns: ["server_id", "created_at"],
    unique: false,
    predicate: "((source = 'send_path'::text) AND (NOT notifiable_at_send))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_computers_key_issued_by_session_family",
    table: "computers",
    columns: ["key_issued_by_session_family_id"],
    unique: false,
    predicate: "(key_issued_by_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // A web session's security-revoke cascade and ON DELETE SET NULL (migration web_session_issued_keys).
    name: "idx_agent_credentials_issued_by_web_session_family",
    table: "agent_credentials",
    columns: ["issued_by_web_session_family_id"],
    unique: false,
    predicate: "(issued_by_web_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_computers_key_issued_by_web_session_family",
    table: "computers",
    columns: ["key_issued_by_web_session_family_id"],
    unique: false,
    predicate: "(key_issued_by_web_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_daemons_key_issued_by_web_session_family",
    table: "daemons",
    columns: ["key_issued_by_web_session_family_id"],
    unique: false,
    predicate: "(key_issued_by_web_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_agent_bootstrap_tokens_issued_by_web_session_family",
    table: "agent_bootstrap_tokens",
    columns: ["issued_by_web_session_family_id"],
    unique: false,
    predicate: "(issued_by_web_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The ON DELETE SET NULL when a family goes (migration oauth_access_requests_approver_session_family).
    name: "idx_oauth_access_requests_approver_session_family",
    table: "oauth_access_requests",
    columns: ["approver_session_family_id"],
    unique: false,
    predicate: "(approver_session_family_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // putObjectFile's caps by billed server and uploader (migration object_files_billed_uploader_index).
    name: "idx_object_files_billed_uploader",
    table: "object_files",
    columns: ["billed_server_id", "uploaded_by_type", "uploaded_by_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // Foreign keys a machine delete follows (migration daemons_fk_indexes).
    name: "idx_agent_credentials_issued_by_machine",
    table: "agent_credentials",
    columns: ["issued_by_machine_id"],
    unique: false,
    predicate: "(issued_by_machine_id IS NOT NULL)",
    createScript: "db:create-daemons-fk-indexes",
  },
  {
    name: "idx_agents_daemon_id",
    table: "agents",
    columns: ["daemon_id"],
    unique: false,
    predicate: "(daemon_id IS NOT NULL)",
    createScript: "db:create-daemons-fk-indexes",
  },
  {
    name: "idx_computer_outage_occurrences_machine",
    table: "computer_outage_occurrences",
    columns: ["machine_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-daemons-fk-indexes",
  },
  {
    // A person's conversations marked unread (migration read_cursor_marked_unread_index).
    name: "idx_user_channel_read_cursors_marked_unread",
    table: "user_channel_read_cursors",
    columns: ["user_id"],
    unique: false,
    predicate: "marked_unread",
    createScript: "db:create-read-cursor-marked-unread-index",
  },
  {
    ...SLACK_INBOUND_HEAD_INDEX,
    createScript: "db:create-slack-inbound-head-index",
  },
  {
    ...SLACK_BOT_WAKE_INDEX,
    createScript: "db:create-slack-bot-wake-index",
  },
  {
    // The unified enqueue's dedupe key (migration notification_outbox): built in the migration only on a small outbox.
    name: NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.name,
    table: NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.table,
    columns: NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.columns,
    unique: NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.unique,
    predicate: NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.predicate,
    createScript: "db:create-notification-outbox-event-key-index",
  },
  {
    // The ON DELETE SET NULL from messages (migration attested_send_events_message_index is SELECT 1).
    name: ATTESTED_SEND_EVENTS_MESSAGE_INDEX.name,
    table: ATTESTED_SEND_EVENTS_MESSAGE_INDEX.table,
    columns: ATTESTED_SEND_EVENTS_MESSAGE_INDEX.columns,
    unique: ATTESTED_SEND_EVENTS_MESSAGE_INDEX.unique,
    predicate: ATTESTED_SEND_EVENTS_MESSAGE_INDEX.predicate,
    createScript: "db:create-attested-send-events-message-index",
  },
  // The channels / users delete cascades' indexes (migration notification_outbox_fk_indexes): built in the migration only on a small outbox.
  ...NOTIFICATION_OUTBOX_FK_INDEXES.map(({ name, table, columns, unique, predicate }) => ({
    name,
    table,
    columns,
    unique,
    predicate,
    createScript: "db:create-notification-outbox-fk-indexes",
  })),
  {
    // RFC 081 inbox items: one agent's unconsumed events by app and object (migration inbox_items_object_ref).
    name: "idx_third_party_agent_events_agent_unconsumed_item",
    table: "third_party_agent_events",
    columns: ["agent_id", "client_id", "system_app", "object_ref", "created_at"],
    unique: false,
    predicate: "(status = ANY (ARRAY['queued'::text, 'delivering'::text]))",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The foreign keys a channel delete checks (migration channel_fk_indexes).
    name: "idx_inbox_notification_facts_source_channel",
    table: "inbox_notification_facts",
    columns: ["source_channel_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_agent_channel_read_cursors_channel",
    table: "agent_channel_read_cursors",
    columns: ["channel_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_reminders_target_channel",
    table: "reminders",
    columns: ["target_channel_id"],
    unique: false,
    predicate: "(target_channel_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_user_channel_read_cursors_channel",
    table: "user_channel_read_cursors",
    columns: ["channel_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_inbox_suppression_states_target",
    table: "inbox_suppression_states",
    columns: ["target_channel_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_action_cards_conversion_source_channel",
    table: "action_cards",
    columns: ["conversion_source_channel_id"],
    unique: false,
    predicate: "(conversion_source_channel_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },  {
    // The foreign keys the closed-server purge's server_rows step checks (migration closed_server_purge_fk_indexes).
    name: "idx_tasks_resource_expiry_followup",
    table: "tasks",
    columns: ["resource_expiry_followup_id"],
    unique: false,
    predicate: "(resource_expiry_followup_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_workflow_instances_template",
    table: "workflow_instances",
    columns: ["template_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_reminder_source_acks_reminder",
    table: "reminder_source_acknowledgements",
    columns: ["reminder_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_reminder_source_acks_source_event",
    table: "reminder_source_acknowledgements",
    columns: ["source_event_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_agent_runtime_provisions_credential",
    table: "agent_runtime_provisions",
    columns: ["credential_id"],
    unique: false,
    predicate: "(credential_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_sso_auth_transactions_connection",
    table: "sso_auth_transactions",
    columns: ["connection_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_app_agent_messages_agent",
    table: "app_agent_messages",
    columns: ["agent_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },  {
    // The foreign keys the closed-server purge's revoke, uninstall and Slack steps check (migration closed_server_purge_step_fk_indexes).
    name: "idx_oauth_access_tokens_server",
    table: "oauth_access_tokens",
    columns: ["server_id"],
    unique: false,
    predicate: "(server_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_access_tokens_request",
    table: "oauth_access_tokens",
    columns: ["request_id"],
    unique: false,
    predicate: "(request_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_access_tokens_grant",
    table: "oauth_access_tokens",
    columns: ["grant_id"],
    unique: false,
    predicate: "(grant_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_client_share_links_target_server",
    table: "oauth_client_share_links",
    columns: ["target_server_id"],
    unique: false,
    predicate: "(target_server_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_client_share_links_created_by_agent",
    table: "oauth_client_share_links",
    columns: ["created_by_agent_id"],
    unique: false,
    predicate: "(created_by_agent_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_link_preview_declines_server",
    table: "oauth_link_preview_declines",
    columns: ["server_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_user_consents_server",
    table: "oauth_user_consents",
    columns: ["server_id"],
    unique: false,
    predicate: "(server_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_slack_usergroup_identities_server",
    table: "slack_usergroup_identities",
    columns: ["server_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_managed_mcp_assignments_bound_connection",
    table: "managed_mcp_assignments",
    columns: ["bound_connection_id"],
    unique: false,
    predicate: "(bound_connection_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_managed_mcp_oauth_attempts_mcp_server",
    table: "managed_mcp_oauth_attempts",
    columns: ["mcp_server_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_provider_probe_intents_connection",
    table: "provider_probe_intents",
    columns: ["connection_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_official_app_auto_install_transitions_installation",
    table: "official_app_auto_install_transitions",
    columns: ["installation_id"],
    unique: false,
    predicate: "(installation_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_agents_managed_by_app_install",
    table: "agents",
    columns: ["managed_by_app_install_id"],
    unique: false,
    predicate: "(managed_by_app_install_id IS NOT NULL)",
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_external_oauth_attempts_server_grant",
    table: "external_oauth_attempts",
    columns: ["server_grant_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    // The foreign keys to oauth_clients the closed-server purge's app delete checks (migration closed_server_purge_app_fk_indexes).
    name: "idx_oauth_access_tokens_client",
    table: "oauth_access_tokens",
    columns: ["client_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_app_installation_tokens_client",
    table: "oauth_app_installation_tokens",
    columns: ["client_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_official_app_auto_install_transitions_client",
    table: "official_app_auto_install_transitions",
    columns: ["client_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
  {
    name: "idx_oauth_agent_auto_grant_blocks_client",
    table: "oauth_agent_auto_grant_blocks",
    columns: ["client_id"],
    unique: false,
    predicate: null,
    createScript: "db:create-device-session-key-indexes",
  },
];

/** One index of a catalog table, as pg_index describes it. */
export interface ObservedIndex {
  table: string;
  name: string;
  columns: readonly string[];
  unique: boolean;
  predicate: string | null;
  /** The key list from pg_get_indexdef (indexKeysFromDefinition); null when it cannot be read. */
  keys?: string | null;
  valid: boolean;
  ready: boolean;
}

export type PostMigrationIndexState =
  | { spec: PostMigrationIndexSpec; state: "ok"; matchedName: string }
  | { spec: PostMigrationIndexSpec; state: "invalid"; matchedName: string }
  | { spec: PostMigrationIndexSpec; state: "missing" };

/** Whitespace and redundant parentheses differ between PostgreSQL versions; the expression does not. */
function normalizePredicate(predicate: string | null): string | null {
  return predicate === null ? null : predicate.replace(/[\s()]/g, "");
}

/**
 * The key list of a pg_get_indexdef definition: `channel_id, COALESCE(a, b)
 * DESC, id DESC` from `CREATE INDEX x ON public.t USING btree (channel_id,
 * COALESCE(a, b) DESC, id DESC) WHERE ...`. Null when the shape is not that.
 */
export function indexKeysFromDefinition(definition: string): string | null {
  const head = definition.split(" WHERE ")[0]!;
  const match = /\bUSING \w+ \((.*)\)$/.exec(head);
  return match ? match[1]! : null;
}

function sameKeys(spec: PostMigrationIndexSpec, index: ObservedIndex): boolean {
  if (spec.keys === undefined) return true;
  return index.keys != null && index.keys.replace(/\s/g, "") === spec.keys.replace(/\s/g, "");
}

function sameShape(spec: PostMigrationIndexSpec, index: ObservedIndex): boolean {
  return index.table === spec.table
    && index.unique === spec.unique
    && index.columns.length === spec.columns.length
    && index.columns.every((column, i) => column === spec.columns[i])
    && normalizePredicate(index.predicate) === normalizePredicate(spec.predicate)
    && sameKeys(spec, index);
}

/** Pure: every spec is ok (a valid, ready index of its shape), invalid (only broken ones), or missing. */
export function evaluatePostMigrationIndexes(
  observed: readonly ObservedIndex[],
  catalog: readonly PostMigrationIndexSpec[] = POST_MIGRATION_INDEXES,
): PostMigrationIndexState[] {
  return catalog.map((spec) => {
    const matches = observed.filter((index) => sameShape(spec, index));
    const usable = matches.find((index) => index.valid && index.ready);
    if (usable) return { spec, state: "ok", matchedName: usable.name };
    if (matches[0]) return { spec, state: "invalid", matchedName: matches[0].name };
    return { spec, state: "missing" };
  });
}

type QueryFn = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Every index of the catalog's tables in the public schema: one catalog read. */
export async function readObservedIndexes(
  query: QueryFn,
  catalog: readonly PostMigrationIndexSpec[] = POST_MIGRATION_INDEXES,
): Promise<ObservedIndex[]> {
  const tables = [...new Set(catalog.map((spec) => spec.table))];
  const result = await query(
    `SELECT t.relname AS "table",
            c.relname AS "name",
            i.indisunique AS "unique",
            i.indisvalid AS "valid",
            i.indisready AS "ready",
            pg_get_expr(i.indpred, i.indrelid) AS "predicate",
            pg_get_indexdef(i.indexrelid) AS "definition",
            ARRAY(
              SELECT a.attname::text
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              ORDER BY k.ord
            ) AS "columns"
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = ANY($1::text[])`,
    [tables],
  );
  return result.rows.map((row) => ({
    table: String(row.table),
    name: String(row.name),
    unique: row.unique === true,
    valid: row.valid === true,
    ready: row.ready === true,
    predicate: typeof row.predicate === "string" ? row.predicate : null,
    keys: typeof row.definition === "string" ? indexKeysFromDefinition(row.definition) : null,
    columns: Array.isArray(row.columns) ? row.columns.map(String) : [],
  }));
}

/** The command an operator runs for a missing or invalid index. */
export function postMigrationIndexRemedy(state: Exclude<PostMigrationIndexState, { state: "ok" }>): string {
  const create = `pnpm --filter @botiverse/raft-server ${state.spec.createScript}`;
  return state.state === "invalid"
    ? `DROP INDEX CONCURRENTLY "${state.matchedName}"; then ${create}`
    : create;
}
