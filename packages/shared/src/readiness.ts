// Agent readiness (#proj-raft-computer:#68): can this agent work right now,
// and if not, where is it stuck, who is affected, and who fixes it.
//
// Model (Tenny, KISS):
// - Facts only: one latest fact per resource, from whoever saw it, with its
//   behaviour (blocked / waiting / advisory) and when.
// - Resources form one dependency chain: server → Computer → runtime → login
//   (credential key) → login window (a usage window some models draw from)
//   → model → agent. An agent depends on every link of its
//   chain; a fact on a link affects every agent whose chain has that link.
// - One pure function (`composeReadiness`) walks a chain: the first broken
//   link is the answer, and that resource's owner acts. Daemon, server and web
//   call the same function. Per-viewer trimming happens outside it, on the
//   server (`trimReadinessForViewer`).
// - Whoever sees a fact enforces it; everyone else only displays it. A login
//   block is enforced by the daemon alone (it does not deliver to a held
//   agent); the server does not stop waking agents for a daemon-reported fact.
//
// Codes are a contract (Tenny, 973ccfea #5): code + params cross the wire,
// clients render copy for the code (`readiness.<code>`). A reader that does
// not know a code keeps the fact and acts on its carried behaviour, showing
// the generic sentence. Each new code later is one more entry here.

/**
 * Server capability (on `machine:context.capabilities`): the server reads
 * `machine:runtime_readiness`. Only then does the daemon send it; an older
 * server keeps getting the agent's runtime error alone (a verification hold
 * as `AuthError` + `user_reauth`, so it still pauses and tells the owner).
 */
export const SERVER_CAPABILITY_RUNTIME_READINESS_V1 = "machine:runtime-readiness-v1";

/** blocked: someone must act (messages are kept); waiting: clears by itself; advisory: can run. */
export const READINESS_BEHAVIOURS = ["blocked", "waiting", "advisory"] as const;
export type ReadinessBehaviour = (typeof READINESS_BEHAVIOURS)[number];

/** The dependency chain, outermost first. */
export const READINESS_CHAIN = ["server", "computer", "runtime", "login", "login_window", "model", "agent"] as const;
export type ReadinessResourceKind = (typeof READINESS_CHAIN)[number];

/**
 * What a fact is about. `login.key` is the credential key: `shared:<runtime>`
 * (the Computer's machine login, every agent on it depends on it) or
 * `agent:<id>` (that agent's own credential). A fact is always about one
 * Computer's resources, except `server`.
 */
export type ReadinessResource =
  | { kind: "server" }
  | { kind: "computer" }
  | { kind: "runtime"; runtime: string }
  | { kind: "login"; key: string }
  /**
   * One usage window of a login (e.g. Claude's `seven_day_opus`): a fact on it
   * holds only the agents whose model draws from that window
   * (`ReadinessModelWindows`), not every agent on the login.
   */
  | { kind: "login_window"; key: string; window: string }
  | { kind: "model"; key: string; model: string }
  | { kind: "agent"; agentId: string };

/**
 * Which usage windows of a login a model draws from: model id → windows, and
 * `"*"` for windows every model draws from (an "all models" weekly window).
 */
export type ReadinessModelWindows = Readonly<Record<string, readonly string[]>>;

/** The windows `model` draws from under `windows` (the shared ones first). */
export function readinessWindowsForModel(windows: ReadinessModelWindows | undefined, model: string | null | undefined): string[] {
  if (!windows) return [];
  return [...new Set([...(windows["*"] ?? []), ...(model ? windows[model] ?? [] : [])])];
}

/** Who acts: the owner of the broken resource. */
export type ReadinessActor = "server_admin" | "computer_owner" | "agent_owner";

/**
 * What the actor does, a closed set a viewer who may not see the reason may
 * read ("Olive can sign in"): derived from the code on the server, so the
 * code itself never reaches them. Anything without a closer word is `fix`.
 */
export const READINESS_ACTIONS = ["sign_in", "verify_account", "update_computer", "fix"] as const;
export type ReadinessAction = (typeof READINESS_ACTIONS)[number];

const READINESS_ACTION_BY_CODE: Readonly<Record<string, ReadinessAction>> = {
  verification_required: "verify_account",
  computer_too_old: "update_computer",
  computer_update_available: "update_computer",
  computer_update_required: "update_computer",
  // A login the daemon reports signed out (not a code yet; prepared).
  signed_out: "sign_in",
};

/** The action for a code: `fix` for any code without a closer word. */
export function readinessActionOf(code: string): ReadinessAction {
  return READINESS_ACTION_BY_CODE[code] ?? "fix";
}

/**
 * The action a viewer who may not see the reason reads (Tenny, #14587):
 * `sign_in` / `verify_account` would tell them the owner's account is signed
 * out or unverified, which is the reason itself. Only `update_computer` (about
 * the machine, not a person's account) survives; everything else is `fix`.
 */
export function readinessMemberActionOf(action: ReadinessAction): ReadinessAction {
  return action === "update_computer" ? "update_computer" : "fix";
}

/** The codes this build knows. */
export const READINESS_CODES = [
  "computer_offline",
  "computer_reconnecting",
  "computer_restarting",
  "computer_updating",
  "computer_too_old",
  "runtime_missing",
  "verification_required",
] as const;
export type ReadinessCode = (typeof READINESS_CODES)[number];

export function isReadinessCode(value: unknown): value is ReadinessCode {
  return typeof value === "string" && (READINESS_CODES as readonly string[]).includes(value);
}

/**
 * Each code: the resource it is about, its behaviour, and its exits (what
 * ends it). Every blocked code must have an exit (readiness.test.ts): a block
 * nothing can end would hold an agent forever.
 */
export const READINESS_CODE_SPEC: Readonly<Record<ReadinessCode, { resource: ReadinessResourceKind; behaviour: ReadinessBehaviour; exits: readonly string[] }>> = {
  // Server facts from the Computer outage machinery (computerOutageNotificationService):
  // an unplanned disconnect past its 60 s dwell, when the owner was told `computer.offline`.
  computer_offline: { resource: "computer", behaviour: "blocked", exits: ["computer_reconnects"] },
  // An unplanned disconnect inside the dwell: no notice yet, likely back soon.
  computer_reconnecting: { resource: "computer", behaviour: "advisory", exits: ["computer_reconnects", "dwell_elapsed"] },
  // A planned disconnect (shutdown, or a stop / restart the server asked for): no outage.
  // Five minutes after its last heartbeat it is computer_offline instead.
  computer_restarting: { resource: "computer", behaviour: "waiting", exits: ["computer_reconnects", "restart_window_elapsed"] },
  // Offline while the upgrade the server sent it runs (its open upgrade
  // request): `until` is the request's deadline, after which it is
  // computer_offline.
  computer_updating: { resource: "computer", behaviour: "waiting", exits: ["computer_reconnects", "upgrade_deadline_elapsed"] },
  // Server fact: below the enforced version floor (ComputerVersionGate).
  computer_too_old: { resource: "computer", behaviour: "blocked", exits: ["computer_upgraded", "version_floor_lowered"] },
  // Server fact: detection finished and the runtime is not on the Computer.
  runtime_missing: { resource: "runtime", behaviour: "blocked", exits: ["runtime_detected", "agent_runtime_changed", "agent_moved"] },
  // Daemon fact on a login: the provider refuses every call until the holder verifies the account.
  verification_required: { resource: "login", behaviour: "blocked", exits: ["model_output_after_retry", "credentials_changed"] },
};

/** Per-code params. A code not listed carries none. Never error text, paths or accounts. */
export interface ReadinessParamsByCode {
  /** Raft Desktop's bundled Computer: the copy says to update Raft Desktop. */
  computer_too_old: { managedByDesktop: boolean };
}
export type ReadinessParams = Record<string, string | number | boolean | null>;

/** One fact. `code` may be one this build does not know: `behaviour` says what to do with it. */
export interface ReadinessFact {
  resource: ReadinessResource;
  code: string;
  behaviour: ReadinessBehaviour;
  /** Epoch ms: since when it holds. */
  since: number;
  /** Epoch ms: a wait that ends by itself; past it the fact no longer counts. */
  until?: number;
  params?: ReadinessParams;
}

/**
 * The conclusion for one chain. `primary` is the first broken link's fact
 * (null when ready, or for a viewer who may not see the reason: then the
 * generic sentence). `scope` says whose problem it is, `actor` who fixes it.
 */
export interface Readiness {
  state: "ready" | ReadinessBehaviour;
  primary: ReadinessFact | null;
  scope: "server" | "computer" | "agent" | null;
  actor: ReadinessActor | null;
  /**
   * The display name of the person who owns the broken resource (their
   * server member name, never an email or account field), when the server
   * knows one. Kept for a viewer who may not see the reason, so they know
   * whom to ask. Absent from older servers.
   */
  actorName?: string;
  /**
   * What the actor does, for a viewer who may not see the reason (the action
   * is not the reason): set by trimReadinessForViewer from the code.
   */
  action?: ReadinessAction;
  /** The other facts on the chain, in chain order. */
  also: ReadinessFact[];
}

export const READY: Readiness = Object.freeze({ state: "ready", primary: null, scope: null, actor: null, also: [] }) as unknown as Readiness;

/** A Computer's readiness: its own (the Computer link) and per runtime on it (Computer → runtime → machine login). */
export interface ComputerReadiness extends Readiness {
  runtimes: Record<string, Readiness>;
}

/**
 * Where the account holder verifies an Anthropic account. Always this
 * constant: a link is never taken from the provider's error text.
 */
export const ANTHROPIC_VERIFICATION_PORTAL_URL = "https://portal.anthropic.com/verify";

// ── The chain ──

/** The login an agent depends on: the machine login of `sharedRuntime` (sharedCredentialsAuthRuntime), else its own. */
export function readinessLoginKey(agentId: string, sharedRuntime: string | null): string {
  return sharedRuntime ? `shared:${sharedRuntime}` : `agent:${agentId}`;
}

/**
 * An agent's chain on its Computer. `modelWindows`: the login's usage windows
 * per model, when known; the agent depends on the windows its model draws from.
 */
export function agentReadinessChain(input: { agentId: string; runtime: string; loginKey: string; model?: string | null; modelWindows?: ReadinessModelWindows }): ReadinessResource[] {
  return [
    { kind: "server" },
    { kind: "computer" },
    { kind: "runtime", runtime: input.runtime },
    { kind: "login", key: input.loginKey },
    ...readinessWindowsForModel(input.modelWindows, input.model).map((window) => ({ kind: "login_window" as const, key: input.loginKey, window })),
    ...(input.model ? [{ kind: "model" as const, key: input.loginKey, model: input.model }] : []),
    { kind: "agent", agentId: input.agentId },
  ];
}

/** A runtime's chain on a Computer: its machine login when it has one. */
export function runtimeReadinessChain(runtime: string, sharedLoginKey: string | null): ReadinessResource[] {
  return [
    { kind: "server" },
    { kind: "computer" },
    { kind: "runtime", runtime },
    ...(sharedLoginKey ? [{ kind: "login" as const, key: sharedLoginKey }] : []),
  ];
}

export function sameReadinessResource(a: ReadinessResource, b: ReadinessResource): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "server":
    case "computer":
      return true;
    case "runtime":
      return a.runtime === (b as typeof a).runtime;
    case "login":
      return a.key === (b as typeof a).key;
    case "login_window":
      return a.key === (b as typeof a).key && a.window === (b as typeof a).window;
    case "model":
      return a.key === (b as typeof a).key && a.model === (b as typeof a).model;
    case "agent":
      return a.agentId === (b as typeof a).agentId;
  }
}

/** Whose problem a resource is: the server's, the Computer's (itself, a runtime, its machine login) or the agent's. */
export function readinessScopeOf(resource: ReadinessResource): "server" | "computer" | "agent" {
  switch (resource.kind) {
    case "server":
      return "server";
    case "computer":
    case "runtime":
      return "computer";
    case "login":
    case "login_window":
      return resource.key.startsWith("shared:") ? "computer" : "agent";
    case "model":
    case "agent":
      return "agent";
  }
}

/** The owner of a resource, who acts on it. */
export function readinessActorOf(resource: ReadinessResource): ReadinessActor {
  const scope = readinessScopeOf(resource);
  return scope === "server" ? "server_admin" : scope === "computer" ? "computer_owner" : "agent_owner";
}

const BEHAVIOUR_ORDER: Record<ReadinessBehaviour, number> = { blocked: 0, waiting: 1, advisory: 2 };

/**
 * THE readiness function. Walks `chain` outermost first: the first link with
 * a blocked or waiting fact is the answer (blocked before waiting on that
 * link, then the oldest). With no broken link the first advisory is shown,
 * and the agent can run. Facts past their `until` (at `nowMs`) and facts on
 * resources outside the chain do not count.
 */
export function composeReadiness(facts: readonly ReadinessFact[], chain: readonly ReadinessResource[], nowMs: number): Readiness {
  const onChain: Array<{ fact: ReadinessFact; link: number }> = [];
  for (const fact of facts) {
    if (fact.until !== undefined && fact.until <= nowMs) continue;
    const link = chain.findIndex((resource) => sameReadinessResource(resource, fact.resource));
    if (link >= 0) onChain.push({ fact, link });
  }
  if (onChain.length === 0) return READY;
  onChain.sort((a, b) => a.link - b.link
    || BEHAVIOUR_ORDER[a.fact.behaviour] - BEHAVIOUR_ORDER[b.fact.behaviour]
    || a.fact.since - b.fact.since);
  const broken = onChain.find((entry) => entry.fact.behaviour !== "advisory") ?? onChain[0]!;
  const primary = broken.fact;
  return {
    state: primary.behaviour,
    primary,
    scope: readinessScopeOf(primary.resource),
    actor: readinessActorOf(primary.resource),
    also: onChain.filter((entry) => entry !== broken).map((entry) => entry.fact),
  };
}

/**
 * What a viewer who may not see the reason reads (Tenny #1): the state and
 * who can fix it (the actor and their display name), no fact, so the client
 * shows "can't reply right now; messages are kept; <name> can fix it".
 * Advisories can run: nothing to say.
 */
export function trimReadinessForViewer(readiness: Readiness, canSeeReason: boolean): Readiness {
  if (canSeeReason) return readiness;
  if (readiness.state === "ready" || readiness.state === "advisory") return READY;
  return {
    state: readiness.state,
    primary: null,
    scope: null,
    actor: readiness.actor,
    ...(readiness.actorName ? { actorName: readiness.actorName } : {}),
    ...(readiness.primary ? { action: readinessMemberActionOf(readinessActionOf(readiness.primary.code)) } : {}),
    also: [],
  };
}

// ── Per-Computer "needs attention" (the machine list) ──

/**
 * Summary item codes beside the readiness codes: the Computer has a newer
 * version (`computer_update_available`) or is below the version floor that is
 * not enforced yet (`computer_update_required`; once enforced it is the
 * `computer_too_old` fact).
 */
export const READINESS_ATTENTION_UPDATE_AVAILABLE = "computer_update_available";
export const READINESS_ATTENTION_UPDATE_REQUIRED = "computer_update_required";

/** One thing a person must act on for a Computer. */
export interface ReadinessAttentionItem {
  /** A readiness code or a summary update code; absent for a viewer who may not see the reason. */
  code?: string;
  /** Absent for a viewer who may not see the reason. */
  resource?: ReadinessResource;
  actor: ReadinessActor;
  /** The actor's server member display name, when known. */
  actorName?: string;
  /** What the actor does (from the code; kept for every viewer). */
  action: ReadinessAction;
  /** The agents it holds; absent for a viewer who may not see the reason. */
  agentIds?: string[];
  agentCount: number;
}

/**
 * A Computer's "needs attention": only what a person must act on (blocked
 * facts holding at least one of its agents, the Computer's own block such as
 * offline, and an update available or required). Waits that clear by
 * themselves (a quota window, a restart) are not counted; they are
 * `waitingAgents`, with the earliest `waitingUntil` when one is known.
 */
export interface ReadinessAttention {
  count: number;
  items: ReadinessAttentionItem[];
  waitingAgents: number;
  /** Epoch ms: the earliest end among the waits that have one. */
  waitingUntil?: number;
}

function resourceKey(resource: ReadinessResource): string {
  return JSON.stringify(Object.entries(resource).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * THE needs-attention function (server computes it for the machine list;
 * desktop and web may call it on the same inputs). `facts`: every fact about
 * the Computer (the server's and its daemon's); `agents`: each agent on it
 * with its chain. A fact counts only through an agent it holds, so a runtime
 * or login no agent uses never counts; the Computer's own block counts on its
 * own. `update`: the Computer's version verdict.
 */
export function composeReadinessAttention(input: {
  facts: readonly ReadinessFact[];
  agents: ReadonlyArray<{ id: string; chain: readonly ReadinessResource[] }>;
  update: "available" | "required" | null;
  nowMs: number;
}): ReadinessAttention {
  const items = new Map<string, ReadinessAttentionItem & { agentIds: string[] }>();
  const add = (fact: ReadinessFact, agentId: string | null) => {
    const key = `${fact.code}|${resourceKey(fact.resource)}`;
    let item = items.get(key);
    if (!item) {
      item = { code: fact.code, resource: fact.resource, actor: readinessActorOf(fact.resource), action: readinessActionOf(fact.code), agentIds: [], agentCount: 0 };
      items.set(key, item);
    }
    if (agentId !== null && !item.agentIds.includes(agentId)) {
      item.agentIds.push(agentId);
      item.agentCount = item.agentIds.length;
    }
  };
  const own = composeReadiness(input.facts, [{ kind: "server" }, { kind: "computer" }], input.nowMs);
  if (own.state === "blocked" && own.primary) add(own.primary, null);
  let waitingAgents = 0;
  let waitingUntil: number | undefined;
  for (const agent of input.agents) {
    const readiness = composeReadiness(input.facts, agent.chain, input.nowMs);
    if (readiness.state === "blocked" && readiness.primary) add(readiness.primary, agent.id);
    else if (readiness.state === "waiting") {
      waitingAgents += 1;
      const until = readiness.primary?.until;
      if (until !== undefined && (waitingUntil === undefined || until < waitingUntil)) waitingUntil = until;
    }
  }
  const result = [...items.values()];
  // An enforced floor is already the Computer's computer_too_old block: one thing to do, not two.
  const tooOld = result.some((item) => item.code === "computer_too_old");
  // Already installing it (computer_updating): in progress, nothing for a person to do.
  const updating = input.facts.some((fact) => fact.code === "computer_updating" && fact.resource.kind === "computer");
  if (!updating && input.update === "required" && !tooOld) {
    result.push({ code: READINESS_ATTENTION_UPDATE_REQUIRED, resource: { kind: "computer" }, actor: "computer_owner", action: "update_computer", agentIds: [], agentCount: 0 });
  } else if (!updating && input.update === "available" && !tooOld) {
    result.push({ code: READINESS_ATTENTION_UPDATE_AVAILABLE, resource: { kind: "computer" }, actor: "computer_owner", action: "update_computer", agentIds: [], agentCount: 0 });
  }
  return { count: result.length, items: result, waitingAgents, ...(waitingUntil !== undefined ? { waitingUntil } : {}) };
}

/** What a viewer who may not see the Computer's reasons reads: how many, who can fix each and how (the action), how many agents. */
export function trimReadinessAttentionForViewer(attention: ReadinessAttention, canSeeReason: boolean): ReadinessAttention {
  if (canSeeReason) return attention;
  return {
    ...attention,
    items: attention.items.map((item) => ({ actor: item.actor, ...(item.actorName ? { actorName: item.actorName } : {}), action: readinessMemberActionOf(item.action), agentCount: item.agentCount })),
  };
}

// ── Daemon → server: `machine:runtime_readiness` ──

/**
 * The daemon's full snapshot of the facts only it observes (its logins).
 * Sent on change and on connect, never on a timer. `seq` is per daemon and
 * only grows (across restarts too); the server drops a report whose `seq` is
 * not above the last one it stored for that Computer.
 */
export interface RuntimeReadinessReport {
  seq: number;
  facts: ReadinessFact[];
}

function parseResource(value: unknown): ReadinessResource | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 200 ? field : null;
  switch (candidate.kind) {
    case "server":
      return { kind: "server" };
    case "computer":
      return { kind: "computer" };
    case "runtime": {
      const runtime = text(candidate.runtime);
      return runtime ? { kind: "runtime", runtime } : null;
    }
    case "login": {
      const key = text(candidate.key);
      return key ? { kind: "login", key } : null;
    }
    case "login_window": {
      const key = text(candidate.key);
      const window = text(candidate.window);
      return key && window ? { kind: "login_window", key, window } : null;
    }
    case "model": {
      const key = text(candidate.key);
      const model = text(candidate.model);
      return key && model ? { kind: "model", key, model } : null;
    }
    case "agent": {
      const agentId = text(candidate.agentId);
      return agentId ? { kind: "agent", agentId } : null;
    }
    default:
      return null;
  }
}

/** At most this many facts are read from one report; the rest are dropped (a daemon has a handful). */
export const READINESS_REPORT_MAX_FACTS = 50;
/** At most this many params are read from one fact; the rest are dropped. */
export const READINESS_FACT_MAX_PARAMS = 8;

function parseParams(value: unknown): ReadinessParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params: ReadinessParams = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(params).length >= READINESS_FACT_MAX_PARAMS) break;
    if (field === null || typeof field === "boolean" || (typeof field === "number" && Number.isFinite(field))) params[key] = field;
    else if (typeof field === "string" && field.length <= 200) params[key] = field;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** One fact read leniently: an unknown code is kept; a fact without a known resource, a behaviour or a time is not. */
export function parseReadinessFact(value: unknown): ReadinessFact | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const resource = parseResource(candidate.resource);
  if (!resource) return null;
  if (typeof candidate.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.code)) return null;
  if (!(READINESS_BEHAVIOURS as readonly unknown[]).includes(candidate.behaviour)) return null;
  if (typeof candidate.since !== "number" || !Number.isFinite(candidate.since) || candidate.since <= 0) return null;
  const until = typeof candidate.until === "number" && Number.isFinite(candidate.until) ? candidate.until : undefined;
  const params = parseParams(candidate.params);
  return {
    resource,
    code: candidate.code,
    behaviour: candidate.behaviour as ReadinessBehaviour,
    since: candidate.since,
    ...(until !== undefined ? { until } : {}),
    ...(params ? { params } : {}),
  };
}

/**
 * Lenient read of a `machine:runtime_readiness` frame: null only when `seq`
 * is not a positive safe integer. A fact that cannot be read is dropped,
 * never the whole report; a fact with an unknown code is kept. Bounded: the
 * first READINESS_REPORT_MAX_FACTS readable facts, each with at most
 * READINESS_FACT_MAX_PARAMS params.
 */
export function parseRuntimeReadinessReport(value: unknown): RuntimeReadinessReport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const seq = candidate.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return null;
  const facts: ReadinessFact[] = [];
  for (const raw of Array.isArray(candidate.facts) ? candidate.facts : []) {
    if (facts.length >= READINESS_REPORT_MAX_FACTS) break;
    const fact = parseReadinessFact(raw);
    if (fact) facts.push(fact);
  }
  return { seq, facts };
}

// ── Daemon persistence: `<raft home>/machines/<machine id>/runtime-readiness.json` ──

/**
 * One runner's readiness file. Each runner (one per connected server) writes
 * only its own file, atomically (temp file + rename); one writer per file, so
 * no lock. `credentials` holds the logins that are held now, keyed by
 * credential key: `shared:<runtime>` (the Computer's machine login, which
 * every runner on the Computer uses) and `agent:<id>`. Every runner also
 * reads the `shared:*` evidence in the other runners' files and merges it
 * with its own (`mergeSharedLoginEvidence`: the latest real call wins). Never
 * a secret, a path, an account or error text.
 */
export interface RuntimeReadinessFile {
  version: 1;
  /** The last report `seq` this runner used. */
  seq: number;
  credentials: Record<string, RuntimeReadinessFileEntry>;
  /**
   * `shared:*` keys only: when this runner last saw a hold on that machine
   * login end. Kept apart from `credentials` (an entry there always means
   * "held now", also for a reader that predates this field), so another
   * runner can tell "this runner saw it end" from "this runner never saw
   * it": without it a runner whose call succeeded would be held again by
   * another runner's older entry. Absent in files written before it existed.
   */
  ended?: Record<string, RuntimeReadinessFileEnd>;
}

export interface RuntimeReadinessFileEntry {
  /** A readiness code. */
  state: string;
  /** Epoch ms: first seen in this state. */
  since: number;
  /** Epoch ms: the latest real call that saw it; model output proves the credential only from a turn started after it. */
  recordedAt: number;
}

/** Why a hold on a machine login ended: model output, a changed credential, or a person's Retry (which only lets the next call try). */
export const RUNTIME_READINESS_END_CAUSES = ["model_output", "credentials_changed", "explicit_stop"] as const;
export type RuntimeReadinessEndCause = (typeof RUNTIME_READINESS_END_CAUSES)[number];

export interface RuntimeReadinessFileEnd {
  /**
   * Epoch ms: the instant from which the hold no longer stands. For model
   * output, the start of the turn that produced it (a finding recorded after
   * that turn started is later evidence); otherwise when it happened.
   */
  at: number;
  cause: RuntimeReadinessEndCause;
}

export type SharedLoginEvidence =
  | { kind: "finding"; entry: RuntimeReadinessFileEntry }
  | { kind: "end"; end: RuntimeReadinessFileEnd };

/**
 * One machine login as every runner on the Computer saw it: the latest
 * evidence wins, a finding (at its `recordedAt`) or an end (at its `at`). At
 * the same instant the finding wins: holding one call too long costs less
 * than releasing agents onto a login that refuses them. Null with no evidence.
 */
export function mergeSharedLoginEvidence(
  findings: readonly RuntimeReadinessFileEntry[],
  ends: readonly RuntimeReadinessFileEnd[],
): SharedLoginEvidence | null {
  let finding: RuntimeReadinessFileEntry | null = null;
  for (const entry of findings) if (!finding || entry.recordedAt > finding.recordedAt) finding = entry;
  let end: RuntimeReadinessFileEnd | null = null;
  for (const each of ends) if (!end || each.at > end.at) end = each;
  if (finding && (!end || finding.recordedAt >= end.at)) return { kind: "finding", entry: finding };
  return end ? { kind: "end", end } : null;
}
