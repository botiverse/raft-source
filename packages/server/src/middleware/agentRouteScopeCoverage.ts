// Agent route scope-coverage allowlist.
//
// Why this file exists: every `/internal/agent/:id/*` route MUST be one of:
//   • static — gated by `requireAgentScope(scope)` middleware on the route
//   • intrinsic — capability inherent to "being an agent" and not gated by a
//     grantable scope (`profile:*`, `reminder:*`, fetching own scope set,
//     runtime-control acks)
//   • exempt — route does not expose data or perform an agent-scoped action
//     (internal helpers, ack endpoints, always-403 stubs)
//
// v1 scope granularity is per-CLI-subcommand (stdrc, #proj-permission:1414ca65
// msg=a9b3feaf). `message:read` / `message:send` are aggregate — the
// channel/DM split was reverted in favor of the simpler model. Every
// /agent/:id/* message route is now static-gated by `requireAgentScope`.
// If a future v2 introduces handler-decided scopes (e.g. `<resource>:<verb>:<sub>`),
// reintroduce a `kind: "dynamic"` here together with an `assertAgentScope`
// helper and a literal-presence check in the test.
//
// Static routes are auto-detected by the route-coverage test via the
// `__agentScope` tag that `requireAgentScope` attaches to its returned handler.
// Anything else MUST appear in this allowlist with a reason. Stale entries
// (allowlist key with no matching route) and missing entries (route with no
// middleware and no allowlist entry) both fail the test.

export type AgentRouteCoverageKind = "intrinsic" | "exempt";

export interface AgentRouteCoverageEntry {
  kind: AgentRouteCoverageKind;
  /** Why this route is exempt from the static `requireAgentScope` middleware
   *  rule — required, non-empty. For `intrinsic`, name the inherent capability
   *  (e.g. `profile:write`, `reminder:manage`). For `exempt`, name the reason
   *  (internal helper, ack-only, etc.). */
  reason: string;
}

/**
 * The route key is `<METHOD> <path>`, where path is the Express route literal
 * exactly as registered (e.g. `POST /agent/:id/send`). Method is uppercase.
 *
 * Add a new entry whenever you add a `/agent/:id/*` route that:
 *   • cannot use static `requireAgentScope` middleware, OR
 *   • is intentionally not gated by a grantable scope.
 *
 * Routes gated by `requireAgentScope` middleware MUST NOT appear here — the
 * test will fail with "static-gated route should not be in allowlist" if they
 * do. Keep this file lean: it documents exceptions, not the rule.
 */
export const AGENT_ROUTE_SCOPE_COVERAGE: ReadonlyMap<string, AgentRouteCoverageEntry> = new Map([
  // ── Intrinsic: capability inherent to being an agent ───────────────────────
  [
    "GET /agent/:id/profile",
    { kind: "intrinsic", reason: "profile:read — fetching own profile is intrinsic" },
  ],
  [
    "POST /agent/:id/profile",
    { kind: "intrinsic", reason: "profile:write — editing own profile is intrinsic" },
  ],
  [
    "POST /agent/:id/profile/avatar",
    { kind: "intrinsic", reason: "profile:write — uploading own avatar is intrinsic" },
  ],
  [
    "GET /agent/:id/reminders",
    { kind: "intrinsic", reason: "reminder:manage — listing own reminders is intrinsic" },
  ],
  [
    "POST /agent/:id/reminders",
    { kind: "intrinsic", reason: "reminder:manage — scheduling own reminder is intrinsic" },
  ],
  [
    "DELETE /agent/:id/reminders/:reminderId",
    { kind: "intrinsic", reason: "reminder:manage — cancelling own reminder is intrinsic" },
  ],
  [
    "POST /agent/:id/reminders/:reminderId/snooze",
    { kind: "intrinsic", reason: "reminder:manage — snoozing own reminder is intrinsic" },
  ],
  [
    "PATCH /agent/:id/reminders/:reminderId",
    { kind: "intrinsic", reason: "reminder:manage — updating own reminder is intrinsic" },
  ],
  [
    "GET /agent/:id/reminders/:reminderId/log",
    { kind: "intrinsic", reason: "reminder:manage — reading own reminder log is intrinsic" },
  ],
  [
    "GET /agent/:id/scopes",
    {
      kind: "intrinsic",
      reason:
        "fetching own scope set is intrinsic; daemon needs this on connect for cooperative cache",
    },
  ],
  [
    "GET /agent/:id/integrations",
    {
      kind: "intrinsic",
      reason:
        "app access discovery is intrinsic; agents may list registered apps available in their server",
    },
  ],
  [
    "POST /agent/:id/integrations/login",
    {
      kind: "intrinsic",
      reason:
        "app access login is intrinsic for registered apps; server-side registry controls available apps and scopes",
    },
  ],
  [
    "POST /agent/:id/integrations/app/prepare",
    {
      kind: "intrinsic",
      reason:
        "app registration preparation only posts a human action card; server owner/admin commits the live app registration",
    },
  ],
  [
    "POST /agent/:id/runtime-profile/migration-done",
    {
      kind: "intrinsic",
      reason:
        "agent-runtime control ack, not a slock CLI / human-facing operation; tied to live launchId",
    },
  ],

  // ── Exempt: no agent-scoped action / data exposure ─────────────────────────
  [
    "POST /agent/:id/resolve-channel",
    {
      kind: "exempt",
      reason:
        "internal helper for upload_file — returns channelId for an already-resolvable target, exposes no message data",
    },
  ],
  [
    "POST /agent/:id/receive-ack",
    {
      kind: "exempt",
      reason:
        "ack-only mechanism paired with /receive; informs orchestrator of processed seqs, no data exposure",
    },
  ],
]);
