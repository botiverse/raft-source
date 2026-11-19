// OpenCode on OAR, behind the server flag `agent_runtime_oar_opencode`
// (default off) and the Computer capability `runtime-host:oar:opencode`.
//
// OAR runs `opencode acp`: one session that lives across turns, where the
// legacy driver runs `opencode run` per turn. Raft supplies what the driver
// supplies around it, from the same preparation:
//
// - Standing prompt: in Raft's own injected config (`OPENCODE_CONFIG_CONTENT`,
//   the `slock` agent's `prompt`) with `default_agent: slock`, since ACP takes
//   no `--agent` and OAR refuses `systemPrompt` / `appendSystemPrompt` on
//   OpenCode 2.x. Never OAR's prompt options: on 1.x those need
//   `OPENCODE_CONFIG_CONTENT` unset, and Raft's config carries the user's
//   provider, agent and MCP entries.
// - Environment (`prepareOpenCodeOarEnvironment`): the driver's own: Raft's
//   CLI transport, the injected config, on 2.x no project config
//   (`OPENCODE_DISABLE_PROJECT_CONFIG`) and an empty config directory (no
//   user plugins), and `PWD` = the agent's workspace. On 1.x `--pure` (no
//   external plugins) goes as a launch argument, as the driver passes it to
//   `opencode run`.
// - Managed MCP: `SessionOptions.mcpServers`, HTTP with the token as a bearer
//   header (oarManagedMcp.ts), on every open, attached whenever the driver
//   would attach it (an empty catalog included: OpenCode reloads a changed
//   tool list). The token is no longer in the config text.
// - Model: OAR's `model` (its `set_config_option`), "default" leaves OpenCode's.
// - Resume: OpenCode's own session id, in OpenCode's own store (the same HOME,
//   XDG directories and workspace the driver uses), so either host resumes the
//   other's session. Raft's rule stands: never across OpenCode major lines
//   (`decideOpenCodeSessionResume`, the driver's record file); a session the
//   rule refuses is handed back to the driver, which shows the refusal. A
//   session this host opens is recorded the same way (`sessionOpened`).
// - Version: 1.x from 1.18.30, 2.x from 2.0.27, nothing from 3.0 (OAR's
//   adapter was checked against these). Another version keeps the driver.
// - Opens are serialized per Computer (`openOpencodeSerially`).
// - Deliveries are prompts first (`promptFirst`, OAR #777), steered on
//   `busy` where the session can steer (1.x; 2.x from 2.2.7, which
//   advertises `_session/steering`), else held for the turn end.

import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import type { Session } from "@botiverse/oar";
import path from "node:path";
import {
  decideOpenCodeSessionResume,
  ensureOpenCodeSessionRecordWritable,
  openCodeSessionRecordPath,
  prepareOpenCodeOarEnvironment,
  readOpenCodeSessionRecord,
  readOpenCodeVersionDetailedAsync,
  resolveOpenCodeSpawnAsync,
  writeOpenCodeSessionRecord,
  type OpenCodeSessionResumeDecision,
  type OpenCodeVersionRead,
} from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { prepareManagedMcpRuntimeProxy, type ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { resolveRaftHome } from "../raftHome";
import { launchEnvOverlay } from "./oarGrokLaunch";
import { OarLaunchDeclined, type OarLaunch } from "./oarLaunch";
import { managedMcpSessionOptions } from "./oarManagedMcp";

/** The oldest OpenCode of each line the OAR host runs (the versions OAR's OpenCode adapter was checked against). */
export const OAR_OPENCODE_MIN_VERSIONS = { 1: [1, 18, 30], 2: [2, 0, 27] } as const;

export interface OpencodeRelease {
  major: 1 | 2;
  minor: number;
  patch: number;
}

/**
 * An OpenCode version string as the driver reads it (`1.18.35`, `opencode
 * v2.0.27`, `2.3.0-beta.1`) to its release, or null: unreadable, or a major
 * line other than 1 and 2.
 */
export function opencodeReleaseOf(version: string | null | undefined): OpencodeRelease | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return null;
  const major = Number(match[1]);
  if (major !== 1 && major !== 2) return null;
  return { major, minor: Number(match[2]), patch: Number(match[3]) };
}

/** Whether the OAR host runs this OpenCode: 1.x from 1.18.30, 2.x from 2.0.27, below 3. */
export function isOarOpencodeVersion(version: string | null | undefined): boolean {
  const release = opencodeReleaseOf(version);
  if (!release) return false;
  const minimum = OAR_OPENCODE_MIN_VERSIONS[release.major];
  const actual = [release.major, release.minor, release.patch];
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! !== minimum[i]) return actual[i]! > minimum[i]!;
  }
  return true;
}

/**
 * One OpenCode session open at a time in this process. Several first starts
 * at once on a fresh OpenCode database collide on OpenCode's own table
 * creation, so a Computer opens its OpenCode sessions one by one, in the
 * order they asked. A start stopped while it waits leaves the queue (its
 * `signal` aborts) without opening; the next one still waits for the open
 * before it.
 */
export function createOpenGate(): (open: () => Promise<Session>, signal: AbortSignal) => Promise<Session> {
  let tail: Promise<void> = Promise.resolve();
  return async (open, signal) => {
    const previous = tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    tail = previous.then(() => mine);
    try {
      await untilOrAborted(previous, signal);
      return await open();
    } finally {
      release();
    }
  };
}

async function untilOrAborted(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  const aborted = () => Object.assign(new Error("OpenCode open cancelled while waiting for another open"), { name: "AbortError" });
  if (signal.aborted) throw aborted();
  let onAbort: (() => void) | null = null;
  try {
    await Promise.race([
      wait,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** This process's OpenCode open queue. */
export const openOpencodeSerially = createOpenGate();

/** What the OpenCode launch reads before it builds anything; tests replace them. */
export interface OpencodeLaunchDeps {
  readVersion?: (signal?: AbortSignal) => Promise<OpenCodeVersionRead>;
  resolveCommand?: (signal?: AbortSignal) => Promise<string>;
  prepareEnvironment?: (ctx: SpawnContext, version: string) => Promise<NodeJS.ProcessEnv>;
  prepareManagedMcp?: (ctx: SpawnContext) => Promise<ManagedMcpRuntimeEndpoint | null>;
  openGate?: OarLaunch["openGate"];
  inherited?: NodeJS.ProcessEnv;
}

/**
 * Whether a start may resume its session on the installed OpenCode, by the
 * driver's rule and record (`decideOpenCodeSessionResume`). Anything but
 * `fresh` or `resume` is the driver's to show: declined.
 */
export function opencodeResumeOrDecline(decision: OpenCodeSessionResumeDecision): "fresh" | "resume" {
  if (decision.kind === "fresh" || decision.kind === "resume") return decision.kind;
  if (decision.kind === "version_unknown") throw new OarLaunchDeclined("opencode_version_unknown");
  throw new OarLaunchDeclined(`opencode_session_refused:${decision.reason}`);
}

/** A prepared OpenCode launch as an OAR launch. */
export function opencodeOarLaunch(
  ctx: SpawnContext,
  plan: {
    command: string;
    release: OpencodeRelease;
    env: NodeJS.ProcessEnv;
    resume: string | null;
    managedMcp?: ManagedMcpRuntimeEndpoint | null;
    /** The driver's record of which OpenCode major runs the session, written once it is open. */
    record: { path: string; version: string; alreadyRecorded: boolean } | null;
    openGate?: OarLaunch["openGate"];
  },
  inherited: NodeJS.ProcessEnv = process.env,
): OarLaunch {
  const { model } = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const { release, record } = plan;
  const pinned = Boolean(model) && model !== "default";
  return {
    runtimeId: "opencode",
    installation: {
      kind: "available",
      via: "executable",
      command: plan.command,
      // Read already (the version gate): OAR runs no `--version` of its own.
      version: `${release.major}.${release.minor}.${release.patch}`,
    },
    options: {
      cwd: ctx.workingDirectory,
      env: launchEnvOverlay(plan.env, inherited),
      ...(pinned && model ? { model } : {}),
      ...(plan.resume ? { resume: plan.resume } : {}),
      // Given on every open: OpenCode keeps none across a resume.
      ...managedMcpSessionOptions(plan.managedMcp),
      // 1.x: no external plugins, as the driver runs `opencode run --pure`.
      // 2.x has no such flag; its environment gives the same isolation.
      ...(release.major === 1 ? { launchArgs: ["--pure"] } : {}),
    },
    // 1.x steers (a second `session/prompt` joins the running loop); 2.x from
    // 2.2.7 through `_session/steering`. A session without `steer` (2.x
    // before 2.2.7) holds busy deliveries for the turn end.
    busyDelivery: "now",
    promptFirst: true,
    ...(plan.openGate ? { openGate: plan.openGate } : {}),
    ...(record
      ? {
        sessionOpened: (session: Session) => {
          if (record.alreadyRecorded && session.id === plan.resume) return;
          writeOpenCodeSessionRecord(record.path, {
            version: 1,
            sessionId: session.id,
            opencodeMajor: release.major,
            opencodeVersion: record.version,
            recordedAt: new Date().toISOString(),
          });
        },
      }
      : {}),
    ...(release.major === 2 ? { newSessionOnResumeElsewhere: true as const } : {}),
  };
}

export async function prepareOpencodeOarLaunch(ctx: SpawnContext, deps: OpencodeLaunchDeps = {}): Promise<OarLaunch> {
  const signal = ctx.launchSignal;
  // The installed OpenCode, read now: the ready frame's version can be older
  // than an upgrade since.
  const read = await (deps.readVersion ?? ((s) => readOpenCodeVersionDetailedAsync({ signal: s })))(signal);
  if (read.kind === "unknown") throw new OarLaunchDeclined("opencode_version_unknown");
  const release = opencodeReleaseOf(read.version);
  if (!release || !isOarOpencodeVersion(read.version)) throw new OarLaunchDeclined("opencode_version_unsupported");
  const command = await (deps.resolveCommand ?? (async (s) => (await resolveOpenCodeSpawnAsync([], { signal: s })).command))(signal);

  // Never across OpenCode major lines (the driver's rule and record file).
  const slockHome = ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome();
  const recordPath = openCodeSessionRecordPath(slockHome, ctx.agentId);
  const recordRead = readOpenCodeSessionRecord(recordPath);
  const sessionId = ctx.config.sessionId?.trim() || null;
  const choice = opencodeResumeOrDecline(decideOpenCodeSessionResume(sessionId, recordRead, read.version));
  // A session that could not be recorded afterwards would be resumable
  // without provenance: proved writable before anything starts.
  ensureOpenCodeSessionRecordWritable(recordPath);
  const alreadyRecorded = choice === "resume" && recordRead.kind === "record"
    && recordRead.record.sessionId === sessionId && recordRead.record.opencodeMajor === release.major;

  const env = await (deps.prepareEnvironment ?? prepareOpenCodeOarEnvironment)(ctx, read.version);
  // Attached as the driver attaches it: always, an empty catalog included.
  const managedMcp = await (deps.prepareManagedMcp ?? ((c: SpawnContext) => prepareManagedMcpRuntimeProxy({
    agentId: c.agentId,
    launchId: c.launchId,
    processInstanceId: c.processInstanceId,
    readTurnOrigin: c.readTurnOrigin,
    serverUrl: c.config.serverUrl,
    agentCredentialKey: c.config.agentCredentialKey,
  })))(ctx);
  return opencodeOarLaunch(ctx, {
    command,
    release,
    env,
    resume: choice === "resume" ? sessionId : null,
    managedMcp,
    record: { path: recordPath, version: read.version, alreadyRecorded },
    openGate: deps.openGate ?? openOpencodeSerially,
  }, deps.inherited);
}
