import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  Session as KimiSession,
  createKimiHarness,
  resolveKimiHome,
  LocalKaos,
  type Event as KimiSdkEvent,
  type GoalToolResult,
  type KimiHarness,
} from "@botiverse/kimi-code-sdk";

const requireFromHere = createRequire(import.meta.url);

/**
 * Canonical `kimi-code-cli` UA product — the same product string upstream
 * `apps/kimi-code/src/constant/app.ts` uses (`CLI_USER_AGENT_PRODUCT`).
 * Moonshot's `kimi-for-coding` model gate keys on this product. We're a
 * legitimate consumer of `@moonshot-ai/kimi-code-sdk` (via the
 * `@botiverse/kimi-code-sdk` mirror), so identifying as `kimi-code-cli` is
 * accurate, not impersonation. Telemetry-side, the `userAgentSuffix` we add
 * (`slock-daemon/<version>`) makes our traffic distinguishable.
 */
const KIMI_CODE_USER_AGENT_PRODUCT = "kimi-code-cli";

/**
 * The `X-Msh-Platform` value reported to the OAuth host and managed endpoints.
 * Deliberately a SEPARATE constant from the UA product: the SDK 0.33.0
 * docblock documents this header with underscore examples (`kimi_code_cli`,
 * `kimi_code_desktop`) and requires every host to state its own, so reusing
 * the hyphenated UA product would couple two distinct wire-identity surfaces
 * and send an undocumented format. We present as the CLI product, with the
 * slock-daemon suffix already carried in userAgentSuffix.
 */
export const KIMI_CODE_PLATFORM = "kimi_code_cli";

/**
 * Version we report to Moonshot — the upstream Kimi Code release we mirror
 * the SDK from. Bumps in lockstep with the @botiverse/kimi-code-sdk dep
 * version we depend on. A contract test compares this value to the daemon's
 * exact dependency pin so a package-only bump cannot leave the wire identity
 * stale again.
 */
export const KIMI_CODE_HOST_VERSION = "0.34.0-botiverse.0";

function getDaemonVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

import {
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type AxSurfaceText,
} from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport, SLOCK_AGENT_LAUNCH_DIR_ENV, SLOCK_CLI_TRANSPORT_DIR_ENV } from "./cliTransport.js";
import { prepareManagedMcpRuntimeProxy } from "../managedMcpRuntimeProxy.js";
import type {
  ParsedEvent,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeModelDetectionContext,
  RuntimeProbeResult,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  SpawnContext,
  SpawnResult,
} from "./types.js";

const KIMI_SESSION_DIR = ".kimi-sessions";

type RuntimeSessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

type RuntimeSessionEventName = keyof RuntimeSessionEvents;

type PendingKimiTurnStartAttempt = {
  id: number;
  text: string;
  delivery: boolean;
};

export type KimiSessionFactory = (ctx: SpawnContext, sessionId: string) => Promise<{
  harness: KimiHarness;
  session: KimiSession;
  /**
   * Absolute path to the per-agent `raft` CLI wrapper that prepareCliTransport
   * wrote for this session. Kept for diagnostics/observability; the LLM no
   * longer receives this path in the standing prompt. Instead, the per-session
   * tool Kaos prepends the wrapper directory to PATH so the model can use the
   * bare `raft` command.
   */
  wrapperPath: string;
}>;

export interface KimiSdkEventMappingState {
  sessionId: string | null;
  sessionAnnounced: boolean;
}

export function createKimiSdkEventMappingState(sessionId: string | null = null): KimiSdkEventMappingState {
  return {
    sessionId,
    sessionAnnounced: false,
  };
}

export function buildKimiSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, KIMI_SESSION_DIR);
}

export async function buildKimiSpawnEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

function kimiErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through.
    }
  }
  return "Unknown Kimi error";
}

function kimiDeliveryErrorCode(message: string): "turn.agent_busy" | "runtime.delivery_error" {
  return /Cannot launch a new turn while another turn\b/i.test(message)
    ? "turn.agent_busy"
    : "runtime.delivery_error";
}

function kimiGoalIsActive(result: GoalToolResult | null | undefined): boolean {
  return result?.goal?.status === "active";
}

function pushSessionInitIfNeeded(state: KimiSdkEventMappingState, events: ParsedEvent[]): void {
  if (!state.sessionAnnounced && state.sessionId) {
    events.push({ kind: "session_init", sessionId: state.sessionId });
    state.sessionAnnounced = true;
  }
}

/**
 * Closed mapping from Kimi SDK Event union → ParsedEvent[].
 *
 * RS-004 closed-mapping discipline: every member of the SDK's `AgentEvent`
 * union is either mapped to at most one ParsedEvent.kind OR explicitly
 * dropped via `return events;`. Default branch is `_exhaustive: never` so the
 * TypeScript compiler fails closed if upstream adds a new event class
 * without our mapping table being extended.
 *
 * The single turn-triggering source class is `turn.ended` → daemon idle ONLY
 * derives from this. Other events MUST NOT produce `kind: "turn_end"`.
 */
export function mapKimiSdkEventToParsedEvents(
  event: KimiSdkEvent,
  state: KimiSdkEventMappingState,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  pushSessionInitIfNeeded(state, events);

  switch (event.type) {
    // ── content streaming → ParsedEvent ──
    case "thinking.delta":
      if (typeof event.delta === "string" && event.delta.length > 0) {
        events.push({ kind: "thinking", text: event.delta });
      }
      return events;
    case "assistant.delta":
      if (typeof event.delta === "string" && event.delta.length > 0) {
        events.push({ kind: "text", text: event.delta });
      }
      return events;
    case "tool.call.started":
      events.push({
        kind: "tool_call",
        name: event.name || "unknown_tool",
        input: event.args ?? {},
      });
      return events;
    case "tool.result":
      events.push({ kind: "tool_output", name: "" });
      return events;
    case "compaction.started":
      events.push({ kind: "compaction_started" });
      return events;
    case "compaction.completed":
      events.push({ kind: "compaction_finished" });
      return events;
    case "error":
      events.push({ kind: "error", message: kimiErrorMessage(event) });
      return events;

    // ── THE single turn-triggering source class ──
    case "turn.ended":
      events.push({ kind: "turn_end", sessionId: state.sessionId || undefined });
      return events;

    // ── explicit drops (RS-004) ──
    // `warning` is non-fatal in the SDK's vocabulary; mapping it to
    // ParsedEvent.kind="error" would latch the agent into APM's error state
    // (lastRuntimeError set by `runtime.error`, then NOT cleared by the
    // following turn_end) — so a warning would brick the agent until
    // restart. Drop it here; the SDK's own log already records it.
    case "warning":
    // turn / step lifecycle (state-only, no parsed payload)
    case "turn.started":
    case "turn.step.started":
    case "turn.step.completed":
    case "turn.step.retrying":
    case "turn.step.interrupted":
    // tool-call progress / hooks (could elevate to internal_progress in future)
    case "tool.call.delta":
    case "tool.progress":
    case "shell.output":
    case "shell.started":
    case "shell.completed":
    case "hook.result":
    // status / meta updates
    case "agent.status.updated":
    case "session.meta.updated":
    case "event.session.created":
    case "event.workspace.created":
    case "event.workspace.updated":
    case "event.workspace.deleted":
    case "event.session.work_changed":
    case "event.session.status_changed":
    case "event.config.changed":
    case "event.model_catalog.changed":
    case "goal.updated":
    case "skill.activated":
    case "plugin_command.activated":
    // MCP infra
    case "tool.list.updated":
    case "mcp.server.status":
    // subagent lifecycle (v0: drop; could surface later)
    case "subagent.spawned":
    case "subagent.started":
    case "subagent.suspended":
    case "subagent.completed":
    case "subagent.failed":
    // compaction sub-cases
    case "compaction.blocked":
    case "compaction.cancelled":
    // out-of-band
    case "task.started":
    case "task.terminated":
    case "background.task.started":
    case "background.task.terminated":
    case "cron.fired":
    case "prompt.submitted":
    case "prompt.completed":
    case "prompt.aborted":
    case "prompt.steered":
      return events;

    default: {
      // Compile-time exhaustiveness check. If this errors after a Kimi SDK
      // upgrade, the new event class needs a deliberate decision (map or drop)
      // — failing closed on unmapped event classes is RS-004.
      const _exhaustive: never = event;
      void _exhaustive;
      return events;
    }
  }
}

const KIMI_SDK_RUNTIME_SESSION_DESCRIPTOR = {
  transport: "sdk",
  lifecycle: "sdk_session",
  stdout: {
    channel: "diagnostic",
  },
  input: {
    initial: "start",
    idle: "sdk_prompt",
    busy: "sdk_steer",
  },
  readiness: "sdk_ready",
  turnBoundary: "sdk_event",
  startPolicy: "immediate",
  inFlightWake: "steer",
  busyDelivery: "direct",
  postTurn: "keep_alive",
} as const satisfies RuntimeSessionDescriptor;

/**
 * Composes the long-lived standing role addendum delivered to the Kimi SDK via
 * the sanctioned `roleAdditional` session option (renders into the base system
 * prompt's `{{ ROLE_ADDITIONAL }}` slot, sent on EVERY request). Unlike the old
 * first-turn injection, this lives outside compressible conversation history, so
 * it survives Kimi's context compaction and never has to be re-asserted.
 *
 * Returns the standing prompt verbatim (or "" when absent). The per-agent
 * `raft` wrapper is no longer surfaced here; instead, the Kimi SDK bash tool
 * receives a per-session tool Kaos whose PATH is prepended with the current
 * launch's wrapper directory, so the model can use the bare `raft` command.
 *
 * The `wrapperPath` parameter is kept for signature compatibility but ignored.
 */
export function composeStandingRoleAdditional(
  standingPrompt: string | undefined,
  wrapperPath: string | null,
): string {
  void wrapperPath; // per-session PATH is supplied via tool Kaos; no absolute-path note needed
  return standingPrompt ?? "";
}

/**
 * Injectable seams for {@link createKimiAgentSessionForContext} so tests can
 * exercise the real roleAdditional wiring without a live Kimi harness / on-disk
 * CLI wrapper. Production callers omit `deps` and get the real implementations.
 */
export interface KimiSessionFactoryDeps {
  createHarness?: typeof createKimiHarness;
  prepareTransport?: typeof prepareCliTransport;
  createLocalKaos?: () => Promise<LocalKaos>;
}

export async function createKimiAgentSessionForContext(
  ctx: SpawnContext,
  sessionId: string,
  deps: KimiSessionFactoryDeps = {},
): Promise<{ harness: KimiHarness; session: KimiSession; wrapperPath: string }> {
  const createHarnessImpl = deps.createHarness ?? createKimiHarness;
  const prepareTransportImpl = deps.prepareTransport ?? prepareCliTransport;
  const sessionDir = buildKimiSessionDir(ctx.workingDirectory);
  mkdirSync(sessionDir, { recursive: true });

  // prepareCliTransport writes the per-agent `raft` wrapper into daemon-owned
  // transport storage outside the model workspace. For the in-process Kimi SDK
  // runtime we supply the wrapper directory via a per-session tool Kaos (PATH
  // prepend + launch selector) instead of surfacing an absolute wrapper path in
  // the standing prompt.
  const cliTransport = await prepareTransportImpl(ctx, { NO_COLOR: "1" });
  const spawnEnv = cliTransport.spawnEnv;
  const wrapperPath = cliTransport.wrapperPath;
  const slockDir = cliTransport.slockDir;
  const slockHome = cliTransport.slockHome;

  // The SDK's bash tool must resolve `raft` to the current launch's wrapper and
  // forward any stale absolute wrapper invocation to the current launch before
  // stale credential/proxy env is read. Build a tool Kaos that overlays the
  // per-session env; keep persistence on a plain LocalKaos so session files and
  // credentials stay local to the daemon host.
  const localKaos = await (deps.createLocalKaos ?? LocalKaos.create)();
  const toolKaos = localKaos.withEnv({
    PATH: `${slockDir}${path.delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    SLOCK_HOME: slockHome,
    [SLOCK_AGENT_LAUNCH_DIR_ENV]: path.basename(slockDir),
    [SLOCK_CLI_TRANSPORT_DIR_ENV]: slockDir,
  });

  // Kimi Code keeps config, OAuth credentials, and sessions under
  // KIMI_CODE_HOME (default: ~/.kimi-code). Use the SDK resolver so model
  // detection and session launch cannot silently read different homes. Pass
  // the prepared per-agent override into the SDK's canonical resolver;
  // per-agent env is not installed into the daemon process-wide environment.
  const homeDir = resolveKimiHome(spawnEnv.KIMI_CODE_HOME);
  mkdirSync(homeDir, { recursive: true });

  // The harness resolves auth from <homeDir>/credentials/kimi-code.json by
  // default (KimiAuthFacade with the homeDir we just passed). We do NOT call
  // applyCatalogProvider here — that's a config-patch helper, not session-time
  // setup. Provider/catalog choice flows through the SDK's own auth/config
  // pipeline based on what's already in <homeDir>.
  const harness = createHarnessImpl({
    homeDir,
    identity: {
      productName: KIMI_CODE_USER_AGENT_PRODUCT,
      version: KIMI_CODE_HOST_VERSION,
      platform: KIMI_CODE_PLATFORM,
      userAgentSuffix: `slock-daemon/${getDaemonVersion()}`,
    },
  });

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  // Try to resume an existing kimi session if we have a persisted id; fall
  // back to fresh creation. Resume gives us memory continuity across daemon
  // restarts; createSession with a pre-existing id throws ("Session ... already
  // exists"), so we MUST go through resume on the second launch.
  // Deliver the standing prompt via the SDK's native `roleAdditional` session
  // option (renders into `{{ ROLE_ADDITIONAL }}` in the base system prompt,
  // resent every request → survives context compaction). Passed identically on
  // both the resume and fresh-create paths so a resumed agent keeps the same
  // native standing instructions. The wrapper path note is gone; the per-session
  // tool Kaos supplies the correct PATH.
  const roleAdditional = composeStandingRoleAdditional(ctx.standingPrompt, wrapperPath);
  const managedMcp = await prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
  });
  const selectedModel = launchRuntimeFields.model && launchRuntimeFields.model !== "default"
    ? launchRuntimeFields.model
    : null;
  const sessionFields = {
    workDir: ctx.workingDirectory,
    kaos: toolKaos,
    persistenceKaos: localKaos,
    ...(roleAdditional ? { roleAdditional } : {}),
    ...(managedMcp ? {
      mcpServers: {
        [managedMcp.name]: {
          transport: "http" as const,
          url: managedMcp.url,
        },
      },
    } : {}),
  };
  let session: KimiSession;
  if (ctx.config.sessionId) {
    let resumed = false;
    try {
      session = await harness.resumeSession({ ...sessionFields, id: ctx.config.sessionId });
      resumed = true;
    } catch (resumeError) {
      // Resume can fail if upstream's on-disk session file is gone (e.g.
      // user wiped ~/.kimi-code/sessions/) or otherwise unreadable. Fall through
      // to a fresh session — losing memory continuity is preferable to
      // bricking the agent.
      void resumeError;
      session = await harness.createSession({
        ...sessionFields,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(launchRuntimeFields.reasoningEffort ? { thinking: launchRuntimeFields.reasoningEffort } : {}),
      });
    }
    // Resume restores the persisted model/thinking profile. Re-apply the
    // current Runtime Profile before the first resumed turn: `model` and
    // `thinking` are not resume options, while the Session methods are the
    // SDK's supported live reconfiguration surface. A failure here is not a
    // missing session and must remain visible rather than falling back to a
    // fresh create.
    if (resumed) {
      if (selectedModel) {
        await session.setModel(selectedModel);
      }
      if (launchRuntimeFields.reasoningEffort) {
        await session.setThinking(launchRuntimeFields.reasoningEffort);
      }
    }
  } else {
    session = await harness.createSession({
      ...sessionFields,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(launchRuntimeFields.reasoningEffort ? { thinking: launchRuntimeFields.reasoningEffort } : {}),
    });
  }
  return { harness, session, wrapperPath };
}

export class KimiSdkRuntimeSession implements RuntimeSession {
  readonly descriptor = KIMI_SDK_RUNTIME_SESSION_DESCRIPTOR;
  private readonly events = new EventEmitter();
  private readonly mappingState: KimiSdkEventMappingState;
  private harness: KimiHarness | null = null;
  private session: KimiSession | null = null;
  private wrapperPath: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private didClose = false;
  private requestedStopReason: string | undefined;
  private exitInfo: RuntimeExitInfo | null = null;
  private sdkTurnActive = false;
  private goalRunActive = false;
  private pendingTurnEndSessionId: string | undefined;
  private nextTurnStartAttemptId = 1;
  private pendingTurnStartAttempt: PendingKimiTurnStartAttempt | undefined;

  constructor(
    private readonly ctx: SpawnContext,
    private readonly setCurrentSessionId: (sessionId: string | null) => void,
    private readonly sessionFactory: KimiSessionFactory = createKimiAgentSessionForContext,
  ) {
    this.mappingState = createKimiSdkEventMappingState(ctx.config.sessionId || null);
  }

  get pid(): undefined {
    return undefined;
  }

  get currentSessionId(): string | null {
    return this.mappingState.sessionId;
  }

  get exitCode(): number | null {
    return this.exitInfo?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exitInfo?.signal ?? null;
  }

  get closed(): boolean {
    return this.didClose;
  }

  // In-process SDK session: there is no OS pid to probe with signal-0, so
  // liveness is unknowable via the pid-probe boundary. Return undefined, which
  // callers treat the same as the historic "no pid" probe result (RS-011).
  isAlive(): boolean | undefined {
    return undefined;
  }

  on<T extends RuntimeSessionEventName>(
    event: T,
    cb: (...args: RuntimeSessionEvents[T]) => void,
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    if (this.didClose) return { ok: false, reason: "closed" };
    this.started = true;
    const sessionId = input.sessionId || this.ctx.config.sessionId || randomUUID();
    this.mappingState.sessionId = sessionId;
    this.setCurrentSessionId(sessionId);

    const { harness, session, wrapperPath } = await this.sessionFactory(
      {
        ...this.ctx,
        config: {
          ...this.ctx.config,
          sessionId,
        },
      },
      sessionId,
    );
    this.harness = harness;
    this.session = session;
    this.wrapperPath = wrapperPath;
    this.mappingState.sessionId = session.id;
    this.setCurrentSessionId(session.id);
    await this.seedGoalState(session);
    // Auto-approve tool-call permission requests (Kimi SDK gates bash and a
    // few other tools through `setApprovalHandler`; without a handler all
    // calls return decision='cancelled' / feedback='No approval handler
    // registered', which blocks the agent from doing any real work).
    //
    // Slock's existing agent-isolation model (per-agent workingDirectory +
    // per-agent CLI proxy token) is the actual trust boundary, so always-
    // approving here is consistent with how Claude / Pi run (their child
    // processes don't have an in-band approval prompt either). If a future
    // policy wants to surface tool-call previews to humans, it lives at the
    // slock activity / UI layer, not at this approval-handler shim.
    session.setApprovalHandler(() => ({ decision: "approved", scope: "session" }));
    this.unsubscribe = session.onEvent((event) => this.handleSdkEvent(event));

    this.emitSessionInit();
    // The standing system prompt + wrapper CLI note are NOT injected into the
    // turn text anymore. They are delivered natively via the SDK's
    // `roleAdditional` session option (see composeStandingRoleAdditional +
    // createKimiAgentSessionForContext), which renders them into the base
    // system prompt on every request — so they survive Kimi's context
    // compaction instead of being condensed out of the first turn's history.
    // The first turn therefore carries only the user's text.
    const firstTurnText = this.composeFirstTurnPreamble(input.text);
    if (this.goalRunActive) {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: firstTurnText,
        delivery: false,
        invoke: () => session.steer(firstTurnText),
      });
      return { ok: true, acceptedAs: "steer" };
    }
    this.launchPrompt(firstTurnText, "initial");
    return { ok: true, acceptedAs: "prompt" };
  }

  private composeFirstTurnPreamble(turnText: string): string {
    // Standing prompt + wrapper note now ride the native `roleAdditional`
    // session option, so the first turn is just the user's text. Kept as a seam
    // in case per-turn preamble is needed later.
    return turnText;
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
  }): RuntimeSendResult {
    if (this.didClose) return { ok: false, reason: "closed" };
    const session = this.session;
    if (!session) return { ok: false, reason: "closed" };

    if (input.mode === "busy") {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: input.text,
        delivery: true,
        invoke: () => session.steer(input.text),
      });
      return { ok: true, acceptedAs: "steer" };
    }

    if (this.sdkTurnActive || this.goalRunActive) {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: input.text,
        delivery: true,
        invoke: () => session.steer(input.text),
      });
      return { ok: true, acceptedAs: "steer" };
    }

    this.launchPrompt(input.text, "delivery");
    return { ok: true, acceptedAs: "prompt" };
  }

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    if (this.didClose) return;
    this.requestedStopReason = opts?.reason;
    const signal = opts?.signal ?? "SIGTERM";
    const session = this.session;
    if (session) {
      try {
        await session.cancel();
      } catch (error) {
        this.events.emit("stderr", kimiErrorMessage(error));
      }
    }
    await this.disposeSession();
    this.emitExitAndClose(null, signal);
  }

  async dispose(): Promise<void> {
    if (this.didClose) return;
    await this.disposeSession();
    this.emitExitAndClose(0, null);
  }

  private emitSessionInit(): void {
    const sessionId = this.mappingState.sessionId;
    if (!sessionId || this.mappingState.sessionAnnounced) return;
    this.mappingState.sessionAnnounced = true;
    this.events.emit("runtime_event", { kind: "session_init", sessionId } satisfies ParsedEvent);
  }

  private handleSdkEvent(event: KimiSdkEvent): void {
    if (event.type === "goal.updated") {
      this.updateGoalState({ goal: event.snapshot });
      return;
    }

    if (event.type === "turn.started") {
      this.pendingTurnStartAttempt = undefined;
      this.sdkTurnActive = true;
    }

    if (this.emitDeliveryErrorForSdkBusyEvent(event)) return;

    if (event.type === "turn.ended" && this.goalRunActive) {
      this.sdkTurnActive = false;
      this.pendingTurnEndSessionId = this.mappingState.sessionId || undefined;
      return;
    }
    if (event.type === "turn.ended") {
      this.sdkTurnActive = false;
      if (this.pendingTurnEndSessionId) {
        const sessionId = this.pendingTurnEndSessionId;
        this.pendingTurnEndSessionId = undefined;
        this.emitSessionInit();
        this.events.emit("runtime_event", { kind: "turn_end", sessionId } satisfies ParsedEvent);
        return;
      }
    }
    for (const parsed of mapKimiSdkEventToParsedEvents(event, this.mappingState)) {
      this.events.emit("runtime_event", parsed);
    }
  }

  private flushPendingTurnEnd(): void {
    if (this.didClose || this.sdkTurnActive || this.goalRunActive || !this.pendingTurnEndSessionId) return;
    this.sdkTurnActive = false;
    const sessionId = this.pendingTurnEndSessionId;
    this.pendingTurnEndSessionId = undefined;
    this.emitSessionInit();
    this.events.emit("runtime_event", { kind: "turn_end", sessionId } satisfies ParsedEvent);
  }

  private async seedGoalState(session: KimiSession): Promise<void> {
    const getGoal = (session as { getGoal?: KimiSession["getGoal"] }).getGoal;
    if (!getGoal) return;
    try {
      this.updateGoalState(await getGoal.call(session));
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
  }

  private markGoalActive(): void {
    this.goalRunActive = true;
  }

  private updateGoalState(result: GoalToolResult): void {
    if (kimiGoalIsActive(result)) {
      this.markGoalActive();
      return;
    }
    this.goalRunActive = false;
    this.flushPendingTurnEnd();
  }

  private launchPrompt(text: string, delivery: "initial" | "delivery"): void {
    const session = this.session;
    if (!session) {
      this.events.emit("runtime_event", {
        kind: "error",
        message: "Kimi SDK session is not started",
      } satisfies ParsedEvent);
      return;
    }
    this.sdkTurnActive = true;
    const attemptId = this.trackTurnStartAttempt(text, delivery === "delivery");
    this.deferSdkCall({
      requestMethod: "turn/start",
      text,
      delivery: delivery === "delivery",
      invoke: () => session.prompt(text),
      onSettled: (fulfilled) => {
        if (!fulfilled) {
          this.clearTurnStartAttempt(attemptId);
          this.sdkTurnActive = false;
          this.pendingTurnEndSessionId = undefined;
        }
      },
    });
  }

  private trackTurnStartAttempt(text: string, delivery: boolean): number {
    const id = this.nextTurnStartAttemptId++;
    this.pendingTurnStartAttempt = { id, text, delivery };
    return id;
  }

  private clearTurnStartAttempt(attemptId: number): void {
    if (this.pendingTurnStartAttempt?.id === attemptId) {
      this.pendingTurnStartAttempt = undefined;
    }
  }

  private emitDeliveryErrorForSdkBusyEvent(event: KimiSdkEvent): boolean {
    if (event.type !== "error") return false;
    if (event.code !== "turn.agent_busy") return false;
    const attempt = this.pendingTurnStartAttempt;
    if (!attempt?.delivery) return false;

    this.pendingTurnStartAttempt = undefined;
    this.sdkTurnActive = false;
    this.pendingTurnEndSessionId = undefined;
    this.events.emit("runtime_event", {
      kind: "delivery_error",
      message: kimiErrorMessage(event),
      requestMethod: "turn/start",
      source: "kimi_sdk_response",
      code: "turn.agent_busy",
      payloadBytes: Buffer.byteLength(attempt.text, "utf8"),
    } satisfies ParsedEvent);
    return true;
  }

  private emitSdkCallError(input: {
    error: unknown;
    requestMethod: "turn/start" | "turn/steer";
    text: string;
    delivery: boolean;
  }): void {
    const message = kimiErrorMessage(input.error);
    if (input.delivery) {
      this.events.emit("runtime_event", {
        kind: "delivery_error",
        message,
        requestMethod: input.requestMethod,
        source: "kimi_sdk_response",
        code: kimiDeliveryErrorCode(message),
        payloadBytes: Buffer.byteLength(input.text, "utf8"),
      } satisfies ParsedEvent);
      return;
    }
    this.events.emit("runtime_event", {
      kind: "error",
      message,
    } satisfies ParsedEvent);
  }

  private deferSdkCall(input: {
    requestMethod: "turn/start" | "turn/steer";
    text: string;
    delivery: boolean;
    invoke: () => Promise<unknown>;
    onSettled?: (fulfilled: boolean) => void;
  }): void {
    setImmediate(() => {
      if (this.didClose) {
        input.onSettled?.(false);
        return;
      }
      try {
        void input.invoke()
          .then(
            () => {
              input.onSettled?.(true);
            },
            (error) => {
              if (!this.didClose) {
                this.emitSdkCallError({
                  error,
                  requestMethod: input.requestMethod,
                  text: input.text,
                  delivery: input.delivery,
                });
              }
              input.onSettled?.(false);
            },
          );
      } catch (error) {
        if (!this.didClose) {
          this.emitSdkCallError({
            error,
            requestMethod: input.requestMethod,
            text: input.text,
            delivery: input.delivery,
          });
        }
        input.onSettled?.(false);
      }
    });
  }

  private async disposeSession(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    const session = this.session;
    this.session = null;
    try {
      await session?.close();
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
    const harness = this.harness;
    this.harness = null;
    try {
      await harness?.close();
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
  }

  private emitExitAndClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.didClose) return;
    this.didClose = true;
    const info: RuntimeExitInfo = {
      code,
      signal,
      reason: this.requestedStopReason ? "requested" : "runtime_exit",
    };
    this.exitInfo = info;
    this.events.emit("exit", info);
    this.events.emit("close", info);
  }
}

/**
 * Read the kimi-code SDK's user config and surface whatever models the user
 * has provisioned (most commonly via `kimi login` / `kimi-code login`, which
 * fetches the catalog from Moonshot's `/models` endpoint and writes each
 * entry as `[models."<id>"]` plus a top-level `default_model`). The kimi-code
 * TUI reads exactly the same `config.models` map for its picker
 * (`apps/kimi-code/src/tui/commands/reload.ts`), so daemons surface the same
 * set the user sees in the upstream CLI — including newly-added rollouts
 * (e.g. K2.7) without a daemon-side hardcode bump.
 *
 * Implementation note: we do a narrow regex scan rather than instantiating a
 * `KimiHarness` (the SDK's canonical async API). The harness path is
 * heavier (instantiates `KimiCore`, sets up RPC, allocates logs) for what is
 * a one-shot read; the TOML shape under `[models.<id>]` is stable across
 * upstream versions and all we need is `id` + optional `display_name`. Same
 * shape as `detectKimiModels(home)` in `kimi.ts`. `resolveKimiHome()` is the
 * SDK's exported helper so we honor `KIMI_CODE_HOME` env overrides
 * (default fallback `~/.kimi-code`; see `packages/agent-core/src/config/path.ts`
 * upstream).
 *
 * Tracing: when a `RuntimeModelDetectionContext` is passed through, we
 * record exactly one terminal event `daemon.kimi_sdk.models.config` on the
 * parent `daemon.runtime_models.detect` span so production observers can
 * disambiguate the four reasons K2.7 (or any newly-rolled model) might fail
 * to surface — `outcome` ∈ {`models_returned`, `missing_config`, `no_models`,
 * `read_error`}. Attribute payload is intentionally low-cardinality (counts
 * + booleans + an errno code); model ids, display_names, default value, and
 * raw config bytes are deliberately omitted to keep user-provisioned model
 * rollouts out of trace exports.
 */
type KimiSdkDetectOutcome =
  | "models_returned"
  | "missing_config"
  | "no_models"
  | "read_error";

export function detectKimiSdkModels(
  home: string = resolveKimiHome(),
  ctx: RuntimeModelDetectionContext = {},
): RuntimeModelSourceOutcome {
  const span = ctx.span;
  const configPath = path.join(home, "config.toml");
  const homeFromEnv = Boolean(process.env.KIMI_CODE_HOME);

  const emit = (
    outcome: KimiSdkDetectOutcome,
    extra: Record<string, unknown> = {},
  ): void => {
    span?.addEvent("daemon.kimi_sdk.models.config", {
      outcome,
      kimi_code_home_env_set: homeFromEnv,
      ...extra,
    });
  };

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    // ENOENT = user hasn't run `kimi login` yet (expected first-launch
    // shape, distinguishable from real errors). Anything else (EACCES,
    // EISDIR, etc.) gets the `read_error` bucket so an oncall can tell
    // "host misconfigured" apart from "user never logged in".
    const missingConfig = code === "ENOENT";
    emit(missingConfig ? "missing_config" : "read_error", { errno_code: code });
    return missingConfig
      ? { kind: "missing_config", recovery: "kimi_login" }
      : { kind: "error", retryable: true };
  }

  const models: RuntimeModelInfo[] = [];
  // Match `[models.<key>]` and `[models."<key>"]`. `<key>` may contain `/`,
  // dots, dashes, etc. — we conservatively grab everything up to the closing
  // `]` and trim quoting.
  const sectionRe = /^\s*\[models\.(.+?)\s*\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null;
  let displayNamePresentCount = 0;
  while ((sectionMatch = sectionRe.exec(raw)) !== null) {
    let id = sectionMatch[1].trim();
    if (id.startsWith("\"") && id.endsWith("\"")) id = id.slice(1, -1);
    if (!id) continue;

    // Look for a `display_name = "..."` inside this model's body (lines
    // between this section header and the next `[...]` header). If the user
    // provisioned via `kimi login`, this is set by `provisionManagedKimiCodeConfig`
    // in `packages/oauth/src/managed-kimi-code.ts` upstream.
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSection = raw.slice(sectionStart).search(/^\s*\[/m);
    const body = nextSection === -1 ? raw.slice(sectionStart) : raw.slice(sectionStart, sectionStart + nextSection);
    const displayMatch = body.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
    const label = displayMatch ? displayMatch[1] : id;
    if (displayMatch) displayNamePresentCount++;

    const effortListMatch = body.match(/^\s*support_efforts\s*=\s*\[([^\]]*)\]/m);
    const supportedReasoningEfforts = effortListMatch
      ? [...effortListMatch[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
          .map((match) => match[1])
          .filter((effort) => effort.length > 0 && effort.trim() === effort && !effort.includes("\0"))
      : [];
    const defaultEffortMatch = body.match(/^\s*default_effort\s*=\s*"([^"]+)"/m);
    const defaultReasoningEffort = defaultEffortMatch && supportedReasoningEfforts.includes(defaultEffortMatch[1])
      ? defaultEffortMatch[1]
      : undefined;

    models.push({
      id,
      label,
      verified: "launchable",
      ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }

  let defaultModel: string | undefined;
  const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (defaultMatch) defaultModel = defaultMatch[1];

  if (models.length === 0) {
    // Config exists but `[models.*]` is empty — login completed without any
    // model granted, or upstream changed the schema. Distinct from
    // `missing_config` so an oncall can tell whether the user logged in.
    emit("no_models", { default_model_present: Boolean(defaultModel) });
    return { kind: "no_models", recovery: "kimi_login" };
  }

  emit("models_returned", {
    models_count: models.length,
    display_name_present_count: displayNamePresentCount,
    default_model_present: Boolean(defaultModel),
  });

  return { kind: "live", value: { models, default: defaultModel } };
}

/**
 * Kimi SDK driver.
 *
 * Slock runs Kimi through the @botiverse/kimi-code-sdk Node SDK as a native
 * RuntimeSession. The legacy child-process kimi-cli driver (id "kimi") stays
 * registered alongside this one (frontend marks it deprecated). Visible
 * chat/task/attachment communication goes through the workspace-local `raft`
 * CLI wrapper, whose absolute path is surfaced to the LLM via the SDK's native
 * `roleAdditional` standing slot (process.env.PATH inheritance is unsafe across
 * in-process agents).
 */
export class KimiSdkDriver implements RuntimeDriver {
  readonly id = "kimi-sdk";
  /**
   * Genuine native support: the standing prompt (and wrapper CLI note) are
   * mounted via the Kimi SDK's `roleAdditional` session option, which renders
   * into the base system prompt on every request and therefore survives context
   * compaction — no per-turn re-assertion needed. See
   * composeStandingRoleAdditional + createKimiAgentSessionForContext.
   */
  readonly supportsNativeStandingPrompt = true;
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "suggestion_only" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;

  private sessionId: string | null = null;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  probe(): RuntimeProbeResult {
    // SDK is in-process — availability is "is the package importable".
    // The import at the top of this file would have failed at module-load if
    // not, so by the time probe() runs the SDK is available.
    return { available: true, version: KIMI_CODE_HOST_VERSION };
  }

  async detectModels(ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return detectKimiSdkModels(undefined, ctx);
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new KimiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    });
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error("KimiSdkDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
