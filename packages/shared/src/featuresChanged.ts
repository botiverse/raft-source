/**
 * "Your server's feature flags may have changed": the Server's realtime notice
 * that a flag definition, rule, audience, Lab or Lab enrollment changed in a
 * way that may change what a connected client or Computer evaluated for one
 * Server. It is a refetch signal, not a value: it carries no flag values.
 *
 * Who sends it (packages/server/src/services/featureFlagChangeNotifier.ts):
 * - Feature Flag Admin writes straight to Postgres and bumps the global
 *   `feature_flag_config_versions` cursor in the same transaction. Every Server
 *   replica polls that cursor, diffs the flag configuration, and notifies only
 *   its own connections. A burst of edits is coalesced (2 s quiet, 10 s at most).
 * - A Server Labs change (master access or one Lab's enrollment) notifies that
 *   one Server on every replica.
 *
 * Only connections that may be affected get it: a server-allowlist edit reaches
 * only the listed Servers, a user-rule edit only those users' connections, a
 * percentage change only the units whose bucket crossed; anything else (kill
 * switch, default, plan, lab, platform rules, ...) reaches every connection.
 * Over-notifying is allowed, missing a change is not.
 *
 * Not replayed: a connection that was down when the change happened gets
 * nothing. Clients should also refetch after a socket reconnect.
 */
import type { AgentConfig } from "./index";

/**
 * Server → web/desktop/mobile socket event, sent to each affected socket that
 * is attached to a Server (`socket.data.serverId`). A socket only ever receives
 * its own Server's id.
 *
 * Client contract: refetch that Server's flags (for the web,
 * `POST /api/feature-flags/evaluate` for the keys it uses). `keys` is a hint:
 * the flags whose configuration changed. A client may refetch everything; it
 * must not treat a key missing from `keys` as unchanged across events.
 */
export const SERVER_FEATURES_CHANGED_SOCKET_EVENT = "server:features-changed";

export type ServerFeaturesChangedEvent = {
  serverId: string;
  /** Hint: flag keys whose configuration changed. Never empty when sent. */
  keys: string[];
};

/**
 * Server → Computer (daemon) message on the machine WebSocket, sent to each
 * affected machine connection of the Server (`machine:context.serverId`).
 * Additive: older daemons ignore unknown message types.
 *
 * Daemon contract: flags the Server evaluates for a Server's agents (the
 * `AgentConfig` fields in `AGENT_SERVER_FEATURE_KEYS`) are computed at
 * `agent:start`; this message does not carry them. A daemon that wants to
 * apply a change without waiting for the next start asks for the current
 * values with `server:features:request` (only on a connection whose
 * `machine:context` advertises `SERVER_CAPABILITY_SERVER_FEATURES_V1`). It
 * never re-reads them through the agent API: the daemon host must not call
 * `/internal/agent-api/*` with an agent credential (`AgentConfig.agentCredentialKey`).
 * It must stay cheap and idempotent: the same change may arrive more than once,
 * and a Computer may get it for a change that does not affect its agents.
 * Agent-side evaluations use the Server id only, so user- and platform-scoped
 * rule changes are not sent here.
 */
export type ServerFeaturesChangedMachineMessage = {
  type: typeof SERVER_FEATURES_CHANGED_SOCKET_EVENT;
  serverId: string;
  /** Hint: flag keys whose configuration changed. Never empty when sent. */
  keys: string[];
};

/**
 * The `AgentConfig` fields the Server evaluates per Server id, the same for
 * every agent of that Server, and sets on every `agent:start` (agentOrchestrator
 * `agentServerFeatures`). `server:features` carries exactly these.
 *
 * Not included: `runtimeHost` (RFC 060 OAR) also depends on the machine's
 * capability and the agent's runtime; `runtimeProfileControl` is per agent;
 * `installedApps` is the installed-app catalog, not a flag. Those still change
 * only at the next start.
 *
 * Every key is a boolean present only when true, except `enabledApps` (a list)
 * and `inboxItemsLaunchAt` (an ISO 8601 string, present only beside
 * `inboxItems: true`; a reader drops it otherwise).
 */
export const AGENT_SERVER_FEATURE_KEYS = [
  "subagentDelegation",
  "agentContextView",
  "passiveAx",
  "reminderApp",
  "vaultApp",
  "piSessionRotation",
  "wakeRecycleOar",
  "wakeRecycleTierGate",
  "turnEndCompaction",
  "wakeRecycleWarm",
  "taskConversations",
  "inboxItems",
  "inboxItemsLaunchAt",
  "enabledApps",
] as const;

export type AgentServerFeatureKey = (typeof AGENT_SERVER_FEATURE_KEYS)[number];

/** A Server's flag-derived agent config fields (see `AGENT_SERVER_FEATURE_KEYS`). */
export type AgentServerFeatures = Pick<AgentConfig, AgentServerFeatureKey>;

type AgentServerFeatureBooleanKey = Exclude<AgentServerFeatureKey, "enabledApps" | "inboxItemsLaunchAt">;

const AGENT_SERVER_FEATURE_BOOLEAN_KEYS: readonly AgentServerFeatureBooleanKey[] = AGENT_SERVER_FEATURE_KEYS.filter(
  (key): key is AgentServerFeatureBooleanKey => key !== "enabledApps" && key !== "inboxItemsLaunchAt",
);

/** `inboxItemsLaunchAt` as the contract allows it: a string, and only beside `inboxItems: true`. */
function inboxItemsLaunchAtOf(features: Pick<AgentConfig, "inboxItems" | "inboxItemsLaunchAt">): string | undefined {
  return features.inboxItems === true && typeof features.inboxItemsLaunchAt === "string" ? features.inboxItemsLaunchAt : undefined;
}

/**
 * The server features `config` carries, shaped as `agent:start` sets them: a
 * boolean only when true, `inboxItemsLaunchAt` only beside `inboxItems`,
 * `enabledApps` as given (absent stays absent).
 */
export function pickAgentServerFeatures(config: AgentConfig): AgentServerFeatures {
  const features: AgentServerFeatures = {};
  for (const key of AGENT_SERVER_FEATURE_BOOLEAN_KEYS) {
    if (config[key] === true) features[key] = true;
  }
  const launchAt = inboxItemsLaunchAtOf(config);
  if (launchAt !== undefined) features.inboxItemsLaunchAt = launchAt;
  if (Array.isArray(config.enabledApps)) features.enabledApps = [...config.enabledApps];
  return features;
}

/**
 * The comparable form: each boolean `true` or absent (false and absent read
 * the same, as every reader treats them), `inboxItemsLaunchAt` only beside
 * `inboxItems`, `enabledApps` sorted and de-duplicated (absent reads as none
 * on, as the prompt renders it).
 */
export function normalizeAgentServerFeatures(features: AgentServerFeatures): AgentServerFeatures & { enabledApps: string[] } {
  const normalized: AgentServerFeatures = {};
  for (const key of AGENT_SERVER_FEATURE_BOOLEAN_KEYS) {
    if (features[key] === true) normalized[key] = true;
  }
  const launchAt = inboxItemsLaunchAtOf(features);
  if (launchAt !== undefined) normalized.inboxItemsLaunchAt = launchAt;
  return { ...normalized, enabledApps: [...new Set(features.enabledApps ?? [])].sort() };
}

/** Whether `a` and `b` turn the same things on; order and duplicates in `enabledApps` never count. */
export function agentServerFeaturesEqual(a: AgentServerFeatures, b: AgentServerFeatures): boolean {
  const left = normalizeAgentServerFeatures(a);
  const right = normalizeAgentServerFeatures(b);
  return AGENT_SERVER_FEATURE_BOOLEAN_KEYS.every((key) => left[key] === right[key])
    && left.inboxItemsLaunchAt === right.inboxItemsLaunchAt
    && left.enabledApps.length === right.enabledApps.length
    && left.enabledApps.every((appId, index) => right.enabledApps[index] === appId);
}

/**
 * A copy of `config` with every `AGENT_SERVER_FEATURE_KEYS` field taken from
 * `features` (a boolean that is not true is removed, and so is
 * `inboxItemsLaunchAt` without `inboxItems`; `enabledApps` absent becomes
 * `[]`); every other field is left as it is.
 */
export function withAgentServerFeatures(config: AgentConfig, features: AgentServerFeatures): AgentConfig {
  const next: AgentConfig = { ...config };
  for (const key of AGENT_SERVER_FEATURE_BOOLEAN_KEYS) {
    if (features[key] === true) next[key] = true;
    else delete next[key];
  }
  const launchAt = inboxItemsLaunchAtOf(features);
  if (launchAt !== undefined) next.inboxItemsLaunchAt = launchAt;
  else delete next.inboxItemsLaunchAt;
  next.enabledApps = [...(features.enabledApps ?? [])];
  return next;
}

/**
 * Computer (daemon) → Server on the machine WebSocket: "send me my Server's
 * current server features". Sent only to a Server whose `machine:context`
 * advertised `SERVER_CAPABILITY_SERVER_FEATURES_V1`, after a
 * `server:features-changed` for the connection's Server and once per
 * (re)connect (changes are not replayed), each with a random delay so a
 * change does not make every Computer ask at once. `requestId` is the
 * daemon's own id for this request; the answer echoes it.
 */
export type ServerFeaturesRequestMessage = {
  type: "server:features:request";
  requestId: string;
};

/**
 * Server → Computer (daemon): the answer to `server:features:request`, the
 * same values an `agent:start` sent now would carry. `serverId` is the Server
 * of the machine connection the request came on. A daemon drops (and logs) a
 * reply whose `serverId` is not its connection's Server, or whose `requestId`
 * is not its latest outstanding request. A Server that cannot evaluate the
 * flags sends nothing; the daemon then keeps the values it has.
 */
export type ServerFeaturesMessage = {
  type: "server:features";
  requestId: string;
  serverId: string;
  features: AgentServerFeatures;
};
