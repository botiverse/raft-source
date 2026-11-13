/**
 * task #1357 item 1: the model limits a Built-in custom gateway model was
 * registered with in a Pi session, as the daemon that built the session saw
 * them. Each field names its own source: `catalog` (a matching entry of the
 * Pi SDK's model catalog had the value, or a `modelOverrides` entry in the
 * agent's own `.builtin-runtime/models.json` set it), `raft_default` (Raft filled the
 * value in), or `agent_config` / `gateway` (see MODEL_LIMIT_SOURCES). The two fields can come from different sources; nothing here
 * says why a field has the source it has.
 *
 * Precedence, per field: a models.json `modelOverrides` value (Pi applies
 * it last, over what Raft registers; reported as `catalog`), then
 * `agent_config`, then `gateway`, then a matching catalog entry (`catalog`),
 * then `raft_default`. The source set stays these four: a server older than
 * a new source drops the whole frame.
 *
 * Producer: the daemon, once for every Pi session it creates or rebuilds
 * (`agent:model_limits`), with the config revision the session was built
 * from. It keeps the last frame of each live session and sends that same
 * frame again after a reconnect. It never restarts anything to get one.
 *
 * Consumer: the server stores the newest frame per agent and derives
 * `AgentModelLimitsStatus` for the agent detail; the web renders only that.
 */

/**
 * A daemon declaring this in `ready` sends `agent:model_limits` for every Pi
 * session it creates or rebuilds for a Built-in custom gateway model, and
 * sends each live session's last frame again after a reconnect. Without it
 * the server shows the limits as pending (`unsupported_computer`).
 */
export const DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1 = "agent:model-limits-report-v1";

/**
 * `agent_config`: the agent's own declared limit (#proj-runtime:#50), which
 * wins over the gateway's list and a catalog entry but not over a
 * `modelOverrides` value in the agent's models.json (that field then reports
 * `catalog`); never a default, so it never raises the warning.
 * A server older than it drops the whole frame as malformed: the warning is
 * then not shown, which is the safe direction.
 */
/*
 * `gateway`: the value the gateway's own model list reported (#proj-runtime:#53,
 * public contract docs.raft.build/developers/gateway-model-limits); below
 * `agent_config`, above `catalog`, never a default, so it never raises the
 * warning. A server older than it drops the whole frame as malformed, like
 * `agent_config` above: the warning is then not shown.
 */
export const MODEL_LIMIT_SOURCES = ["catalog", "raft_default", "agent_config", "gateway"] as const;
export type ModelLimitSource = typeof MODEL_LIMIT_SOURCES[number];

export interface ModelLimitValue {
  value: number;
  source: ModelLimitSource;
}

/** The values registered for the model, field by field. */
export interface ModelLimits {
  contextWindow: ModelLimitValue;
  maxTokens: ModelLimitValue;
}

/** daemon -> server. Servers without a handler drop the type. */
export interface AgentModelLimitsFrame {
  type: "agent:model_limits";
  v: 1;
  agentId: string;
  /** The launch the session's process carries when the frame is sent. */
  launchId?: string;
  /** The Pi session the limits were registered in. */
  sessionId: string;
  /** `agents.config_revision` of the config the session was built from (`agent:start` `configRevision` or `agent:config` `revision`). */
  configRevision: number;
  /** The sending daemon process's generation (the `ready` `daemonInstanceId`); the server takes frames only from the machine's current one. */
  daemonInstanceId: string;
  /** Per daemon process, grows with every session the daemon builds; orders frames within one daemon instance and revision. */
  seq: number;
  /** When the daemon registered the model (ms since epoch, daemon clock). Display and diagnostics only, never ordering. */
  observedAtMs: number;
  runtime: string;
  modelLimits: ModelLimits;
}

function parseModelLimitValue(value: unknown): ModelLimitValue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = record.value;
  const source = record.source;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return null;
  if (typeof source !== "string" || !(MODEL_LIMIT_SOURCES as readonly string[]).includes(source)) return null;
  return { value: raw, source: source as ModelLimitSource };
}

/** The limits of an untrusted wire or database value, or null when malformed. */
export function parseModelLimits(value: unknown): ModelLimits | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const contextWindow = parseModelLimitValue(record.contextWindow);
  const maxTokens = parseModelLimitValue(record.maxTokens);
  if (!contextWindow || !maxTokens) return null;
  return { contextWindow, maxTokens };
}

/** Whether at least one value is a Raft default. */
export function modelLimitsHaveDefaultValues(limits: ModelLimits): boolean {
  return limits.contextWindow.source === "raft_default" || limits.maxTokens.source === "raft_default";
}
