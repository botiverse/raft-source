// Route Auth Policy registry — single source of truth for "who can call
// what" on the mounted Raft Computer + Agent Runner surface.
//
// Scope (`rfcs/034-slock-credential-rfc.zh.html#section-route-auth-policy`):
//   1. /internal/agent-api/*                        (sk_agent_* ONLY)
//   2. /internal/computer/*                         (sk_computer_* canonical;
//                                                    sk_machine_* accepted only
//                                                    as a Phase 1 Computer alias)
//
// Out-of-scope for this registry (NOT in the registry):
//   - /daemon/connect and legacy /internal/agent/:id/* routes — these keep
//     the existing machine auth wiring until the legacy surface is retired.
//   - All `/api/*` routes (login, credentials admin, etc.) — these keep
//     their per-route `requireAuth` / handler-internal verifier path.
//   - Gated self-hosted-runner bootstrap exchange endpoint
//     (POST /api/agent/login or equivalent) — `/api/*` is intentionally
//     outside the registry per Hao msg=dbbf2b90 + ApplePI msg=94e72249.
//
// Wrong-principal denial (base RFC §2.4 wrong-principal semantics): paths
// under a declared prefix MUST be registered. Unregistered paths under
// declared prefixes return 401 `auth_policy_unregistered_path` (natural
// fail-closed via the dispatcher in `authFromRegistry.ts`).
//
// The registry is consumed by `authFromRegistry()` which returns Express
// middleware that dispatches to the right authenticator for the current
// mounted path. A future snapshot test should assert:
//   - every entry below has a corresponding mounted route in `app.ts`;
//   - every mounted route under a declared prefix is in the registry;
//   - unregistered paths under declared prefixes return 401 (fail closed).
//
// Capability enforcement — the registry binds the principal. Handler-level
// `requireAgentCapability()` first checks the credential max-capability set,
// then applies the runner session active-capability header when present.

export type PrincipalKind =
  | "sk_machine"               // legacy sk_machine_* surface
  | "sk_computer"              // sk_computer_* (Computer host attachment session)
  | "sk_agent";                // sk_agent_*

export interface RouteAuthPolicyEntry {
  /** HTTP method, or "*" for any method (Express `app.use` semantics). */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "*";
  /**
   * Express path pattern as mounted on the app, including `:id` placeholders.
   * Must match the literal `app.use` / `router.X` path so the snapshot test
   * can pair registry rows with mounted routes 1:1.
   */
  path: string;
  /** Authentication required to reach the handler. */
  principal: PrincipalKind;
  /** Human-readable reason / RFC anchor. */
  note?: string;
}

/**
 * Declared prefixes — fail-closed scope. Paths matching one of these
 * prefixes MUST appear in `routeAuthPolicy` below. Paths NOT under any
 * declared prefix are out of registry scope and use their own per-route
 * auth wiring.
 */
export const CLAIMED_AUTH_POLICY_PREFIXES: readonly string[] = [
  "/internal/agent-api",   // RFC v0.8 sk_agent_* surface
  "/internal/computer/",   // RFC v0.8 sk_computer_* surface + Phase 1 machine alias
];

/**
 * v0.8 registry. /internal/agent-api/* rows are the runner data-plane.
 * /internal/computer/* rows cover the Computer-requested runner credential
 * mint endpoint. Legacy machine-on-behalf routes are intentionally not
 * registry-owned here.
 */
export const routeAuthPolicy: readonly RouteAuthPolicyEntry[] = [
  // ---------------------------------------------------------------------------
  // RFC v0.8 — `/internal/agent-api/*`.
  //
  // sk_agent_* credentials ONLY. The bound `agentId` is read from the
  // credential row — there is NO `:id` path param. All active routes
  // act on the credential's bound agent identity.
  // ---------------------------------------------------------------------------
  {
    method: "GET",
    path: "/internal/agent-api",
    principal: "sk_agent",
    note: "RFC v0.8 — whoami: returns (agentId, serverId, scopes, expiry)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/feedback-locators",
    principal: "sk_agent",
    note: "locator-only feedback v0 — atomic index acceptance receipt",
  },
  {
    method: "GET",
    path: "/internal/agent-api/feedback-locators",
    principal: "sk_agent",
    note: "locator-only feedback v0 — content-free triage index query",
  },
  {
    method: "GET",
    path: "/internal/agent-api/server",
    principal: "sk_agent",
    note: "RFC v0.8 — agent-self server info",
  },
  {
    method: "GET",
    path: "/internal/agent-api/knowledge",
    principal: "sk_agent",
    note: "Slock Manual for Agents v0 — authenticated operating-manual retrieval",
  },
  {
    method: "GET",
    path: "/internal/agent-api/knowledge/search",
    principal: "sk_agent",
    note: "Slock Manual for Agents v0 — authenticated operating-manual search",
  },
  {
    method: "GET",
    path: "/internal/agent-api/wiki/manifest",
    principal: "sk_agent",
    note: "Wiki v2 — configured Wiki Agent reads the canonical S3 manifest",
  },
  {
    method: "GET",
    path: "/internal/agent-api/wiki/artifacts/:artifactId",
    principal: "sk_agent",
    note: "Wiki v2 — configured Wiki Agent reads current manifest-reachable Markdown",
  },
  {
    method: "POST",
    path: "/internal/agent-api/wiki/publish",
    principal: "sk_agent",
    note: "Wiki v2 — configured Wiki Agent conditionally publishes revisions + manifest",
  },
  {
    method: "GET",
    path: "/internal/agent-api/mcp/tools",
    principal: "sk_agent",
    note: "Raft Managed MCP v1 — frozen tool catalog for the bound Agent runner",
  },
  {
    method: "POST",
    path: "/internal/agent-api/mcp/call",
    principal: "sk_agent",
    note: "Raft Managed MCP v1 — server-mediated tools/call for the bound Agent runner",
  },
  {
    method: "POST",
    path: "/internal/agent-api/send",
    principal: "sk_agent",
    note: "RFC v0.8 — agent-self send (target inferred from body)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/v2/send",
    principal: "sk_agent",
    note: "Message send v2 — typed actor mentions and sender-only warning envelope",
  },
  {
    method: "GET",
    path: "/internal/agent-api/history",
    principal: "sk_agent",
    note: "RFC v0.8 — read history for any channel the bound agent is in",
  },
  {
    method: "GET",
    path: "/internal/agent-api/messages/:msgId/resolve",
    principal: "sk_agent",
    note: "RFC v0.8 — exact message id verifier for the bound agent",
  },
  {
    method: "GET",
    path: "/internal/agent-api/mentions",
    principal: "sk_agent",
    note: "RFC v0.8 — mentions inbox for the bound agent",
  },
  {
    method: "GET",
    path: "/internal/agent-api/mention-actions/pending",
    principal: "sk_agent",
    note: "Mention AX — sender-side pending mention resolution actions",
  },
  {
    method: "POST",
    path: "/internal/agent-api/mention-actions/execute",
    principal: "sk_agent",
    note: "Mention AX — execute sender-side mention notify/invite actions",
  },
  {
    method: "POST",
    path: "/internal/agent-api/tasks/claim",
    principal: "sk_agent",
    note: "RFC v0.8 — claim a task (assignee = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/messages/:msgId/reactions",
    principal: "sk_agent",
    note: "RFC v0.8 — add reaction (actor = bound agent)",
  },
  {
    method: "DELETE",
    path: "/internal/agent-api/messages/:msgId/reactions",
    principal: "sk_agent",
    note: "RFC v0.8 — remove the bound agent's reaction",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/:channelId/join",
    principal: "sk_agent",
    note: "RFC v0.8 — join a visible public channel (actor = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/:channelId/leave",
    principal: "sk_agent",
    note: "RFC v0.8 — leave a joined regular/private channel (actor = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels",
    principal: "sk_agent",
    note: "Agent admin — create a regular public/private channel (actor = bound agent)",
  },
  {
    method: "PATCH",
    path: "/internal/agent-api/channels/:channelId",
    principal: "sk_agent",
    note: "Agent admin — edit a regular public/private channel (actor = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/:channelId/members",
    principal: "sk_agent",
    note: "Agent admin — add a human or agent to a regular channel (actor = bound agent)",
  },
  {
    method: "DELETE",
    path: "/internal/agent-api/channels/:channelId/members",
    principal: "sk_agent",
    note: "Agent admin — remove a human or agent from a regular channel (actor = bound agent)",
  },
  {
    method: "PATCH",
    path: "/internal/agent-api/server",
    principal: "sk_agent",
    note: "Agent admin — edit server profile fields (actor = bound agent)",
  },
  {
    method: "GET",
    path: "/internal/agent-api/labs",
    principal: "sk_agent",
    note: "Server Labs — member-scoped catalog and enrollment readback",
  },
  {
    method: "PATCH",
    path: "/internal/agent-api/labs/access",
    principal: "sk_agent",
    note: "Server Labs — owner-only master access mutation",
  },
  {
    method: "PUT",
    path: "/internal/agent-api/labs/:labKey",
    principal: "sk_agent",
    note: "Server Labs — owner/admin enrollment mutation",
  },
  {
    method: "POST",
    path: "/internal/agent-api/server/avatar",
    principal: "sk_agent",
    note: "Agent admin — upload server avatar (actor = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/:channelId/mute",
    principal: "sk_agent",
    note: "Agent attention config — mute ordinary channel Activity for the bound agent",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/:channelId/unmute",
    principal: "sk_agent",
    note: "Agent attention config — unmute ordinary channel Activity for the bound agent",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/archive",
    principal: "sk_agent",
    note: "Agent admin — archive a regular public/private channel (actor = bound agent)",
  },
  {
    method: "POST",
    path: "/internal/agent-api/channels/unarchive",
    principal: "sk_agent",
    note: "Agent admin — unarchive a regular public/private channel (actor = bound agent)",
  },
  {
    method: "GET",
    path: "/internal/agent-api/events",
    principal: "sk_agent",
    note: "RFC v0.8 — catch-up envelope (cursor: since=<messageSeq>|latest)",
  },
  {
    method: "GET",
    path: "/internal/agent-api/wake-hints",
    principal: "sk_agent",
    note: "RFC 035 D7 — content-free wake hints (non-draining)",
  },
  {
    method: "GET",
    path: "/internal/agent-api/wake-hints/stream",
    principal: "sk_agent",
    note: "RFC 035 D7 T1 — SSE push projection of the same content-free wake-hint peek (task #72)",
  },
  { method: "POST", path: "/internal/agent-api/activity", principal: "sk_agent", note: "external plugin activity ingest (#2886) — bridge-forwarded, plugin-reported telemetry" },
  { method: "POST", path: "/internal/agent-api/resolve-channel", principal: "sk_agent", note: "RFC v0.8 — agent-self channel resolution" },
  { method: "POST", path: "/internal/agent-api/upload", principal: "sk_agent", note: "RFC v0.8 — agent-self attachment upload" },
  { method: "GET", path: "/internal/agent-api/attachment-upload-capabilities", principal: "sk_agent", note: "direct attachment upload — server-authoritative agent capability" },
  { method: "POST", path: "/internal/agent-api/attachment-upload-sessions", principal: "sk_agent", note: "direct attachment upload — agent session create" },
  { method: "POST", path: "/internal/agent-api/attachment-upload-sessions/:uploadId/complete", principal: "sk_agent", note: "direct attachment upload — agent session complete" },
  { method: "DELETE", path: "/internal/agent-api/attachment-upload-sessions/:uploadId", principal: "sk_agent", note: "direct attachment upload — agent session cancel" },
  { method: "GET", path: "/internal/agent-api/attachment-upload-sessions/:uploadId", principal: "sk_agent", note: "direct attachment upload — agent session status" },
  { method: "GET", path: "/internal/agent-api/attachments/:attachmentId", principal: "sk_agent", note: "RFC v0.8 — agent-self attachment download" },
  { method: "GET", path: "/internal/agent-api/attachments/:attachmentId/comments", principal: "sk_agent", note: "attachment-comments MVP — agent-self scoped comment list" },
  { method: "POST", path: "/internal/agent-api/attachments/:attachmentId/comments", principal: "sk_agent", note: "attachment-comments MVP — agent-self scoped comment create" },
  { method: "GET", path: "/internal/agent-api/search", principal: "sk_agent", note: "RFC v0.8 — agent-self message search" },
  { method: "GET", path: "/internal/agent-api/channel-members", principal: "sk_agent", note: "RFC v0.8 — agent-self channel member listing" },
  { method: "POST", path: "/internal/agent-api/threads/unfollow", principal: "sk_agent", note: "RFC v0.8 — agent-self thread unfollow" },
  { method: "GET", path: "/internal/agent-api/profile", principal: "sk_agent", note: "RFC v0.8 — agent-self profile show" },
  { method: "POST", path: "/internal/agent-api/profile", principal: "sk_agent", note: "RFC v0.8 — agent-self profile update" },
  { method: "POST", path: "/internal/agent-api/profile/avatar", principal: "sk_agent", note: "RFC v0.8 — agent-self avatar upload" },
  { method: "GET", path: "/internal/agent-api/integrations", principal: "sk_agent", note: "RFC v0.8 — agent-self third-party integration discovery" },
  { method: "GET", path: "/internal/agent-api/integrations/marketplace", principal: "sk_agent", note: "task #216 — agent-self public Marketplace discovery" },
  { method: "POST", path: "/internal/agent-api/integrations/login", principal: "sk_agent", note: "RFC v0.8 — agent-self third-party integration login" },
  { method: "POST", path: "/internal/agent-api/integrations/app/prepare", principal: "sk_agent", note: "agent-prepared third-party app registration action card" },
  { method: "GET", path: "/internal/agent-api/integrations/app", principal: "sk_agent", note: "task #163 — requester/owner/admin-scoped app state reconstruction" },
  { method: "GET", path: "/internal/agent-api/integrations/app/status", principal: "sk_agent", note: "task #163 — requester/owner/admin-scoped app status lookup" },
  { method: "POST", path: "/internal/agent-api/integrations/app/rotate-secret", principal: "sk_agent", note: "task #163 — resource-maintainer-or-server-admin secret rotation" },
  { method: "POST", path: "/internal/agent-api/integrations/app/transfer-owner", principal: "sk_agent", note: "task #163 — owner-or-server-admin transfer of a source-owned app" },
  { method: "POST", path: "/internal/agent-api/integrations/app/update", principal: "sk_agent", note: "task #163 — owner-or-server-admin update of a source-owned app" },
  { method: "POST", path: "/internal/agent-api/integrations/app/manage", principal: "sk_agent", note: "task #163 — owner-or-server-admin app lifecycle and distribution management" },
  { method: "POST", path: "/internal/agent-api/integrations/app/logo", principal: "sk_agent", note: "task #163 — owner-or-server-admin app logo upload" },
  { method: "GET", path: "/internal/agent-api/tasks", principal: "sk_agent", note: "RFC v0.8 — agent-self task list" },
  { method: "POST", path: "/internal/agent-api/tasks", principal: "sk_agent", note: "RFC v0.8 — agent-self task create" },
  { method: "POST", path: "/internal/agent-api/tasks/unclaim", principal: "sk_agent", note: "RFC v0.8 — agent-self task unclaim" },
  { method: "POST", path: "/internal/agent-api/tasks/assign", principal: "sk_agent", note: "task v1.4 — set/clear a task assignee (member-level)" },
  { method: "POST", path: "/internal/agent-api/tasks/update-status", principal: "sk_agent", note: "RFC v0.8 — agent-self task status update" },
  { method: "POST", path: "/internal/agent-api/tasks/resource-receipt", principal: "sk_agent", note: "task resource contract — structured receipt + expiry follow-up" },
  { method: "POST", path: "/internal/agent-api/tasks/delete", principal: "sk_agent", note: "task v1.4 — delete a task (creator or server admin), mirroring the browser rule" },
  { method: "POST", path: "/internal/agent-api/tasks/convert", principal: "sk_agent", note: "task v1.4 — convert a message into a task without claiming it" },
  { method: "POST", path: "/internal/agent-api/tasks/amend", principal: "sk_agent", note: "task card amendment with actor-bound audit history" },
  { method: "GET", path: "/internal/agent-api/tasks/history", principal: "sk_agent", note: "agent-self task audit history read" },
  { method: "POST", path: "/internal/agent-api/migrations", principal: "sk_agent", note: "Agent migration v1 — begin migration for the bound agent" },
  { method: "GET", path: "/internal/agent-api/migrations/current", principal: "sk_agent", note: "Agent migration v1 — read active migration for the bound agent" },
  { method: "POST", path: "/internal/agent-api/migrations/ready", principal: "sk_agent", note: "Agent migration v1 — bound agent prep-ready callback" },
  { method: "POST", path: "/internal/agent-api/migrations/arrived", principal: "sk_agent", note: "Agent migration v1 — bound agent arrived callback" },
  { method: "GET", path: "/internal/agent-api/reminders", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder list" },
  { method: "POST", path: "/internal/agent-api/reminders", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder schedule" },
  { method: "DELETE", path: "/internal/agent-api/reminders/:reminderId", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder cancel" },
  { method: "POST", path: "/internal/agent-api/reminders/:reminderId/snooze", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder snooze" },
  { method: "PATCH", path: "/internal/agent-api/reminders/:reminderId", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder update" },
  { method: "GET", path: "/internal/agent-api/reminders/:reminderId/log", principal: "sk_agent", note: "RFC v0.8 — agent-self reminder event log" },
  { method: "POST", path: "/internal/agent-api/app-sources/ack", principal: "sk_agent", note: "App Inbox source ACK — server-authoritative exact item retirement adjudication" },
  { method: "GET", path: "/internal/agent-api/apps/:appId/config", principal: "sk_agent", note: "RAP App Config v0.1 — read effective config for the bound agent" },
  { method: "PATCH", path: "/internal/agent-api/apps/:appId/config", principal: "sk_agent", note: "RAP App Config v0.1 — atomically update config for the bound agent" },
  { method: "POST", path: "/internal/agent-api/prepare-action", principal: "sk_agent", note: "RFC v0.8 — agent-self action card prepare" },

  // ---------------------------------------------------------------------------
  // RFC v0.8 — `/internal/computer/*` mint surface.
  //
  // The step-3 mint endpoint `POST /internal/computer/runners/:agentId/credentials`
  // and any future Computer-host control plane live here. Canonical
  // principal is `sk_computer_*`; Phase 1 also accepts existing sk_machine_*
  // machine keys as Computer aliases until the wire prefix migration lands.
  // sk_agent_* still returns 401 invalid_principal.
  // ---------------------------------------------------------------------------
  {
    // task #30 PR-C — Computer lists the runners on its bound server.
    // §12 control-plane whitelist is enforced SERVER-SIDE in the handler
    // (the SELECT projects only safe fields; the raw agents row — incl.
    // sessionId / envVars — is never serialized).
    method: "GET",
    path: "/internal/computer/runners",
    principal: "sk_computer",
    note: "RFC v0.8 §12 task #30 — Computer runner list (server-side whitelist)",
  },
  {
    // task #30 PR-C — Computer stops one of its runners (control-plane).
    method: "POST",
    path: "/internal/computer/runners/:agentId/stop",
    principal: "sk_computer",
    note: "RFC v0.8 §12 task #30 — Computer-initiated runner stop",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-o11y/events",
    principal: "sk_computer",
    note: "Agent O11y v0 rev 3.2 — server-mediated ScopeDB event ingest",
  },
  {
    method: "GET",
    path: "/internal/computer/agent-migrations/by-id/:migrationId",
    principal: "sk_computer",
    note: "Agent migration v1 task #130 — target import readback by non-secret migration id",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/source-ready",
    principal: "sk_computer",
    note: "Agent migration v1 task #143 — source daemon marks object-store upload ready",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/transport-lost",
    principal: "sk_computer",
    note: "Agent migration v1 task #143 — participant daemon reports object-store transfer lost",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/cancel-ack",
    principal: "sk_computer",
    note: "Agent migration safe cancel — participant daemon acknowledges generation-fenced cleanup",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/source-quiesced",
    principal: "sk_computer",
    note: "Agent migration Phase B — generation-fenced persisted source quiesce receipt",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/control",
    principal: "sk_computer",
    note: "Agent migration Phase B — source registers fixed-budget control manifest",
  },
  {
    method: "GET",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/control",
    principal: "sk_computer",
    note: "Agent migration Phase B — participant reads generation-bound control manifest",
  },
  {
    method: "GET",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/chunks",
    principal: "sk_computer",
    note: "Agent migration Phase B — participant leases only missing object-store chunks",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/chunks/:chunkIndex/receipt",
    principal: "sk_computer",
    note: "Agent migration Phase B — idempotent generation/lease-bound chunk receipt",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/by-id/:migrationId/resumable/upload-complete",
    principal: "sk_computer",
    note: "Agent migration Phase B — source commits all uploaded chunk receipts",
  },
  {
    method: "GET",
    path: "/internal/computer/agent-migrations/:grantKey",
    principal: "sk_computer",
    note: "Agent migration v1 task #124 — target import generation readback",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/:grantKey/start-transfer",
    principal: "sk_computer",
    note: "Agent migration v1 task #124 — target import transfer start",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/:grantKey/flip-machine",
    principal: "sk_computer",
    note: "Agent migration v1 task #124 — target import holder transfer",
  },
  {
    method: "POST",
    path: "/internal/computer/agent-migrations/:grantKey/arrived",
    principal: "sk_computer",
    note: "Agent migration v1 task #124 — target import arrival report",
  },
  {
    method: "POST",
    path: "/internal/computer/runners/:agentId/credentials",
    principal: "sk_computer",
    note: "RFC v0.8 — Computer-requested runner credential mint",
  },
  {
    method: "POST",
    path: "/internal/computer/runners/:agentId/provider-connection",
    principal: "sk_computer",
    note: "Server-managed provider credential materialization for an attached Agent",
  },
  {
    method: "DELETE",
    path: "/internal/computer/runners/:agentId/credentials/:credentialId",
    principal: "sk_computer",
    note: "RFC v0.8 — Computer-requested managed-runner credential revoke",
  },
  {
    // task #30 PR-A — synthetic read-only attach/login preflight. MUST be
    // explicitly registered: an unregistered sibling under the claimed
    // `/internal/computer/` prefix fail-closes with
    // `auth_policy_unregistered_path`. The preflight handler reflects this
    // registry back to the client, so registry and preflight cannot drift.
    method: "POST",
    path: "/internal/computer/preflight",
    principal: "sk_computer",
    note: "RFC v0.8 §9 task #30 — synthetic side-effect-free attach preflight",
  },
];
