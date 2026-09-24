// Agent permission system — scope contract.
//
// Locked at #proj-permission:10bdc2c9 (2026-05-10) by stdrc / Tenny / Noel /
// Stone. The agent's primary surface is the `slock` CLI; every grantable
// scope maps 1:1 to a `slock <noun> <verb>` CLI command (or to the
// `prepare_action` MCP tool, which is the lone non-CLI grantable surface).
//
// Two policy categories:
//
//   • intrinsic  — capability is inherent to "being an agent" and not
//                  human-toggleable. `auth:whoami`, `profile:*`, `reminder:*`.
//                  Disabling them produces a degenerate state ("agent that
//                  can't manage its own reminders") with no product value;
//                  service layer enforces the self-only invariant
//                  independently of any grant.
//
//   • grantable  — default-granted while an agent is using the system default
//                  permission profile; human can customize/revoke per agent
//                  in the agent profile UI. Once customized, future
//                  capabilities stay off until explicitly enabled.
//
// Self-only invariant (Noel #proj-permission:10bdc2c9 msg=404dae5d):
//   A scope name declares the *capability to self-action*, never the
//   *authority to act-on-others*. `reminder:manage` does not let an agent
//   touch another principal's reminders; `profile:write` does not let an
//   agent edit another principal's profile. The service layer enforces
//   self-only on its own — independently of any scope grant.
//
// Authority model (#proj-permission:10bdc2c9 msg=ce7df4eb):
//   Server-side scope checks are *authoritative*. Daemon-cached scope sets
//   are a *cooperative fast-path* used by the CLI wrapper and MCP listing
//   filter to short-circuit obviously-denied calls before they reach the
//   wire. The server check must always run; daemon cache must never be
//   trusted as the source of truth.
//
// Future-proofing:
//   CLI/action scope literals follow `<resource>:<verb>` and reserve
//   `<resource>:<verb>:<sub>` for additive splits. Notification scopes are a
//   separate top-level section (`inbox:*`) because passive server delivery is
//   not a `slock message` subcommand.

// ── Resource × verb axes (bounded sets) ────────────────────────────────────

export const AGENT_SCOPE_RESOURCES = [
  "server",
  "channel",
  "thread",
  "message",
  "inbox",
  "attachment",
  "task",
  "knowledge",
  "action",
  // intrinsic-only resources (not human-toggleable, listed here so future
  // sub-scopes can still slot into the same `<resource>:<verb>` grid)
  "auth",
  "profile",
  "reminder",
] as const;
export type AgentScopeResource = (typeof AGENT_SCOPE_RESOURCES)[number];

export const AGENT_SCOPE_VERBS = [
  "read",
  "send",
  "create",
  "add_member",
  "write",
  "join",
  "leave",
  "unfollow",
  "upload",
  "view",
  "manage",
  "prepare",
  "receive",
  "whoami",
] as const;
export type AgentScopeVerb = (typeof AGENT_SCOPE_VERBS)[number];

// ── Grantable scope literal set (19 entries) ────────────────────────────────
//
// Every literal here:
//   • maps to either a slock CLI command/action surface OR a passive inbox
//     delivery capability
//   • is human-toggleable in the agent profile UI
//   • is enabled by default for agents using the default profile
//   • appears in `agent_scopes.scopes` JSON when granted

export const AGENT_GRANTABLE_SCOPES = [
  "inbox:receive",      // passive: server may deliver new inbox events / wake
  "server:read",        // slock server info
  "server:update",      // slock server update
  "channel:read",       // slock channel members
  "channel:create",     // slock channel create
  "channel:update",     // slock channel update
  "channel:add_member", // slock channel add-member
  "channel:remove_member", // slock channel remove-member
  "channel:join",       // slock channel join
  "channel:leave",      // slock channel leave
  "thread:unfollow",    // slock thread unfollow
  "message:read",       // slock message check / read / search / resolve
  "message:send",       // slock message send (DM / channel / thread)
  "attachment:upload",  // slock attachment upload
  "attachment:view",    // slock attachment view
  "task:read",          // slock task list
  "task:write",         // slock task create / claim / unclaim / update
  "knowledge:read",     // slock manual get (legacy alias: slock knowledge get)
  "action:prepare",     // slock action prepare — agent prepares card, human commits
] as const;
export type AgentGrantableScope = (typeof AGENT_GRANTABLE_SCOPES)[number];

export const AGENT_SCOPE_PROFILE_MODES = ["default", "custom"] as const;
export type AgentScopeProfileMode = (typeof AGENT_SCOPE_PROFILE_MODES)[number];

// ── Intrinsic scopes (not grantable, not toggleable) ────────────────────────
//
// Listed so middleware / UI / docs share a single source of truth on what is
// inherent to "being an agent". A handler that checks `auth:whoami` should
// always pass for any active agent — this list is descriptive, not
// dispositive.

export const AGENT_INTRINSIC_SCOPES = [
  "auth:whoami",
  "profile:read",
  "profile:write",
  "reminder:manage",
] as const;
export type AgentIntrinsicScope = (typeof AGENT_INTRINSIC_SCOPES)[number];

export type AgentScope = AgentGrantableScope | AgentIntrinsicScope;

export function isGrantableScope(value: string): value is AgentGrantableScope {
  return (AGENT_GRANTABLE_SCOPES as readonly string[]).includes(value);
}

export function isIntrinsicScope(value: string): value is AgentIntrinsicScope {
  return (AGENT_INTRINSIC_SCOPES as readonly string[]).includes(value);
}

export function isAgentScope(value: string): value is AgentScope {
  return isGrantableScope(value) || isIntrinsicScope(value);
}

// Normalize a granted scope set: strip unknown / duplicate / non-grantable
// entries, returning a stable-sorted array. Intended as the single sanitizer
// in front of any DB write (`agent_scopes.scopes` is JSON-typed).
export function sanitizeGrantedScopes(raw: readonly string[] | null | undefined): AgentGrantableScope[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<AgentGrantableScope>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (isGrantableScope(entry)) seen.add(entry);
  }
  // Stable-sort by the canonical AGENT_GRANTABLE_SCOPES order so DB writes
  // produce identical JSON for identical sets — simplifies diffing in audit
  // logs and ws scope-update events.
  return AGENT_GRANTABLE_SCOPES.filter((s) => seen.has(s));
}

// ── UI grouping (resource → grantable scopes in that resource) ─────────────
//
// The agent profile renders scopes grouped by resource with one toggle per
// verb. Keeping the grouping table in shared so UI + docs + a future
// scope-listing CLI can all reuse it.

export interface AgentScopeGroup {
  resource: AgentScopeResource;
  section: "cli" | "notifications";
  /** Display label for the resource group (e.g. "Messages"). */
  label: string;
  /** Short description shown next to the group header. */
  description: string;
  scopes: readonly AgentScopeRow[];
}

export interface AgentScopeRow {
  scope: AgentGrantableScope;
  /** Verb shown next to the toggle (e.g. "Read", "Send"). */
  verbLabel: string;
  /** One-sentence description of what the scope allows; copied straight
   *  into the agent profile UI tooltip. Phrased as agent-side capability,
   *  not human-side authorization. */
  description: string;
}

export const AGENT_SCOPE_GROUPS: readonly AgentScopeGroup[] = [
  {
    resource: "inbox",
    section: "notifications",
    label: "Inbox",
    description: "Control whether new activity can be delivered to this agent and wake it up.",
    scopes: [
      {
        scope: "inbox:receive",
        verbLabel: "Receive notifications",
        description: "Receive new inbox events and wake for activity from other people and agents.",
      },
    ],
  },
  {
    resource: "server",
    section: "cli",
    label: "Server",
    description: "Discover channels, members, and other agents in this server, and edit the server profile when server role allows it.",
    scopes: [
      {
        scope: "server:read",
        verbLabel: "Read",
        description: "List channels, members, and agents (slock server info).",
      },
      {
        scope: "server:update",
        verbLabel: "Edit profile",
        description: "Edit server profile fields or avatar when this agent's server role has server management authority (slock server update).",
      },
    ],
  },
  {
    resource: "channel",
    section: "cli",
    label: "Channels",
    description: "View channel rosters, create channels and add members when server role allows it, join visible public channels, and leave channels the agent is no longer using.",
    scopes: [
      {
        scope: "channel:read",
        verbLabel: "Read members",
        description: "View members of channels the agent has joined (slock channel members).",
      },
      {
        scope: "channel:create",
        verbLabel: "Create",
        description: "Create public or private channels when this agent's server role has channel management authority (slock channel create).",
      },
      {
        scope: "channel:update",
        verbLabel: "Edit",
        description: "Edit public/private channel name, description, or visibility when this agent's server role has channel management authority (slock channel update).",
      },
      {
        scope: "channel:add_member",
        verbLabel: "Add members",
        description: "Add humans or agents to public/private channels when this agent's server role has channel management authority (slock channel add-member).",
      },
      {
        scope: "channel:remove_member",
        verbLabel: "Remove members",
        description: "Remove humans or agents from public/private channels when this agent's server role has channel management authority (slock channel remove-member).",
      },
      {
        scope: "channel:join",
        verbLabel: "Join",
        description: "Join visible public channels (slock channel join).",
      },
      {
        scope: "channel:leave",
        verbLabel: "Leave",
        description: "Leave a channel the agent has joined (slock channel leave).",
      },
    ],
  },
  {
    resource: "thread",
    section: "cli",
    label: "Threads",
    description: "Manage which threads the agent is following inside its channels.",
    scopes: [
      {
        scope: "thread:unfollow",
        verbLabel: "Unfollow",
        description: "Stop receiving deliveries from a thread (slock thread unfollow).",
      },
    ],
  },
  {
    resource: "message",
    section: "cli",
    label: "Messages",
    description: "Read and send messages in channels, DMs, and threads the agent has access to.",
    scopes: [
      {
        scope: "message:read",
        verbLabel: "Read",
        description: "Check, read, search, and resolve messages (slock message check / read / search / resolve).",
      },
      {
        scope: "message:send",
        verbLabel: "Send",
        description: "Send messages to channels, DMs, and threads (slock message send).",
      },
    ],
  },
  {
    resource: "attachment",
    section: "cli",
    label: "Attachments",
    description: "Upload and view file attachments alongside messages.",
    scopes: [
      {
        scope: "attachment:upload",
        verbLabel: "Upload",
        description: "Upload files to attach to messages (slock attachment upload).",
      },
      {
        scope: "attachment:view",
        verbLabel: "View",
        description: "Download and inspect attachments (slock attachment view).",
      },
    ],
  },
  {
    resource: "task",
    section: "cli",
    label: "Tasks",
    description: "Read the task board and create / claim / progress tasks.",
    scopes: [
      {
        scope: "task:read",
        verbLabel: "Read",
        description: "List tasks on a channel's board (slock task list).",
      },
      {
        scope: "task:write",
        verbLabel: "Write",
        description: "Create, claim, unclaim, and update tasks (slock task create / claim / unclaim / update).",
      },
    ],
  },
  {
    resource: "knowledge",
    section: "cli",
    label: "Slock Manual",
    description: "Read Slock Manual for Agents topics through the authenticated Slock knowledge endpoint.",
    scopes: [
      {
        scope: "knowledge:read",
        verbLabel: "Read",
        description: "Fetch Slock Manual for Agents topics (slock manual get).",
      },
    ],
  },
  {
    resource: "action",
    section: "cli",
    label: "Action cards",
    description:
      "Allow the agent to prepare quick-commit cards for you. Commit authority always stays with the human — the agent never executes the action itself.",
    scopes: [
      {
        scope: "action:prepare",
        verbLabel: "Prepare",
        description:
          "Allow this agent to prepare quick-commit action cards (channel / agent / member additions) for you to click and commit.",
      },
    ],
  },
] as const;

// Static check: every grantable scope appears in exactly one group row.
type _AssertEveryScopeGrouped = AgentGrantableScope extends
  (typeof AGENT_SCOPE_GROUPS)[number]["scopes"][number]["scope"]
  ? true
  : never;
const _everyScopeGroupedOk: _AssertEveryScopeGrouped = true;
void _everyScopeGroupedOk;

// ── Deny reason enum (Stone OTLP span attribute, #proj-permission:10bdc2c9) ─
//
// Server-side middleware sets `req.scopeDenyReason` so the OTLP `permission.denied`
// span and the prom counter `slock_agent_permission_denied_total` can both
// emit a low-cardinality attribute. Keep the enum tight; new values land
// here, never as ad-hoc strings in middleware.

export const AGENT_SCOPE_DENY_REASONS = [
  // Required scope is grantable and was not in the agent's scope set.
  "missing_scope",
  // Caller is an agent but the scope being checked is intrinsic-only and
  // got into a check path it shouldn't have (defense-in-depth — should not
  // happen in practice, surfaces config bugs).
  "intrinsic_scope_misrouted",
  // Resource exists but the agent is not a member / not the owner — e.g.
  // sending to a channel the agent hasn't joined. Distinct from
  // missing_scope so observability can tell scope policy issues from
  // membership issues.
  "not_a_member",
  // Self-only invariant violation: scope grants self-action but the request
  // targets another principal's resource (e.g. another agent's reminder).
  "self_only_violation",
  // The agent_scopes row exists but failed to load (DB error / cache miss
  // with no fallback). Emitted to surface infra problems, never used in
  // happy paths.
  "scope_lookup_failed",
] as const;
export type AgentScopeDenyReason = (typeof AGENT_SCOPE_DENY_REASONS)[number];

export interface AgentScopeDeniedEvent {
  agentId: string;
  /** Scope literal that was checked (e.g. `"task:write"`). */
  requiredScope: AgentScope;
  /** A short surface tag — typically the route pattern (e.g.
   *  `"POST /internal/agent/:id/tasks"`). Low-cardinality, OTLP / prom safe. */
  surface: string;
  reason: AgentScopeDenyReason;
}

// ── Scope set wire shape ────────────────────────────────────────────────────
//
// Returned by `GET /internal/agent/:id/scopes` (daemon fetch on connect) and
// pushed via `agent:scope-updated` ws event when an admin edits the grant.
// Single-row-per-agent JSON (per agent_scopes.scopes column) makes whole-set
// updates atomic and the cache invalidation event payload trivial.

export interface AgentScopeSet {
  agentId: string;
  /** Granted grantable scopes only — intrinsics are inferred by the server,
   *  not stored. Empty array means "no grantable scopes" (the agent is
   *  effectively read-quiet). */
  granted: AgentGrantableScope[];
  /** `default` means the agent follows the current system default profile:
   *  newly-added default capabilities are automatically enabled. `custom`
   *  means a human has saved a custom set; newly-added capabilities are off
   *  until explicitly enabled. */
  mode: AgentScopeProfileMode;
  /** Server-stamped revision token; changes on every write. Daemons compare
   *  to short-circuit redundant cache invalidations on reconnect. */
  revision: number;
  /** ISO timestamp of last edit; for audit / display only. */
  updatedAt: string;
}

// Whether a given scope is currently granted on a scope set. Wraps the
// allow-list check + the intrinsic short-circuit so server middleware and
// the raft CLI wrapper share a single decision function.
export function hasScope(set: AgentScopeSet | null | undefined, scope: AgentScope): boolean {
  if (isIntrinsicScope(scope)) return true;
  if (!set) return false;
  return set.granted.includes(scope);
}
