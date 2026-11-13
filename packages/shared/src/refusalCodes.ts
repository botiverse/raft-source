// The closed list of refusal codes a client may branch on in code (#wg-ax:#13,
// docs/contracts/agent-api-refusals.md). Every other refusal is informative:
// clients show its `error` as sent. Adding a code needs Tenny's approval; a code
// whose only client use is picking local wording does not belong here.
// First version: compiled 2026-11-05 from the clients' code as it was then.
// Added since: agent_connection_account_mismatch, _connector_not_found,
// _connector_forbidden and _pending_invalid, the Raft codes antiproton's
// GitHub connector refusals map to (routes/agents.ts); the web acts on them
// (GitHub connections phase 2). agent_credential_expired and
// runner_credential_already_renewed, which the daemon's runner credential
// renewal acts on (#wg-rbac:#27, design agreed with Tenny and Archer).
// user_not_found, which shared userInfo uses to tell "nobody by that name"
// from a gated refusal (#wg-ax:#13, Tenny).
// grant_kind_unsupported, which setup's legacy migration falls back on when the
// Server does not know the computer_migrate approval (#wg-device-auth:#1, Tenny).
// Removed since: ACTION_ENDPOINT_REVIEW_STALE, with Raft's card URL review
// route and its web panel (App Admin decides those reviews, #proj-apps task #19).

export type RefusalKind =
  | "wait_retry" | "poll" | "stale" | "already_done" | "auth"
  | "client_too_old" | "plan_limit" | "unsupported" | "terminal" | "alternate";

export type RefusalClient = "shared" | "cli" | "sdk" | "daemon" | "computer" | "web";

export interface RefusalCodeEntry {
  kind: RefusalKind;
  /** What the client does with this code, in code (not wording). One sentence. */
  action: string;
  /** Which clients branch on it today. */
  clients: readonly RefusalClient[];
}

export const REFUSAL_CODES = {
  // kind: wait_retry
  RATE_LIMITED: { kind: "wait_retry", action: "Wait retryAfterSeconds, then send the same request again.", clients: ["shared", "cli", "web"] }, // shared/src/agentOps/outcome.ts:191; cli/src/core/apiFailure.ts rateLimitedResponse (every budgeted write command); cli/src/commands/artifact/_shared.ts:26; cli/src/commands/message/updateCard.ts:328; web/src/components/message/linkCardExecute.tsx:170
  QUESTION_RATE_LIMITED: { kind: "wait_retry", action: "Mark the question card prepare retryable after the body's retryAfterSeconds.", clients: ["shared"] }, // shared/src/agentOps/actions.ts:206
  LOCK_TIMEOUT: { kind: "wait_retry", action: "Wait, then send the link card execute again with the same id.", clients: ["web"] }, // web/src/components/message/linkCardExecute.tsx:170
  rw_overloaded: { kind: "wait_retry", action: "Retry the read once after Retry-After.", clients: ["web"] }, // web/src/api/overloadRetry.ts:47
  raftbench_unavailable: { kind: "wait_retry", action: "Classify the failure as retry_identical: repeat the same read or submission later.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:417
  managed_mcp_unreachable: { kind: "wait_retry", action: "Classify the MCP call failure as unavailable: the tool was not called, try again later.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:135
  managed_mcp_oauth_busy: { kind: "wait_retry", action: "Classify the MCP call failure as unavailable: the tool was not called, try again later.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:135
  duplicate_machine_connection_held: { kind: "wait_retry", action: "Keep the long reconnect delay when this daemon was recently closed as the duplicate.", clients: ["daemon"] }, // daemon/src/connection.ts:556
  agent_connection_connector_disconnect_partial: { kind: "wait_retry", action: "Keep the disconnect retryable so the person can run it again.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx:402
  agent_connection_disconnect_not_cleared: { kind: "wait_retry", action: "Keep the disconnect retryable so the person can run it again.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx:650
  wechat_poll_in_flight: { kind: "wait_retry", action: "Treat the WeChat poll as transient and keep the connect flow waiting to try again.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:88
  wechat_upstream_unavailable: { kind: "wait_retry", action: "Treat the WeChat upstream failure as transient and keep the connect flow retryable.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:89

  // kind: poll
  UPLOAD_OBJECT_NOT_FOUND: { kind: "poll", action: "Ask to complete the upload session again after a short backoff (up to 3 tries); the web also falls back to another upload path.", clients: ["shared", "cli", "web"] }, // shared/src/agentOps/attachments.ts:234; cli/src/commands/attachment/upload.ts:386; web/src/utils/directAttachmentUpload.ts:168; web/src/utils/directAttachmentUpload.ts:214
  UPLOAD_VERIFICATION_IN_PROGRESS: { kind: "poll", action: "Ask to complete the upload session again after a short backoff (up to 3 tries).", clients: ["shared", "cli", "web"] }, // shared/src/agentOps/attachments.ts:234; cli/src/commands/attachment/upload.ts:387; web/src/utils/directAttachmentUpload.ts:169
  authorization_pending: { kind: "poll", action: "Keep polling the device-login token endpoint until it is approved, denied or expired.", clients: ["cli", "computer", "web"] }, // cli/src/agentLogin/deviceAuthClient.ts:269; computer/src/apiClient.ts:118; web/src/components/machine/localComputer/desktopAttachGrant.ts:134
  computer_offline: { kind: "poll", action: "Mark the lifecycle upgrade intent retryable_ready_pending so the daemon tries again later; the web instead stops the turn or sign-in it was for.", clients: ["computer", "daemon", "web"] }, // computer/src/localLifecycleIntents.ts:333; daemon/src/core.ts:6481; web/src/components/agent/stopAgentTurn.ts:20; web/src/components/agent/stopSubagent.ts:22; web/src/features/computer/RuntimeSignInDialog.tsx:319
  computer_lifecycle_completion_ready_pending: { kind: "poll", action: "Mark the lifecycle upgrade intent retryable_ready_pending so the daemon tries again later.", clients: ["computer", "daemon"] }, // computer/src/localLifecycleIntents.ts:334; daemon/src/core.ts:6481
  VIEW_PENDING: { kind: "poll", action: "Keep polling the link card's view until it is ready.", clients: ["web"] }, // web/src/components/message/linkCardExecute.tsx:1018

  // kind: stale
  card_revision_conflict: { kind: "stale", action: "Re-read the card and use its currentRevision: shared sets next retry_with_revision, the CLI treats an already-applied update as success.", clients: ["shared", "cli"] }, // shared/src/agentOps/messageCards.ts:175; cli/src/commands/message/updateCard.ts:289
  raftbench_revision_conflict: { kind: "stale", action: "Classify as reread: read the run context again from the first page, then redo the result.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:381
  raftbench_cursor_stale: { kind: "stale", action: "Classify as reread: read the run context again from the first page, then redo the result.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:382
  raftbench_cursor_invalid: { kind: "stale", action: "Classify as reread: read the run context again from the first page, then redo the result.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:383
  raftbench_findings_changed: { kind: "stale", action: "Classify as reread: read the findings again from the first page.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:384
  managed_mcp_config_stale: { kind: "stale", action: "Refetch the MCP tool catalog and retry the call once with the current versions.", clients: ["shared", "daemon"] }, // shared/src/agentOps/mcp.ts:133; daemon/src/drivers/managedMcpTools.ts:166
  managed_mcp_assignment_stale: { kind: "stale", action: "Classify the MCP call failure as stale: refetch the catalog and remount before the next turn.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:133
  managed_mcp_tool_not_allowed: { kind: "stale", action: "Classify the MCP call failure as stale: refetch the catalog and remount before the next turn.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:133
  managed_mcp_server_not_found: { kind: "stale", action: "Classify the MCP call failure as stale: refetch the catalog and remount before the next turn.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:134
  managed_mcp_server_disabled: { kind: "stale", action: "Classify the MCP call failure as stale: refetch the catalog and remount before the next turn.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:134
  migration_generation_stale: { kind: "stale", action: "Re-read the migration's import view and resend start-transfer once with the current generation.", clients: ["daemon"] }, // daemon/src/core.ts:4395
  MIGRATION_REVISION_STALE: { kind: "stale", action: "Re-read the migration and retry the cancel with its current revision (bounded attempts).", clients: ["web"] }, // web/src/components/agentMigration/AgentMigrationCancelDialog.tsx:54
  form_revision_stale: { kind: "stale", action: "Reload the runtime form and its revision before saving again.", clients: ["web"] }, // web/src/hooks/useRuntimeFormV2.ts:118
  APP_PERMISSIONS_CHANGED: { kind: "stale", action: "Re-read the app's permissions and ask for review again; the install card dialog disables install instead.", clients: ["web"] }, // web/src/lib/appPermissionExpectation.ts:28; web/src/lib/appPromptText.ts:197; web/src/components/actions/InstallAppCardDialog.tsx:57
  PROMPT_TEXT_REVIEW_STALE: { kind: "stale", action: "Re-read the app's prompt text and ask for review again.", clients: ["web"] }, // web/src/lib/appPromptText.ts:206
  INVALID_CURSOR: { kind: "stale", action: "Start the marketplace listing over from the first page.", clients: ["web"] }, // web/src/components/apps/MarketplaceListingsTab.tsx:150
  login_mode_changed: { kind: "stale", action: "Reload the login setup to the server's current login mode.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:45; web/src/pages/HumanLoginSetupPage.tsx:352
  wechat_binding_changed: { kind: "stale", action: "Re-read the WeChat binding before acting on it again.", clients: ["web"] }, // web/src/assistant/wechatClient.ts:261
  onboarding_agent_exists: { kind: "stale", action: "Reload the server setup projection to pick up the onboarding agent that already exists.", clients: ["web"] }, // web/src/components/onboarding/ServerSetupProjectionGate.tsx:443
  passkey_not_found: { kind: "stale", action: "Reload the passkey list.", clients: ["web"] }, // web/src/components/settings/PasskeysSection.tsx:461; web/src/components/settings/PasskeysSection.tsx:514; web/src/components/settings/PasskeysSection.tsx:547
  PASSWORD_CREDENTIAL_REQUIRED: { kind: "stale", action: "Reload the account's sign-in methods.", clients: ["web"] }, // web/src/features/settings/account/AccountSection.tsx:210
  approval_in_progress: { kind: "stale", action: "Re-read the external invite's state instead of failing.", clients: ["web"] }, // web/src/pages/ExternalInvitePage.tsx:218
  connect_in_progress: { kind: "stale", action: "Re-read the external invite's state instead of failing.", clients: ["web"] }, // web/src/pages/ExternalInvitePage.tsx:218
  request_not_pending: { kind: "stale", action: "Reload the request to show what it is now.", clients: ["web"] }, // web/src/pages/ExternalInvitePage.tsx:342; web/src/pages/ServerConnectRequestPage.tsx:130
  FORBIDDEN: { kind: "stale", action: "Reload the artifact forward targets after the move was refused.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactForward.tsx:242
  NAME_TAKEN: { kind: "stale", action: "Reload the artifact forward targets after the move was refused.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactForward.tsx:242
  HOME_NOT_NARROWER: { kind: "stale", action: "Reload the artifact's home before offering the narrowing again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactNarrowHome.tsx:79
  NOT_ORIGINAL_HOME: { kind: "stale", action: "Reload the artifact's home before offering the narrowing again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactNarrowHome.tsx:79
  HOME_NOT_WIDER: { kind: "stale", action: "Reload the artifact's home before offering the narrowing again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactNarrowHome.tsx:79
  LOSS_CHANGED: { kind: "stale", action: "Re-read who would lose access, then ask the person to confirm again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactNarrowHome.tsx:177
  NOT_PUBLIC: { kind: "stale", action: "Reload the artifact's sharing state.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactViewerMenu.tsx:213
  IMAGE_NOT_FOUND: { kind: "stale", action: "Drop the missing comment image and refresh the attachments.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactCommentBox.tsx:572
  DRAFT_LIMIT: { kind: "stale", action: "Reload the review drafts.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactReviewContext.tsx:431
  DRAFT_NOT_FOUND: { kind: "stale", action: "Reload the review drafts; deleting a draft that is already gone counts as done.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactReviewContext.tsx:444; web/src/apps/artifacts/ArtifactReviewContext.tsx:454
  DRAFTS_CHANGED: { kind: "stale", action: "Reload the review drafts before submitting again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactReviewContext.tsx:523
  NO_DRAFTS: { kind: "stale", action: "Return to the artifact and read everything again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactReviewContext.tsx:530
  agent_connection_connector_not_found: { kind: "stale", action: "Reload the agent's connection status; the connection leaves the list.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx:258; web/src/pages/AgentConnectionCallbackPage.tsx:79; server: routes/agents.ts sendAgentConnectionFailure (antiproton 404 not_found on a connector, 404 connector_gone at confirm, cf/src/provision/handlers.ts connection PUT, POST with connectorId, disconnect)
  agent_connection_owner_required: { kind: "stale", action: "Reload the agent's connection status, which then offers only what this agent's owner can use, and say the sentence.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx failed(); server: routes/agents.ts (PUT and POST connections)
  agent_connection_connector_forbidden: { kind: "stale", action: "Reload the agent's connection status, whose canManage then hides Reconnect, Switch and Disconnect for that connection, and say its creator or a server owner/admin can.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx:258; web/src/pages/AgentConnectionCallbackPage.tsx:83; server: routes/agents.ts loadConnectorAction (Raft's own check) and sendAgentConnectionFailure (antiproton 403 not_creator, cf/src/provision/handlers.ts creatorRefused)

  // kind: already_done
  ALREADY_ANSWERED: { kind: "already_done", action: "Use the person's answers from the body's metadata instead of withdrawing (next use_answers; the CLI prints them).", clients: ["shared", "cli"] }, // shared/src/agentOps/actions.ts:427; cli/src/commands/action/withdraw.ts:92
  ALREADY_EXECUTED: { kind: "already_done", action: "Treat the action card as already executed.", clients: ["web"] }, // web/src/components/actions/actionCardCommon.tsx:212
  ALREADY_SAVED: { kind: "already_done", action: "Treat the attachment as already saved to Artifacts.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactAttachment.tsx:186
  CLIENT_KEY_REUSED: { kind: "already_done", action: "Treat the review as already submitted and read everything again.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactReviewContext.tsx:530
  INTEGRATION_MCP_CONNECTION_REQUESTED: { kind: "already_done", action: "Report the MCP login as a success (status mcp_connection_requested).", clients: ["cli"] }, // cli/src/commands/integration/login.ts:15; cli/src/commands/integration/login.ts:81
  INTEGRATION_MCP_TARGET_REQUIRED: { kind: "already_done", action: "Report the MCP login as a success (status mcp_target_required).", clients: ["cli"] }, // cli/src/commands/integration/login.ts:16; cli/src/commands/integration/login.ts:81
  INTEGRATION_MCP_APP_READY: { kind: "already_done", action: "Report the MCP login as a success (status mcp_app_ready).", clients: ["cli"] }, // cli/src/commands/integration/login.ts:17; cli/src/commands/integration/login.ts:81
  THREAD_NOT_FOUND: { kind: "already_done", action: "Treat the thread as gone and drop it locally.", clients: ["web"] }, // web/src/store/threadStore.ts:183
  assistant_exists: { kind: "already_done", action: "Treat the assistant as already created and use it.", clients: ["web"] }, // web/src/assistant/assistantClient.ts:210
  wechat_already_connected: { kind: "already_done", action: "Treat WeChat as already connected.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:76
  wechat_not_connected: { kind: "already_done", action: "Treat the WeChat disconnect as done.", clients: ["web"] }, // web/src/assistant/wechatClient.ts:265
  feedback_card_already_sent: { kind: "already_done", action: "Treat the feedback card as already sent.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:103
  already_connected: { kind: "already_done", action: "End the connect request as already connected.", clients: ["web"] }, // web/src/pages/ServerConnectRequestPage.tsx:76; web/src/pages/ServerConnectRequestPage.tsx:135
  second_factor_not_enabled: { kind: "already_done", action: "Treat two-step verification as already off and refresh its state.", clients: ["web"] }, // web/src/components/auth/SecondFactorCodeEntry.tsx:270; web/src/components/settings/SecondFactorStepUpHost.tsx:43; web/src/components/settings/TwoStepVerificationSection.tsx:1152
  second_factor_already_enabled: { kind: "already_done", action: "Treat two-step verification as already on and refresh its state.", clients: ["web"] }, // web/src/components/settings/TwoStepVerificationSection.tsx:192; web/src/components/settings/TwoStepVerificationSection.tsx:737
  no_live_computer_key: { kind: "already_done", action: "Treat the Computer's key as already revoked.", clients: ["web"] }, // web/src/features/computer/othersAgentsApi.ts:144
  email_code_recently_sent: { kind: "already_done", action: "Go on to code entry: the code sent recently still stands.", clients: ["web"] }, // web/src/features/settings/account/DeleteAccountVerifyDialog.tsx:162
  session_revoked: { kind: "already_done", action: "Treat the device session as retired and delete the local user session.", clients: ["computer"] }, // computer/src/deviceSessionRetire.ts:238
  session_not_device: { kind: "already_done", action: "Treat the device session as retired and delete the local user session.", clients: ["computer"] }, // computer/src/deviceSessionRetire.ts:239
  computer_key_revoked: { kind: "already_done", action: "On detach, treat the key as already refused and remove its local copy without a revoke.", clients: ["computer"] }, // computer/src/detach.ts:78; computer/src/detach.ts:224
  computer_not_found: { kind: "already_done", action: "On detach, treat the key as already refused and remove its local copy without a revoke.", clients: ["computer"] }, // computer/src/detach.ts:80; computer/src/detach.ts:224
  computer_key_hash_mismatch: { kind: "already_done", action: "On detach, treat the key as already refused and remove its local copy without a revoke.", clients: ["computer"] }, // computer/src/detach.ts:81; computer/src/detach.ts:224
  invalid_principal: { kind: "already_done", action: "On detach, treat the key as already refused and remove its local copy without a revoke.", clients: ["computer"] }, // computer/src/detach.ts:82; computer/src/detach.ts:224

  // kind: auth
  auth_required: { kind: "auth", action: "Refresh the user session and retry once; the web restarts sign-in.", clients: ["computer", "web"] }, // computer/src/apiClient.ts:273; computer/src/services/adoptLegacy.ts:589; web/src/utils/socialAuthCompletion.ts:7
  password_incorrect: { kind: "auth", action: "Keep the session: this 401 is a wrong password, not an expired session.", clients: ["web"] }, // web/src/api/client.ts:117
  SSO_REQUIRED: { kind: "auth", action: "Send the person to SSO sign-in.", clients: ["web"] }, // web/src/utils/ssoSignIn.ts:55; web/src/store/socketBridge.ts:1145
  second_factor_step_up_required: { kind: "auth", action: "Open the second-factor step-up, then retry the request.", clients: ["web"] }, // web/src/components/settings/secondFactorStepUp.ts:61; web/src/pages/DeviceLoginPage.tsx:219; web/src/pages/AppLoginPage.tsx:117
  session_family_required: { kind: "auth", action: "Open the verify-it's-you step, then retry the request.", clients: ["web"] }, // web/src/components/settings/VerifyItsYouDialog.tsx:72; web/src/features/settings/account/accountDeletionApi.ts:361
  reauth_required: { kind: "auth", action: "Ask the person to sign in again, then retry the request.", clients: ["web"] }, // web/src/components/settings/PasskeysSection.tsx:173; web/src/components/settings/TwoStepVerificationSection.tsx:190; web/src/features/settings/account/accountDeletionApi.ts:363
  step_up_required: { kind: "auth", action: "Open the step-up before managing passkeys; two-step settings treat it as already enabled.", clients: ["web"] }, // web/src/components/settings/PasskeysSection.tsx:175; web/src/components/settings/PasskeysSection.tsx:533; web/src/components/settings/TwoStepVerificationSection.tsx:192
  email_code_not_available: { kind: "auth", action: "Switch account deletion to another way of verifying.", clients: ["web"] }, // web/src/features/settings/account/accountDeletionApi.ts:364
  agent_connection_account_mismatch: { kind: "auth", action: "Keep the connection as it was, ask the person to sign in to GitHub as the account that made the connection, and send them back to the agent's page, whose Reconnect names that connection.", clients: ["web"] }, // web/src/pages/AgentConnectionCallbackPage.tsx:81; server: routes/agents.ts sendAgentConnectionFailure (antiproton 409 account_mismatch at confirm of a reconnect, cf/src/provision/handlers.ts reconnectInPlace)
  computer_key_family_mismatch: { kind: "auth", action: "Try the next attached Computer key for the session retire.", clients: ["computer"] }, // computer/src/deviceSessionRetire.ts:240
  computer_key_invalid: { kind: "auth", action: "Try the next attached Computer key for the session retire.", clients: ["computer"] }, // computer/src/deviceSessionRetire.ts:241
  computer_key_required: { kind: "auth", action: "Try the next attached Computer key for the session retire.", clients: ["computer"] }, // computer/src/deviceSessionRetire.ts:241
  server_access_denied: { kind: "auth", action: "Raise RaftAppError code server_access_denied (this token can't be used for that Server) instead of http_error.", clients: ["sdk"] }, // raft-sdk/src/app.ts:327
  agent_credential_expired: { kind: "auth", action: "Renew the runner credential (or mint a fresh one when renewal is refused), then retry the call once; any other 401 is not renewed.", clients: ["daemon"] }, // daemon: runner-credential-renew:v1 (#wg-rbac:#27, lands with the daemon's renew, Computer 1.0.65); server: middleware/auth.ts authenticateAgentCredential

  // kind: client_too_old
  CLIENT_UPGRADE_REQUIRED: { kind: "client_too_old", action: "Stop as not retryable and show the Server's upgrade sentence; the CLI keeps the code.", clients: ["shared", "cli"] }, // shared/src/agentOps/outcome.ts:220; cli/src/commands/artifact/_shared.ts:30
  computer_upgrade_required: { kind: "client_too_old", action: "Stop the turn, subagent or runtime sign-in: that Computer needs an upgrade first.", clients: ["web"] }, // web/src/components/agent/stopAgentTurn.ts:20; web/src/components/agent/stopSubagent.ts:22; web/src/features/computer/RuntimeProviderConnectDialog.tsx:53; web/src/features/computer/RuntimeSignInDialog.tsx:43
  computer_remote_upgrade_unsupported: { kind: "client_too_old", action: "Do not offer the remote upgrade: that Computer is too old to take one.", clients: ["web"] }, // web/src/components/machine/useComputerUpgradeCard.ts:26
  MIGRATION_RESUMABLE_CAPABILITY_REQUIRED: { kind: "client_too_old", action: "Stop the migration: the Computer must be upgraded first.", clients: ["web"] }, // web/src/components/agentMigration/errors.ts:625

  // kind: plan_limit
  agent_limit_reached: { kind: "plan_limit", action: "Open the plan upsell instead of creating the agent.", clients: ["web"] }, // web/src/features/agent/CreateAgentDialog.tsx:929
  human_seat_limit_reached: { kind: "plan_limit", action: "Open the seat upsell.", clients: ["web"] }, // web/src/components/member/HumanDetailPanel.tsx:477
  MIGRATION_PRO_PLAN_REQUIRED: { kind: "plan_limit", action: "Open the Pro plan upsell for the migration.", clients: ["web"] }, // web/src/components/agentMigration/billing.ts:31
  FILE_UPLOAD_QUOTA_EXCEEDED: { kind: "plan_limit", action: "Mark the monthly upload quota as reached and offer the upgrade.", clients: ["web"] }, // web/src/utils/monthlyUploadQuota.ts:45
  joint_channel_free_limit_reached: { kind: "plan_limit", action: "Open the joint channel host-limit upsell.", clients: ["web"] }, // web/src/components/channel/CreateJointChannelDialog.tsx:226
  joint_free_server_limit: { kind: "plan_limit", action: "Open the joint channel free-cap upsell.", clients: ["web"] }, // web/src/components/channel/CreateJointChannelDialog.tsx:227; web/src/components/externalInvite/externalInviteAccept.ts:334; web/src/components/externalInvite/externalInviteAccept.ts:365
  free_external_limit: { kind: "plan_limit", action: "Offer the upgrade for external members.", clients: ["web"] }, // web/src/components/channel/ExternalInviteSteps.tsx:57; web/src/components/externalInvite/externalInviteAccept.ts:328; web/src/components/externalInvite/externalInviteAccept.ts:361
  history_limited: { kind: "plan_limit", action: "Hide history beyond the plan's window and offer the upgrade.", clients: ["web"] }, // web/src/store/hiddenHistoryStore.ts:158; web/src/utils/threadRefContext.ts:22

  // kind: unsupported
  unsupported_capability: { kind: "unsupported", action: "Fall back to server.info for the user's facts and skip the channel rosters.", clients: ["shared"] }, // shared/src/agentOps/server.ts:193
  reminders_unsupported_for_external_agents: { kind: "unsupported", action: "Classify as the SDK's UNSUPPORTED_FOR_EXTERNAL_AGENTS error, so the caller uses its own runtime instead.", clients: ["shared"] }, // shared/src/agentOps/outcome.ts:153
  grant_kind_unsupported: { kind: "unsupported", action: "Treat the one-time approval kind as missing on an older Server and fall back to the user-session sign-in.", clients: ["computer"] }, // computer/src/apiClient.ts:100
  auth_policy_unregistered_path: { kind: "unsupported", action: "Treat the machine-key route as missing on an older Server and fall back (session route, or detach on the web).", clients: ["computer"] }, // computer/src/apiClient.ts:863
  passkeys_unavailable: { kind: "unsupported", action: "Hide or stop passkey sign-in on this server.", clients: ["web"] }, // web/src/components/auth/usePasskeySignIn.ts:89; web/src/components/auth/usePasskeySignIn.ts:109; web/src/components/auth/usePasskeySignIn.ts:138
  computer_managed_by_desktop: { kind: "unsupported", action: "Do not offer the remote upgrade: the desktop app manages that Computer.", clients: ["web"] }, // web/src/components/machine/useComputerUpgradeCard.ts:30
  wechat_unavailable: { kind: "unsupported", action: "Stop the WeChat connect flow as unavailable here.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:78
  assistant_not_found: { kind: "unsupported", action: "Stop the WeChat connect flow: there is no assistant to connect.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:79
  feedback_integration_unavailable: { kind: "unsupported", action: "Treat the feedback integration as off for this page.", clients: ["web"] }, // web/src/feedback/standalone/host.ts:129
  ARTIFACTS_NOT_ENABLED: { kind: "unsupported", action: "Show the conversation's or server's artifacts as empty instead of an error.", clients: ["web"] }, // web/src/apps/artifacts/conversationArtifacts.ts:29; web/src/apps/artifacts/ArtifactsDashboard.tsx:254
  TARGET_NOT_FOUND: { kind: "unsupported", action: "Show the conversation's artifacts as empty; forwarding stops for that target.", clients: ["web"] }, // web/src/apps/artifacts/conversationArtifacts.ts:30; web/src/apps/artifacts/ArtifactForward.tsx:64; web/src/apps/artifacts/ArtifactForward.tsx:238
  NOT_VISIBLE: { kind: "unsupported", action: "Treat the artifact as not there for this person (not found view, forward stops).", clients: ["web"] }, // web/src/apps/artifacts/artifactApi.ts:96; web/src/apps/artifacts/ArtifactForward.tsx:250; web/src/apps/artifacts/ArtifactFrame.tsx:691
  user_not_found: { kind: "unsupported", action: "Answer user info as not found at once, instead of falling back to the server directory as a gated refusal does.", clients: ["shared"] }, // shared/src/agentOps/server.ts:197 (AGENT_API_USER_NOT_FOUND_CODE)

  // kind: terminal
  capability_not_authorized: { kind: "terminal", action: "Classify as CAPABILITY_NOT_AUTHORIZED (not retryable); RaftBench stops the run.", clients: ["shared"] }, // shared/src/agentOps/outcome.ts:154; shared/src/agentOps/raftbench.ts:420
  raftbench_reader_not_authorized: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:388
  raftbench_findings_unavailable: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:389
  raftbench_source_unavailable: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:390
  raftbench_disabled: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:391
  raftbench_read_permission_revoked: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:392
  raftbench_access_revoked: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:393
  raftbench_server_not_allowed: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:394
  raftbench_service_credential_required: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:396
  raftbench_run_not_owned: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:397
  raftbench_run_finished: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:398
  raftbench_submission_conflict: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:399
  raftbench_read_only: { kind: "terminal", action: "Classify as stop: end the run and tell the person who asked.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:400
  managed_mcp_oauth_required: { kind: "terminal", action: "Classify the MCP call failure as reconnect_required: tell the user, do not retry.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:131
  managed_mcp_oauth_invalid_state: { kind: "terminal", action: "Classify the MCP call failure as reconnect_required: tell the user, do not retry.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:131
  managed_mcp_auth_invalid: { kind: "terminal", action: "Classify the MCP call failure as reconnect_required: tell the user, do not retry.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:132
  managed_mcp_endpoint_auth_rejected: { kind: "terminal", action: "Classify the MCP call failure as reconnect_required: tell the user, do not retry.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:132
  managed_mcp_credential_invalid: { kind: "terminal", action: "Classify the MCP call failure as reconnect_required: tell the user, do not retry.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:132
  managed_mcp_internal_error: { kind: "terminal", action: "Classify the MCP call as outcome_unknown and mark it not retryable: check before calling again.", clients: ["shared"] }, // shared/src/agentOps/mcp.ts:118; shared/src/agentOps/mcp.ts:166
  experimental_surface_disabled: { kind: "terminal", action: "Do not retry minting the runner credential.", clients: ["daemon"] }, // daemon/src/core.ts:1019; daemon/src/agentProcessManager.ts:552
  app_source_authority_not_registered: { kind: "terminal", action: "Clear the persisted app-source ack intent so the attempt is not retried.", clients: ["daemon"] }, // daemon/src/agentCredentialProxy.ts:1754; shared/src/agentApiContract.ts:3046
  invalid_source_revision: { kind: "terminal", action: "Clear the persisted app-source ack intent so the attempt is not retried.", clients: ["daemon"] }, // daemon/src/agentCredentialProxy.ts:1754; shared/src/agentApiContract.ts:3047
  source_id_ambiguous: { kind: "terminal", action: "Clear the persisted app-source ack intent so the attempt is not retried.", clients: ["daemon"] }, // daemon/src/agentCredentialProxy.ts:1754; shared/src/agentApiContract.ts:3048
  source_not_found: { kind: "terminal", action: "Clear the persisted app-source ack intent so the attempt is not retried.", clients: ["daemon"] }, // daemon/src/agentCredentialProxy.ts:1754; shared/src/agentApiContract.ts:3049
  target_not_fired: { kind: "terminal", action: "Clear the persisted app-source ack intent so the attempt is not retried.", clients: ["daemon"] }, // daemon/src/agentCredentialProxy.ts:1754; shared/src/agentApiContract.ts:3050
  legacy_machine_key_migrated: { kind: "terminal", action: "Stop reconnecting with the migrated legacy key; detach treats the key as already refused.", clients: ["daemon", "computer"] }, // daemon/src/connection.ts:119; computer/src/detach.ts:77
  computer_machine_unlinked: { kind: "terminal", action: "Exit the runner and keep it down instead of reconnecting.", clients: ["computer"] }, // computer/src/health.ts:74
  computer_revoked: { kind: "terminal", action: "Exit the runner and keep it down; detach treats the key as already refused.", clients: ["computer"] }, // computer/src/health.ts:74; computer/src/detach.ts:79
  computer_not_attached: { kind: "terminal", action: "Stop the runtime connect or sign-in: that Computer is not attached.", clients: ["web"] }, // web/src/features/computer/RuntimeProviderConnectDialog.tsx:54; web/src/features/computer/RuntimeSignInDialog.tsx:44
  MARKETPLACE_APP_CHANGED: { kind: "terminal", action: "Disable install on the install card.", clients: ["web"] }, // web/src/components/actions/InstallAppCardDialog.tsx:57
  SCOPE_BINDING_CHANGED: { kind: "terminal", action: "Disable install on the install card.", clients: ["web"] }, // web/src/components/actions/InstallAppCardDialog.tsx:57
  AGENT_BINDING_CHANGED: { kind: "terminal", action: "Disable install on the install card.", clients: ["web"] }, // web/src/components/actions/InstallAppCardDialog.tsx:57
  agent_connection_agent_missing_at_provider: { kind: "terminal", action: "Stop the agent connection flow: the agent is gone at the provider.", clients: ["web"] }, // web/src/components/agent/AgentConnections.tsx:90; web/src/components/agent/AgentConnections.tsx:242
  agent_connection_provider_refused: { kind: "terminal", action: "Show the provider's sentence and stop this attempt; offer no automatic retry.", clients: ["web"] }, // web/src/components/agent/agentConnectionApi.ts:71; web/src/components/agent/AgentConnections.tsx:496
  agent_connection_pending_invalid: { kind: "terminal", action: "End the confirm (the link expired, was used, or was started by someone else) and offer Connect or Reconnect again from the agent's connections.", clients: ["web"] }, // web/src/pages/AgentConnectionCallbackPage.tsx:77; server: services/agentConnectionService.ts confirmAgentConnection (antiproton 404 not_found at confirm, cf/src/provision/handlers.ts connection confirm)
  archive_workspace_unavailable: { kind: "terminal", action: "Disable the workspace archive for this agent.", clients: ["web"] }, // web/src/components/agent/AgentWorkspace.tsx:315
  challenge_expired: { kind: "terminal", action: "End the second-factor challenge; the person starts again.", clients: ["web"] }, // web/src/components/auth/SecondFactorCodeEntry.tsx:211; web/src/components/auth/SecondFactorSignInStep.tsx:157
  challenge_attempts_exhausted: { kind: "terminal", action: "End the second-factor challenge; the person starts again.", clients: ["web"] }, // web/src/components/auth/SecondFactorCodeEntry.tsx:213
  second_factor_locked: { kind: "terminal", action: "End the second-factor challenge: the factor is locked.", clients: ["web"] }, // web/src/components/auth/SecondFactorCodeEntry.tsx:215
  last_factor: { kind: "terminal", action: "Stop removing the passkey: it is the last sign-in factor.", clients: ["web"] }, // web/src/components/settings/PasskeysSection.tsx:547
  device_login_disabled: { kind: "terminal", action: "Stop the desktop attach approval: device login is off on that server.", clients: ["web"] }, // web/src/components/machine/localComputer/desktopAttachGrant.ts:81
  account_deletion_token_invalid: { kind: "terminal", action: "End the account deletion confirmation.", clients: ["web"] }, // web/src/features/settings/account/accountDeletionApi.ts:412
  account_deletion_pending: { kind: "terminal", action: "Put the app in the account-deletion-pending state.", clients: ["web"] }, // web/src/store/accountDeletionPending.ts:32
  app_not_available: { kind: "terminal", action: "End the Login with Raft flow: the app is not available.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:31
  root_issuer_required: { kind: "terminal", action: "End the Login with Raft flow.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:54
  OAUTH_INSTALLATION_SUSPENDED: { kind: "terminal", action: "End the Login with Raft flow: the installation is suspended.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:56
  installation_suspended: { kind: "terminal", action: "End the Login with Raft flow: the installation is suspended.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:56
  pending_link_expired: { kind: "terminal", action: "End the account-link sign-in.", clients: ["web"] }, // web/src/hooks/useAccountLinkSignIn.ts:49
  provider_conflict: { kind: "terminal", action: "End the account-link sign-in.", clients: ["web"] }, // web/src/hooks/useAccountLinkSignIn.ts:49
  private_app_invite_invalid: { kind: "terminal", action: "End the private app invite.", clients: ["web"] }, // web/src/pages/IntegrationInvitePage.tsx:94
  private_app_invite_admin_required: { kind: "terminal", action: "End the private app invite: an admin has to accept it.", clients: ["web"] }, // web/src/pages/IntegrationInvitePage.tsx:97
  recovery_token_invalid: { kind: "terminal", action: "End the second-factor recovery link.", clients: ["web"] }, // web/src/pages/SecondFactorRecoveryLinkPage.tsx:63
  approver_lost_role: { kind: "terminal", action: "End the connect request for this approver.", clients: ["web"] }, // web/src/pages/ServerConnectRequestPage.tsx:73; web/src/pages/ServerConnectRequestPage.tsx:135
  requester_left: { kind: "terminal", action: "End the connect request for this approver.", clients: ["web"] }, // web/src/pages/ServerConnectRequestPage.tsx:74; web/src/pages/ServerConnectRequestPage.tsx:135
  request_expired: { kind: "terminal", action: "End the connect request for this approver.", clients: ["web"] }, // web/src/pages/ServerConnectRequestPage.tsx:75; web/src/pages/ServerConnectRequestPage.tsx:135
  channel_archived: { kind: "terminal", action: "End the connect request for this approver.", clients: ["web"] }, // web/src/pages/ServerConnectRequestPage.tsx:76; web/src/pages/ServerConnectRequestPage.tsx:135
  claim_expired: { kind: "terminal", action: "End the AppSumo redemption.", clients: ["web"] }, // web/src/pages/AppSumoRedemptionPage.tsx:47
  wechat_upstream_refused: { kind: "terminal", action: "Stop the WeChat connect flow.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:95
  STATE_MISMATCH: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:36; web/src/feedback/FeedbackCardForm.tsx:109
  NOT_FEEDBACK_CARD: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:38; web/src/feedback/FeedbackCardForm.tsx:109
  FEATURE_DISABLED: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:39; web/src/feedback/FeedbackCardForm.tsx:109
  NOT_A_MEMBER: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:40; web/src/feedback/FeedbackCardForm.tsx:109
  CONFIRMATION_VERSION_MISMATCH: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:41; web/src/feedback/FeedbackCardForm.tsx:109
  action_card_reconfirmation_required: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:42; web/src/feedback/FeedbackCardForm.tsx:109
  CONFIRMATION_VERSION_REQUIRED: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:43; web/src/feedback/FeedbackCardForm.tsx:109
  action_card_conversion_frozen: { kind: "terminal", action: "Stop the feedback card send: a retry can't succeed.", clients: ["web"] }, // web/src/feedback/FeedbackCardForm.tsx:44; web/src/feedback/FeedbackCardForm.tsx:109
  ATTACHMENT_NOT_SAVABLE: { kind: "terminal", action: "Stop saving the attachment to Artifacts.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactAttachment.tsx:205
  ATTACHMENT_NOT_FOUND: { kind: "terminal", action: "Stop saving the attachment to Artifacts.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactAttachment.tsx:209
  FIELD_TOO_LONG: { kind: "terminal", action: "Stop the artifact forward.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactForward.tsx:237
  IMAGE_REFUSED: { kind: "terminal", action: "Drop the refused comment image instead of retrying it.", clients: ["web"] }, // web/src/apps/artifacts/useCommentImageAttachments.ts:61
  VERSION_NOT_FOUND: { kind: "terminal", action: "Stop loading that artifact version.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactFrame.tsx:701

  // kind: alternate
  last_member_deletes_channel: { kind: "alternate", action: "Build the same leave or remove command with delete-if-last as the next step.", clients: ["shared", "cli"] }, // shared/src/agentOps/channels.ts:122; shared/src/agentOps/channelAdmin.ts:284; cli/src/commands/channel/leave.ts:100; cli/src/commands/channel/remove-member.ts:122
  QUERY_TOO_BROAD: { kind: "alternate", action: "Build narrower search commands (sort by recent, or one target); the web drops its retry action.", clients: ["cli", "web"] }, // cli/src/commands/message/search.ts:329; web/src/features/search/searchFailure.ts:15
  download_url_unavailable: { kind: "alternate", action: "Point next at the binary download operation instead of a download URL.", clients: ["shared"] }, // shared/src/agentOps/attachments.ts:284
  raftbench_validation_failed: { kind: "alternate", action: "Read the body's issues and return an invalid outcome so the harness fixes and resubmits the whole result.", clients: ["shared"] }, // shared/src/agentOps/raftbench.ts:240
  idempotency_key_reused: { kind: "alternate", action: "Classify as the SDK's IDEMPOTENCY_KEY_REUSED error (not retryable), so the caller uses a new key for a different request.", clients: ["shared"] }, // shared/src/agentOps/outcome.ts:152
  others_agents_on_computer: { kind: "alternate", action: "Read the blocking agents and build the detach command that force-unbinds them.", clients: ["computer", "web"] }, // computer/src/apiClient.ts:972; web/src/features/computer/othersAgentsApi.ts:146
  others_agents_on_computers: { kind: "alternate", action: "Read the blocking agents and offer account deletion that force-unbinds them.", clients: ["web"] }, // web/src/features/settings/account/accountDeletionApi.ts:358
  sole_owner_servers: { kind: "alternate", action: "Read the servers the person solely owns and route account deletion through handing them over.", clients: ["web"] }, // web/src/features/settings/account/accountDeletionApi.ts:354
  COMPUTER_CAPABILITY_INSUFFICIENT: { kind: "alternate", action: "Offer a different migration path for a Computer without the capability.", clients: ["web"] }, // web/src/components/agentMigration/errors.ts:622
  agreement_required: { kind: "alternate", action: "Route the join through accepting the agreement, then retry.", clients: ["web"] }, // web/src/components/auth/InviteAcceptPage.tsx:180; web/src/hooks/useJoinCommunityFlow.tsx:23; web/src/pages/PublicServerPage.tsx:429
  agreement_changed: { kind: "alternate", action: "Route the join through accepting the changed agreement, then retry.", clients: ["web"] }, // web/src/components/auth/InviteAcceptPage.tsx:180; web/src/hooks/useJoinCommunityFlow.tsx:23; web/src/pages/PublicServerPage.tsx:429
  LEGAL_ACCEPTANCE_REQUIRED: { kind: "alternate", action: "Route the social sign-in through legal acceptance.", clients: ["web"] }, // web/src/components/auth/SocialAuthCallbackPage.tsx:244
  TERMS_CHANGED: { kind: "alternate", action: "Route the social sign-in through accepting the changed terms.", clients: ["web"] }, // web/src/components/auth/SocialAuthCallbackPage.tsx:244
  legal_acceptance_required: { kind: "alternate", action: "Route the SSO sign-in through legal acceptance.", clients: ["web"] }, // web/src/components/auth/SsoAuthCallbackPage.tsx:142
  archived_name_collision: { kind: "alternate", action: "Read the archived channel from the body and offer to restore or rename instead.", clients: ["web"] }, // web/src/components/channel/archivedNameCollision.ts:27
  channel_conversion_uploads_in_flight: { kind: "alternate", action: "Hold the joint conversion until the uploads in flight finish.", clients: ["web"] }, // web/src/components/channel/JointConversionSection.tsx:445
  joint_invitee_unavailable: { kind: "alternate", action: "Change the joint invite step for an invitee that can't be reached.", clients: ["web"] }, // web/src/features/channel/EditChannelDialog.tsx:899
  computer_broadcast_not_eligible: { kind: "alternate", action: "Offer the Computer upgrade another way than the remote broadcast.", clients: ["web"] }, // web/src/components/machine/useComputerUpgradeCard.ts:28
  OAUTH_SCOPE_NOT_APPROVED: { kind: "alternate", action: "Send the Login with Raft flow back to approving the scopes.", clients: ["web"] }, // web/src/features/login-with-raft/loginErrors.ts:12
  runner_credential_already_renewed: { kind: "alternate", action: "Mint a fresh runner credential instead of renewing this one again.", clients: ["daemon"] }, // daemon: runner-credential-renew:v1 (#wg-rbac:#27, lands with the daemon's renew); server: routes/internalComputer.ts renew
  account_link_required: { kind: "alternate", action: "Route the sign-in through linking the account.", clients: ["web"] }, // web/src/utils/pendingAccountLink.ts:70
  grant_selection_required: { kind: "alternate", action: "Route the device login through choosing a grant.", clients: ["web"] }, // web/src/pages/DeviceLoginPage.tsx:224
  grant_selection_not_allowed: { kind: "alternate", action: "Route the device login without a grant choice.", clients: ["web"] }, // web/src/pages/DeviceLoginPage.tsx:224
  FORM_INVALID: { kind: "alternate", action: "Place the body's issues on the action card's fields.", clients: ["web"] }, // web/src/components/actions/actionCardCommon.tsx:209
  invalid_api_key: { kind: "alternate", action: "Put the error on the API key field of the runtime provider form.", clients: ["web"] }, // web/src/features/computer/RuntimeProviderConnectDialog.tsx:50
  invalid_base_url: { kind: "alternate", action: "Put the error on the base URL field of the runtime provider form.", clients: ["web"] }, // web/src/features/computer/RuntimeProviderConnectDialog.tsx:50
  invalid_model: { kind: "alternate", action: "Put the error on the model field of the runtime provider form.", clients: ["web"] }, // web/src/features/computer/RuntimeProviderConnectDialog.tsx:50
  invalid_verify_code: { kind: "alternate", action: "Keep the WeChat connect on code entry so the person enters the code again.", clients: ["web"] }, // web/src/assistant/useWeChatConnect.ts:87
  feedback_diagnostics_invalid: { kind: "alternate", action: "Send the feedback again without diagnostics.", clients: ["web"] }, // web/src/feedback/standalone/diagnostics.ts:37
  feedback_diagnostics_rejected: { kind: "alternate", action: "Send the feedback again without diagnostics.", clients: ["web"] }, // web/src/feedback/standalone/diagnostics.ts:37
  NOT_FRAMED: { kind: "alternate", action: "Open the artifact outside the frame instead.", clients: ["web"] }, // web/src/apps/artifacts/ArtifactFrame.tsx:709
} as const satisfies Record<string, RefusalCodeEntry>;

export type RefusalCode = keyof typeof REFUSAL_CODES;

export function isRefusalCode(code: unknown): code is RefusalCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_CODES, code);
}
