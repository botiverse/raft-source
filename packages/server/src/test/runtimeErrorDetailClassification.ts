// #wg-rbac:#57: every server site that reads or serializes an agent's runtime
// error text (`activityDetail`, `lastRuntimeError`, `last_runtime_error`, an
// `agent:activity` emit), keyed `file#enclosing declaration` (see
// runtimeErrorDetailSites.ts), with why it is safe:
//
// - `projected:<helper>`: the value leaves through the per-viewer projection
//   (agentRuntimeErrorVisibility.ts): members get the code and fixed sentence
//   or the generic message, managers the scrubbed, capped text.
// - `manager-only: <why>`: only the creator / `editAgents` (an assistant's
//   owner) can reach it.
// - `internal: <why>`: never leaves the server toward a person (storage,
//   cache, typed state, server-authored text, machine credentials).
//
// A new site fails runtimeErrorDetailClassification.structure.test.ts until it
// is listed here; a listed site that no longer exists fails too.
export const RUNTIME_ERROR_DETAIL_CLASSIFICATION: Readonly<Record<string, string>> = {
  // ── Outbound to people: projected ──
  "routes/agents.ts#withRuntimeErrorProjection": "projected:projectRuntimeErrorState+projectRuntimeErrorActivityDetail (the REST helper itself)",
  "routes/agents.ts#agentRouter.GET /:id": "projected:withRuntimeErrorProjection (member for non-managers, manager otherwise); joint and guest views go through toJointAgentProfile / toGuestChannelAgentProfile",
  "routes/agents.ts#buildAgentListItems": "projected:withRuntimeErrorProjection per row (GET /api/agents); guests go through toGuestChannelAgentProfile",
  "routes/agents.ts#toJointAgentProfile": "projected:constant empty activityDetail, no lastRuntimeError (joint viewers)",
  "routes/agents.ts#toGuestChannelAgentProfile": "projected:constant empty activityDetail, no lastRuntimeError (guests)",
  "routes/channels.ts#buildChannelMembersView": "projected:projectRuntimeErrorActivityDetail member (every channel viewer)",
  "routes/internal.ts#toServerInfoAgentSummary": "projected:projectRuntimeErrorActivityDetail member (agent-facing serverInfo)",
  "routes/internal.ts#buildAgentProfileView": "projected:projectRuntimeErrorState (manager for the agent itself, member for another agent)",
  "services/agentRuntimeErrorVisibility.ts#projectRuntimeErrorActivityDetail": "projected:the projection itself",
  "services/agentOrchestrator.ts#AgentOrchestrator.emitActivity": "projected:runtimeErrorActivityPush for every runtime error activity (isRuntimeErrorDetailActivity); other activities carry no runtime error text",
  "services/agentOrchestrator.ts#AgentOrchestrator.runtimeErrorActivityPush": "projected:projectRuntimeErrorActivityDetail, manager rooms vs member rooms",
  "services/agentOrchestrator.ts#AgentOrchestrator.emitJointActivityToProjectionRooms": "projected:joint rooms always get detail \"\" (emitActivity passes it)",

  // ── Manager-only ──
  "services/externalAgentDiagnosticsService.ts#getExternalAgentDiagnostics": "manager-only: GET /api/agents/:id/diagnostics checks roleCanInspectAgentPrivateSurfaces",

  // ── Internal ──
  "routes/internal.ts#internalRouter.GET /machine/agents": "internal: machine-credential read of the agents on that machine (their errors came from it)",
  "routes/internal.ts#internalRouter.POST /agent/:id/send": "internal: activityDetail is the server-authored Raft action title",
  "routes/internalAgentApi.ts#renderAgentFreshnessHold": "internal: activityDetail is the server-authored Raft action title",
  "routes/channels.ts#resolveManagedFollowerActivity": "internal: the activity is written into the agent's activity log row (manager-only trajectory), never returned",
  "services/channelService.ts#removeManagedAgentThreadFollower": "internal: written to agent_activity_events (manager-only activity log)",
  "services/channelService.ts#restoreManagedAgentThreadFollower": "internal: written to agent_activity_events (manager-only activity log)",
  "services/closedServerPurgeFinish.ts#scrubAgentTombstones": "internal: the closed-server purge clears last_runtime_error on a closed server's agent tombstones (a write of null); nothing is read out toward a person",
  "services/agentOrchestrator.ts#AgentOrchestrator.handleMachineMessage": "internal: ingest; the detail is scrubbed and capped here (isDaemonRuntimeErrorActivityFrame)",
  "services/agentOrchestrator.ts#AgentOrchestrator.broadcastRaftAction": "internal: server-authored Raft action title, pushed through emitActivity",
  "services/agentOrchestrator.ts#AgentOrchestrator.recordAgentRaftAction": "internal: server-authored Raft action title, pushed through emitActivity",
  "services/agentOrchestrator.ts#AgentOrchestrator.formatActivity": "internal: builds VisibleActivity for getActivity; callers project it",
  "services/agentOrchestrator.ts#AgentOrchestrator.formatActivityFromSnapshot": "internal: builds VisibleActivity (keeps runtime error detail kinds so callers can project)",
  "services/agentOrchestrator.ts#AgentOrchestrator.resolveLastRuntimeErrorActivity": "internal: getActivity from the stored error (bounded by formatRuntimeErrorActivity); callers project it",
  "services/agentOrchestrator.ts#AgentOrchestrator.rememberRuntimeError": "internal: cache + snapshot write of the stored error (bounded)",
  "services/agentOrchestrator.ts#AgentOrchestrator.applyRuntimeErrorCleared": "internal: cache clear",
  "services/agentOrchestrator.ts#AgentOrchestrator.syncCachedRuntimeError": "internal: cache resync",
  "services/agentOrchestrator.ts#AgentOrchestrator.stampRuntimeErrorRecoveryLaunch": "internal: cache update",
  "services/agentOrchestrator.ts#AgentOrchestrator.persistAgentLastRuntimeError": "internal: database write",
  "services/agentOrchestrator.ts#AgentOrchestrator.cachedStateFromPersistedAgent": "internal: cache fill",
  "services/agentOrchestrator.ts#AgentOrchestrator.startAgentHereUnguarded": "internal: typed error state for start decisions",
  "services/agentOrchestrator.ts#AgentOrchestrator.applyStopAction": "internal: typed error state for stop decisions",
  "services/agentOrchestrator.ts#AgentOrchestrator.broadcastReadyOnline": "internal: presence check only",
  "services/agentOrchestrator.ts#CachedAgentState": "internal: type",
  "services/agentOrchestrator.ts#VisibleActivity": "internal: type",
  "services/agentService.ts#setAgentLastRuntimeError": "internal: database write",
  "services/agentService.ts#loadAgentLastRuntimeErrorRow": "internal: database read for the orchestrator",
  "services/agentService.ts#getAgentLastRuntimeError": "internal: database read for the orchestrator",
  "services/agentService.ts#clearAgentLastRuntimeErrorUnlessBilling": "internal: database write",
  "services/agentService.ts#clearAgentBillingErrorOnRecovery": "internal: database write",
  "services/agentService.ts#stampAgentRuntimeErrorRecoveryLaunch": "internal: database write",
  "services/agentService.ts#billingErrorIsNewerThanStoredSql": "internal: SQL predicate",
  "db/schema.ts#agents": "internal: column definition",
};
