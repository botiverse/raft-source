import { randomUUID } from "node:crypto";
import type { ServerRole } from "@botiverse/raft-shared";
import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, integrationAuditEvents, oauthClients, servers, users } from "../db/schema";
import { ownerDispatchRequestId } from "./ownerDispatchContext";

export const INTEGRATION_AUDIT_EVENT_TYPES = [
  "app.registered",
  "app.updated",
  "app.client_key_changed",
  "app.owner_transferred",
  "app.deleted",
  "app.publish_requested",
  "app.publish_approved",
  "app.publish_rejected",
  "app.publish_withdrawn",
  "app.offline_requested",
  "app.offline_approved",
  "app.offline_rejected",
  "app.action_endpoint_requested",
  "app.action_endpoint_reviewed",
  // RFC 076 §17 before card buttons moved to the installation: a server_local
  // App's own Server confirmed its endpoint. No longer written; kept for the rows.
  "app.link_card_actions_confirmed",
  // Card buttons of an App that is not official, on the event's Server (RFC
  // 076 §17): allowed for the endpoint in force, or that allow withdrawn; on
  // a server_local App's own Server, switched on or off.
  "app.link_card_actions_allowed",
  "app.link_card_actions_withdrawn",
  "app.link_card_actions_on",
  "app.link_card_actions_off",
  // RFC 086 §5.2: the public key card SecretInputs are sealed to, set or
  // removed with the App's own credential (appCardEncryptionKeyService.ts);
  // removed by the system only with a registration another App took over.
  // Metadata: the `kid`, never the key.
  "app.card_encryption_key_set",
  "app.card_encryption_key_removed",
  // A server_local App's or an MCP App's own Server vouched for it (every agent there is granted
  // it automatically), or that vouch ended: by an owner or admin, at creation, by the 0731 / 0732
  // backfill (`backfill`), or by an agent widening its scopes (reason `scope_widened`). An MCP
  // App's rows target `managed_mcp_server` and name it in `appName` (it has no client key).
  "app.server_vouched",
  "app.server_unvouched",
  // An MCP App's Connection (an account; RFC 087 §7.4), shared or a member's own, by a person:
  // created; signed in (an OAuth sign-in completed, or an API key saved); deleted (`revokedBy` when
  // someone other than its owner deleted a member's own); which Agents use it changed (a personal
  // grant, a shared pin, or the shared "All agents" default); and an App's "Members can connect
  // their own account" switched. Server-scoped (owners and admins read them). Ids only: never the
  // account label or email, the endpoint or a secret.
  "mcp_connection.created",
  "mcp_connection.signed_in",
  "mcp_connection.deleted",
  // An OAuth sign-in removed (tokens deleted, the Connection kept): `revokedBy` when an admin signed
  // out a member's own.
  "mcp_connection.signed_out",
  "mcp_connection.agents_changed",
  "mcp_connection.members_can_connect_changed",
  "official_app.registry_created",
  "official_app.registry_updated",
  "official_app.registry_removed",
  "marketplace.installed",
  "marketplace.uninstalled",
  "client.secret_rotated",
  "action_card.executed",
  "link_card.operation_resolved_manually",
  "link_card.operation_first_send_expired",
  "link_preview.consent_granted",
  "link_preview.declined",
  "oauth.redirect_mismatch",
  "oauth.lifecycle",
  // RFC 079 phase 3a: an App's reviewed switch from server to account mode
  // (written by the db:oauth-login-mode switch, design §2.4).
  "oauth.login_mode_switched",
  // RFC 079 phase 3a: a person revoked one App's account-mode login and
  // everything it held of theirs (DELETE /api/me/app-logins/:clientId).
  "oauth.app_login_revoked",
  "agent.jwt_issued",
  "app.agent_jwt_updated",
  "installation.agent_jwt_updated",
  "oauth.token_exchange_failed",
  "private_share.link_created",
  "private_share.link_revoked",
  "private_share.installed",
  "private_share.uninstalled",
  "app.outbound_permission_requested",
  "app.outbound_permission_approved",
  "app.prompt_text_requested",
  "app.prompt_text_reviewed",
  "app.prompt_text_confirmed",
  "installation.outbound_grant_updated",
  "installation.outbound_subscription_updated",
  "installation.token_issued",
  "installation.setup_updated",
  "installation.bot_grant_updated",
  "installation.legacy_import_grants_created",
  "assistant.send_as_owner",
  "assistant.send_as_owner.deleted",
  // A personal assistant published an Artifact as its owner (#proj-assistant:#33).
  "assistant.publish_artifact_as_owner",
  // A personal assistant changed one of its owner's settings (assistantOwnerSettingsService).
  "assistant.owner_setting_changed",
  // A personal assistant acted as its owner on one of the owner's own routes (middleware/assistantAsOwner.ts).
  "assistant.owner_action",
  // RFC 085 request:prepare cards (preparedRequestCommit.ts, preparedRequestCards.ts): one event per commit
  // attempt that reached the route (its outcome: success, refused with the route's code, unknown) and one per
  // decline. Actor the person, requester the preparing agent, target the card; request_id the dispatched
  // request's own id, which the route's own audit rows carry too.
  "action_card.request_run",
  "action_card.request_declined",
  // A personal assistant read its owner's own state (a `read` owner action); the tool only, never what it read.
  "assistant.owner_read",
  // The WeChat bridge (wechatBridgeService): a person's WeChat bound to their
  // assistant's DM, disconnected, its bot token gone stale, messages from
  // anyone but the bound WeChat user dropped.
  "assistant.wechat_bound",
  "assistant.wechat_disconnected",
  "assistant.wechat_token_stale",
  "assistant.wechat_messages_dropped",
  // An External Agent's inbox push registration (agentInboxPushService.ts):
  // its endpoint and signing secret set or removed, by
  // the agent's own credential or by its runtime provider
  // (routes/runtimeProviderControl.ts). Never the secret or the full URL.
  "agent_inbox_push.configured",
  "agent_inbox_push.deleted",
  "app_bot.credential",
  "webhook.configured",
  "webhook.rotated",
  "webhook.disabled",
  "managed_mcp.tool_invocation_admitted",
  // The closed-server purge's revoke of a credential at its provider (Slack
  // auth.revoke, OAuth token revocation): one event per attempt, success or
  // failure; a failure is retried on a later day (closedServerPurgeRevoke.ts).
  "closed_server_purge.credential_revoke",
  "agent_connection.connect_initiated",
  "agent_connection.confirmed",
  "agent_connection.disconnected",
  "agent_connection.connector_assigned",
  "agent_connection.connector_disconnected",
  "agent_runtime.approval_decided",
  // View Context (services/agentContextViewRelay.ts), two rows per view of an
  // agent's model context by a person who passed the access check, linked by
  // the `request_id` column: `agent.context_view_requested` (required, written
  // before anything is sent to the Computer) and `agent.context_viewed` (the
  // outcome, best-effort). Never anything from the context.
  "agent.context_view_requested",
  "agent.context_viewed",
  // Raft voice (#wg-runtime-form:#22): a person's side question to an agent
  // (agentVoiceService), required and written before the Computer is asked.
  // Who, which agent, when and through which App; never the question or answer.
  "agent.voice_question_asked",
  // A hold ended `expired` (agentRuntimeApprovalService): whether any card of it ever reached a decider.
  "agent_runtime.approval_ended",
  // Server-wide audit (#wg-rbac): high-impact server actions share this table.
  "server.profile_updated",
  // A platform operator changed servers.plan through Feature Flag Admin
  // (public.ffa_change_server_plan, migration 0724), written in SQL by that
  // function in the same transaction as the change.
  "server.plan_changed",
  // A public channel of a public server made visible to signed-out visitors,
  // or hidden again (PATCH /api/channels/:id visitorVisible). Only plain
  // public channels can carry it, so owners and admins may read it.
  "channel.visitor_visibility_changed",
  "membership.role_changed",
  "membership.agent_role_changed",
  "membership.removed",
  // A person's channel membership ended (services/channelMembershipAudit.ts):
  // `member_left` when they ended it themselves, `member_removed` when someone
  // else (a person, an agent) or the system did. Ids and an enum reason only.
  "channel.member_left",
  "channel.member_removed",
  // A joint channel's host disconnected a participant server
  // (channelService.disconnectParticipantServerByHost): one event on the host
  // and one on the disconnected server, in the disconnect's own commit.
  "channel.server_disconnected",
  // A channel member connected a server they own or administer to a joint
  // channel (self_connect, jointMemberConnectService): one event on the
  // joint's host, in the connection's commit.
  "channel.server_connected",
  // A person's ended membership source on a joint channel server reopened by
  // their own explicit connection of that server (externalInviteConnectService,
  // reopenEndedOwnSource): one event on the joint's host, in the connection's commit.
  "channel.source_readmitted",
  // A View Context grant (#wg-ax:#15, services/agentContextViewGrantService.ts):
  // a server owner or admin let an agent view other agents' context, or the
  // granter / an owner or admin revoked it. Grants that stop working (granter
  // demoted or gone, grantee or target changed) write nothing: no row changes.
  "agent.context_view_granted",
  "agent.context_view_grant_revoked",
  "agent_credential.issued",
  "agent_credential.revoked",
  "agent_credential.bootstrap_token_issued",
  "computer.removed",
  "computer.agent_assigned",
  // An agent retried, once, its own migration to another Computer after it
  // failed for workspace size (POST /internal/agent-api/migrations/retry):
  // actor the agent, requester the person who started the failed migration
  // (the retry runs on their behalf). One event, in the start's commit.
  "agent.migration_retry_started",
  "computer.key_rotated",
  "computer.key_revoked",
  "computer.device_session_retired",
  // Revoking a Computer's key from the web unbound other people's agents from
  // it (forceAgentIds, POST /servers/:id/machines/:machineId/revoke-computer-key).
  "computer.revoke_unbound_others_agents",
  // Who Raft records as a Computer's owner changed (Computer owner v1,
  // computerOwnerService.ts): set, transferred, made Public, or cleared
  // because the owner left the server or deleted their account.
  "computer.owner_changed",
  // A server owner or admin moved another member's old Raft daemon over to a
  // Computer (POST /api/computer/adopt-legacy by its machine id, with their
  // session or a computer_migrate approval): actor the person who moved it,
  // subject the member who had added the machine (`machines.user_id`; they may
  // have left since). Never a machine that already had someone else's Computer.
  // Written in the adoption's commit, once, when the old key is retired.
  "computer.legacy_adopted_by_other",
  // A server owner or admin who did not connect a Computer spent one of its
  // runtime account's limit resets (Claude Code or Codex; the limit-reset
  // redeem, or a Claude read on which the older program spent the 5-hour
  // reset; routes/runtimeAuthRoutes.ts): actor the person who used it,
  // subject the person who connected the Computer (who is emailed). Only for
  // an answer that says a reset was spent (`answer` in the metadata).
  "computer.limit_reset_used_by_other",
  // A person pressed Install on a Computer's runtime and confirmed the plan
  // (POST …/runtimes/:runtime/install, routes/runtimeAuthRoutes.ts): actor the
  // person, target the Computer's machine, written once the attempt ends,
  // whatever its end (the Computer's outcome, no answer in time, offline).
  // The Computer's activity record of installs; never a command or output.
  "computer.runtime_install",
  // A person pressed Stop on one of an agent's `raft proc` jobs on the Computer
  // page (POST …/proc-jobs/stop, routes/computerProcJobsRoutes.ts): actor the
  // person, target the Computer's machine, written for every attempt that
  // passed the permission checks, whatever its end (the Computer's outcome,
  // offline, needs an upgrade, no answer in time). Never a command or a pid.
  "computer.proc_job_stopped",
  // A person asking to delete their account unbound other people's agents from
  // their Computers (forceAgentIds, services/accountDeletion/requests.ts).
  // One record per server those agents are in, written with that server's id
  // (its owners and admins see it), naming only that server's agents.
  "account.deletion_unbound_others_agents",
  // A person's own sign-in security (two-step verification, routes/secondFactor.ts).
  // Written with no serverId: the person's, never on a server's audit page.
  "account.second_factor_totp_confirmed",
  "account.second_factor_enabled",
  "account.second_factor_disabled",
  "account.second_factor_backup_codes_regenerated",
  "account.second_factor_passkey_added",
  "account.second_factor_passkey_removed",
  // A passkey's sign counter did not go up (design §5): allowed, recorded.
  "account.second_factor_passkey_counter_regressed",
  // A backup code answered a second step (sign-in, step-up, ...): one fewer left.
  "account.second_factor_backup_code_used",
  // Email recovery of two-step verification (services/secondFactor/recovery.ts).
  "account.second_factor_recovery_started",
  "account.second_factor_recovery_cancelled",
  "account.second_factor_recovery_completed",
  // A person signed out or revoked their own other sign-in(s) from their
  // sign-in list (services/mySessions.ts): `reason` sign_out (logout-like) or
  // lost_device (a security revoke: what they issued or approved goes too).
  "account.session_revoked",
  "sso.connection_saved",
  "sso.connection_deleted",
  "sso.rules_updated",
  "sso.domain_added",
  "sso.domain_verified",
  "sso.reviewed_domain_verified",
  "sso.domain_unverified",
  "sso.domain_removed",
  "sso.identity_linked",
  "sso.signed_in",
  "sso.sign_in_refused",
  "sso.connection_tested",
  "sso.domain_lookup_failing_notice",
  "sso.domain_unverified_notice",
] as const;

export type IntegrationAuditEventType = (typeof INTEGRATION_AUDIT_EVENT_TYPES)[number];
export type IntegrationAuditOutcome = "success" | "failure";
export type IntegrationAuditSource = "web" | "api" | "cli" | "action_card" | "system";
export const INTEGRATION_AUDIT_ACTOR_TYPES = ["human", "agent", "system"] as const;
export type IntegrationAuditActorType = (typeof INTEGRATION_AUDIT_ACTOR_TYPES)[number];
export type IntegrationAuditSubjectType = "human" | "agent" | "app" | "system";
export const INTEGRATION_AUDIT_EVENT_CATEGORIES = [
  "registration",
  "scope",
  "install",
  "runtime",
  "revocation",
  "server_profile",
  "membership",
  "agent_credential",
  "computer",
  "account_security",
  "sso",
] as const;
export type IntegrationAuditEventCategory = (typeof INTEGRATION_AUDIT_EVENT_CATEGORIES)[number];

type AuditMetadata = Record<string, unknown>;
type AuditDiff = Record<string, unknown>;

/**
 * What a server-wide audit write knows beyond the event itself (metadata keys
 * of the same names). `actorRole`: the acting human's (or agent's) server role
 * at that moment, as the writer's permission check loaded it; absent for system
 * actors and for writers that do not know it. `operationId`: one id shared by
 * every event one logical operation wrote (a member removal and the credentials
 * it revoked; a setup reset and every Computer it revoked).
 */
export interface ServerAuditContext {
  actorRole?: ServerRole | null;
  operationId?: string;
}

const SERVER_AUDIT_CONTEXT_KEYS = ["actorRole", "operationId"] as const;

/** What an agent's View Context search or read records beside the ids (agentContextViewService.ts queryMetadata). */
const AGENT_CONTEXT_QUERY_AUDIT_KEYS = ["mode", "query", "around", "matches", "grantId", "granterUserId"] as const;

/** A fresh id for the events of one multi-event operation. */
export function newAuditOperationId(): string {
  return randomUUID();
}

/** The metadata entries of a ServerAuditContext; unknown parts are omitted, never null. */
export function serverAuditContextMetadata(context: ServerAuditContext | null | undefined): AuditMetadata {
  return {
    ...(context?.actorRole ? { actorRole: context.actorRole } : {}),
    ...(context?.operationId ? { operationId: context.operationId } : {}),
  };
}

const EVENT_METADATA_ALLOWLIST: Record<IntegrationAuditEventType, readonly string[]> = {
  "app.registered": ["appType", "clientKey", "name", "hasReturnUrl", "hasHomepageUrl", "hasAgentManifestUrl"],
  // linkPreview/reason/takeover: a link preview registration suspended, resumed or taken over (domain proof rechecks).
  "app.updated": ["changedFields", "clientKey", "appType", "linkPreview", "reason", "takeover"],
  // RFC 084 §4: clientKey is the new id; previousKeyKept says the old one stayed an alias.
  "app.client_key_changed": ["clientKey", "previousClientKey", "newClientKey", "previousKeyKept"],
  "app.owner_transferred": ["clientKey", "previousOwnerType", "previousOwnerId", "nextOwnerType", "nextOwnerId", "recovery", "ownershipOutcome", "actorAuthority"],
  "app.deleted": ["clientKey", "appType", "publishStatus"],
  "app.publish_requested": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  "app.publish_approved": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus", "installedCount"],
  "app.publish_rejected": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  "app.publish_withdrawn": ["clientKey", "appType", "previousPublishStatus"],
  "app.offline_requested": ["clientKey", "appType", "previousPublishStatus"],
  "app.offline_approved": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus", "removedInstallCount", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount"],
  "app.offline_rejected": ["clientKey", "appType", "previousPublishStatus", "nextPublishStatus"],
  // Interactive link cards (RFC 076 §4): a published App's action endpoint and its review.
  "app.action_endpoint_requested": ["clientKey"],
  "app.action_endpoint_reviewed": ["clientKey", "decision"],
  "app.link_card_actions_confirmed": ["clientKey", "actionEndpoint"],
  "app.link_card_actions_allowed": ["clientKey", "actionEndpoint"],
  "app.link_card_actions_withdrawn": ["clientKey", "actionEndpoint"],
  "app.link_card_actions_on": ["clientKey"],
  "app.link_card_actions_off": ["clientKey"],
  "app.card_encryption_key_set": ["clientKey", "kid", "previousKid"],
  // reason: removed (by the App), registration_deleted (by the App), taken_over (system).
  "app.card_encryption_key_removed": ["clientKey", "kid", "reason"],
  // reason: created_by_admin, vouched, backfill, legacy_no_creator (0732, an MCP App with no
  // recorded creator) / unvouched, scope_widened. appName: an MCP App's.
  "app.server_vouched": ["clientKey", "appName", "reason", "backfill"],
  "app.server_unvouched": ["clientKey", "appName", "reason"],
  // appId/appName: the MCP App; connectionId, ownerKind (shared | personal), ownerUserId (personal).
  // connectionCreatedBy / byConnectionCreator: who added the Connection, and whether that is the
  // actor (an admin pinning Agents to a shared Connection someone else added shows as false).
  "mcp_connection.created": ["appId", "appName", "connectionId", "ownerKind", "ownerUserId", "authKind", ...SERVER_AUDIT_CONTEXT_KEYS],
  "mcp_connection.signed_in": ["appId", "appName", "connectionId", "ownerKind", "ownerUserId", "authKind", ...SERVER_AUDIT_CONTEXT_KEYS],
  // revokedBy: who deleted a member's own Connection, when not its owner; agentIds: the Agents it was given to.
  "mcp_connection.deleted": ["appId", "appName", "connectionId", "ownerKind", "ownerUserId", "revokedBy", "wasServerDefault", "agentIds", ...SERVER_AUDIT_CONTEXT_KEYS],
  "mcp_connection.signed_out": ["appId", "appName", "connectionId", "ownerKind", "ownerUserId", "revokedBy", ...SERVER_AUDIT_CONTEXT_KEYS],
  // granted_by: who chose; added/removed: Agent ids; moved_from: [{ agentId, connectionId, ownerKind, ownerUserId }]
  // for each added Agent that used another Connection's this way before; allAgents: the shared
  // default set (true) or given up (false); via: agents_api | assignments | sign_in | default (PUT
  // /apps/:appId/default) | api_key (an API-key Connection created as the default).
  "mcp_connection.agents_changed": [
    "appId", "appName", "connectionId", "ownerKind", "ownerUserId", "granted_by", "added", "removed", "moved_from",
    "allAgents", "connectionCreatedBy", "byConnectionCreator", "via", ...SERVER_AUDIT_CONTEXT_KEYS,
  ],
  "mcp_connection.members_can_connect_changed": ["appId", "appName", "enabled", "previous", ...SERVER_AUDIT_CONTEXT_KEYS],
  "official_app.registry_created": ["clientKey", "publisherServerId", "revision", "autoInstall", "status", "purpose"],
  "official_app.registry_updated": ["clientKey", "publisherServerId", "revision", "autoInstall", "status", "purpose", "changedFields"],
  "official_app.registry_removed": ["clientKey", "publisherServerId", "revision", "autoInstall", "status", "purpose"],
  "marketplace.installed": ["clientKey", "targetServerId"],
  // reason: why a system uninstall ran (closed_server_purge).
  "marketplace.uninstalled": ["clientKey", "targetServerId", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount", "reason"],
  "client.secret_rotated": ["clientKey", "appType"],
  "action_card.executed": ["actionType", "clientKey", "mode"],
  // A platform admin closes an interactive link card operation stuck in
  // needs_reconciliation (RFC 076 §5.2). The free-text reason stays in FFA's log.
  "link_card.operation_resolved_manually": ["operationId", "actionId", "providerKind", "providerKey", "previousState"],
  // The first-send deadline sweep closed a sent operation that was never
  // dispatched as failed_not_sent (protocol v3.2.3 §5.3.4, §14.3): proved
  // never sent. No token, URL or body.
  "link_card.operation_first_send_expired": ["operationId", "actionId", "providerKind", "providerKey"],
  // A person answers an App's first-view link-preview prompt for themselves on
  // one Server (or turns previews back on or off). Never the message or URL.
  // loginMode: "account" when the answer is for every Server (an account-mode
  // App, RFC 079 D17); absent in server mode.
  "link_preview.consent_granted": ["clientKey", "consentSource", "removedDecline", "loginMode"],
  "link_preview.declined": ["clientKey", "loginMode"],
  "oauth.redirect_mismatch": ["clientKey", "errorCode"],
  "agent.jwt_issued": ["clientKey", "grantId", "jti", "expiresAt"],
  "app.agent_jwt_updated": ["clientKey", "enabled"],
  "installation.agent_jwt_updated": ["clientKey", "enabled"],
  // loginMode: "account" on an account-mode login's events (RFC 079 phase 3a); absent in server mode.
  // source: where the person approved, when the approving client said so (`desktop_browser`: Raft Desktop's built-in browser sheet).
  "oauth.lifecycle": ["clientKey", "stage", "result", "grantType", "principalType", "errorClass", "loginMode", "source"],
  // The reviewed switch (design §2.4): from and to modes, the review reference, the reason and who ran it,
  // and what it found (§2.3): the App's live server-mode human tokens and open server-mode human codes.
  "oauth.login_mode_switched": ["clientKey", "from", "to", "review", "reason", "operator", "liveServerHumanTokens", "openServerHumanCodes"],
  // Per-app revoke (design §3.2, Q9): what the person's revoke changed. Written with no serverId.
  "oauth.app_login_revoked": ["clientKey", "deniedPendingRequestCount", "revokedTokenCount", "revokedAccountConsentCount", "revokedServerConsentCount"],
  "oauth.token_exchange_failed": ["clientKey", "grantType", "errorCode", "requestIdHash"],
  // The target as the creator typed it; never whether it named a Server.
  "private_share.link_created": ["clientKey", "shareLinkId", "targetServerSlug", "expiresAt", "convertedFromServerLocal"],
  "private_share.link_revoked": ["clientKey", "shareLinkId", "targetServerSlug"],
  "private_share.installed": ["clientKey", "shareLinkId", "sourceServerId", "targetServerId"],
  "private_share.uninstalled": ["clientKey", "targetServerId", "revokedGrantCount", "revokedTokenCount", "deniedPendingRequestCount", "reason"],
  "app.outbound_permission_requested": ["clientKey", "revision", "state", "groupCount", "eventCount", "invalidatedInstallationCount"],
  "app.outbound_permission_approved": ["clientKey", "revision", "groupCount", "eventCount"],
  "app.prompt_text_requested": ["revision"],
  "app.prompt_text_reviewed": ["revision", "decision"],
  "app.prompt_text_confirmed": ["revision"],
  "installation.outbound_grant_updated": ["clientKey", "installationId", "grantRevision", "groupCount", "eventCount", "approvedScopes"],
  "installation.outbound_subscription_updated": ["clientKey", "installationId", "subscriptionRevision", "eventCount"],
  "installation.setup_updated": ["installationId", "setupRevision", "status"],
  "installation.token_issued": ["clientKey", "installationId", "grantRevision", "audience", "expiresAt"],
  "installation.bot_grant_updated": ["clientKey", "installationId", "botGrant"],
  "installation.legacy_import_grants_created": ["installationId", "grantCount", "scopes"],
  // RFC 077: never the message text.
  "assistant.send_as_owner": ["messageId", "channelId", "channelType", "errorCode"],
  "assistant.send_as_owner.deleted": ["messageId", "channelId"],
  // Never the files or the title. The Artifact's id (pt_…) is here: target_id is a uuid column.
  "assistant.publish_artifact_as_owner": ["artifactId", "version", "homeChannelId", "newArtifact"],
  // One row per changed setting: which (theme, themeDecor, displayLanguage,
  // preferredTimezone) and its value before and after. Actor: the assistant;
  // subject: its owner. The owner reads these back (GET /api/servers/:id/assistant/setting-changes).
  "assistant.owner_setting_changed": ["setting", "previousValue", "nextValue"],
  // One row per change: the table entry and tool, the target's id, the value before and after.
  // Actor: the assistant; subject: its owner.
  // A confirmed (confirm-tier) action also says who asked (`via`, the assistant), that the owner
  // confirmed it, on which card, and the route's status (assistantOwnerActionCards.ts).
  "assistant.owner_action": ["action", "tool", "targetId", "previousValue", "nextValue", "via", "confirmed", "cardMessageId", "status"],
  "action_card.request_run": ["cardMessageId", "operation", "route", "attempt", "preparerAgentId", "outcome", "routeStatus", "routeCode", "dispatchRequestId"],
  "action_card.request_declined": ["cardMessageId", "operation", "route", "attempt", "preparerAgentId", "outcome"],
  "assistant.owner_read": ["action", "tool"],
  // WeChat bridge: Raft ids, a reason and counts only. Never an iLink id, a
  // token or message text. Subject: the owner; target: the binding.
  "assistant.wechat_bound": ["agentId", "channelId", "replacedBinding"],
  // reason: user | owner_departed | account_deletion | assistant_archived | server_deleted | flag_off.
  "assistant.wechat_disconnected": ["agentId", "reason"],
  "assistant.wechat_token_stale": ["agentId", "errorCode"],
  "assistant.wechat_messages_dropped": ["agentId", "droppedCount"],
  "agent_inbox_push.configured": ["agentId", "providerKind", "configuredBy", "endpointOrigin", "previousEndpointOrigin", "endpointChanged", "previousConfiguredBy", "secretSet"],
  "agent_inbox_push.deleted": ["agentId", "providerKind", "configuredBy"],
  "app_bot.credential": ["clientKey", "installationId", "result", "revokedCount"],
  "webhook.configured": ["clientKey", "configRevision", "endpointOrigin"],
  "webhook.rotated": ["clientKey", "configRevision", "endpointOrigin", "previousValidUntil", "emergency"],
  "webhook.disabled": ["clientKey", "configRevision"],
  "managed_mcp.tool_invocation_admitted": ["toolName"],
  "closed_server_purge.credential_revoke": ["credentialKind", "attempt", "failure", "gaveUp"],
  "agent_connection.connect_initiated": ["connectionProvider", "access", "connectorId", "actingRole", "scopes", "errorCode"],
  "agent_connection.confirmed": ["connectionProvider", "account", "connectorId", "errorCode"],
  "agent_connection.disconnected": ["connectionProvider", "errorCode"],
  "agent_connection.connector_assigned": ["connectionProvider", "connectorId", "actingRole", "errorCode"],
  "agent_connection.connector_disconnected": ["connectionProvider", "connectorId", "actingRole", "errorCode"],
  // A decision on an antiproton held call (agentRuntimeApprovalService): the decider's grounds, never their antiproton-facing ids.
  "agent_runtime.approval_decided": ["operationId", "decision", "role", "result", "providerStatus", "attempts"],
  // How a hold ended and whether a card was ever delivered; never who it went to.
  "agent_runtime.approval_ended": ["operationId", "status", "delivered"],
  // Server-wide audit. Ids and roles only: never key material, prefixes or hashes.
  // Every server-wide type also takes SERVER_AUDIT_CONTEXT_KEYS (actorRole, operationId).
  "server.profile_updated": ["changedFields", "agentServerRole", ...SERVER_AUDIT_CONTEXT_KEYS],
  "server.plan_changed": [
    "serverSlug", "fromPlan", "toPlan", "planDowngradedAt", "reason",
    "actorId", "actorName", "approvedBy", "approvalMessageId", "via",
  ],
  "channel.visitor_visibility_changed": ["channelId", "visitorVisible", ...SERVER_AUDIT_CONTEXT_KEYS],
  "membership.role_changed": ["previousRole", "nextRole", ...SERVER_AUDIT_CONTEXT_KEYS],
  "membership.agent_role_changed": ["agentId", "previousRole", "nextRole", "grantedBy", ...SERVER_AUDIT_CONTEXT_KEYS],
  "membership.removed": ["reason", "removedRole", "revokedAgentCredentialCount", ...SERVER_AUDIT_CONTEXT_KEYS],
  // reason: CHANNEL_MEMBERSHIP_END_REASONS; a joint channel adds the joint, the server the removal came through and the joint's host.
  "channel.member_left": ["reason", "channelId", "channelType", "jointChannelId", "initiatingServerId", "hostServerId", ...SERVER_AUDIT_CONTEXT_KEYS],
  "channel.member_removed": ["reason", "channelId", "channelType", "jointChannelId", "initiatingServerId", "hostServerId", ...SERVER_AUDIT_CONTEXT_KEYS],
  // channelId: the event's own server's copy. byHost: the host disconnected the server (true), or the server disconnected itself (false).
  "channel.server_disconnected": ["jointChannelId", "hostServerId", "disconnectedServerId", "channelId", "byHost", ...SERVER_AUDIT_CONTEXT_KEYS],
  // channelId: the host's copy. mode: how it connected (ServerConnectedMode, jointMemberConnectEffects.ts). guestReleased (self_connect): the actor's Guest seat on the host ended with it.
  "channel.server_connected": ["mode", "jointChannelId", "hostServerId", "channelId", "connectedServerId", "guestReleased", ...SERVER_AUDIT_CONTEXT_KEYS],
  // channelId: the host's copy. previous*: the ended source row as it was before it was reopened (ISO times).
  "channel.source_readmitted": ["jointChannelId", "hostServerId", "channelId", "sourceServerId", "userId", "generation",
    "previousEndedAt", "previousAdmittedBy", "previousAdmittedAt", "previousKind", ...SERVER_AUDIT_CONTEXT_KEYS],
  // sessionSource: minted with a person's session (POST /api/agents/:id/credentials), which kind (`web_session`,
  // or `device_session` for a device login's, which is not gated by step-up). Its family id is trace-only.
  // via/expiresAt: a Computer's runner credential renewal (`via: "runner_renewed"`, recordRunnerCredentialRenewed).
  "agent_credential.issued": ["agentId", "credentialId", "scopes", "issuedVia", "viaBootstrapToken", "machineId", "bootstrapTokenId", "replacedCredentialId", "sessionSource", "via", "expiresAt", ...SERVER_AUDIT_CONTEXT_KEYS],
  // computerId/via: revoked with the Computer that minted it (computerKeyRevocation.ts), through its revoke link, the web or its detach.
  // grantId/trigger: revoked because the web session that approved its device-login grant was security-revoked (approverSessionGrants.ts).
  // departureReason: revoked with its Computer because the person who attached it left or was removed from the server, or asked to delete their account (`via: "member_removed"`).
  "agent_credential.revoked": ["agentId", "credentialId", "reason", "revokedCount", "computerId", "via", "grantId", "trigger", "departureReason", ...SERVER_AUDIT_CONTEXT_KEYS],
  "agent_credential.bootstrap_token_issued": ["agentId", "bootstrapTokenId", "scopes", "expiresAt", ...SERVER_AUDIT_CONTEXT_KEYS],
  "computer.removed": ["machineId", "machineName", ...SERVER_AUDIT_CONTEXT_KEYS],
  // Ids only (the agent's Computer, if any); the request id is the row's `request_id`.
  // An agent's search or read (#wg-ax:#15) adds what it asked (mode, the redacted
  // query or the entry, the match count) and, viewing another agent, the grant it
  // used and that grant's granter (grantId, granterUserId).
  "agent.context_view_requested": ["agentId", "messageId", "machineId", "viewerType", ...AGENT_CONTEXT_QUERY_AUDIT_KEYS],
  // Ids, the outcome (`ok` or a failure reason), decompressed bytes (ok only), runtime and duration.
  "agent.context_viewed": ["agentId", "messageId", "machineId", "viewerType", "outcome", "bytes", "runtime", "durationMs", ...AGENT_CONTEXT_QUERY_AUDIT_KEYS],
  "agent.voice_question_asked": ["agentId", "machineId"],
  // The grant's id and its grantee; a revoke also says whether the revoker was the granter.
  "agent.context_view_granted": ["grantId", "agentId", ...SERVER_AUDIT_CONTEXT_KEYS],
  "agent.context_view_grant_revoked": ["grantId", "agentId", "granterUserId", "byGranter", ...SERVER_AUDIT_CONTEXT_KEYS],
  // via: `placed_without_source`, an agent on no Computer placed by POST /agents/:id/migrate (placeAgentWithoutSource).
  "computer.agent_assigned": ["agentId", "machineId", "previousMachineId", "machineOwnerIsActor", "via", ...SERVER_AUDIT_CONTEXT_KEYS],
  // Ids only: the new migration, the failed one it retries, the Computers, and the starter it acts for.
  "agent.migration_retry_started": ["agentId", "migrationId", "retryOfMigrationId", "onBehalfOfUserId", "sourceMachineId", "targetMachineId"],
  "computer.key_rotated": ["machineId", "machineName", "computerId", "computerName", "reason", ...SERVER_AUDIT_CONTEXT_KEYS],
  // via: how one Computer was revoked (its revoke link, the web, or its own detach); revokedCount: the runner credentials revoked with it.
  // departureReason (`via: "member_removed"`): the person who attached it was removed (`removed`) or left (`left`), serverService.ts removeMemberInTransaction; or asked to delete their account (`account_deleted`), accountDeletion/requests.ts.
  "computer.key_revoked": ["computerId", "computerName", "machineId", "reason", "via", "revokedCount", "grantId", "trigger", "departureReason", ...SERVER_AUDIT_CONTEXT_KEYS],
  // A Computer retired the device session that issued its key (reason
  // migration_retire, POST /api/computer/retire-session). Written with no
  // serverId: the person's, never on a server's audit page. keyMatch: the
  // session issued the key, or the key records no issuer and the person attached it.
  "computer.device_session_retired": ["reason", "keyMatch", "sessionFamilyId", "computerId", "computerName", "machineId", "computerServerId", "requestIp"],
  // Ids only: the agents unbound and the machine they were on; from a detach (`raft-computer detach`),
  // via `detach` and the Computer that asked.
  // reason: transfer / claim / made_public / owner_left_server / owner_account_deleted.
  "computer.owner_changed": ["machineId", "machineName", "previousOwnerUserId", "ownerUserId", "reason", ...SERVER_AUDIT_CONTEXT_KEYS],
  // via: migrate_grant (a computer_migrate approval, with its grantId) / session.
  "computer.legacy_adopted_by_other": ["machineId", "machineName", "computerId", "computerName", "machineAddedByUserId", "via", "grantId", ...SERVER_AUDIT_CONTEXT_KEYS],
  "computer.revoke_unbound_others_agents": ["agentIds", "machineId", "computerId", "via", ...SERVER_AUDIT_CONTEXT_KEYS],
  // provider: the runtime account (`claude`, `codex`); resetKind: the Claude reset spent (five_hour, weekly, fable, full);
  // requestedKind: the one asked for when Claude's older program spent its 5-hour reset instead; via: redeem / read;
  // answer: reset / already_redeemed / five_hour_spent (services/runtimeLimitResetUsedByOther.ts).
  "computer.limit_reset_used_by_other": ["machineId", "machineName", "provider", "resetKind", "requestedKind", "via", "answer", ...SERVER_AUDIT_CONTEXT_KEYS],
  // runtime: the sign-in id (`grok`, `qwen`, ...); result: the Computer's outcome kind (installed / already_installed /
  // failed / unsupported / error) or the request's end without one (computer_timeout / computer_offline / request_failed);
  // version (a plain release version), exitCode, reason (OAR's unsupported reason), errorCode (in_progress / internal).
  "computer.runtime_install": ["machineId", "machineName", "runtime", "result", "version", "exitCode", "reason", "errorCode", ...SERVER_AUDIT_CONTEXT_KEYS],
  // agentId, jobName (a `raft proc` name: letters, digits, - and _); result: the Computer's outcome (stopped /
  // not_found / already_exited / failed) or the request's end without one (computer_offline /
  // computer_upgrade_required / computer_timeout / request_failed).
  "computer.proc_job_stopped": ["machineId", "machineName", "agentId", "jobName", "result", ...SERVER_AUDIT_CONTEXT_KEYS],
  // Ids only: the agents unbound in this server and the person's machines they were on.
  "account.deletion_unbound_others_agents": ["agentIds", "machineIds"],
  // Ids and the method only: never a secret, a TOTP code or a backup code.
  "account.second_factor_totp_confirmed": ["sessionFamilyId", "rebind", "signedOutSessionCount"],
  "account.second_factor_enabled": ["sessionFamilyId", "method", "signedOutSessionCount"],
  "account.second_factor_disabled": ["sessionFamilyId", "method", "signedOutSessionCount"],
  "account.second_factor_backup_codes_regenerated": ["sessionFamilyId", "method", "signedOutSessionCount"],
  "account.second_factor_passkey_added": ["sessionFamilyId", "passkeyId", "aaguid", "synced"],
  "account.second_factor_passkey_removed": ["sessionFamilyId", "passkeyId", "method", "signedOutSessionCount"],
  "account.second_factor_passkey_counter_regressed": ["sessionFamilyId", "passkeyId", "storedCounter", "receivedCounter", "context"],
  "account.second_factor_backup_code_used": ["sessionFamilyId", "method", "context", "signInFlow", "remaining"],
  // Ids, the reason and a count only: never the client's platform or version.
  "account.session_revoked": ["sessionFamilyId", "revokedSessionFamilyIds", "reason", "scope", "signedOutSessionCount"],
  "account.second_factor_recovery_started": ["requestId", "eligibleAt"],
  "account.second_factor_recovery_cancelled": ["requestId", "cancelledBy"],
  "account.second_factor_recovery_completed": ["requestId", "signInFlow"],
  // SSO configuration (rfcs/083-server-sso.md §7): ids, protocol, domain and
  // rule values only; never a client secret or a certificate.
  "sso.connection_saved": ["connectionId", "protocol", "status", "draft", "created", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.connection_deleted": ["connectionId", "protocol", "status", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.rules_updated": ["connectionId", "autoJoin", "sessionMaxAgeDays", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.domain_added": ["domainId", "domain", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.domain_verified": ["domainId", "domain", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.reviewed_domain_verified": ["domainId", "domain"],
  "sso.domain_unverified": ["domainId", "domain", "result", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.domain_removed": ["domainId", "domain", "verified", ...SERVER_AUDIT_CONTEXT_KEYS],
  // A sign-in (rfcs/083-server-sso.md §7): never the assertion, the subject or the email.
  "sso.identity_linked": ["connectionId", "relinked", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.signed_in": ["connectionId", "sessionFamilyId", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.sign_in_refused": ["connectionId", "reason", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.connection_tested": ["connectionId", "promotedDraft", "activated", "identitiesCleared", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.domain_lookup_failing_notice": ["domainId", "domain", "recipients", "since", ...SERVER_AUDIT_CONTEXT_KEYS],
  "sso.domain_unverified_notice": ["domainId", "domain", "recipients", "since", ...SERVER_AUDIT_CONTEXT_KEYS],
};

const EVENT_CATEGORY: Record<IntegrationAuditEventType, IntegrationAuditEventCategory> = {
  "app.registered": "registration",
  "app.updated": "registration",
  "app.client_key_changed": "registration",
  "app.owner_transferred": "registration",
  "app.deleted": "revocation",
  "app.publish_requested": "registration",
  "app.publish_approved": "registration",
  "app.publish_rejected": "registration",
  "app.publish_withdrawn": "registration",
  "app.offline_requested": "revocation",
  "app.offline_approved": "revocation",
  "app.offline_rejected": "revocation",
  "app.action_endpoint_requested": "registration",
  "app.action_endpoint_reviewed": "registration",
  "app.link_card_actions_confirmed": "registration",
  "app.link_card_actions_allowed": "registration",
  "app.link_card_actions_withdrawn": "revocation",
  "app.link_card_actions_on": "registration",
  "app.link_card_actions_off": "revocation",
  "app.card_encryption_key_set": "registration",
  "app.card_encryption_key_removed": "revocation",
  "app.server_vouched": "membership",
  "app.server_unvouched": "membership",
  // Who acts as whom for this Server's agents: in the server audit owners and admins read, like the vouch.
  "mcp_connection.created": "membership",
  "mcp_connection.signed_in": "membership",
  "mcp_connection.deleted": "membership",
  "mcp_connection.signed_out": "membership",
  "mcp_connection.agents_changed": "membership",
  "mcp_connection.members_can_connect_changed": "membership",
  "official_app.registry_created": "registration",
  "official_app.registry_updated": "registration",
  "official_app.registry_removed": "revocation",
  "marketplace.installed": "install",
  "marketplace.uninstalled": "revocation",
  "client.secret_rotated": "revocation",
  "action_card.executed": "runtime",
  "link_card.operation_resolved_manually": "runtime",
  "link_card.operation_first_send_expired": "runtime",
  "link_preview.consent_granted": "scope",
  "link_preview.declined": "scope",
  "oauth.redirect_mismatch": "runtime",
  "oauth.lifecycle": "runtime",
  "oauth.login_mode_switched": "registration",
  "oauth.app_login_revoked": "revocation",
  "agent.jwt_issued": "runtime",
  "app.agent_jwt_updated": "scope",
  "installation.agent_jwt_updated": "scope",
  "oauth.token_exchange_failed": "runtime",
  "private_share.link_created": "install",
  "private_share.link_revoked": "revocation",
  "private_share.installed": "install",
  "private_share.uninstalled": "revocation",
  "app.outbound_permission_requested": "scope",
  "app.outbound_permission_approved": "scope",
  "app.prompt_text_requested": "scope",
  "app.prompt_text_reviewed": "scope",
  "app.prompt_text_confirmed": "scope",
  "installation.outbound_grant_updated": "scope",
  "installation.outbound_subscription_updated": "scope",
  "installation.token_issued": "runtime",
  "installation.bot_grant_updated": "scope",
  "installation.legacy_import_grants_created": "scope",
  "assistant.send_as_owner": "runtime",
  "assistant.send_as_owner.deleted": "runtime",
  "assistant.publish_artifact_as_owner": "runtime",
  "assistant.owner_setting_changed": "runtime",
  "assistant.owner_action": "runtime",
  "action_card.request_run": "runtime",
  "action_card.request_declined": "runtime",
  "assistant.owner_read": "runtime",
  "assistant.wechat_bound": "install",
  "assistant.wechat_disconnected": "revocation",
  "assistant.wechat_token_stale": "runtime",
  "assistant.wechat_messages_dropped": "runtime",
  "agent_inbox_push.configured": "runtime",
  "agent_inbox_push.deleted": "runtime",
  "app_bot.credential": "runtime",
  "installation.setup_updated": "install",
  "webhook.configured": "runtime",
  "webhook.rotated": "revocation",
  "webhook.disabled": "revocation",
  "managed_mcp.tool_invocation_admitted": "runtime",
  "closed_server_purge.credential_revoke": "revocation",
  "agent_connection.connect_initiated": "scope",
  "agent_connection.confirmed": "scope",
  "agent_connection.disconnected": "revocation",
  "agent_connection.connector_assigned": "scope",
  "agent_connection.connector_disconnected": "revocation",
  // Platform-admin only, like the other runtime events: the product surface for
  // who viewed is GET /api/agents/:id/context-views (the agent's own viewers).
  "agent.context_view_requested": "runtime",
  "agent.context_viewed": "runtime",
  "agent.voice_question_asked": "runtime",
  "agent_runtime.approval_decided": "runtime",
  "agent_runtime.approval_ended": "runtime",
  "server.profile_updated": "server_profile",
  "server.plan_changed": "server_profile",
  "channel.visitor_visibility_changed": "server_profile",
  "membership.role_changed": "membership",
  "membership.agent_role_changed": "membership",
  "membership.removed": "membership",
  "channel.member_left": "membership",
  "channel.member_removed": "membership",
  "channel.server_disconnected": "membership",
  "channel.server_connected": "membership",
  "channel.source_readmitted": "membership",
  // A permission change on an agent, like its role: in the server audit owners and admins read.
  "agent.context_view_granted": "membership",
  "agent.context_view_grant_revoked": "membership",
  "agent_credential.issued": "agent_credential",
  "agent_credential.revoked": "agent_credential",
  "agent_credential.bootstrap_token_issued": "agent_credential",
  "computer.removed": "computer",
  "computer.agent_assigned": "computer",
  "agent.migration_retry_started": "computer",
  "computer.key_rotated": "computer",
  "computer.key_revoked": "computer",
  "computer.device_session_retired": "computer",
  "computer.revoke_unbound_others_agents": "computer",
  "computer.owner_changed": "computer",
  "computer.legacy_adopted_by_other": "computer",
  "computer.limit_reset_used_by_other": "computer",
  "computer.runtime_install": "computer",
  "computer.proc_job_stopped": "computer",
  "account.deletion_unbound_others_agents": "computer",
  "account.second_factor_totp_confirmed": "account_security",
  "account.second_factor_enabled": "account_security",
  "account.second_factor_disabled": "account_security",
  "account.second_factor_backup_codes_regenerated": "account_security",
  "account.second_factor_passkey_added": "account_security",
  "account.second_factor_passkey_removed": "account_security",
  "account.second_factor_passkey_counter_regressed": "account_security",
  "account.second_factor_backup_code_used": "account_security",
  "account.session_revoked": "account_security",
  "account.second_factor_recovery_started": "account_security",
  "account.second_factor_recovery_cancelled": "account_security",
  "account.second_factor_recovery_completed": "account_security",
  "sso.connection_saved": "sso",
  "sso.connection_deleted": "sso",
  "sso.rules_updated": "sso",
  "sso.domain_added": "sso",
  "sso.domain_verified": "sso",
  "sso.reviewed_domain_verified": "sso",
  "sso.domain_unverified": "sso",
  "sso.domain_removed": "sso",
  "sso.identity_linked": "sso",
  "sso.signed_in": "sso",
  "sso.sign_in_refused": "sso",
  "sso.connection_tested": "sso",
  "sso.domain_lookup_failing_notice": "sso",
  "sso.domain_unverified_notice": "sso",
};

const DIFF_ALLOWLIST = new Set([
  "setupUrl", "setupDescription", "setupRevision",
  "name",
  "description",
  "homepageUrl",
  "returnUrl",
  "agentManifestUrl",
  "allowedScopes",
  "agentTokenSigningAlg",
  "agentTokenType",
  "category",
  "logoUrl",
  "enabled",
  "humanMarketplaceVisible",
  "publishStatus",
  "autoInstall",
  "purpose",
  "status",
  "hideHumansFromMembers",
  "avatarChanged",
  "role",
  "plan",
]);

const CREDENTIAL_KEY_PATTERN = /(^|_)(authorization|bearer|client_secret|code|cookie|jwt|password|secret|token)(_|$)/i;
const CREDENTIAL_VALUE_PATTERN = /(?:sk_(?:agent|machine)_[A-Za-z0-9_-]+|(?:slock|raft)_secret_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;

export class IntegrationAuditValidationError extends Error {}

function assertKnownEventType(eventType: string): asserts eventType is IntegrationAuditEventType {
  if (!(INTEGRATION_AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new IntegrationAuditValidationError(`Unknown integration audit event type: ${eventType}`);
  }
}

function isSafeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !CREDENTIAL_VALUE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.every(isSafeValue);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(([key, nested]) => (
      !CREDENTIAL_KEY_PATTERN.test(key) && isSafeValue(nested)
    ));
  }
  return true;
}

export function sanitizeIntegrationAuditMetadata(
  eventType: IntegrationAuditEventType,
  metadata: AuditMetadata | null | undefined,
): AuditMetadata {
  const allowed = new Set(EVENT_METADATA_ALLOWLIST[eventType]);
  const safe: AuditMetadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!allowed.has(key) || CREDENTIAL_KEY_PATTERN.test(key) || !isSafeValue(value)) continue;
    safe[key] = value;
  }
  return safe;
}

export function sanitizeIntegrationAuditDiff(diff: AuditDiff | null | undefined): AuditDiff | null {
  const safe: AuditDiff = {};
  for (const [key, value] of Object.entries(diff ?? {})) {
    if (!DIFF_ALLOWLIST.has(key) || CREDENTIAL_KEY_PATTERN.test(key) || !isSafeValue(value)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

export interface IntegrationAuditEventInput {
  serverId?: string | null;
  clientId?: string | null;
  eventType: IntegrationAuditEventType;
  outcome: IntegrationAuditOutcome;
  source: IntegrationAuditSource;
  actor: { type: IntegrationAuditActorType; id?: string | null };
  requester?: { type: IntegrationAuditSubjectType; id?: string | null } | null;
  subject?: { type: IntegrationAuditSubjectType; id?: string | null } | null;
  target: { type: string; id?: string | null };
  correlationId?: string | null;
  requestId?: string | null;
  metadata?: AuditMetadata | null;
  diff?: AuditDiff | null;
}

function integrationAuditEventRow(input: IntegrationAuditEventInput): typeof integrationAuditEvents.$inferInsert {
  assertKnownEventType(input.eventType);
  return {
    serverId: input.serverId ?? null,
    clientId: input.clientId ?? null,
    eventType: input.eventType,
    eventCategory: EVENT_CATEGORY[input.eventType],
    outcome: input.outcome,
    source: input.source,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    requesterType: input.requester?.type ?? null,
    requesterId: input.requester?.id ?? null,
    subjectType: input.subject?.type ?? null,
    subjectId: input.subject?.id ?? null,
    targetType: input.target.type,
    targetId: input.target.id ?? null,
    correlationId: input.correlationId ?? null,
    // Inside a confirmed card's dispatched request (ownerDispatchContext.ts), its id, so this row joins the card's own event.
    requestId: input.requestId ?? ownerDispatchRequestId() ?? null,
    metadata: sanitizeIntegrationAuditMetadata(input.eventType, input.metadata),
    diff: sanitizeIntegrationAuditDiff(input.diff),
  };
}

export async function recordIntegrationAuditEvent(input: IntegrationAuditEventInput, dbOrTx: DatabaseExecutor = getDb()) {
  const [created] = await dbOrTx.insert(integrationAuditEvents).values(integrationAuditEventRow(input)).returning();
  return created;
}

/** Several events in one INSERT (one statement, the caller's transaction); nothing for none. */
export async function recordIntegrationAuditEvents(inputs: readonly IntegrationAuditEventInput[], dbOrTx: DatabaseExecutor = getDb()): Promise<void> {
  if (inputs.length === 0) return;
  await dbOrTx.insert(integrationAuditEvents).values(inputs.map(integrationAuditEventRow));
}

export async function recordIntegrationAuditEventBestEffort(
  input: Parameters<typeof recordIntegrationAuditEvent>[0],
  dbOrTx: DatabaseExecutor = getDb(),
) {
  try {
    await recordIntegrationAuditEvent(input, dbOrTx);
  } catch (err) {
    console.warn("[integration-audit] audit_write_failed", err instanceof Error ? err.message : err);
  }
}

export function redactIntegrationAuditEventForAppAdmin<T extends {
  eventType: string;
  correlationId: string | null;
  requestId: string | null;
  metadata: unknown;
}>(event: T): T {
  if (event.eventType !== "oauth.token_exchange_failed") {
    return event;
  }
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? Object.fromEntries(
        Object.entries(event.metadata as Record<string, unknown>).filter(([key]) => key !== "requestIdHash"),
      )
    : event.metadata;
  return {
    ...event,
    correlationId: null,
    requestId: null,
    metadata,
  };
}

export async function listIntegrationAuditEventsForAppAdmin(limit = 100) {
  const safeLimit = Math.max(1, Math.min(limit, 250));
  const rows = await getDb().select({
    id: integrationAuditEvents.id,
    serverId: integrationAuditEvents.serverId,
    serverName: servers.name,
    serverSlug: servers.slug,
    clientId: integrationAuditEvents.clientId,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
    eventType: integrationAuditEvents.eventType,
    eventCategory: integrationAuditEvents.eventCategory,
    outcome: integrationAuditEvents.outcome,
    source: integrationAuditEvents.source,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    actorName: users.name,
    actorDisplayName: users.displayName,
    requesterType: integrationAuditEvents.requesterType,
    requesterId: integrationAuditEvents.requesterId,
    subjectType: integrationAuditEvents.subjectType,
    subjectId: integrationAuditEvents.subjectId,
    targetType: integrationAuditEvents.targetType,
    targetId: integrationAuditEvents.targetId,
    correlationId: integrationAuditEvents.correlationId,
    requestId: integrationAuditEvents.requestId,
    metadata: integrationAuditEvents.metadata,
    diff: integrationAuditEvents.diff,
    createdAt: integrationAuditEvents.createdAt,
  })
    .from(integrationAuditEvents)
    .leftJoin(oauthClients, eq(oauthClients.id, integrationAuditEvents.clientId))
    .leftJoin(servers, eq(servers.id, integrationAuditEvents.serverId))
    .leftJoin(users, eq(users.id, integrationAuditEvents.actorId))
    .orderBy(desc(integrationAuditEvents.createdAt))
    .limit(safeLimit);
  return rows.map(redactIntegrationAuditEventForAppAdmin);
}

export const SERVER_AUDIT_EVENTS_DEFAULT_LIMIT = 100;
export const SERVER_AUDIT_EVENTS_MAX_LIMIT = 200;

/**
 * The categories a server's owners and admins may read. The integration
 * categories (registration, scope, install, runtime, revocation) stay
 * platform-admin only (listIntegrationAuditEventsForAppAdmin).
 */
export const SERVER_AUDIT_EVENT_CATEGORIES = [
  "server_profile",
  "membership",
  "agent_credential",
  "computer",
  "sso",
] as const satisfies readonly IntegrationAuditEventCategory[];

/**
 * Keyset position of one event: its exact `created_at` (microseconds, UTC) and
 * id. Rows written in one transaction share `created_at` (Postgres `now()`),
 * and a JS Date drops the microseconds, so the cursor carries Postgres's own
 * text and the id breaks ties.
 */
type ServerAuditCursor = { createdAt: string; id: string };

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeServerAuditCursor(cursor: ServerAuditCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** The cursor a client sent back, or null when it is not one this API issued. */
export function decodeServerAuditCursor(raw: string): ServerAuditCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const [createdAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !createdAt || !id) return null;
  if (!CURSOR_TIME_PATTERN.test(createdAt) || !CURSOR_ID_PATTERN.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

/**
 * Optional narrowing of the server audit list, always inside `serverId`. A
 * `nextCursor` is only meaningful with the filters it was issued under: a
 * client that changes filters starts again without a cursor.
 */
export interface ServerAuditEventFilters {
  /** One or more of SERVER_AUDIT_EVENT_CATEGORIES (default: all of them). */
  categories?: readonly ServerAuditEventCategory[];
  /** `actorId` requires a human or agent `actorType`. */
  actorType?: IntegrationAuditActorType;
  actorId?: string;
  /** Inclusive lower bound on `createdAt`: an ISO 8601 timestamp with a zone. */
  since?: string;
  /** Exclusive upper bound on `createdAt`, same form as `since`. */
  until?: string;
}

// A zone is required: Postgres would read a bare date or time in the session zone.
const AUDIT_FILTER_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidAuditFilterTime(value: string): boolean {
  if (!AUDIT_FILTER_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) return false;
  // Date.parse rolls 2026-02-30 over to March; Postgres would refuse it.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDate() === day;
}

function queryValues(value: unknown): string[] | null {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.every((entry) => typeof entry === "string") ? values as string[] : null;
}

/**
 * The read route's filter query (`category` repeated or comma-separated,
 * `actorType`, `actorId`, `since`, `until`), or the 400 message for the first
 * malformed one.
 */
export function parseServerAuditEventFilters(query: Record<string, unknown>):
  | { ok: true; filters: ServerAuditEventFilters }
  | { ok: false; error: string } {
  const filters: ServerAuditEventFilters = {};
  const rawCategories = queryValues(query.category);
  if (rawCategories === null) return { ok: false, error: "category must be a string" };
  const categories = rawCategories.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (rawCategories.length > 0 && categories.length === 0) return { ok: false, error: "category must not be empty" };
  for (const category of categories) {
    if (!(SERVER_AUDIT_EVENT_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, error: `category must be one of ${SERVER_AUDIT_EVENT_CATEGORIES.join(", ")}` };
    }
  }
  if (categories.length > 0) filters.categories = categories as ServerAuditEventCategory[];

  const single = (name: string): string | null | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  };
  const actorType = single("actorType");
  if (actorType !== undefined) {
    if (actorType === null || !(INTEGRATION_AUDIT_ACTOR_TYPES as readonly string[]).includes(actorType)) {
      return { ok: false, error: `actorType must be one of ${INTEGRATION_AUDIT_ACTOR_TYPES.join(", ")}` };
    }
    filters.actorType = actorType as IntegrationAuditActorType;
  }
  const actorId = single("actorId");
  if (actorId !== undefined) {
    if (actorId === null || !CURSOR_ID_PATTERN.test(actorId)) return { ok: false, error: "actorId must be a uuid" };
    if (filters.actorType !== "human" && filters.actorType !== "agent") {
      return { ok: false, error: "actorId requires actorType human or agent" };
    }
    filters.actorId = actorId.toLowerCase();
  }
  for (const name of ["since", "until"] as const) {
    const value = single(name);
    if (value === undefined) continue;
    if (value === null || !isValidAuditFilterTime(value)) {
      return { ok: false, error: `${name} must be an ISO 8601 timestamp with a time zone, e.g. 2026-01-31T00:00:00Z` };
    }
    filters[name] = value;
  }
  return { ok: true, filters };
}

export type ServerAuditEventCategory = (typeof SERVER_AUDIT_EVENT_CATEGORIES)[number];

/**
 * Event types in a server-audit category its owners and admins still do not
 * read (platform-admin only, listIntegrationAuditEventsForAppAdmin): a
 * channel membership ending names private channels and DMs, and who left
 * them, which an owner or admin outside them must not learn (RBAC, for now).
 */
export const SERVER_AUDIT_HIDDEN_EVENT_TYPES = [
  "channel.member_left",
  "channel.member_removed",
  // Names a joint channel the reader may not be in; same rule, until RBAC decides.
  "channel.server_disconnected",
  "channel.server_connected",
  "channel.source_readmitted",
] as const satisfies readonly IntegrationAuditEventType[];

/** What the owners' server audit page keeps of a `server.plan_changed` row (Tenny, #15250 follow-up). */
const SERVER_PLAN_CHANGED_OWNER_METADATA_KEYS = ["fromPlan", "toPlan"] as const;

/**
 * A platform operator changed the plan through Feature Flag Admin
 * (`server.plan_changed`, written by public.ffa_change_server_plan). Owners
 * and admins see only that a platform admin changed it, from which plan to
 * which, and when. The operator's reason, the approval it acted on
 * (`approvedBy`, the approver's own words, and `approvalMessageId`) and the
 * operator's identity (`actor_id`, `actorId`, `actorName`) stay
 * platform-admin only (listIntegrationAuditEventsForAppAdmin returns the full
 * row).
 */
export function projectServerPlanChangedForServerAudit<T extends {
  eventType: string;
  actorId: string | null;
  metadata: Record<string, unknown>;
}>(event: T): T & { summary?: { zh: string; en: string } } {
  if (event.eventType !== "server.plan_changed") return event;
  const source = event.metadata ?? {};
  const metadata: Record<string, unknown> = { actorRole: "platform_admin" };
  for (const key of SERVER_PLAN_CHANGED_OWNER_METADATA_KEYS) {
    if (key in source) metadata[key] = source[key];
  }
  const from = String(source.fromPlan ?? "?");
  const to = String(source.toPlan ?? "?");
  return {
    ...event,
    actorId: null,
    metadata,
    summary: {
      zh: `平台管理员把 plan 从 ${from} 改成 ${to}`,
      en: `A platform admin changed the plan from ${from} to ${to}`,
    },
  };
}

/** A person or agent named by an event on the page, resolved at read time. */
export interface ServerAuditPerson {
  type: "human" | "agent";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Agents only: the agent has since been deleted (archived). */
  deleted?: boolean;
}

/**
 * Newest-first audit events of one server, in the server-audit categories
 * only and none of SERVER_AUDIT_HIDDEN_EVENT_TYPES, for its owners and
 * admins. Keyset-paged on (created_at, id) DESC: `nextCursor` is null on
 * the last page. A `server.plan_changed` row is shown through
 * projectServerPlanChangedForServerAudit (no approval text, no operator
 * identity). Request correlation stays internal:
 * request ids are never returned and a metadata `requestIdHash` is stripped.
 * `people` resolves every human and agent the page names (actor, requester,
 * subject, target, metadata `agentId`), keyed `${type}:${id}`.
 */
export async function listServerAuditEvents(serverId: string, options: {
  limit?: number;
  cursor?: ServerAuditCursor | null;
  filters?: ServerAuditEventFilters;
} = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? SERVER_AUDIT_EVENTS_DEFAULT_LIMIT, SERVER_AUDIT_EVENTS_MAX_LIMIT));
  const filters = options.filters ?? {};
  const categories = filters.categories && filters.categories.length > 0
    ? SERVER_AUDIT_EVENT_CATEGORIES.filter((category) => filters.categories!.includes(category))
    : [...SERVER_AUDIT_EVENT_CATEGORIES];
  const createdAtText = sql<string>`to_char(${integrationAuditEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = await getDb().select({
    id: integrationAuditEvents.id,
    serverId: integrationAuditEvents.serverId,
    clientId: integrationAuditEvents.clientId,
    eventType: integrationAuditEvents.eventType,
    eventCategory: integrationAuditEvents.eventCategory,
    outcome: integrationAuditEvents.outcome,
    source: integrationAuditEvents.source,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    requesterType: integrationAuditEvents.requesterType,
    requesterId: integrationAuditEvents.requesterId,
    subjectType: integrationAuditEvents.subjectType,
    subjectId: integrationAuditEvents.subjectId,
    targetType: integrationAuditEvents.targetType,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
    diff: integrationAuditEvents.diff,
    createdAt: integrationAuditEvents.createdAt,
    cursorCreatedAt: createdAtText,
  })
    .from(integrationAuditEvents)
    .where(and(
      eq(integrationAuditEvents.serverId, serverId),
      inArray(integrationAuditEvents.eventCategory, categories),
      notInArray(integrationAuditEvents.eventType, [...SERVER_AUDIT_HIDDEN_EVENT_TYPES]),
      filters.actorType ? eq(integrationAuditEvents.actorType, filters.actorType) : undefined,
      filters.actorId ? eq(integrationAuditEvents.actorId, filters.actorId) : undefined,
      // The operator behind a server.plan_changed is not shown to owners, so
      // an actor filter must not reveal it either.
      filters.actorId ? ne(integrationAuditEvents.eventType, "server.plan_changed") : undefined,
      filters.since ? sql`${integrationAuditEvents.createdAt} >= ${filters.since}::timestamptz` : undefined,
      filters.until ? sql`${integrationAuditEvents.createdAt} < ${filters.until}::timestamptz` : undefined,
      options.cursor
        ? sql`(${integrationAuditEvents.createdAt}, ${integrationAuditEvents.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`
        : undefined,
    ))
    .orderBy(desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const events = page.map(({ cursorCreatedAt: _cursor, ...row }) =>
    projectServerPlanChangedForServerAudit({ ...row, metadata: stripRequestIdHash(row.metadata) }));
  return {
    events,
    nextCursor: rows.length > limit && last ? encodeServerAuditCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
    people: await resolveServerAuditPeople(serverId, events),
  };
}

/**
 * One query per principal type for every human and agent the events name.
 * Users resolve wherever they are now (a member who left still has a name);
 * agents only within this server, including deleted ones. Never emails.
 */
async function resolveServerAuditPeople(serverId: string, events: Array<{
  actorType: string; actorId: string | null;
  requesterType: string | null; requesterId: string | null;
  subjectType: string | null; subjectId: string | null;
  targetType: string; targetId: string | null;
  metadata: Record<string, unknown>;
}>): Promise<Record<string, ServerAuditPerson>> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const add = (type: string | null, id: unknown) => {
    if (typeof id !== "string" || !CURSOR_ID_PATTERN.test(id)) return;
    if (type === "human") userIds.add(id);
    else if (type === "agent") agentIds.add(id);
  };
  for (const event of events) {
    add(event.actorType, event.actorId);
    add(event.requesterType, event.requesterId);
    add(event.subjectType, event.subjectId);
    add(event.targetType, event.targetId);
    add("agent", event.metadata?.agentId);
  }
  const [userRows, agentRows] = await Promise.all([
    userIds.size === 0 ? [] : getDb().select({
      id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl,
    }).from(users).where(inArray(users.id, [...userIds])),
    agentIds.size === 0 ? [] : getDb().select({
      id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl, deletedAt: agents.deletedAt,
    }).from(agents).where(and(eq(agents.serverId, serverId), inArray(agents.id, [...agentIds]))),
  ]);
  const people: Record<string, ServerAuditPerson> = {};
  for (const row of userRows) {
    people[`human:${row.id}`] = { type: "human", id: row.id, name: row.name, displayName: row.displayName, avatarUrl: row.avatarUrl };
  }
  for (const row of agentRows) {
    people[`agent:${row.id}`] = {
      type: "agent", id: row.id, name: row.name, displayName: row.displayName, avatarUrl: row.avatarUrl,
      ...(row.deletedAt ? { deleted: true } : {}),
    };
  }
  return people;
}

function stripRequestIdHash(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("requestIdHash" in metadata)) return metadata;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "requestIdHash"));
}

/**
 * A role the system itself gives an Agent (today: the onboarding agent is
 * created as admin). Recorded so "who authorized this agent" ends at a
 * definite answer, "the system, at creation", instead of an empty trail.
 */
export async function recordSystemAgentRoleGrant(input: {
  serverId: string;
  agentId: string;
  nextRole: string;
  previousRole?: string | null;
  grantedBy: "onboarding_agent_created";
}, dbOrTx: Parameters<typeof recordIntegrationAuditEvent>[1] = getDb()) {
  return recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "membership.agent_role_changed",
    outcome: "success",
    source: "system",
    actor: { type: "system" },
    target: { type: "agent", id: input.agentId },
    metadata: { agentId: input.agentId, previousRole: input.previousRole ?? "member", nextRole: input.nextRole, grantedBy: input.grantedBy },
    diff: { role: { before: input.previousRole ?? "member", after: input.nextRole } },
  }, dbOrTx);
}

/**
 * A Computer renewed one of its runner credentials (#wg-rbac:#27): an
 * `agent_credential.issued` for the new credential, naming the one it
 * replaces, the Machine and when the new one expires. Ids only, never the key.
 */
export async function recordRunnerCredentialRenewed(input: {
  serverId: string;
  agentId: string;
  credentialId: string;
  replacedCredentialId: string;
  machineId: string;
  scopes: readonly string[];
  expiresAt: Date;
}, dbOrTx: DatabaseExecutor) {
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "agent_credential.issued",
    outcome: "success",
    source: "system",
    actor: { type: "system" },
    subject: { type: "agent", id: input.agentId },
    target: { type: "agent_credential", id: input.credentialId },
    metadata: {
      agentId: input.agentId,
      credentialId: input.credentialId,
      scopes: [...input.scopes],
      issuedVia: "computer",
      machineId: input.machineId,
      replacedCredentialId: input.replacedCredentialId,
      via: "runner_renewed",
      expiresAt: input.expiresAt.toISOString(),
    },
  }, dbOrTx);
}

/**
 * One `agent_credential.revoked` for every credential of one Agent revoked
 * together (archive, delete), with how many. Nothing revoked, nothing recorded.
 */
export async function recordAgentCredentialsBulkRevoked(input: {
  serverId: string;
  agentId: string;
  actorUserId: string | null;
  revokedCount: number;
  reason: "agent_archived" | "agent_deleted";
  audit?: ServerAuditContext | null;
}, dbOrTx: DatabaseExecutor) {
  if (input.revokedCount === 0) return;
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "agent_credential.revoked",
    outcome: "success",
    source: input.actorUserId ? "web" : "system",
    actor: input.actorUserId ? { type: "human", id: input.actorUserId } : { type: "system" },
    subject: { type: "agent", id: input.agentId },
    target: { type: "agent", id: input.agentId },
    metadata: {
      agentId: input.agentId,
      revokedCount: input.revokedCount,
      reason: input.reason,
      ...serverAuditContextMetadata(input.actorUserId ? input.audit : { operationId: input.audit?.operationId }),
    },
  }, dbOrTx);
}
