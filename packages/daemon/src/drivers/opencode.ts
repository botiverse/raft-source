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
import { lookupCommandOnPath, readCommandVersion, readCommandVersionDetailedAsync, resolveCommandOnPath, resolveCommandOnPathAsync, type CommandVersionRead, type ProbeDeps } from "./probe";
import { ProbeChildError, runProbeChild } from "./probeChild";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types";
import { prepareManagedMcpRuntimeProxy } from "../managedMcpRuntimeProxy";
import type { ModelLister } from "@botiverse/oar";
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
  const builtConfig = buildOpenCodeConfig(ctx, home, managedMcp);
  // Without `--agent` (OpenCode >= 1.15, see requiresAgentCliFlag), `opencode
  // run` uses `default_agent`, else its built-in `build` agent, whose prompt is
  // OpenCode's own: the standing prompt in the `slock` agent was never used.
  // Verified on 1.15.0 and 1.18.35 by capturing the provider request.
  const selectedConfig = agentCliFlag ? builtConfig : { ...builtConfig, default_agent: SLOCK_AGENT_NAME };
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
  const { plugin: _plugin, ...configWithoutPlugins } = selectedConfig;
  const config = v2 ? configWithoutPlugins : selectedConfig;
  let emptyConfigDir: string | null = null;
  if (v2) {
    const slockHome = ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome();
    emptyConfigDir = path.join(slockHome, OPENCODE_EMPTY_CONFIG_DIR);
    mkdirSync(emptyConfigDir, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    ...slock.spawnEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(emptyConfigDir ? { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_CONFIG_DIR: emptyConfigDir } : {}),
  };

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


// ── task #1277: asynchronous twins of the Windows models listing above ───────
//
// After #9790 the Windows form detection is the only caller of the models
// command; these twins keep its command resolution, environment and result
// mapping and run every child (the PATH lookup, the version read, the models
// listing, the optional `npm root -g`) through runProbeChild. The synchronous
// functions stay for the launch path and the detection child until their PRs.

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
      if (globalRoot) candidates.push(...opencodePackageEntryCandidates(winPath.join(globalRoot, "opencode-ai")));
    } catch (error) {
      if (isProbeAbort(error)) throw error;
      // npm is not guaranteed to exist for native OpenCode installs.
    }
  }

  if (commandPath) {
    const commandDir = winPath.dirname(commandPath);
    candidates.push(...opencodePackageEntryCandidates(winPath.join(commandDir, "node_modules", "opencode-ai")));
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
    const command = await resolveCommandOnPathAsync("opencode", deps);
    if (!command) {
      throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message: "Cannot resolve OpenCode CLI on PATH." });
    }
    return { command, args: commandArgs, shell: false };
  }

  const command = await resolveCommandOnPathAsync("opencode", deps);
  if (command && path.win32.extname(command).toLowerCase() === ".exe") {
    return { command, args: commandArgs, shell: false };
  }

  const packageEntry = await resolveWindowsOpenCodePackageEntryAsync(command, deps);
  if (packageEntry) return openCodeSpecForEntry(packageEntry, commandArgs, deps);

  if (command && !isWindowsCommandShim(command)) {
    return { command, args: commandArgs, shell: false };
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message:
    "Cannot resolve OpenCode CLI entry point on Windows without cmd.exe. " +
    "Install the native OpenCode executable or install opencode-ai globally so Slock can launch " +
    "node_modules/opencode-ai/bin/opencode.exe directly." });
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

async function readOpenCodeVersionAsync(deps: OpenCodeProbeDeps = {}): Promise<string | null> {
  try {
    const read = await readOpenCodeVersionDetailedAsync(deps);
    return read.kind === "version" ? read.version : null;
  } catch (error) {
    if (isProbeAbort(error)) throw error;
    return null;
  }
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

type OpenCodeModelsCommandAsync = (home: string) => Promise<OpenCodeModelsCommandResult>;

/** task #1277 — {@link runOpenCodeModelsCommand} off the event loop; same result shape (status / stdout / error). */
export async function runOpenCodeModelsCommandAsync(
  home: string,
  deps: OpenCodeProbeDeps = {},
): Promise<OpenCodeModelsCommandResult> {
  const platform = deps.platform ?? process.platform;
  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const env = { ...ambientProcessEnv(), HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" };
  // task #1258: on 2.x every subcommand, `models` included, attaches to or
  // starts the per-user background server unless told to stand alone.
  const modelsArgs = isOpenCodeV2Launch(await readOpenCodeVersionAsync({ ...deps, env })) ? ["models", "--standalone"] : ["models"];
  let launch: { command: string; args: string[]; env?: NodeJS.ProcessEnv } = { command: "opencode", args: modelsArgs };
  if (platform === "win32") {
    try {
      launch = await resolveOpenCodeSpawnAsync(modelsArgs, { ...deps, env });
    } catch (error) {
      if (isProbeAbort(error)) throw error;
      return { status: null, stdout: "", error: error as Error };
    }
  }
  try {
    const { stdout } = await runChild(launch.command, launch.args, {
      env: launch.env ?? env,
      timeoutMs: 5000,
      shell: false,
      platform,
      signal: deps.signal,
    });
    return { status: 0, stdout };
  } catch (error) {
    if (isProbeAbort(error)) throw error;
    const failure = error as ProbeChildError;
    // A non-zero exit carries its status, as spawnSync's result did; a timeout
    // or spawn failure carries the error, as spawnSync's `error` did.
    if (typeof failure.status === "number") return { status: failure.status, stdout: failure.stdout ?? "" };
    return { status: null, stdout: failure.stdout ?? "", error: failure };
  }
}

/** task #1277 — {@link detectOpenCodeModelSource} off the event loop; same outcome mapping. */
export async function detectOpenCodeModelSourceAsync(
  home: string = os.homedir(),
  runCommand: OpenCodeModelsCommandAsync = runOpenCodeModelsCommandAsync,
): Promise<RuntimeModelSourceOutcome> {
  const commandResult = await runCommand(home);
  if (commandResult.error || commandResult.status !== 0) {
    return { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet(parseOpenCodeModelsOutput(commandResult.stdout));
}

/** Above OAR's cold first run (it also fetches models.dev) and under the server's 20 s per-detection budget. */
const OPENCODE_MODEL_DETECTION_DEADLINE_MS = 15_000;

/**
 * Lists opencode models through OAR's `listModels`: asynchronous, so a slow
 * `opencode models` no longer blocks the daemon's event loop the way the
 * spawnSync path did. The listed binary is the one sessions launch: the bare
 * `opencode` command on PATH, which is what `runOpenCodeModelsCommand` ran.
 */
async function opencodeModelLister(): Promise<ModelLister> {
  const { listModels } = await loadOarRuntime("opencode");
  if (!listModels) throw new Error("OAR's opencode runtime has no model listing");
  return listModels;
}

export async function detectOpenCodeModelSourceViaOar(
  lister?: ModelLister,
  deadlineMs: number = OPENCODE_MODEL_DETECTION_DEADLINE_MS,
): Promise<RuntimeModelSourceOutcome> {
  return detectModelSourceViaOar({
    lister: lister ?? await opencodeModelLister(),
    installation: { kind: "available", via: "executable", command: "opencode" },
    deadlineMs,
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
        candidates.push(...opencodePackageEntryCandidates(winPath.join(globalRoot, "opencode-ai")));
      }
    } catch {
      // npm is not guaranteed to exist for native OpenCode installs.
    }
  }

  if (commandPath) {
    const commandDir = winPath.dirname(commandPath);
    candidates.push(...opencodePackageEntryCandidates(winPath.join(commandDir, "node_modules", "opencode-ai")));
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
    const command = resolveCommandOnPath("opencode", deps);
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

  const packageEntry = resolveWindowsOpenCodePackageEntry(command, deps);
  if (packageEntry) return openCodeSpecForEntry(packageEntry, commandArgs, deps);

  if (command && !isWindowsCommandShim(command)) {
    return { command, args: commandArgs, shell: false };
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "opencode", message:
    "Cannot resolve OpenCode CLI entry point on Windows without cmd.exe. " +
    "Install the native OpenCode executable or install opencode-ai globally so Slock can launch " +
    "node_modules/opencode-ai/bin/opencode.exe directly." });
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
 * resumed with OpenCode's native `--session <id>` support.
 */
export class OpenCodeDriver implements RuntimeDriver {
  readonly id = "opencode";
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

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    // Windows keeps the daemon's own launch resolution: opencode there is often
    // an npm .cmd shim that resolveOpenCodeSpawn unwraps to node + entry script.
    // task #1277: the Windows listing runs as bounded probe children too.
    if (process.platform === "win32") return detectOpenCodeModelSourceAsync();
    return detectOpenCodeModelSourceViaOar();
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || null;
    this.announcedId = null;
    this.seenToolCallIds.clear();
    this.persistedSessionId = null;
    this.sessionRecordState = "pending";

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

    switch (event.type) {
      case "step_start":
        events.push({ kind: "thinking", text: "" });
        break;

      case "text":
        if (typeof event.part?.text === "string" && event.part.text.length > 0) {
          events.push({ kind: "text", text: event.part.text });
        }
        break;

      case "tool_use":
        events.push(...this.finishedToolEvents(event.part));
        break;

      case "step_finish":
        // 1.x ends every reply with a step_finish (reason "stop"); 2.0.27
        // prints one only after tool calls and none for the final reply, so a
        // 2.x turn may end without this event. That is fine for a per_turn
        // runtime: the daemon closes the turn on process exit (see
        // runtimeSession.ts turnBoundary "process_exit").
        if (event.part?.reason !== "tool-calls") {
          events.push({ kind: "turn_end", sessionId: this.announcedSessionId() });
        }
        break;

      case "error": {
        const message =
          event.error?.data?.message ||
          event.error?.message ||
          (event.error?.name ? `${event.error.name} (no message)` : null) ||
          "Unknown OpenCode error";
        events.push({ kind: "error", message });
        events.push({ kind: "turn_end", sessionId: this.announcedSessionId() });
        break;
      }
    }

    return events;
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
