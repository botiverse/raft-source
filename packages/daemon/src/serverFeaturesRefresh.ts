import { randomUUID } from "node:crypto";
import {
  AGENT_SERVER_FEATURE_KEYS,
  clearClockTimeout,
  currentRandomUnit,
  currentTimeMs,
  FIRST_PARTY_APP_GUIDE_ENTRIES,
  normalizeAgentServerFeatures,
  setClockTimeout,
  type AgentServerFeatureKey,
  type AgentServerFeatures,
  type FirstPartyAppGuideEntry,
  type ServerFeaturesMessage,
} from "@botiverse/raft-shared";
import { axSurface } from "./agentRuntimeInput";

/**
 * Picking up a Server's feature flag changes in running agents (task
 * #proj-workspace:#30; contract in shared `featuresChanged.ts`).
 *
 * The flag-derived `AgentConfig` fields (`AGENT_SERVER_FEATURE_KEYS`) are
 * computed by the Server at `agent:start`. When the Server says a flag may have
 * changed (`server:features-changed`), and once after every (re)connect
 * (changes are not replayed), the daemon asks for the current values over the
 * machine WebSocket (`server:features:request` → `server:features`), never
 * through the agent API: the daemon host must not call `/internal/agent-api/*`
 * with an agent credential. The answer goes to both agent hosts
 * (`applyServerFeatures`, through the host router): every agent's config is
 * updated, a running agent whose session drifted from it is stopped once it is
 * idle (`serverFeaturesDrift`, reconciler step 6; one kind of runtime spec
 * drift since step 7, runtimeSpec.ts) so its next wake starts on the new
 * prompt, and on the legacy host that next start tells it what
 * changed (`formatServerFeaturesNotice`).
 */

/** A request goes out a uniform random 0..30 s after the trigger, so one flag change does not make every Computer ask at once. */
export const SERVER_FEATURES_REFRESH_MAX_DELAY_MS = 30_000;

export interface ServerFeaturesRefreshOptions {
  /** Sends `server:features:request` with this id. */
  send(requestId: string): void;
  now?: () => number;
  /** In [0, 1); picks the delay. */
  random?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  newRequestId?: () => string;
  maxDelayMs?: number;
}

/**
 * Coalesces triggers into one delayed request and accepts only the answer to
 * the latest one. Per connection: `reset()` on disconnect.
 */
export class ServerFeaturesRefresh {
  private timer: unknown = null;
  private outstanding: { requestId: string; sentAtMs: number } | null = null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly newRequestId: () => string;
  private readonly maxDelayMs: number;

  constructor(private readonly options: ServerFeaturesRefreshOptions) {
    this.now = options.now ?? currentTimeMs;
    this.random = options.random ?? currentRandomUnit;
    this.setTimer = options.setTimeout ?? ((callback, ms) => {
      // Never keeps the daemon process alive on its own.
      const handle = setClockTimeout(callback, ms) as { unref?: () => void };
      handle.unref?.();
      return handle;
    });
    this.clearTimer = options.clearTimeout ?? clearClockTimeout;
    this.newRequestId = options.newRequestId ?? randomUUID;
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? SERVER_FEATURES_REFRESH_MAX_DELAY_MS);
  }

  /**
   * Ask for the current values after a random delay. While a delay is running
   * further calls join it. A call after a request went out starts a new delay:
   * the newer request then supersedes the older one, whose answer is ignored.
   */
  schedule(): void {
    if (this.timer !== null) return;
    const delayMs = Math.min(this.maxDelayMs, Math.max(0, Math.floor(this.random() * this.maxDelayMs)));
    this.timer = this.setTimer(() => this.fire(), delayMs);
  }

  private fire(): void {
    this.timer = null;
    const requestId = this.newRequestId();
    this.outstanding = { requestId, sentAtMs: this.now() };
    this.options.send(requestId);
  }

  /** The request waiting for an answer, if any (for logs and traces). */
  get outstandingRequest(): { readonly requestId: string; readonly sentAtMs: number } | null {
    return this.outstanding;
  }

  /**
   * The features of `msg` when it answers the latest outstanding request and
   * names the connection's own Server; otherwise null (the caller logs it) and
   * the request stays outstanding.
   */
  acceptReply(msg: ServerFeaturesMessage, connectionServerId: string | null): AgentServerFeatures | null {
    if (!this.outstanding || msg.requestId !== this.outstanding.requestId) return null;
    if (!connectionServerId || msg.serverId !== connectionServerId) return null;
    const features = readAgentServerFeatures(msg.features);
    if (!features) return null;
    this.outstanding = null;
    return features;
  }

  /** Disconnect (or shutdown): no delay running, no request outstanding. */
  reset(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.outstanding = null;
  }
}

/**
 * The known server features of a wire value, each in its expected shape: a
 * boolean only when `true`, `inboxItemsLaunchAt` only as a string beside
 * `inboxItems: true`, `enabledApps` only as an array of strings. Null when the
 * value is not an object. Unknown fields are dropped.
 */
export function readAgentServerFeatures(value: unknown): AgentServerFeatures | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const features: AgentServerFeatures = {};
  for (const key of AGENT_SERVER_FEATURE_KEYS) {
    if (key === "enabledApps" || key === "inboxItemsLaunchAt") continue;
    if (raw[key] === true) features[key] = true;
  }
  if (features.inboxItems === true && typeof raw.inboxItemsLaunchAt === "string") features.inboxItemsLaunchAt = raw.inboxItemsLaunchAt;
  if (Array.isArray(raw.enabledApps)) {
    features.enabledApps = raw.enabledApps.filter((appId): appId is string => typeof appId === "string");
  }
  return features;
}

/** The feature keys whose normalized values differ (for traces). */
export function changedAgentServerFeatureKeys(before: AgentServerFeatures, after: AgentServerFeatures): AgentServerFeatureKey[] {
  const left = normalizeAgentServerFeatures(before);
  const right = normalizeAgentServerFeatures(after);
  return AGENT_SERVER_FEATURE_KEYS.filter((key) => key === "enabledApps"
    ? left.enabledApps.join("\n") !== right.enabledApps.join("\n")
    : left[key] !== right[key]);
}

/**
 * What a runtime makes of the server features (the restart decision):
 * `supportsSubagents` from the driver (RuntimeDriver.supportsSubagents: it
 * renders the sub-agent section), `rotatesSessions` from the running session
 * (RuntimeSession.rotateSessionIfDue: pi, Built-in).
 */
export interface ServerFeaturesRuntimeFacts {
  supportsSubagents: boolean;
  rotatesSessions: boolean;
}

/**
 * Whether a running session must be restarted to pick up `changedKeys`
 * (against what it started with). `subagentDelegation` changes only the
 * prompt of a runtime that can start sub-agents, `piSessionRotation` only a
 * session that rotates; every other key changes the standing prompt
 * (`enabledApps`, `taskConversations`, `reminderApp`, `vaultApp`) or what the
 * spawn publishes to the CLI (`passiveAx`) for every runtime; `agentContextView`
 * changes only what the daemon keeps and answers, never the session, and
 * `wakeRecycleOar` only what the OAR host decides when the session is idle
 * and at the next start, `wakeRecycleTierGate` likewise for both hosts, and
 * `turnEndCompaction` and `wakeRecycleWarm` only what a turn end (and, for
 * the second, the next start) decides. A key that does not need a restart
 * still updates the config the next spawn reads.
 */
export function serverFeatureChangeNeedsRestart(
  changedKeys: readonly AgentServerFeatureKey[],
  runtime: ServerFeaturesRuntimeFacts,
): boolean {
  return changedKeys.some((key) => {
    if (key === "subagentDelegation") return runtime.supportsSubagents;
    if (key === "piSessionRotation") return runtime.rotatesSessions;
    // View Context state lives in the daemon (index, captured requests), not in the prompt or the spawn.
    if (key === "agentContextView") return false;
    // Read by the OAR host's cold-idle check and at the next start's recycle decision, never by a running session.
    if (key === "wakeRecycleOar") return false;
    // Read by the cold-idle checks and the next start's recycle decision (both hosts), never by a running session.
    if (key === "wakeRecycleTierGate") return false;
    // Read at each turn end by both hosts, never baked into a running session.
    if (key === "turnEndCompaction") return false;
    // Read at each turn end and at the next start's recycle decision (both hosts), never by a running session.
    if (key === "wakeRecycleWarm") return false;
    return true;
  });
}

/**
 * Reconciler step 6: the keys a running session has drifted on, read on
 * demand (nothing stores a pending restart): what it started with against
 * what it should run with now, empty unless the change needs a restart
 * (serverFeatureChangeNeedsRestart). A change undone before the session was
 * restarted is no drift.
 */
export function serverFeaturesDrift(
  startedWith: AgentServerFeatures,
  desired: AgentServerFeatures,
  runtime: ServerFeaturesRuntimeFacts,
): AgentServerFeatureKey[] {
  const changed = changedAgentServerFeatureKeys(startedWith, desired);
  return serverFeatureChangeNeedsRestart(changed, runtime) ? changed : [];
}

/** What the notice needs to know about the runtime it goes to. */
export interface ServerFeaturesNoticeRuntime {
  /** The driver renders the sub-agent section (RuntimeDriver.supportsSubagents). */
  supportsSubagents: boolean;
}

/**
 * The boolean features an agent is told about, with the phrase for each
 * direction; `appliesTo` leaves out a runtime whose prompt the key does not
 * change. Every key that restarts an agent's process for its prompt is named
 * here, so such a restart never goes unexplained. `passiveAx` and
 * `piSessionRotation` change how the daemon runs the agent, not its
 * instructions, and are not named.
 */
const NAMED_BOOLEAN_FEATURES: readonly {
  key: AgentServerFeatureKey;
  on: string;
  off: string;
  appliesTo?: (runtime: ServerFeaturesNoticeRuntime) => boolean;
}[] = [
  // Per-task mode (server taskConversationsGate.ts): the flag decides how new
  // tasks are made; a task that has its conversation keeps it either way.
  {
    key: "taskConversations",
    on: "Task conversations turned on (a task has its own conversation: `raft task reply`)",
    off: "Task conversations turned off for new tasks (a task that already has a conversation keeps it)",
  },
  // `raft reminder schedule` is what stops working: the Reminder app is reached
  // through `raft integration invoke`, not through `raft reminder`.
  {
    key: "reminderApp",
    on: "reminders moved to the Reminder app (`raft reminder schedule`, `update` and `snooze` are refused here now)",
    off: "new reminders use `raft reminder schedule` again (the ones made in the Reminder app stay there)",
  },
  // The Vault line of "Credential handling" (shared raftCliGuide.ts): only the
  // instructions change; the app itself may or may not be installed.
  {
    key: "vaultApp",
    on: "your instructions now cover asking for credentials through the Vault app",
    off: "your instructions no longer cover the Vault app",
  },
  // The "Working through sub-agents" section (drivers/systemPrompt.ts), which
  // only a runtime that can start sub-agents renders.
  {
    key: "subagentDelegation",
    on: "your instructions now cover working through sub-agents",
    off: "your instructions no longer cover working through sub-agents",
    appliesTo: (runtime) => runtime.supportsSubagents,
  },
];

/**
 * What changed between the features a session last ran with (`before`) and
 * the ones it starts with now (`after`), as the notice's phrases: first-party
 * apps first (in `table` order; an app without a `name` is not named), then
 * the named booleans that change this runtime's prompt. Empty when nothing an
 * agent would notice changed.
 */
export function describeAgentServerFeatureChanges(
  before: AgentServerFeatures,
  after: AgentServerFeatures,
  options: { runtime?: ServerFeaturesNoticeRuntime; table?: readonly FirstPartyAppGuideEntry[] } = {},
): string[] {
  const runtime = options.runtime ?? { supportsSubagents: false };
  const left = normalizeAgentServerFeatures(before);
  const right = normalizeAgentServerFeatures(after);
  const phrases: string[] = [];
  for (const entry of options.table ?? FIRST_PARTY_APP_GUIDE_ENTRIES) {
    if (!entry.name) continue;
    const wasOn = left.enabledApps.includes(entry.appId);
    const isOn = right.enabledApps.includes(entry.appId);
    if (!wasOn && isOn) phrases.push(entry.command ? `${entry.name} turned on (\`${entry.command}\`)` : `${entry.name} turned on`);
    if (wasOn && !isOn) phrases.push(entry.command ? `${entry.name} turned off (\`${entry.command}\` no longer works here)` : `${entry.name} turned off`);
  }
  for (const feature of NAMED_BOOLEAN_FEATURES) {
    if (feature.appliesTo && !feature.appliesTo(runtime)) continue;
    const wasOn = left[feature.key] === true;
    const isOn = right[feature.key] === true;
    if (wasOn !== isOn) phrases.push(isOn ? feature.on : feature.off);
  }
  return phrases;
}

export const formatServerFeaturesNotice = axSurface(
  "Notice in an agent's first input, right before its wake or catch-up content, after the server's feature flags changed what it can use or its instructions since its session last ran (server:features); null when nothing that runtime's agent would notice changed.",
  (before: AgentServerFeatures, after: AgentServerFeatures, runtime: ServerFeaturesNoticeRuntime = { supportsSubagents: false }): string | null => {
    const phrases = describeAgentServerFeatureChanges(before, after, { runtime });
    if (phrases.length === 0) return null;
    return `Raft notice: this server's features changed: ${phrases.join("; ")}. Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.\n\n`;
  },
  {
    examples: [
      { title: "an app on, a feature off", args: [{ taskConversations: true, enabledApps: [] }, { enabledApps: ["artifacts"] }] },
      { title: "an app off", args: [{ enabledApps: ["artifacts"] }, { enabledApps: [] }] },
      { title: "instructions only, on a runtime with sub-agents", args: [{ enabledApps: [] }, { vaultApp: true, subagentDelegation: true, enabledApps: [] }, { supportsSubagents: true }] },
      { title: "nothing an agent would notice", args: [{ passiveAx: true, enabledApps: [] }, { enabledApps: [] }] },
    ],
  },
);
