import { RuntimeExecutableNotFoundError, RuntimeSessionRuntimeMismatchError } from "../spawnFailureErrors";
import { ambientProcessEnv } from "../processEnvPatch";
import { resolveRaftHome } from "../raftHome";
import { spawnSync } from "node:child_process";
import { spawnRuntimeChild } from "./runtimeChild";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatRuntimeProviderModelLabel, hydrateRuntimeConfig, runtimeConfigToLaunchFields, runtimeModelSourceOutcomeFromSet, type AgentConfig, type AgentMessage, type RuntimeModelInfo, type RuntimeModelSet, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { resolveNodeHostLaunch } from "./nodeHostLaunch";
import { lookupCommandOnPath, readCommandVersion, readCommandVersionDetailedAsync, resolveCommandOnPath, resolveCommandOnPathAsync, withWindowsUserEnvironmentAsync, type CommandVersionRead, type ProbeDeps } from "./probe";
import { ProbeChildError } from "./probeChild";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, RuntimeQuietOutputDeadline, SpawnContext, SpawnResult } from "./types";
import { prepareManagedMcpRuntimeProxy } from "../managedMcpRuntimeProxy";
import type { InstallationSnapshot, ModelLister, Runtime } from "@botiverse/oar";
import { loadOarRuntime } from "../oarLoader";
import { detectModelSourceViaOar } from "../runtimeModels/oarListModels";

const SLOCK_AGENT_NAME = "slock";
const NO_MESSAGE_PROMPT = "No new messages are pending. Stop now.";
const FIRST_MESSAGE_TASK_PREFIX = "First message task (system-triggered):";
export const MIN_SUPPORTED_OPENCODE_VERSION = "1.14.30";

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    /** 1.x: the provider's call id. */
    callID?: string;
    /** 2.x: the provider's call id (the part id moved to `partID`). */
    id?: string;
    state?: {
      status?: string;
      input?: unknown;
      /** 1.x bash: `exit`; 2.x: `metadata.exit`. */
      metadata?: { exit?: unknown; metadata?: { exit?: unknown } };
      time?: { start?: unknown; end?: unknown };
    };
    reason?: string;
  };
  error?: {
    name?: string;
    data?: {
      message?: string;
    };
    message?: string;
  };
  /** 2.x `background_wait` (since 2.2.6): the jobs the run waits for. */
  jobs?: unknown;
}

interface OpenCodeModelsCommandResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

type OpenCodeModelsCommand = (home: string) => OpenCodeModelsCommandResult;

export interface OpenCodeModelsCommandDeps extends OpenCodeProbeDeps {
  spawnSyncFn?: typeof spawnSync;
}

interface OpenCodeProbeDeps extends ProbeDeps {
  readFileSyncFn?: typeof readFileSync;
}

interface OpenCodeLaunchSpecOptions {
  home?: string;
  readVersion?: () => string | null;
}

export interface OpenCodeLaunchOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  config: Record<string, unknown>;
}

export interface OpenCodeSpawnSpec {
  command: string;
  args: string[];
  shell: false;
  env?: NodeJS.ProcessEnv;
}

function parseOpenCodeConfigContent(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore invalid user-provided config content rather than blocking launch.
  }
  return {};
}

function parseUserOpenCodeConfig(ctx: SpawnContext): Record<string, unknown> {
  const raw = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config)).envVars?.OPENCODE_CONFIG_CONTENT;
  return parseOpenCodeConfigContent(raw);
}

function readLocalOpenCodeConfig(home: string = os.homedir()): Record<string, unknown> {
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  try {
    return parseOpenCodeConfigContent(readFileSync(configPath, "utf8"));
  } catch {
    // Missing or invalid local OpenCode config is not fatal.
  }
  return {};
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedOpenCodeVersion(version: string | null | undefined): boolean {
  if (!version) return true;
  const actual = parseSemver(version);
  const minimum = parseSemver(MIN_SUPPORTED_OPENCODE_VERSION);
  if (!actual || !minimum) return true;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

const AGENT_FLAG_CUTOFF_VERSION = "1.15.0";

export function requiresAgentCliFlag(version: string | null | undefined): boolean {
  if (!version) return true;
  const actual = parseSemver(version);
  const cutoff = parseSemver(AGENT_FLAG_CUTOFF_VERSION);
  if (!actual || !cutoff) return true;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > cutoff[i]) return false;
    if (actual[i] < cutoff[i]) return true;
  }
  return false;
}

/**
 * task #1258: OpenCode 2.0 is a different launch contract (private server
 * per run, `--auto` instead of `--dangerously-skip-permissions`, no `--pure`
 * / `--dir`). The 2.x branch is a PROPOSED support range anchored on the one
 * version that was actually exercised end to end (config injection, session
 * resume, tool events, process cleanup); a later 2.x may still change the
 * beta's CLI and is admitted on that basis, not verified. 3.x and later are
 * refused until read.
 */
export const OPENCODE_V2_VERIFIED_VERSION = "2.0.27";
export const OPENCODE_V2_MIN_VERSION = OPENCODE_V2_VERIFIED_VERSION;
export const OPENCODE_UNSUPPORTED_MAJOR = 3;

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/** Major version of an OpenCode CLI version string; null when unparseable/unknown. */
export function openCodeMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const parsed = parseSemver(version);
  return parsed ? parsed[0] : null;
}

/** 2.x in the proposed support range (>= OPENCODE_V2_MIN_VERSION, < 3). */
export function isOpenCodeV2Launch(version: string | null | undefined): boolean {
  const parsed = version ? parseSemver(version) : null;
  const minimum = parseSemver(OPENCODE_V2_MIN_VERSION);
  if (!parsed || !minimum) return false;
  return parsed[0] === 2 && compareSemver(parsed, minimum) >= 0;
}

export function unsupportedOpenCodeVersionMessage(version: string | null | undefined): string | null {
  if (!version) return null;
  const parsed = parseSemver(version);
  if (!parsed) return null;
  if (parsed[0] >= OPENCODE_UNSUPPORTED_MAJOR) {
    return `OpenCode CLI ${version} is not supported yet: Raft has only read the 1.x line and OpenCode ${OPENCODE_V2_VERIFIED_VERSION} (2.x). Install a supported release before starting this runtime.`;
  }
  if (parsed[0] === 2) {
    if (isOpenCodeV2Launch(version)) return null;
    return `OpenCode CLI ${version} is an early 2.0 beta below ${OPENCODE_V2_MIN_VERSION}, the first 2.x release Raft verified; upgrade opencode (2.x) before starting this runtime.`;
  }
  if (isSupportedOpenCodeVersion(version)) return null;
  return `OpenCode CLI ${version} is unsupported; requires OpenCode >= ${MIN_SUPPORTED_OPENCODE_VERSION}. Upgrade opencode before starting this runtime.`;
}

/** The version lines this driver launches, for probe output and messages. */
export function openCodeSupportedRangeText(): string {
  return `>= ${MIN_SUPPORTED_OPENCODE_VERSION} (1.x) or >= ${OPENCODE_V2_MIN_VERSION} (2.x, proposed range below 3.0)`;
}

/**
 * task #1258 — which OpenCode major line an agent's saved session was made
 * by. OpenCode 1.x and 2.x keep separate session stores and a 2.x
 * `--session <id>` with an id it does not know silently CREATES a session under
 * that id (observed on 2.0.27), so a resume across majors would look like
 * success while losing the conversation. The daemon therefore records, per
 * agent, the major that last ran the session, and refuses a resume when the
 * installed CLI is on another major (or when the record is missing and the
 * CLI is 2.x: every session that predates this record was made by 1.x, because
 * no 2.x launch succeeded before task #1258). The server's `sessionId` and the
 * record are left untouched by a refusal; only Reset Session (a new session)
 * or installing the recorded major gets out.
 *
 * Record file: `<SLOCK_HOME>/opencode-sessions/<agentId>.json`, daemon-owned,
 * outside the agent workspace.
 */
export interface OpenCodeSessionRecord {
  version: 1;
  sessionId: string;
  opencodeMajor: number;
  opencodeVersion: string;
  recordedAt: string;
}

export type OpenCodeSessionRefusalReason =
  /** the record names another major than the installed CLI */
  | "major_mismatch"
  /** no record for this session and the CLI is 2.x: a pre-record session is 1.x by construction, never guessed */
  | "unrecorded"
  /** a record file exists but cannot be read or parsed: nothing can be proven, so nothing is resumed */
  | "record_unreadable";

export type OpenCodeSessionResumeDecision =
  | { kind: "fresh" }
  | { kind: "resume" }
  /**
   * task #1365 — the installed CLI's version could not be read or parsed, so
   * whether this session may be resumed cannot be decided yet. Neither
   * compatible nor incompatible: the start fails retryably and the record and
   * session id are left alone.
   */
  | { kind: "version_unknown" }
  | { kind: "refuse"; reason: OpenCodeSessionRefusalReason; recordedMajor: number | null };

/**
 * What reading the record file found. "missing" (no file) and "unreadable"
 * (a file that cannot be read or parsed) are kept apart on purpose: only a
 * missing file may be treated as "this session predates the record" (review
 * on task #1258: a corrupt record must not turn a 2.x session back into a
 * resumable 1.x one).
 */
export type OpenCodeSessionRecordRead =
  | { kind: "missing" }
  | { kind: "unreadable"; detail: string }
  | { kind: "record"; record: OpenCodeSessionRecord };

const OPENCODE_SESSION_RECORD_DIR = "opencode-sessions";
/** task #1258: a daemon-owned directory kept empty, handed to 2.x as its config directory. */
export const OPENCODE_EMPTY_CONFIG_DIR = "opencode-config-empty";

function safeRecordPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function openCodeSessionRecordPath(slockHome: string, agentId: string): string {
  return path.join(slockHome, OPENCODE_SESSION_RECORD_DIR, `${safeRecordPathPart(agentId)}.json`);
}

export function readOpenCodeSessionRecord(filePath: string, deps: { readFileSyncFn?: typeof readFileSync } = {}): OpenCodeSessionRecordRead {
  const readFileSyncFn = deps.readFileSyncFn ?? readFileSync;
  let raw: string;
  try {
    raw = String(readFileSyncFn(filePath, "utf8"));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // Only a plain absence is "missing". ENOTDIR (a file where the record
    // directory should be) and every other error are unreadable evidence.
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", detail: `read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: Partial<OpenCodeSessionRecord> | null;
  try {
    parsed = JSON.parse(raw) as Partial<OpenCodeSessionRecord> | null;
  } catch (error) {
    return { kind: "unreadable", detail: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unreadable", detail: "not an object" };
  if (parsed.version !== 1) return { kind: "unreadable", detail: `unknown record version ${String(parsed.version)}` };
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return { kind: "unreadable", detail: "sessionId missing" };
  if (typeof parsed.opencodeMajor !== "number" || !Number.isInteger(parsed.opencodeMajor)) return { kind: "unreadable", detail: "opencodeMajor missing" };
  return {
    kind: "record",
    record: {
      version: 1,
      sessionId: parsed.sessionId,
      opencodeMajor: parsed.opencodeMajor,
      opencodeVersion: typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion : "",
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
    },
  };
}

export function writeOpenCodeSessionRecord(filePath: string, record: OpenCodeSessionRecord): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

/**
 * Prove, before the CLI is launched, that a record can be persisted where
 * `writeOpenCodeSessionRecord` will put it (directory creatable, file
 * writable, rename allowed). A launch whose session could not be recorded
 * afterwards would be resumable without provenance, so it is refused here
 * instead, with the cause. Review finding on task #1258.
 */
export function ensureOpenCodeSessionRecordWritable(filePath: string): void {
  const probe = `${filePath}.${process.pid}.probe`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(probe, "", { encoding: "utf8", mode: 0o600 });
    renameSync(probe, `${probe}.ok`);
    rmSync(`${probe}.ok`, { force: true });
  } catch (error) {
    try {
      rmSync(probe, { force: true });
    } catch {
      // the probe never came to exist; the original error is the one to report
    }
    throw new Error(`Cannot persist the OpenCode session record under ${path.dirname(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resume only when the record says the session was last run by the installed
 * major. A missing record (or one for another session id) is "unknown": a 1.x
 * CLI resumes it as before (1.x behaviour unchanged), a 2.x CLI refuses it
 * rather than guessing. An unreadable record proves nothing either way and is
 * refused on every major. An unknown installed version decides nothing
 * (task #1365): it used to be read as 1.x, which turned a failed version read
 * into a permanent major mismatch for every 2.x session.
 */
export function decideOpenCodeSessionResume(
  sessionId: string | null | undefined,
  read: OpenCodeSessionRecordRead,
  installedVersion: string | null | undefined,
): OpenCodeSessionResumeDecision {
  if (!sessionId) return { kind: "fresh" };
  if (read.kind === "unreadable") return { kind: "refuse", reason: "record_unreadable", recordedMajor: null };
  const installedMajor = openCodeMajor(installedVersion);
  if (installedMajor === null) return { kind: "version_unknown" };
  const recordedMajor = read.kind === "record" && read.record.sessionId === sessionId ? read.record.opencodeMajor : null;
  if (recordedMajor !== null) {
    return recordedMajor === installedMajor ? { kind: "resume" } : { kind: "refuse", reason: "major_mismatch", recordedMajor };
  }
  return installedMajor >= 2 ? { kind: "refuse", reason: "unrecorded", recordedMajor: null } : { kind: "resume" };
}

function mergeOpenCodeConfigs(
  localConfig: Record<string, unknown>,
  envConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...localConfig,
    ...envConfig,
    provider: {
      ...recordField(localConfig.provider),
      ...recordField(envConfig.provider),
    },
    agent: {
      ...recordField(localConfig.agent),
      ...recordField(envConfig.agent),
    },
    mcp: {
      ...recordField(localConfig.mcp),
      ...recordField(envConfig.mcp),
    },
  };
}

export function buildOpenCodeConfig(
  ctx: SpawnContext,
  home: string = os.homedir(),
  managedMcp?: { name: string; url: string } | null,
): Record<string, unknown> {
  const userConfig = mergeOpenCodeConfigs(readLocalOpenCodeConfig(home), parseUserOpenCodeConfig(ctx));
  const userAgents = recordField(userConfig.agent);
  const userSlockAgent = recordField(userAgents[SLOCK_AGENT_NAME]);
  return {
    ...userConfig,
    $schema: "https://opencode.ai/config.json",
    agent: {
      ...userAgents,
      [SLOCK_AGENT_NAME]: {
        ...userSlockAgent,
        description: "Slock agent runtime",
        prompt: ctx.standingPrompt,
      },
    },
    mcp: {
      ...recordField(userConfig.mcp),
      ...(managedMcp ? {
        [managedMcp.name]: {
          type: "remote",
          url: managedMcp.url,
          enabled: true,
        },
      } : {}),
    },
  };
}

export async function buildOpenCodeLaunchOptions(ctx: SpawnContext, home: string = os.homedir(), version: string | null = null): Promise<OpenCodeLaunchOptions> {
  const slock = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  const managedMcp = await prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    processInstanceId: ctx.processInstanceId,
    readTurnOrigin: ctx.readTurnOrigin,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
  });

  const v2 = isOpenCodeV2Launch(version);
  const agentCliFlag = v2 || requiresAgentCliFlag(version);
  // Without `--agent` (OpenCode >= 1.15, see requiresAgentCliFlag), `opencode
  // run` uses `default_agent`, else its built-in `build` agent, whose prompt is
  // OpenCode's own: the standing prompt in the `slock` agent was never used.
  // Verified on 1.15.0 and 1.18.35 by capturing the provider request.
  const { env, config } = buildOpenCodeLaunchEnv(ctx, slock.spawnEnv, { home, version, managedMcp, selectDefaultAgent: !agentCliFlag });

  // 2.x: `--standalone` is not optional. Without it `opencode run` discovers
  // or starts a per-user shared background server that owns sessions and
  // outlives this process (verified on 2.0.27: a non-standalone call left
  // `opencode serve --service` listening on 127.0.0.1:49374 after exit).
  const args = v2
    ? [
      "run",
      "--standalone",
      "--format", "json",
      "--auto",
    ]
    : [
      "run",
      "--format", "json",
      "--dangerously-skip-permissions",
      "--pure",
      "--dir", ctx.workingDirectory,
    ];

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (agentCliFlag) {
    args.push("--agent", SLOCK_AGENT_NAME);
  }

  if (ctx.config.sessionId) {
    args.push("--session", ctx.config.sessionId);
  }

  const turnPrompt = ctx.prompt === ctx.standingPrompt ? NO_MESSAGE_PROMPT : ctx.prompt;
  args.push("--", turnPrompt);

  return { args, env, config };
}

/**
 * The 2.x config isolation (task #1258, see buildOpenCodeLaunchEnv): the
 * workspace's opencode.json and .opencode/plugins and the user's config
 * directory are not read. Null for any other version: 1.x isolates with
 * `--pure` / `--dir` flags instead, which only `opencode run` takes. Creates
 * the empty config directory. Every process Raft starts for an agent's
 * OpenCode in its workspace gets this (the launch, the skills read).
 */
export function openCodeConfigIsolationEnv(
  version: string | null | undefined,
  slockHome: string | undefined,
): { OPENCODE_DISABLE_PROJECT_CONFIG: string; OPENCODE_CONFIG_DIR: string } | null {
  if (!isOpenCodeV2Launch(version)) return null;
  const emptyConfigDir = path.join(slockHome ? path.resolve(slockHome) : resolveRaftHome(), OPENCODE_EMPTY_CONFIG_DIR);
  mkdirSync(emptyConfigDir, { recursive: true });
  return { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_CONFIG_DIR: emptyConfigDir };
}

/** A config document without its `plugin` list (2.x: see buildOpenCodeLaunchEnv). */
function withoutOpenCodePlugins(config: Record<string, unknown>): Record<string, unknown> {
  const { plugin: _plugin, ...rest } = config;
  return rest;
}

/**
 * 2.x: `compaction.background: false` unless the user's config (the agent's
 * OPENCODE_CONFIG_CONTENT or the user's opencode.json, merged by
 * buildOpenCodeConfig) already says `compaction.background` either way.
 * OpenCode 2.3.1 compacts in the background by default, which can keep
 * `opencode run` alive after the reply, and on 2.x that end of output is what
 * ends the turn (OpenCodeDriver.parseStdoutEnd). Merged into an existing
 * `compaction` object. 1.x does not know the key (its old switch,
 * `experimental.background_compaction`, is gone in 2.3.1).
 */
function withForegroundCompaction(config: Record<string, unknown>): Record<string, unknown> {
  const compaction = recordField(config.compaction);
  if (Object.prototype.hasOwnProperty.call(compaction, "background")) return config;
  return { ...config, compaction: { ...compaction, background: false } };
}

/**
 * The env a short-lived OpenCode process Raft starts in an agent's workspace
 * outside a session (the skills read's `opencode serve`) puts over the
 * agent's env vars: the launch's config isolation, and the agent's
 * `OPENCODE_CONFIG_CONTENT` without its `plugin` list (always set, so an
 * inherited one is replaced too). Null where the launch has no isolation to
 * copy (not 2.x): do not start one.
 */
export function openCodeWorkspaceProcessEnv(
  version: string | null | undefined,
  slockHome: string | undefined,
  agentEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> | null {
  const isolation = openCodeConfigIsolationEnv(version, slockHome);
  if (!isolation) return null;
  const config = withoutOpenCodePlugins(parseOpenCodeConfigContent(agentEnv?.OPENCODE_CONFIG_CONTENT));
  return { ...isolation, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/**
 * The environment OpenCode starts in, on either host (the legacy `opencode
 * run` per turn, the OAR host's `opencode acp` session,
 * agentHost/oarOpencodeLaunch.ts): Raft's CLI transport environment
 * (`spawnEnv`), the injected config with the `slock` agent carrying the
 * standing prompt (`OPENCODE_CONFIG_CONTENT`), the 2.x config isolation, and
 * `PWD` = the agent's workspace. `selectDefaultAgent` adds `default_agent:
 * slock` for a launch that cannot name the agent itself (no `--agent`).
 * `managedMcp` puts the managed MCP server into the config (the legacy
 * driver); the OAR host passes none and attaches it as a session MCP server.
 */
export function buildOpenCodeLaunchEnv(
  ctx: SpawnContext,
  spawnEnv: NodeJS.ProcessEnv,
  input: { home?: string; version: string | null; managedMcp: { name: string; url: string } | null; selectDefaultAgent: boolean },
): { env: NodeJS.ProcessEnv; config: Record<string, unknown> } {
  const v2 = isOpenCodeV2Launch(input.version);
  const builtConfig = buildOpenCodeConfig(ctx, input.home ?? os.homedir(), input.managedMcp);
  const selectedConfig = input.selectDefaultAgent ? { ...builtConfig, default_agent: SLOCK_AGENT_NAME } : builtConfig;
  // task #1258 (2.x only). On 1.x `--pure` means "run without external
  // plugins" (1.x plugin/index.ts: `flags.pure ? [] : cfg.plugin_origins`) and
  // `--dir` pins the project; 2.x has neither flag and no plugin switch, so the
  // same isolation is built from what 2.x does have (each verified on 2.0.27
  // with a marker plugin, see opencode.live.test.ts and the task #1258 PR):
  //  - OPENCODE_DISABLE_PROJECT_CONFIG=1: the workspace's opencode.json and
  //    .opencode/plugins are not read, so a stray project file cannot redefine
  //    the `slock` agent or load code into the agent.
  //  - OPENCODE_CONFIG_DIR=<empty dir>: the user's config directory (its
  //    opencode.json `plugin` list and plugins/ directory) is not read by
  //    OpenCode. The parts of the user's opencode.json this driver supports
  //    (provider, agent, mcp) still reach 2.x: buildOpenCodeConfig merges them
  //    into the injected document, exactly as on 1.x.
  //  - the injected document carries no `plugin` key: `plugin` lists are
  //    merged across config sources, so an injected `[]` does not clear one,
  //    and the user's own list must not travel through the merge above.
  // OPENCODE_CONFIG_CONTENT has the last word over every file source
  // (verified: an injected agent beat project, config-dir and user agents of
  // the same name). Sessions, logs and auth stay in OpenCode's own data
  // directories under the host user's HOME/XDG, as on 1.x.
  const config = v2 ? withForegroundCompaction(withoutOpenCodePlugins(selectedConfig)) : selectedConfig;
  const isolation = openCodeConfigIsolationEnv(input.version, ctx.slockHome);
  const env: NodeJS.ProcessEnv = {
    ...spawnEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(isolation ?? {}),
    // 2.x has no `--dir` and takes its working directory from $PWD, not
    // from the process cwd (verified on 2.3.0: with cwd set to the
    // workspace and PWD inherited from the daemon, both the agent's and a
    // sub-agent's `pwd` printed the daemon's directory). Keep them equal.
    PWD: ctx.workingDirectory,
  };
  return { env, config };
}

/**
 * The environment the OAR host starts `opencode acp` in
 * (agentHost/oarOpencodeLaunch.ts): the legacy driver's own (CLI transport,
 * injected config, 2.x isolation, `PWD`), with `default_agent: slock`, since
 * ACP has no `--agent` and OAR refuses `systemPrompt` on OpenCode 2.x, and
 * without the managed MCP server in the config text: the OAR launch attaches
 * it as a session MCP server, so its token is not in the environment.
 */
export async function prepareOpenCodeOarEnvironment(ctx: SpawnContext, version: string): Promise<NodeJS.ProcessEnv> {
  const slock = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  return buildOpenCodeLaunchEnv(ctx, slock.spawnEnv, { version, managedMcp: null, selectDefaultAgent: true }).env;
}

export function parseOpenCodeModelsOutput(output: string): RuntimeModelSet | null {
  const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
  const models: RuntimeModelInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("{") || line.startsWith("}") || line.startsWith("\"")) continue;
    if (/^opencode models\b/i.test(line) || /^list all available models$/i.test(line)) continue;
    if (!line.includes("/") || /\s/.test(line) || line.startsWith("-")) continue;
    if (seen.has(line)) continue;

    seen.add(line);
    models.push({
      id: line,
      label: formatRuntimeProviderModelLabel(line),
      verified: "launchable",
    });
  }

  return models.length > 0 ? { models } : null;
}

export function detectOpenCodeModels(
  home: string = os.homedir(),
  runCommand: OpenCodeModelsCommand = runOpenCodeModelsCommand,
): RuntimeModelSet | null {
  const commandResult = runCommand(home);
  if (commandResult.error || commandResult.status !== 0) return null;
  return parseOpenCodeModelsOutput(commandResult.stdout);
}

export function detectOpenCodeModelSource(
  home: string = os.homedir(),
  runCommand: OpenCodeModelsCommand = runOpenCodeModelsCommand,
): RuntimeModelSourceOutcome {
  const commandResult = runCommand(home);
  if (commandResult.error || commandResult.status !== 0) {
    return { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet(parseOpenCodeModelsOutput(commandResult.stdout));
}


// ── task #1277: the legacy driver's launch resolution off the event loop ─────
//
// Every child (the PATH lookup, the version read, the optional `npm root -g`)
// runs as a bounded probe child. The model listing no longer uses it: it goes
// through OAR on every platform (detectOpenCodeModelSourceViaOar).

function isProbeAbort(error: unknown): boolean {
  return error instanceof ProbeChildError && error.code === "ABORT_ERR";
}

async function resolveWindowsOpenCodePackageEntryAsync(commandPath: string | null, deps: OpenCodeProbeDeps = {}): Promise<string | null> {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  const candidates: string[] = [];

  // Parity with the synchronous resolver: `npm root -g` is consulted only when
  // a child runner is injected (there: execFileSyncFn), never by default.
  const runChild = deps.runProbeChildFn;
  if (runChild) {
    try {
      const globalRoot = (await runChild("npm", ["root", "-g"], {
        env,
        timeoutMs: 5000,
        stderr: "ignore",
        platform: deps.platform ?? process.platform,
        signal: deps.signal,
      })).stdout.trim();
      if (globalRoot) for (const pkg of OPENCODE_NPM_PACKAGES) candidates.push(...opencodePackageEntryCandidates(winPath.join(globalRoot, pkg)));
    } catch (error) {
      if (isProbeAbort(error)) throw error;
      // npm is not guaranteed to exist for native OpenCode installs.
    }
  }

  if (commandPath) {
    const commandDir = winPath.dirname(commandPath);
    for (const pkg of OPENCODE_NPM_PACKAGES) candidates.push(...opencodePackageEntryCandidates(winPath.join(commandDir, "node_modules", pkg)));
    candidates.push(...extractWindowsShimTargets(commandPath, deps));
  }

  for (const candidate of candidates) {
    if (existsSyncFn(candidate)) return candidate;
  }
  return null;
}

/** task #1277 — {@link resolveOpenCodeSpawn} off the event loop; same resolution, same errors. */
export async function resolveOpenCodeSpawnAsync(commandArgs: string[], deps: OpenCodeProbeDeps = {}): Promise<OpenCodeSpawnSpec> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    const command = await resolveCommandOnPathAsync("opencode", deps) ?? openCodeInstallScriptPosix(deps);
    if (!command) {
      throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message: "Cannot resolve OpenCode CLI on PATH." });
    }
    return { command, args: commandArgs, shell: false };
  }

  const command = await resolveCommandOnPathAsync("opencode", deps);
  if (command && path.win32.extname(command).toLowerCase() === ".exe") {
    return { command, args: commandArgs, shell: false };
  }
  const installScriptExe = command ? null : openCodeInstallScriptExe(deps);
  if (installScriptExe) return { command: installScriptExe, args: commandArgs, shell: false };

  const packageEntry = await resolveWindowsOpenCodePackageEntryAsync(command, deps);
  if (packageEntry) return openCodeSpecForEntry(packageEntry, commandArgs, deps);

  if (command && !isWindowsCommandShim(command)) {
    return { command, args: commandArgs, shell: false };
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message:
    "Cannot resolve OpenCode CLI entry point on Windows without cmd.exe. " +
    "Install the native OpenCode executable, or install OpenCode globally with npm " +
    "(`npm i -g @opencode/cli` for 2.x, `npm i -g opencode-ai` for 1.x) so Raft can launch its opencode.exe directly." });
}

/**
 * task #1365 — the installed OpenCode version, or why it is unknown. The
 * generic read keeps its contract (any first output line); deciding whether
 * that line is an OpenCode version is done here. A cancel is rethrown, and so
 * is a failure to resolve the CLI at all.
 */
export type OpenCodeVersionRead =
  | { kind: "version"; version: string }
  | { kind: "unknown"; reason: "probe_timeout" | "permission_denied" | "probe_failed" | "unparseable_output"; detail: string };

export async function readOpenCodeVersionDetailedAsync(deps: OpenCodeProbeDeps & { readVersionFn?: typeof readCommandVersionDetailedAsync } = {}): Promise<OpenCodeVersionRead> {
  // A CLI that cannot be resolved at all is the resolver's own error (not
  // installed / lookup verdict), thrown as before; only a resolved CLI whose
  // version cannot be read is "unknown".
  const launch = await resolveOpenCodeSpawnAsync([], deps);
  const read: CommandVersionRead = await (deps.readVersionFn ?? readCommandVersionDetailedAsync)(launch.command, launch.args, { ...deps, env: launch.env ?? deps.env });
  if (read.kind === "failed") return { kind: "unknown", reason: read.reason, detail: `\`opencode --version\` ${read.detail}` };
  if (openCodeMajor(read.version) === null) {
    return { kind: "unknown", reason: "unparseable_output", detail: "`opencode --version` printed no recognisable version number" };
  }
  return { kind: "version", version: read.version };
}

/** task #1365 — a start whose OpenCode version could not be established; retryable (runtime_not_found with a lookup verdict). */
export function openCodeVersionUnknownError(read: Extract<OpenCodeVersionRead, { kind: "unknown" }>): RuntimeExecutableNotFoundError {
  return new RuntimeExecutableNotFoundError({
    runtimeId: "opencode",
    reason: read.reason === "probe_timeout" || read.reason === "permission_denied" ? read.reason : "probe_failed",
    message:
      `Raft could not confirm the installed OpenCode version (${read.detail}), so it cannot yet tell whether this agent's session can be resumed. ` +
      "The session is kept as it is and Raft tries again on the next start. " +
      "If this keeps happening, check that `opencode --version` runs in a new terminal, then restart Raft Computer.",
  });
}

/** Above OAR's cold first run (it also fetches models.dev) and under the server's 20 s per-detection budget. */
const OPENCODE_MODEL_DETECTION_DEADLINE_MS = 15_000;

/** The Windows environment read (ProbeDeps) and a stand-in for OAR's runtime. */
export interface OpenCodeInstallationDeps extends ProbeDeps {
  /** Stand-in for OAR's OpenCode runtime (tests). */
  loadRuntime?: () => Promise<Pick<Runtime, "installation">>;
}

/**
 * OpenCode as OAR finds it: `opencode` on PATH (with PATHEXT on Windows),
 * then the install script's `~/.opencode/bin`, its `--version` run through a
 * Windows command shim's own target (npm's `%dp0%` and pnpm's `%~dp0` shims
 * alike, so `npm i -g @opencode/cli` is found). Detection, the model listing
 * and the OAR host's launch all take this one installation; Raft keeps no
 * OpenCode lookup of its own for them. On Windows the PATH is first refreshed
 * from the registry, as Raft's own lookups do, so a CLI installed after the
 * Computer started is found. Rejects when OAR's `--version` run fails.
 */
export async function readOpenCodeInstallation(deps: OpenCodeInstallationDeps = {}): Promise<InstallationSnapshot> {
  const runtime = await (deps.loadRuntime ?? (() => loadOarRuntime("opencode")))();
  if (!runtime.installation) throw new Error("OAR's opencode runtime has no installation probe");
  const base = (deps.platform ?? process.platform) === "win32"
    ? await withWindowsUserEnvironmentAsync(deps.env ?? ambientProcessEnv(), deps)
    : deps.env;
  if (!base) return runtime.installation();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  return runtime.installation({ env });
}

/** What the runtime inventory reports for OAR's OpenCode installation; the version range is Raft's own (unsupportedOpenCodeVersionMessage). */
export async function probeOpenCodeInstallation(read: () => Promise<InstallationSnapshot> = readOpenCodeInstallation): Promise<RuntimeProbeResult> {
  let installation: InstallationSnapshot;
  try {
    installation = await read();
  } catch (error) {
    // Found, but its `--version` could not run (spawn failure, timeout): not
    // "not installed". The diagnostic names no path (a Windows path carries
    // the user name).
    const code = (error as { code?: unknown } | null)?.code;
    return {
      available: false,
      unavailableReason: "probe_failed",
      diagnostic: `OpenCode's installation could not be checked (\`opencode --version\` or the lookup itself failed)${typeof code === "string" ? ` (${code})` : ""}.`,
    };
  }
  if (installation.kind === "not_found") return { available: false, unavailableReason: "not_installed" };
  if (installation.kind === "unsupported") {
    return installation.code === "version_unsupported"
      ? { available: false, unavailableReason: "unsupported_version", ...(installation.installedVersion ? { version: `${installation.installedVersion} (requires ${openCodeSupportedRangeText()})` } : {}) }
      : { available: false, unavailableReason: "probe_failed" };
  }
  const version = installation.via === "executable" ? installation.version ?? null : null;
  if (unsupportedOpenCodeVersionMessage(version)) {
    return {
      available: false,
      unavailableReason: "unsupported_version",
      version: `${version} (requires ${openCodeSupportedRangeText()})`,
    };
  }
  return { available: true, ...(version ? { version } : {}) };
}

/**
 * Lists opencode models through OAR's `listModels`, asynchronously, on every
 * platform. The listed binary is OAR's installation (readOpenCodeInstallation),
 * the one the OAR host launches; its version read spares OAR a second one.
 */
async function opencodeModelLister(): Promise<ModelLister> {
  const { listModels } = await loadOarRuntime("opencode");
  if (!listModels) throw new Error("OAR's opencode runtime has no model listing");
  return listModels;
}

export async function detectOpenCodeModelSourceViaOar(
  lister?: ModelLister,
  deadlineMs: number = OPENCODE_MODEL_DETECTION_DEADLINE_MS,
  readInstallation: () => Promise<InstallationSnapshot> = readOpenCodeInstallation,
): Promise<RuntimeModelSourceOutcome> {
  const startedAt = Date.now();
  let installation: InstallationSnapshot;
  try {
    installation = await readInstallation();
  } catch {
    return { kind: "error", retryable: true, code: "detect_failed" };
  }
  if (installation.kind === "not_found") return { kind: "error", retryable: true, code: "runtime_not_found" };
  if (installation.kind !== "available") return { kind: "error", retryable: true, code: "protocol_unsupported" };
  return detectModelSourceViaOar({
    lister: lister ?? await opencodeModelLister(),
    installation,
    // One budget for the installation read and the listing.
    deadlineMs: Math.max(1_000, deadlineMs - (Date.now() - startedAt)),
    // OAR's 1.x display name drops the provider ("GPT-5 Nano"); keep the
    // daemon's provider-qualified label ("GPT 5 Nano · OpenCode Zen").
    label: (entry) => formatRuntimeProviderModelLabel(entry.id),
    // The opencode form has no reasoning-effort field and spawn passes none.
    keepReasoningEfforts: false,
    // OAR returns `unsupported` for an empty 2.x listing: `models --standalone`
    // can exit before the cold catalog loads (anomalyco/opencode#53724), so an
    // empty answer does not establish that no models exist. Retry later.
    onUnsupported: () => ({ kind: "error", retryable: true, code: "detect_failed" }),
  });
}

export function runOpenCodeModelsCommand(
  home: string,
  deps: OpenCodeModelsCommandDeps = {},
): OpenCodeModelsCommandResult {
  const platform = deps.platform ?? process.platform;
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const env = { ...ambientProcessEnv(), HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" };
  // task #1258: on 2.x every subcommand, `models` included, attaches to or
  // starts the per-user background server unless told to stand alone.
  const modelsArgs = isOpenCodeV2Launch(readOpenCodeVersion({ ...deps, env })) ? ["models", "--standalone"] : ["models"];
  let launch: { command: string; args: string[]; env?: NodeJS.ProcessEnv } = { command: "opencode", args: modelsArgs };
  if (platform === "win32") {
    try {
      launch = resolveOpenCodeSpawn(modelsArgs, { ...deps, env });
    } catch (error) {
      return { status: null, stdout: "", error: error as Error };
    }
  }
  const result = spawnSyncFn(launch.command, launch.args, {
    env: launch.env ?? env,
    encoding: "utf8",
    timeout: 5000,
    shell: false,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    error: result.error,
  };
}

function isWindowsCommandShim(commandPath: string): boolean {
  const ext = path.win32.extname(commandPath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * The npm packages OpenCode ships as: 1.x `opencode-ai`, 2.x `@opencode/cli`.
 * Windows only, for the legacy driver, which launches the package's
 * `bin/opencode.exe` itself (no cmd.exe). TEMPORARY (#proj-runtime:#71,
 * #oar-raft:38631b94): goes with the legacy driver once OpenCode runs on the
 * OAR host on Windows, where OAR resolves npm's shims.
 */
const OPENCODE_NPM_PACKAGES = ["opencode-ai", "@opencode/cli"] as const;

/**
 * The install script's `%USERPROFILE%\.opencode\bin\opencode.exe`, which OAR's
 * detection also finds off PATH: without it the runtime list could say
 * available while the legacy launch says not found. Same TEMPORARY scope as
 * OPENCODE_NPM_PACKAGES.
 */
function openCodeInstallScriptExe(deps: OpenCodeProbeDeps): string | null {
  const env = deps.env ?? ambientProcessEnv();
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const exe = path.win32.join(home, ".opencode", "bin", "opencode.exe");
  return (deps.existsSyncFn ?? existsSync)(exe) ? exe : null;
}

/**
 * The install script's `~/.opencode/bin/opencode` on macOS and Linux (what
 * Install on the web runs for OpenCode 2.x, and OAR's detection finds off
 * PATH). The script adds that folder to the shell profile only, so a daemon
 * started before the install, or as a service, never has it on PATH.
 */
function openCodeInstallScriptPosix(deps: OpenCodeProbeDeps): string | null {
  const env = deps.env ?? ambientProcessEnv();
  const home = env.HOME || os.homedir();
  const bin = path.posix.join(home, ".opencode", "bin", "opencode");
  return (deps.existsSyncFn ?? existsSync)(bin) ? bin : null;
}

function opencodePackageEntryCandidates(packageRoot: string): string[] {
  const winPath = path.win32;
  return [
    winPath.join(packageRoot, "bin", "opencode.exe"),
    winPath.join(packageRoot, "bin", "opencode.js"),
    winPath.join(packageRoot, "bin", "opencode.mjs"),
    winPath.join(packageRoot, "dist", "index.js"),
  ];
}

function openCodeSpecForEntry(entry: string, commandArgs: string[], deps: OpenCodeProbeDeps = {}): OpenCodeSpawnSpec {
  if (path.win32.extname(entry).toLowerCase() === ".exe") {
    return { command: entry, args: commandArgs, shell: false };
  }
  const nodeHost = resolveNodeHostLaunch({
    env: deps.env ?? ambientProcessEnv(),
    execPath: deps.execPath,
    execIsElectron: deps.execIsElectron,
  });
  return {
    command: nodeHost.command,
    args: [...nodeHost.execArgv, entry, ...commandArgs],
    shell: false,
    env: nodeHost.env,
  };
}

function resolveWindowsOpenCodePackageEntry(commandPath: string | null, deps: OpenCodeProbeDeps = {}): string | null {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const execFileSyncFn = deps.execFileSyncFn;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  const candidates: string[] = [];

  if (execFileSyncFn) {
    try {
      const globalRoot = String(execFileSyncFn("npm", ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      })).trim();
      if (globalRoot) {
        for (const pkg of OPENCODE_NPM_PACKAGES) candidates.push(...opencodePackageEntryCandidates(winPath.join(globalRoot, pkg)));
      }
    } catch {
      // npm is not guaranteed to exist for native OpenCode installs.
    }
  }

  if (commandPath) {
    const commandDir = winPath.dirname(commandPath);
    for (const pkg of OPENCODE_NPM_PACKAGES) candidates.push(...opencodePackageEntryCandidates(winPath.join(commandDir, "node_modules", pkg)));
    candidates.push(...extractWindowsShimTargets(commandPath, deps));
  }

  for (const candidate of candidates) {
    if (existsSyncFn(candidate)) return candidate;
  }

  return null;
}

function extractWindowsShimTargets(commandPath: string, deps: OpenCodeProbeDeps = {}): string[] {
  if (!isWindowsCommandShim(commandPath)) return [];
  const readFileSyncFn = deps.readFileSyncFn ?? readFileSync;
  const commandDir = path.win32.dirname(commandPath);
  let raw: string;
  try {
    raw = String(readFileSyncFn(commandPath, "utf8"));
  } catch {
    return [];
  }

  const candidates: string[] = [];
  const dp0Pattern = /%~dp0\\?([^"\r\n]*?opencode\.(?:exe|js|mjs|cjs))/gi;
  for (const match of raw.matchAll(dp0Pattern)) {
    const relative = match[1]?.replace(/^\\+/, "");
    if (relative) candidates.push(path.win32.normalize(path.win32.join(commandDir, relative)));
  }

  return candidates;
}

export function resolveOpenCodeSpawn(commandArgs: string[], deps: OpenCodeProbeDeps = {}): OpenCodeSpawnSpec {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    const command = resolveCommandOnPath("opencode", deps) ?? openCodeInstallScriptPosix(deps);
    if (!command) {
      throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message: "Cannot resolve OpenCode CLI on PATH." });
    }
    return {
      command,
      args: commandArgs,
      shell: false,
    };
  }

  const command = resolveCommandOnPath("opencode", deps);
  if (command && path.win32.extname(command).toLowerCase() === ".exe") {
    return { command, args: commandArgs, shell: false };
  }
  const installScriptExe = command ? null : openCodeInstallScriptExe(deps);
  if (installScriptExe) return { command: installScriptExe, args: commandArgs, shell: false };

  const packageEntry = resolveWindowsOpenCodePackageEntry(command, deps);
  if (packageEntry) return openCodeSpecForEntry(packageEntry, commandArgs, deps);

  if (command && !isWindowsCommandShim(command)) {
    return { command, args: commandArgs, shell: false };
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message:
    "Cannot resolve OpenCode CLI entry point on Windows without cmd.exe. " +
    "Install the native OpenCode executable, or install OpenCode globally with npm " +
    "(`npm i -g @opencode/cli` for 2.x, `npm i -g opencode-ai` for 1.x) so Raft can launch its opencode.exe directly." });
}

function readOpenCodeVersion(deps: OpenCodeProbeDeps = {}): string | null {
  try {
    const launch = resolveOpenCodeSpawn([], deps);
    return readCommandVersion(launch.command, launch.args, {
      ...deps,
      env: launch.env ?? deps.env,
    });
  } catch {
    return null;
  }
}

/**
 * How long a 2.x turn whose reply is printed may wait in `background_wait`
 * before the daemon stops the run (OpenCodeDriver.quietOutputDeadline). Since
 * 2.3.1 a shell command still running at its tool timeout always moves to the
 * background, and `opencode run` stays alive until it ends: a dev server
 * started through the shell tool would keep the turn open forever. Shell jobs
 * only: 10 minutes. Any other kind (2.3+ runs sub-agents in the background,
 * and they do real work), or no job list at all: 30 minutes.
 */
export const OPENCODE_BACKGROUND_WAIT_SHELL_CAP_MS = 10 * 60_000;
export const OPENCODE_BACKGROUND_WAIT_OTHER_CAP_MS = 30 * 60_000;

export interface OpenCodeDriverOptions {
  /** Overrides of the background wait caps (tests). */
  backgroundWaitCapMs?: { shell?: number; other?: number };
  /** Stand-in for OAR's OpenCode installation behind probeAsync and detectModels (tests). */
  readInstallation?: () => Promise<InstallationSnapshot>;
}

interface OpenCodeBackgroundJob {
  /** OpenCode's job id (`sh_...`); compares job sets. Empty when it sent none. */
  id: string;
  /** Bounded token (trace-safe); "other" when OpenCode sent none or an odd one. */
  kind: string;
  /** The job's title as OpenCode printed it (a shell job's command line): Activity only, never traces. */
  title: string;
}

function openCodeBackgroundJobs(raw: unknown): OpenCodeBackgroundJob[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((job) => {
    const record = recordField(job);
    const kind = typeof record.kind === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(record.kind) ? record.kind : "other";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const id = typeof record.id === "string" ? record.id : "";
    return { id, kind, title };
  });
}

/** The job set's identity: its ids (kind and title stand in for a missing id), order-free. */
function backgroundJobSetKey(jobs: OpenCodeBackgroundJob[]): string {
  return JSON.stringify(jobs.map((job) => job.id || `${job.kind}:${job.title}`).sort());
}

/** Shell jobs only can take the short cap; any other kind, or an empty or missing list (unknown), takes the long one. */
function backgroundJobsNeedLongCap(jobs: OpenCodeBackgroundJob[]): boolean {
  return jobs.length === 0 || jobs.some((job) => job.kind !== "shell");
}

/** The bounded wait of a 2.x turn whose reply is printed (OpenCodeDriver.quietOutputDeadline). */
interface OpenCodeBackgroundWaitState {
  /** Date.now() of the first `background_wait` after the reply. */
  startedAtMs: number;
  /** Fixed at the start; only ever moved later (to start + long cap). */
  deadlineAtMs: number;
  longCap: boolean;
  /** The last job set printed. */
  jobs: OpenCodeBackgroundJob[];
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Up to three titles, each cut to 80 characters, then "+N more". */
function backgroundJobTitles(jobs: OpenCodeBackgroundJob[]): string {
  const titles = jobs.map((job) => job.title || job.kind);
  const shown = titles.slice(0, 3).map((title) => truncateText(title.replace(/\s+/g, " "), 80));
  const more = titles.length - shown.length;
  return more > 0 ? `${shown.join(", ")} (+${more} more)` : shown.join(", ");
}

function formatCapDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

function backgroundJobsTraceFields(jobs: OpenCodeBackgroundJob[], capMs?: number): { count: number; kinds: string[]; capMinutes?: number } {
  return {
    count: jobs.length,
    kinds: [...new Set(jobs.map((job) => job.kind))].sort(),
    ...(capMs !== undefined ? { capMinutes: Math.round((capMs / 60_000) * 100) / 100 } : {}),
  };
}

function isSystemFirstMessageTask(message: AgentMessage): boolean {
  return message.sender_id === "system" &&
    message.channel_type === "channel" &&
    message.channel_name === "all" &&
    message.content.trimStart().startsWith(FIRST_MESSAGE_TASK_PREFIX);
}

function buildOpenCodeSystemPrompt(config: AgentConfig): AxSurfaceText {
  return buildCliTransportSystemPrompt(config, {
    extraCriticalRules: [],
  });
}

/**
 * OpenCode CLI driver.
 *
 * Uses `opencode run --format json`, which emits NDJSON events on stdout.
 * The command is per-turn and exits when the turn is complete; session state is
 * resumed with OpenCode's native `--session <id>` support. On 1.x the final
 * step_finish ends the turn (and the daemon then terminates the process); on
 * 2.x the end of stdout does (parseStdoutEnd), because background sub-agents
 * (2.3+) keep the turn going after the parent's step_finish (see parseLine).
 */
export class OpenCodeDriver implements RuntimeDriver {
  readonly id = "opencode";
  private readonly backgroundWaitCapMs: { shell: number; other: number };
  private readonly readInstallation: () => Promise<InstallationSnapshot>;

  constructor(options: OpenCodeDriverOptions = {}) {
    this.backgroundWaitCapMs = {
      shell: options.backgroundWaitCapMs?.shell ?? OPENCODE_BACKGROUND_WAIT_SHELL_CAP_MS,
      other: options.backgroundWaitCapMs?.other ?? OPENCODE_BACKGROUND_WAIT_OTHER_CAP_MS,
    };
    this.readInstallation = options.readInstallation ?? (() => readOpenCodeInstallation());
  }

  readonly lifecycle = {
    kind: "per_turn",
    start: "defer_until_concrete_message",
    exit: "terminate_on_turn_end",
    inFlightWake: "coalesce_into_pending",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // Never emits a compaction event.
    compaction: "unreported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: async (modelId: string, ctx?: SpawnContext, opts?: OpenCodeLaunchSpecOptions) => {
      if (!ctx) return { args: ["--model", modelId] };
      const launchCtx = {
        ...ctx,
        config: {
          ...ctx.config,
          model: modelId,
        },
      };
      const version = (opts?.readVersion ?? readOpenCodeVersion)();
      const launch = await buildOpenCodeLaunchOptions(launchCtx, opts?.home, version);
      return {
        args: launch.args,
        env: launch.env as Record<string, string>,
        config: launch.config,
      };
    },
  };
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly standingPromptRefreshesOnResume = true;
  readonly terminateProcessOnTurnEnd = true;
  readonly deferSpawnUntilMessage = true;

  shouldDeferWakeMessage(message: AgentMessage): boolean {
    return isSystemFirstMessageTask(message);
  }

  private sessionId: string | null = null;
  /** Tool calls already printed in this launch (see finishedToolEvents). */
  private readonly seenToolCallIds = new Set<string>();
  /** The id last announced with session_init; re-announced when the persisted id changes. */
  private announcedId: string | null = null;
  /** The id whose provenance is on disk for this launch's major (or already was, for a matching resume). */
  private persistedSessionId: string | null = null;
  /** task #1258: where this launch records the session's OpenCode major once the id is known. */
  private sessionRecord: { path: string; major: number; version: string } | null = null;
  /** 2.x: the last step was a finished reply (step_finish, not tool-calls) with nothing after it yet; see parseStdoutEnd. */
  private replyFinished = false;
  /**
   * 2.x: the turn is answered (a finished reply, then `background_wait`) and
   * `opencode run` only waits for background jobs; see quietOutputDeadline.
   * Cleared only by new model work (step_start, text, tool_use) or the cap.
   */
  private backgroundWait: OpenCodeBackgroundWaitState | null = null;
  /** The job set of the last `background_wait` Activity row since the last model work (one row per distinct set). */
  private backgroundWaitShownKey: string | null = null;
  /** The CLI version read for the last launch (see RuntimeDriver.launchedCliVersion). */
  launchedCliVersion: string | null = null;
  /**
   * Provenance state of this launch's session. "persisted" is the only state
   * in which the session id leaves the driver (session_init, turn_end). A
   * permitted resume whose record already matches starts as "persisted"; a
   * fresh or legacy session is "pending" until the CLI echoes its id and the
   * record is written; "failed" is terminal for this process: the failure
   * was reported as a runtime error and no id is ever handed out.
   */
  private sessionRecordState: "pending" | "persisted" | "failed" = "pending";

  /**
   * The synchronous inventory, only for a server without asynchronous runtime
   * detection (`emitReady`'s in-process round): Raft's own lookup, which
   * cannot see every Windows install (an npm `@opencode/cli` shim). The
   * detection round (`detectRuntimesAsync`) uses probeAsync.
   */
  probe(deps: OpenCodeProbeDeps = {}): RuntimeProbeResult {
    let version: string | null;
    try {
      const launch = resolveOpenCodeSpawn([], deps);
      version = readCommandVersion(launch.command, launch.args, {
        ...deps,
        env: launch.env ?? deps.env,
      });
    } catch (error) {
      // Only a definitive PATH miss is "not installed"; a found-but-unlaunchable
      // command (e.g. an unresolvable Windows shim) or an undecided lookup is not.
      const lookup = error instanceof RuntimeExecutableNotFoundError ? lookupCommandOnPath("opencode", deps) : null;
      const unavailableReason = lookup && !lookup.command ? lookup.missReason : "probe_failed";
      return { available: false, unavailableReason };
    }
    const unsupportedMessage = unsupportedOpenCodeVersionMessage(version);
    if (unsupportedMessage) {
      return {
        available: false,
        unavailableReason: "unsupported_version",
        version: `${version} (requires ${openCodeSupportedRangeText()})`,
      };
    }
    return { available: true, version: version ?? undefined };
  }

  /** The runtime inventory from OAR's installation (readOpenCodeInstallation), with Raft's supported version range. */
  probeAsync(): Promise<RuntimeProbeResult> {
    return probeOpenCodeInstallation(this.readInstallation);
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    // Every platform through OAR, Windows included: OAR runs a command shim's
    // own target (an npm `@opencode/cli` or `opencode-ai` shim).
    return detectOpenCodeModelSourceViaOar(undefined, undefined, this.readInstallation);
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || null;
    this.announcedId = null;
    this.seenToolCallIds.clear();
    this.persistedSessionId = null;
    this.sessionRecordState = "pending";
    this.replyFinished = false;
    this.backgroundWait = null;
    this.backgroundWaitShownKey = null;

    // task #1277: the version read and the launch resolution run as bounded
    // probe children under this start attempt's signal; a cancelled lookup is
    // rethrown, never a verdict.
    const versionRead = await readOpenCodeVersionDetailedAsync({ signal: ctx.launchSignal });
    // task #1365: an unknown version is neither 1.x nor 2.x. Stop before the
    // session record is consulted and before any launch arguments are built.
    if (versionRead.kind === "unknown") throw openCodeVersionUnknownError(versionRead);
    const version = versionRead.version;
    this.launchedCliVersion = version;
    const unsupportedMessage = unsupportedOpenCodeVersionMessage(version);
    if (unsupportedMessage) {
      throw new Error(unsupportedMessage);
    }

    // task #1258: never resume a session across OpenCode major lines (see
    // decideOpenCodeSessionResume). The record is written on session_init,
    // for a fresh session and for a permitted resume alike.
    const slockHome = ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome();
    const recordPath = openCodeSessionRecordPath(slockHome, ctx.agentId);
    const read = readOpenCodeSessionRecord(recordPath);
    const decision = decideOpenCodeSessionResume(this.sessionId, read, version);
    if (decision.kind === "version_unknown") {
      throw openCodeVersionUnknownError({ kind: "unknown", reason: "unparseable_output", detail: "`opencode --version` printed no recognisable version number" });
    }
    if (decision.kind === "refuse") {
      throw new RuntimeSessionRuntimeMismatchError({
        runtimeId: this.id,
        sessionId: this.sessionId ?? "",
        reason: decision.reason,
        recordedMajor: decision.recordedMajor,
        installedVersion: version ?? "unknown",
      });
    }
    // The record is written only once the CLI has echoed the session id
    // (session_init in parseLine): a permitted resume is then recorded by what
    // actually ran, never by this process's assumption before launch.
    const major = openCodeMajor(version);
    this.sessionRecord = major === null ? null : { path: recordPath, major, version: version ?? "" };
    if (this.sessionRecord) ensureOpenCodeSessionRecordWritable(recordPath);
    // A resume whose record already says exactly this (id, major) needs no
    // write: prior valid provenance is kept as it is.
    if (
      decision.kind === "resume" && this.sessionId && major !== null
      && read.kind === "record" && read.record.sessionId === this.sessionId && read.record.opencodeMajor === major
    ) {
      this.sessionRecordState = "persisted";
      this.persistedSessionId = this.sessionId;
    }

    const launch = await buildOpenCodeLaunchOptions(ctx, os.homedir(), version);
    const spawnSpec = await resolveOpenCodeSpawnAsync(launch.args, { env: launch.env, signal: ctx.launchSignal });
    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    // A start stopped while the lookup ran must not create a child.
    if (ctx.launchSignal?.aborted) throw new ProbeChildError("opencode launch cancelled before the child was created", { code: "ABORT_ERR" });
    const proc = spawnRuntimeChild(spawnSpec.command, spawnSpec.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnSpec.env ?? launch.env,
      shell: spawnSpec.shell,
    });
    // `opencode run` is a per-turn CLI. Leaving stdin open causes some
    // versions to wait before bootstrapping even when the prompt is supplied
    // as argv, so close it immediately.
    proc.stdin?.end();

    return { process: proc };
  }

  /**
   * task #26: `opencode run --format json` prints a tool call once, after it
   * completed or failed (1.x and 2.x alike); there is no start event. So one
   * `tool_use` is both the call's start and its end. A part seen twice is
   * printed once.
   */
  private finishedToolEvents(part: OpenCodeEvent["part"]): ParsedEvent[] {
    const name = part?.tool || "unknown_tool";
    const state = part?.state;
    const rawId = part?.callID ?? part?.id;
    const callId = typeof rawId === "string" && rawId ? rawId : undefined;
    if (callId) {
      if (this.seenToolCallIds.has(callId)) return [];
      this.seenToolCallIds.add(callId);
    }
    const exit = state?.metadata?.exit ?? state?.metadata?.metadata?.exit;
    const start = state?.time?.start;
    const end = state?.time?.end;
    const durationMs = typeof start === "number" && typeof end === "number" && end >= start ? end - start : undefined;
    const ids = callId ? { callId } : {};
    return [
      { kind: "tool_call", name, input: state?.input, ...ids },
      {
        kind: "tool_output",
        name,
        ...ids,
        ...(state?.status === "completed" ? { ok: true } : state?.status === "error" ? { ok: false } : {}),
        ...(typeof exit === "number" && Number.isInteger(exit) ? { exitCode: exit } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ];
  }

  /** The session id as the daemon may learn it: only the id whose provenance is on disk. */
  private announcedSessionId(): string | undefined {
    return this.sessionRecordState === "persisted" && this.sessionId && this.persistedSessionId === this.sessionId ? this.sessionId : undefined;
  }

  /**
   * Persist the session's provenance the first time the CLI reports its id.
   * Two back-to-back attempts; then the failure is terminal for this process
   * and is surfaced as a runtime error (returned here, pushed by parseLine):
   * the turn ends as a failure, the id is never handed to the daemon, and the
   * next start opens a fresh session rather than resuming one without
   * provenance. Launch-time `ensureOpenCodeSessionRecordWritable` makes this
   * path exceptional. Nothing is thrown from here.
   */
  private persistSession(sessionId: string): ParsedEvent[] {
    if (this.sessionRecordState === "failed") return [];
    if (this.sessionRecordState === "persisted" && this.persistedSessionId === sessionId) return [];
    // A different id than the one on record (the CLI opened or switched to
    // another session) needs its own record before it may be announced.
    this.sessionRecordState = "pending";
    if (!this.sessionRecord) {
      this.sessionRecordState = "persisted";
      this.persistedSessionId = sessionId;
      return [];
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeOpenCodeSessionRecord(this.sessionRecord.path, {
          version: 1,
          sessionId,
          opencodeMajor: this.sessionRecord.major,
          opencodeVersion: this.sessionRecord.version,
          recordedAt: new Date().toISOString(),
        });
        this.sessionRecordState = "persisted";
        this.persistedSessionId = sessionId;
        return [];
      } catch (error) {
        lastError = error;
      }
    }
    this.sessionRecordState = "failed";
    const cause = lastError instanceof Error ? lastError.message : String(lastError);
    const message = `OpenCode session record could not be persisted at ${this.sessionRecord.path} (${cause}); this session is not resumable and the turn is treated as failed`;
    console.warn(`[opencode] ${message}`);
    return [
      { kind: "error", message },
      { kind: "turn_end" },
    ];
  }

  parseLine(line: string): ParsedEvent[] {
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];
    if (event.sessionID && event.sessionID !== this.sessionId) {
      this.sessionId = event.sessionID;
    }
    // task #1258: the session is announced (and so becomes the daemon's
    // resumable id) only once its provenance is on disk; a persistence
    // failure is a runtime error for this turn and the id never leaves.
    if (this.sessionId) events.push(...this.persistSession(this.sessionId));
    const announced = this.announcedSessionId();
    if (announced && this.announcedId !== announced) {
      events.push({ kind: "session_init", sessionId: announced });
      this.announcedId = announced;
    }

    // New model work ends a background wait (and its cap); nothing else does:
    // a stray line, an error or an unknown event type leaves the deadline
    // running (see quietOutputDeadline).
    if (event.type === "step_start" || event.type === "text" || event.type === "tool_use") {
      this.backgroundWait = null;
      this.backgroundWaitShownKey = null;
    }

    switch (event.type) {
      case "step_start":
        this.replyFinished = false;
        events.push({ kind: "thinking", text: "" });
        break;

      case "text":
        if (typeof event.part?.text === "string" && event.part.text.length > 0) {
          events.push({ kind: "text", text: event.part.text });
          // 2.0.27 ends a plain reply with its text and no step_finish.
          if (isOpenCodeV2Launch(this.launchedCliVersion)) this.replyFinished = true;
        }
        break;

      case "tool_use":
        this.replyFinished = false;
        events.push(...this.finishedToolEvents(event.part));
        break;

      case "step_finish":
        // 1.x ends every reply with a step_finish (reason "stop") and it is
        // final. On 2.x it is not: 2.3.0 runs sub-agents in the background,
        // prints the parent's step_finish(stop), then `background_wait`, and
        // resumes the parent with its final reply once they finish. A
        // turn_end here would make the daemon terminate the process
        // (terminateProcessOnTurnEnd) and kill the sub-agents with it. So on
        // 2.x the reply only marks the turn as answered, and the turn_end
        // comes from parseStdoutEnd once `opencode run` has printed
        // everything (about 80 ms after the final reply on 2.3.0).
        if (event.part?.reason !== "tool-calls") {
          if (isOpenCodeV2Launch(this.launchedCliVersion)) this.replyFinished = true;
          else events.push({ kind: "turn_end", sessionId: this.announcedSessionId() });
        }
        break;

      case "background_wait": {
        // 2.3.0: the parent waits for background sub-agents and resumes after.
        // 2.3.1: also for a shell command still running at its tool timeout
        // (always moved to the background now). Observed on 2.3.1: reply,
        // background_wait 10 ms later, the wait for the job, then a new step
        // with a second reply and an exit about 10 ms after it.
        const jobs = openCodeBackgroundJobs(event.jobs);
        const jobSetKey = backgroundJobSetKey(jobs);
        const longCap = backgroundJobsNeedLongCap(jobs);
        const replied = this.replyFinished;
        this.replyFinished = false;
        // One Activity row per distinct job set: a repeated wait adds none.
        if (jobSetKey !== this.backgroundWaitShownKey) {
          this.backgroundWaitShownKey = jobSetKey;
          events.push({
            kind: "runtime_diagnostic",
            severity: "info",
            source: "opencode_background_wait",
            itemType: "background_wait",
            message: jobs.length > 0 ? `Waiting for ${jobs.length} background job(s): ${backgroundJobTitles(jobs)}` : "Waiting for background jobs",
            backgroundJobs: backgroundJobsTraceFields(jobs),
          });
        }
        const wait = this.backgroundWait;
        if (wait) {
          // Already waiting: never restart the clock (a CLI that re-prints
          // the wait would never be bounded) and never shorten it; a job set
          // that now needs the long cap moves the deadline to start + long cap.
          wait.jobs = jobs;
          if (longCap && !wait.longCap) {
            wait.longCap = true;
            wait.deadlineAtMs = Math.max(wait.deadlineAtMs, wait.startedAtMs + this.backgroundWaitCapMs.other);
          }
        } else if (replied && isOpenCodeV2Launch(this.launchedCliVersion)) {
          // Bounded only once this turn's reply is printed: a wait mid-step
          // is the model's own work in progress.
          const startedAtMs = Date.now();
          this.backgroundWait = {
            startedAtMs,
            deadlineAtMs: startedAtMs + (longCap ? this.backgroundWaitCapMs.other : this.backgroundWaitCapMs.shell),
            longCap,
            jobs,
          };
        }
        break;
      }

      case "error": {
        const message =
          event.error?.data?.message ||
          event.error?.message ||
          (event.error?.name ? `${event.error.name} (no message)` : null) ||
          "Unknown OpenCode error";
        events.push({ kind: "error", message });
        events.push({ kind: "turn_end", sessionId: this.announcedSessionId() });
        this.replyFinished = false;
        break;
      }
    }

    return events;
  }

  /**
   * 2.x: the bounded background wait. After a finished reply, `background_wait`
   * means the turn is answered and `opencode run` only waits for background
   * jobs (2.3.1: a shell command past its tool timeout, e.g. a dev server,
   * which may never end). The deadline is fixed when the wait starts: 10 min
   * for shell jobs only, 30 min when any job is something else (e.g. a
   * sub-agent) or the list is empty; a later job set that needs the long cap
   * extends it to start + 30 min, never shortens it, and a repeated wait
   * does not restart it. Only new model work (step_start, text, tool_use)
   * cancels it; if that ends in another reply and wait, a fresh one starts.
   * When it passes, the session emits a notice and a turn_end: the turn ends as
   * completed, and the daemon's turn end stop (terminate_on_turn_end:
   * SIGTERM, which 2.3.1 answers by exiting with 143 and killing the jobs, then
   * the tree after the grace) ends the run. The exit after a turn_end is the
   * expected termination, not a runtime failure.
   */
  quietOutputDeadline(): RuntimeQuietOutputDeadline | null {
    const wait = this.backgroundWait;
    if (!wait) return null;
    return {
      atMs: wait.deadlineAtMs,
      stopReason: "opencode_background_wait_cap",
      expire: () => {
        if (this.backgroundWait !== wait) return [];
        this.backgroundWait = null;
        this.backgroundWaitShownKey = null;
        this.replyFinished = false;
        const capMs = wait.deadlineAtMs - wait.startedAtMs;
        return [
          {
            kind: "runtime_diagnostic",
            severity: "info",
            source: "opencode_background_wait",
            itemType: "background_wait_stopped",
            message: `Stopped background job(s) still running after ${formatCapDuration(capMs)}${wait.jobs.length > 0 ? `: ${backgroundJobTitles(wait.jobs)}` : ""}`,
            backgroundJobs: backgroundJobsTraceFields(wait.jobs, capMs),
          },
          { kind: "turn_end", sessionId: this.announcedSessionId() },
        ];
      },
    };
  }

  /**
   * 2.x: the turn ends when the output does, if the last thing printed was
   * reply output (a step_finish other than tool-calls, or text). A run that
   * stopped mid-step (crash, tool call, background wait) gets no turn_end; its
   * process exit decides the outcome. A 2.x run that prints its reply and then
   * stays alive is bounded only where it says why: `background_wait` after
   * the reply ends the turn after the cap (quietOutputDeadline), and
   * background compaction is turned off at launch (withForegroundCompaction).
   * Known risk, still accepted: a run that prints its reply and then hangs
   * silently, without `background_wait`, is not ended here (1.x was killed at
   * its final step_finish). 2.3.0 exits about 80 ms after the reply.
   */
  parseStdoutEnd(): ParsedEvent[] {
    if (!this.replyFinished) return [];
    this.replyFinished = false;
    return [{ kind: "turn_end", sessionId: this.announcedSessionId() }];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildOpenCodeSystemPrompt(config);
  }
}
