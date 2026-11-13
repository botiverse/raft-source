// The scripted-runtime OarAgentHost harness shared by the OAR host's tests and
// the APM's cross-host provider-limit test: an OarAgentHost over
// @botiverse/oar's scripted runtime, with every daemon dependency recorded in
// memory. It must not import the AgentProcessManager module
// (daemon-runtime-boundaries): a test that needs one builds it itself and
// hands its ledger in (`limitHarness(..., { ledger })`).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Event, EventObserver, EventsOptions, FailedTurn, FailureClass, Session } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentConfig, AgentMessage, MachineToServerMessage, TraceContext } from "@botiverse/raft-shared";
import { exampleMessage } from "../axExampleFixtures";
import type { AgentStartRequest } from "../agentHost/agentLifecycleHost";
import { OarAgentHost, type OarAgentHostDeps, type OpenOarSession } from "../agentHost/oarAgentHost";
import type { OarLaunch } from "../agentHost/oarLaunch";
import { ProviderLimitLedger } from "../providerLimitLedger";

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "oar-agent",
    displayName: "OAR Agent",
    description: "test agent",
    model: "default",
    runtime: "grok",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "",
    runtimeHost: "oar",
    ...overrides,
  };
}

export function request(overrides: Partial<AgentStartRequest> = {}): AgentStartRequest {
  return {
    agentId: "agent-1",
    config: makeConfig(),
    launchId: "launch-1",
    wakeMessageTransient: false,
    recoveryGrant: null,
    claimedConnectionEpochId: null,
    ...overrides,
  };
}

export const message = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ ...exampleMessage, message_id: id, ...extra });

export async function until(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface Harness {
  host: OarAgentHost;
  dataDir: string;
  frames: MachineToServerMessage[];
  /** `parent`: the trace the host attached the record to, when it named one. */
  events: Array<{ name: string; attrs: Record<string, unknown>; parent?: TraceContext }>;
  inputs: string[];
  steered: () => string[];
  opened: OarLaunch[];
  gateCalls: string[];
  waiting: Map<string, string[]>;
  notSpawned: Array<{ launchId: string; reason: string }>;
  rebound: Array<{ launchId: string; processInstanceId: string }>;
  revokes: string[];
  sessions: Session[];
  /** The harness's accepted-launch ledger, for a router beside the host. */
  settleNotSpawned: OarAgentHostDeps["launches"]["settleNotSpawned"];
  framesOf<T extends MachineToServerMessage["type"]>(type: T): Array<Extract<MachineToServerMessage, { type: T }>>;
  cleanup(): Promise<void>;
}

export async function harness(options: {
  turn?: (turn: ScriptedTurn) => void | Promise<void>;
  openSession?: OpenOarSession;
  deps?: Partial<OarAgentHostDeps>;
  wrapSession?: (session: Session) => Session;
  /** The first session open waits for this before the runtime opens it. */
  firstOpenGate?: Promise<void>;
  /** Session open number `n` (from 1) waits for what this returns, if anything, before the runtime opens it. */
  openGate?: (n: number) => Promise<void> | undefined;
} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "oar-host-test-"));
  const frames: MachineToServerMessage[] = [];
  const events: Harness["events"] = [];
  const inputs: string[] = [];
  const steeredInputs: string[] = [];
  const opened: OarLaunch[] = [];
  const gateCalls: string[] = [];
  const waiting = new Map<string, string[]>([["agent-1", ["launch-1"]]]);
  const notSpawned: Harness["notSpawned"] = [];
  const rebound: Harness["rebound"] = [];
  const revokes: string[] = [];
  const sessions: Session[] = [];
  let seq = 0;
  let opens = 0;
  // As the legacy host's ledger: only a launch still waiting gets a result; an emptied list is dropped.
  const settle = (agentId: string, launchId: string): boolean => {
    const list = waiting.get(agentId) ?? [];
    if (!list.includes(launchId)) return false;
    const rest = list.filter((each) => each !== launchId);
    if (rest.length > 0) waiting.set(agentId, rest);
    else waiting.delete(agentId);
    return true;
  };
  const runtime = scriptedRuntime({
    turn: async (turn) => {
      inputs.push(turn.input);
      await (options.turn ?? ((t: ScriptedTurn) => { t.say("ok"); }))(turn);
      steeredInputs.push(...turn.steered);
    },
  });
  const deps: OarAgentHostDeps = {
    dataDir,
    // Daemon state beside the workspaces, never inside an agent's dir, and never the real Raft home.
    sessionSummaryDir: path.join(dataDir, ".daemon-state", "agent-session-summaries"),
    serverUrl: "http://localhost:3001",
    daemonApiKey: "sk_machine_test",
    slockCliPath: process.execPath,
    sendToServer: (msg) => { frames.push(msg); },
    nextClientSeq: () => { seq += 1; return seq; },
    daemonInstanceId: () => "daemon-1",
    buildSpawnConfig: async (_agentId, config) => ({ ...config, agentCredentialKey: "sk_agent_x", agentCredentialId: "cred-1" }),
    isStaleClaim: () => false,
    gate: {
      openProcess: (_agentId, processInstanceId, launchId) => { gateCalls.push(`open:${processInstanceId}:${launchId}`); return true; },
      processExitedLocally: (_agentId, processInstanceId) => { gateCalls.push(`exitedLocally:${processInstanceId}`); },
      processNotStarted: (_agentId, processInstanceId) => { gateCalls.push(`notStarted:${processInstanceId}`); },
      startRefusal: (_agentId, launchId) => { gateCalls.push(`refusal:${launchId}`); return null; },
      waitForCapability: () => ({ confirmed: Promise.resolve(true), cancel: () => {} }),
    },
    launches: {
      take: (agentId) => { const list = waiting.get(agentId) ?? []; waiting.delete(agentId); return list; },
      settleNotSpawned: (agentId, launchId, reason) => { if (settle(agentId, launchId)) notSpawned.push({ launchId, reason }); },
      settleRebound: (agentId, launchId, processInstanceId) => { if (settle(agentId, launchId)) rebound.push({ launchId, processInstanceId }); },
    },
    slockHome: dataDir,
    recordEvent: (name, attrs, _status, parent) => { events.push({ name, attrs, ...(parent ? { parent } : {}) }); },
    fetchImpl: async (url) => { revokes.push(url); return new Response(null, { status: 204 }); },
    platform: "linux",
    // The fixture stands in for Grok Build itself (#oar-raft:#4).
    detectedRuntimeCliVersion: (runtimeId) => (runtimeId === "grok" ? "grok 1.0.77" : undefined),
    prepareLaunch: async (ctx) => ({
      runtimeId: "grok",
      installation: { kind: "available", via: "bundled" },
      options: {
        cwd: ctx.workingDirectory,
        systemPrompt: ctx.standingPrompt,
        ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
      },
      busyDelivery: "after_turn",
    }),
    openSession: options.openSession ?? (async (launch) => {
      opens += 1;
      if (opens === 1 && options.firstOpenGate) await options.firstOpenGate;
      await options.openGate?.(opens);
      opened.push(launch);
      const session = await runtime.session({ kind: "available", via: "bundled" }, launch.options);
      const wrapped = options.wrapSession ? options.wrapSession(session) : session;
      sessions.push(wrapped);
      return wrapped;
    }),
    ...options.deps,
  };
  const host = new OarAgentHost(deps);
  host.setServerTurnEndedCapable(true);
  return {
    host,
    dataDir,
    frames,
    events,
    inputs,
    steered: () => steeredInputs,
    opened,
    gateCalls,
    waiting,
    notSpawned,
    rebound,
    revokes,
    sessions,
    settleNotSpawned: deps.launches.settleNotSpawned,
    framesOf: <T extends MachineToServerMessage["type"]>(type: T) =>
      frames.filter((frame): frame is Extract<MachineToServerMessage, { type: T }> => frame.type === type),
    cleanup: async () => {
      await host.stopAll();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A scripted session whose failed turns carry `failure` (the scripted runtime only reports `unknown`). */
/** Every failed turn of `session` ends with OAR's `failure` class (and `extra` fields, e.g. a quota's `resetsAt`). */
export function withFailure(session: Session, failure: FailureClass, extra: Record<string, unknown> = {}): Session {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "events") {
        return (observer: EventObserver, options?: EventsOptions) => target.events((event: Event) => {
          if (event.kind === "turn_ended" && event.outcome.kind === "failed") {
            observer({ ...event, outcome: { kind: "failed", failure, reason: event.outcome.reason, ...extra } as FailedTurn });
            return;
          }
          observer(event);
        }, options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export const codexShared = (overrides: Partial<AgentConfig> = {}) => makeConfig({ runtime: "codex", ...overrides });

export const QUOTA_TEXT = "You've hit your usage limit. Try again later.";
export const limitEvents = (h: Harness, agentId: string) => h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === agentId);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A harness whose `failing` agents' first turn ends with OAR's `failure` class; every other turn answers. */
export async function limitHarness(failure: FailureClass, options: {
  failing?: readonly string[];
  extra?: Record<string, unknown>;
  ledger?: ProviderLimitLedger;
  backoff?: OarAgentHostDeps["providerLimitBackoff"];
} = {}): Promise<{ h: Harness; ledger: ProviderLimitLedger; turnInputs: Map<string, string[]> }> {
  const failing = new Set(options.failing ?? ["agent-1"]);
  const ledger = options.ledger ?? new ProviderLimitLedger();
  const turnInputs = new Map<string, string[]>();
  const h = await harness({
    turn: (turn) => {
      const agentId = path.basename(String(turn.options.cwd));
      const seen = [...(turnInputs.get(agentId) ?? []), turn.input];
      turnInputs.set(agentId, seen);
      if (failing.has(agentId) && seen.length === 1) throw new Error(QUOTA_TEXT);
      turn.say("ok");
    },
    wrapSession: (session) => withFailure(session, failure, options.extra),
    deps: { providerLimits: ledger, providerLimitBackoff: options.backoff ?? { baseMs: 300, jitterRatio: 0 } },
  });
  return { h, ledger, turnInputs };
}

export const startRequest = (agentId: string, config: AgentConfig) => request({ agentId, config, launchId: `launch-${agentId}` });
