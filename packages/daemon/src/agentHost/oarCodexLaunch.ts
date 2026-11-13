// Codex on OAR (RFC 060; #wg-ax:#3), wherever the Computer advertises the
// `runtime-host:oar:codex` capability (the server's flag is retired).
//
// OAR runs `codex app-server -c sandbox_mode="danger-full-access" [launchArgs]
// --listen stdio://`, the app-server the legacy driver runs (it sets the
// sandbox in the thread params instead). Raft supplies what the driver
// supplies around it, from the same preparation (`prepareCodexLaunch`,
// `codexThreadFields`): the resolved executable, the app-server environment
// (Raft's CLI transport, daemon credentials removed), model, effort, service
// tier and the thread to resume, plus the standing prompt as
// `appendSystemPrompt`, which OAR sends as `developerInstructions` like the
// driver. Never `systemPrompt`: on codex that is `baseInstructions`, which
// replaces Codex's own base prompt.
//
// The managed MCP server goes as `SessionOptions.mcpServers` (oarManagedMcp.ts,
// #oar-raft:#8): OAR sends it as the `mcp_servers` config override of
// `thread/start` / `thread/resume`, the token as its `http_headers` bearer, over
// the app-server's stdin. The driver's `-c` overrides and its token variable
// (`RAFT_MANAGED_MCP_TOKEN`, read through `bearer_token_env_var`) are not
// passed: the token is no longer in the app-server's environment.
//
// With a managed MCP server the first input waits (bounded) for Codex to
// report it started, as the driver holds its first turn (`firstInputReady`).
//
// Resume: OAR's `resume` is the Codex thread id (`thread/resume`), in the same
// CODEX_HOME under the same environment, so a thread the legacy driver started
// is the thread OAR resumes.
//
// Not passed yet: the thread name (`Raft · <agent>`). Since OAR 0.87.2 a
// failed `thread/name/set` (older app-servers lack it) no longer fails the
// open (OAR records a `thread/name/set/error` frame), as the driver ignores
// it. There is no version floor: OAR needs a `serviceTier` in the open reply
// (the tier is always explicit here) and, for a resume whose effort changed,
// `thread/settings/updated` within OAR's 10 s; the driver needs neither. An
// older Codex fails the open and the start falls back to the legacy host.

import type { RawEvent, Session } from "@botiverse/oar";
import { CODEX_MANAGED_MCP_TOKEN_ENV, codexCandidateTraceAttrs, codexThreadFields, prepareCodexLaunch, type CodexLaunchPreparation } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { launchEnvOverlay } from "./oarGrokLaunch";
import type { FirstInputReadiness, OarLaunch } from "./oarLaunch";
import { managedMcpSessionOptions } from "./oarManagedMcp";

/**
 * How long the first input waits for the managed MCP server. Codex gives an
 * MCP server 10 s to start by default (`startup_timeout_sec`) and then
 * reports it failed; this only covers a Codex that never reports.
 */
export const CODEX_MANAGED_MCP_READY_TIMEOUT_MS = 30_000;

const MCP_STARTUP_FRAME = "mcpServer/startupStatus/updated";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one record says about the wait: the server's report, or Codex gone (nothing more will come). */
export function mcpStartupOutcome(record: RawEvent, serverName: string): FirstInputReadiness["outcome"] | null {
  if (record.kind === "response" && record.body.kind === "exited") return "exited";
  if (record.kind !== "frame" || record.body.type !== MCP_STARTUP_FRAME) return null;
  const native = record.body.native;
  if (!isRecord(native) || native.name !== serverName) return null;
  if (native.status === "ready") return "ready";
  return native.status === "failed" || native.status === "cancelled" ? "failed" : null;
}

/**
 * Waits until Codex reports the managed MCP server started (or failed to), as
 * the driver holds its first `turn/start` for that report: a first turn sent
 * earlier runs without Raft's MCP tools. OAR keeps the report as a frame
 * (no event), recorded even when it came before the thread opened, so the
 * replay from the stream's start sees it.
 */
export function awaitCodexManagedMcp(
  session: Pick<Session, "id" | "rawEvents">,
  serverName: string,
  signal: AbortSignal,
  timeoutMs = CODEX_MANAGED_MCP_READY_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<FirstInputReadiness> {
  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (outcome: FirstInputReadiness["outcome"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      resolve({ waitedFor: "managed_mcp", outcome, waitedMs: now() - startedAt });
    };
    const onAbort = () => finish("stopped");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) return finish("stopped");
    const subscription = session.rawEvents((record) => {
      const outcome = mcpStartupOutcome(record, serverName);
      if (outcome) finish(outcome);
    }, { sessionId: session.id, afterSeq: -1 });
    // A recorded report is replayed during the subscribe call itself.
    if (settled) subscription();
    else unsubscribe = subscription;
  });
}

/**
 * The tier as Codex names it. Codex takes `fast` but reports the thread's tier
 * as `priority`, and OAR refuses an open whose reported tier is not the one
 * requested, so Raft asks for the native id. `default` clears a tier the
 * thread or the Codex config would otherwise keep (#11175). Probed on codex
 * 0.144.5, 0.163.0 and 0.166.0 (`thread/start`): `fast` and `priority` report
 * `priority`, `default` and `null` report `default`.
 */
export const CODEX_OAR_SERVICE_TIER = { fast: "priority", standard: "default" } as const;

/** A prepared Codex launch as an OAR launch. */
export function codexOarLaunch(
  ctx: SpawnContext,
  prep: Pick<CodexLaunchPreparation, "command" | "args" | "appServerArgs" | "spawnEnv" | "appServerEnv" | "windowsShim" | "managedMcp">,
  inherited: NodeJS.ProcessEnv = process.env,
): OarLaunch {
  // OAR starts `<command> app-server …` itself, so a launch whose command is
  // the Codex executable carries over as it is. On Windows the driver's
  // resolution can instead run a Node script through a node host (`<node>
  // <codex.js> app-server …`: an npm install, a `.cmd` shim on PATH or in
  // CODEX_BIN); OAR gets the `.cmd` shim that script came from, set only
  // when OAR runs the shim's script itself without cmd.exe (an npm or pnpm
  // shim: the shim's own node.exe, else `node` on PATH; codex.ts
  // oarRunnableShim). With no such shim the start falls back to the driver.
  // The node host's environment (Electron's Node mode) is not that node's,
  // so the transport env goes instead.
  const viaHost = prep.args.length !== prep.appServerArgs.length || prep.args.some((arg, i) => arg !== prep.appServerArgs[i]);
  const command = viaHost ? prep.windowsShim : prep.command;
  if (!command) throw new Error("OAR host cannot launch a Codex app-server that runs through a host command without its npm shim");
  const fields = codexThreadFields(ctx);
  const { managedMcp } = prep;
  // The driver's token variable stays out: the token travels in the session's MCP entry.
  const appServerEnv = { ...(viaHost ? prep.spawnEnv : prep.appServerEnv) };
  delete appServerEnv[CODEX_MANAGED_MCP_TOKEN_ENV];
  return {
    runtimeId: "codex",
    installation: { kind: "available", via: "executable", command },
    options: {
      cwd: fields.cwd,
      env: launchEnvOverlay(appServerEnv, inherited),
      // On every open, as the driver re-sends it: OAR applies it to a resumed
      // thread too (after Codex's next compaction when it changed).
      appendSystemPrompt: fields.developerInstructions,
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.reasoningEffort ? { effort: fields.reasoningEffort } : {}),
      serviceTier: fields.fast ? CODEX_OAR_SERVICE_TIER.fast : CODEX_OAR_SERVICE_TIER.standard,
      ...(fields.resumeThreadId ? { resume: fields.resumeThreadId } : {}),
      ...managedMcpSessionOptions(managedMcp),
      // A Stop ends what the turn started, as the driver kills the turn's
      // process tree after turn/interrupt (Codex leaves a running command and
      // its detached children alive). OAR keeps processes that ran before the
      // prompt (MCP servers, earlier background commands). On Windows OAR ends
      // nothing: it interrupts the turn in place and the turn's commands keep
      // running. The driver sends no turn/interrupt there; its Stop restarts
      // the app-server.
      endTurnProcessesOnAbort: true,
    },
    // Codex steers natively (`turn/steer`), as the driver delivers to a busy session.
    busyDelivery: "now",
    ...(managedMcp ? { managedMcpServerName: managedMcp.name } : {}),
    ...(managedMcp ? { firstInputReady: (session, signal) => awaitCodexManagedMcp(session, managedMcp.name, signal) } : {}),
  };
}

/**
 * Records which Codex install this launch picked on the span the legacy driver
 * records it on (`daemon.runtime.node_host_launch`, #14189), with
 * `host: "oar"`: path-free, so one event name answers it on either host. An
 * install OAR cannot run (a node host without its npm shim) ends it in error;
 * the start then falls back to the legacy driver, which records its own.
 */
export async function prepareCodexOarLaunch(
  ctx: SpawnContext,
  prepare: (ctx: SpawnContext) => Promise<CodexLaunchPreparation> = prepareCodexLaunch,
): Promise<OarLaunch> {
  const prep = await prepare(ctx);
  const span = ctx.tracer?.startSpan("daemon.runtime.node_host_launch", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: ctx.agentId,
      launchId: ctx.launchId || undefined,
      runtime: "codex",
      host: "oar",
      ...codexCandidateTraceAttrs(prep),
    },
  });
  try {
    const launch = codexOarLaunch(ctx, prep);
    span?.end("ok");
    return launch;
  } catch (error) {
    span?.end("error", { attrs: { error_class: error instanceof Error ? error.name : "Error" } });
    throw error;
  }
}
