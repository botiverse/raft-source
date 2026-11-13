import { ambientProcessEnv } from "../processEnvPatch";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { spawn, execFileSync } from "node:child_process";
import { spawnRuntimeChild } from "./runtimeChild";
import { codexInstalledExecutableCandidates } from "@botiverse/oar/runtimes/codex/installation-candidates";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, runtimeModelSourceOutcomeFromSet, type AgentConfig, type RuntimeModelInfo, type RuntimeModelSet, type RuntimeModelSourceOutcome, type Tracer , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent, RuntimeProbeResult, RuntimeProbeUnavailableReason } from "./types";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { codexStateRootCandidates, resolveCodexHomeRootFromEnv } from "./codexHome";
import { detectNodeHostKind, NodeHostUnavailableError, resolveNodeHostLaunch } from "./nodeHostLaunch";
import {
  firstExistingPath,
  lookupCommandOnPath,
  lookupCommandOnPathAsync,
  resolveCommandOnPath,
  resolveCommandOnPathAsync,
  withWindowsUserEnvironment,
  withWindowsUserEnvironmentAsync,
  type ProbeDeps,
} from "./probe";
import { killProbeTreeAndSettle, ProbeChildError, runProbeChild } from "./probeChild";
import { isWindowsBatchFile, resolveWindowsDirectLaunch, resolveWindowsDirectLaunchAsync } from "./windowsLaunch";
import {
  CodexEventNormalizer,
  parseCodexJsonRpcLine,
  type JsonRpcMessage,
  type JsonRpcId,
} from "./codexEventNormalizer";
import { prepareManagedMcpRuntimeProxy, type ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import {
  buildCodexInstructionShapeAttrs,
  buildCodexInstructionShapeStaticAttrs,
  type CodexInstructionObservationPhase,
  type CodexInstructionShapeStaticAttrs,
  type CodexThreadRequestMethod,
} from "./codexInstructionShape";

export { codexBlankFinalAnswerDiagnostic, codexMcpToolName, codexNotificationDiagnostics, parseCodexJsonRpcLine } from "./codexEventNormalizer";
export { parseCodexTelemetryEvent } from "./codexTelemetrySidecar";
export { buildCodexInstructionShapeAttrs, buildCodexInstructionShapeStaticAttrs, type CodexInstructionObservationPhase, type CodexThreadRequestMethod } from "./codexInstructionShape";

/**
 * macOS desktop-bundled Codex CLI locations that are still real install surfaces.
 * `Codex.app` is intentionally NOT listed: shipping installs put the CLI under
 * ChatGPT.app; re-introducing the dead Codex.app path would re-select a missing
 * fallback and mask PATH/override failures. Use CODEX_BIN for one-off paths.
 */
const CODEX_DESKTOP_BUNDLE_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
] as const;
const CODEX_APP_SERVER_PROBE_ARGS = ["app-server", "--help"] as const;

/** Escape hatch: absolute path or PATH name. Checked before PATH discovery. */
const CODEX_BIN_ENV = "CODEX_BIN";
/**
 * Budget for the `npm root -g` child that locates a global npm Codex install on
 * Windows (task #1263). It ran unbounded before: a hung npm (corrupt cache,
 * slow network-backed profile) stalled the whole synchronous runtime detection
 * round, which runs before the daemon's `ready`. Same value as the other probe
 * children (`readCommandVersion`, the app-server probe, the PATH lookup steps).
 */
export const CODEX_NPM_ROOT_TIMEOUT_MS = 5000;

/** Budget for each probe child (`app-server --help`, `--version`). */
const CODEX_PROBE_CHILD_TIMEOUT_MS = 5000;
/**
 * A candidate whose app-server check timed out gets one longer check before a
 * start settles for another candidate (#oar-raft:#7): right after a Computer
 * restart a busy Windows machine timed out the PATH Codex 0.165 and started
 * agents on Codex Desktop's 0.130, which cannot read the newer config.
 */
const CODEX_PROBE_RETRY_TIMEOUT_MS = 15_000;

/**
 * task #1358 — how long a failed probe result (or a success whose version read
 * failed) may be reused for an unchanged file. A failure is not proof about the
 * file: a timeout or a signal is about this moment, and a non-zero exit or
 * EACCES/EPERM can clear without the mtime or size changing (chmod, a config
 * or environment fix). Long enough that the detection probe and the launch
 * that follows it do not each wait out the same slow child; short enough that
 * a manual retry soon after re-probes. Only a full success (app-server check
 * passed and the version read) is reused until the file's mtime or size
 * changes.
 */
export const CODEX_PROBE_FAILURE_TTL_MS = 10_000;

type CodexProbeCacheEntry = {
  mtimeMs: number;
  size: number;
  appServerOk: boolean;
  version: string | null;
  failure: string | null;
  /** True when the app-server failure was a timeout (the typed `probe_timeout` outcome). */
  timedOut: boolean;
  /** The app-server check's time budget; a timeout under a shorter budget than a caller asks for is not reused. */
  probeTimeoutMs: number;
  /** True when the entry expires after {@link CODEX_PROBE_FAILURE_TTL_MS}: every result except a full success. */
  transient: boolean;
  /** Monotonic time ({@link probeNow}) the result was recorded. */
  storedAt: number;
};

const codexProbeCache = new Map<string, CodexProbeCacheEntry>();

type CodexProbeOutcome = {
  failure: string | null;
  version: string | null;
  timedOut: boolean;
  /** Present when the result came from the cache: its age and whether it expires. */
  cached?: { ageMs: number; transient: boolean };
};

function probeNow(deps: ProbeDeps): number {
  return deps.nowFn ? deps.nowFn() : performance.now();
}

/**
 * task #1358 — a timeout is checked before the signal: execFileSync reports a
 * child killed at its budget as `code: ETIMEDOUT, signal: SIGTERM`, and the
 * async runner as `code: ETIMEDOUT`; both are the same "timed out".
 */
function classifyCodexProbeError(error: unknown): { failure: string; timedOut: boolean } {
  if ((error as { code?: unknown } | null)?.code === "ETIMEDOUT") return { failure: "ETIMEDOUT", timedOut: true };
  return { failure: describeCodexProbeFailure(error), timedOut: false };
}

function readCodexProbeCache(
  cacheKey: string,
  stat: { mtimeMs: number; size: number } | null,
  deps: ProbeDeps,
  probeTimeoutMs: number = CODEX_PROBE_CHILD_TIMEOUT_MS,
): CodexProbeOutcome | null {
  if (!stat) return null;
  const cached = codexProbeCache.get(cacheKey);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null;
  if (cached.timedOut && cached.probeTimeoutMs < probeTimeoutMs) return null;
  const ageMs = probeNow(deps) - cached.storedAt;
  if (cached.transient && (ageMs < 0 || ageMs >= CODEX_PROBE_FAILURE_TTL_MS)) {
    codexProbeCache.delete(cacheKey);
    return null;
  }
  return {
    failure: cached.failure,
    version: cached.version,
    timedOut: cached.timedOut,
    cached: { ageMs: Math.max(0, ageMs), transient: cached.transient },
  };
}

function writeCodexProbeCache(
  cacheKey: string,
  stat: { mtimeMs: number; size: number } | null,
  deps: ProbeDeps,
  result: { failure: string | null; version: string | null; timedOut: boolean; transient: boolean; probeTimeoutMs?: number },
): void {
  if (!stat) return;
  codexProbeCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    appServerOk: result.failure === null,
    version: result.version,
    failure: result.failure,
    timedOut: result.timedOut,
    probeTimeoutMs: result.probeTimeoutMs ?? CODEX_PROBE_CHILD_TIMEOUT_MS,
    transient: result.transient,
    storedAt: probeNow(deps),
  });
}

/** Path- and environment-free note on a rejection whose result came from the cache. */
function codexCachedRejectionNote(outcome: CodexProbeOutcome): string {
  if (!outcome.cached) return "";
  const ageS = Math.round(outcome.cached.ageMs / 1000);
  return ` (cached result from ${ageS} s ago; checked again after ${CODEX_PROBE_FAILURE_TTL_MS / 1000} s)`;
}

function codexRejection(prefix: string, outcome: CodexProbeOutcome): string {
  return `${prefix} rejected: app-server probe ${outcome.failure}${codexCachedRejectionNote(outcome)}`;
}

/**
 * task #1358 — every candidate was found but its app-server check timed out.
 * The message is shown to the user (classifySpawnFailure), so it names no
 * path and no environment.
 */
function codexProbeTimeoutError(explicitOverride: boolean): RuntimeExecutableNotFoundError {
  const subject = explicitOverride ? `The Codex CLI named by ${CODEX_BIN_ENV}` : "Codex";
  return new RuntimeExecutableNotFoundError({
    runtimeId: "codex",
    reason: "probe_timeout",
    message:
      `${subject} was found on this Computer, but its \`app-server\` check did not finish within ${CODEX_PROBE_CHILD_TIMEOUT_MS} ms. ` +
      `This is not evidence that Codex is missing; Raft checks it again on a start after ${CODEX_PROBE_FAILURE_TTL_MS / 1000} seconds. ` +
      "If it keeps happening, check that `codex app-server --help` runs in a new terminal, then restart Raft Computer.",
  });
}

function hasNonEmptyCodexTextInput(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) =>
    item &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "text" &&
    typeof (item as { text?: unknown }).text === "string" &&
    (item as { text: string }).text.length > 0
  );
}

function resultTurnId(message: JsonRpcMessage): string | null {
  const turn = message.result?.turn;
  return turn && typeof turn.id === "string" ? turn.id : null;
}

interface CodexSpawnCandidate {
  source: "explicit_bin" | "npm_global" | "path" | "desktop_bundle" | "desktop_install";
  command: string;
  argsPrefix: string[];
  /** Runtimes are never started through a shell; see windowsLaunch.ts. */
  shell: false;
  env?: NodeJS.ProcessEnv;
  /**
   * Windows: the npm/pnpm `.cmd` shim this launch was resolved from, only
   * when OAR runs that shim's target itself without cmd.exe
   * (oarRunnableShim), for the OAR host.
   */
  windowsShim?: string;
}

interface CodexSpawnCandidateDiscovery {
  candidates: CodexSpawnCandidate[];
  /** Credential-free reasons a discovered surface could not become a candidate. */
  rejected: string[];
  /** Why the `codex` PATH lookup resolved nothing; absent when it resolved a command. */
  pathMissReason?: RuntimeProbeUnavailableReason;
  /** Path-free observations that reject nothing and never change classification (e.g. a timed-out discovery step). */
  notes: string[];
}

type ExplicitCodexBinResolution =
  | { status: "unset" }
  | { status: "resolved"; candidate: CodexSpawnCandidate }
  | { status: "invalid"; raw: string; reason: string };

/**
 * Codex's Windows sandbox helpers: `codex-command-runner*`, and anything under
 * a `.sandbox-bin` directory (#oar-raft:#7), where a helper can carry a
 * `codex.exe`-like name and an old version (0.130.0-alpha.5).
 */
/** Path-free: the first `codex` on PATH is a sandbox helper, so PATH gives no candidate. */
const CODEX_PATH_SANDBOX_HELPER_REJECTION = "path codex rejected: the first codex on PATH is a Codex sandbox helper (codex-command-runner or .sandbox-bin); put the Codex CLI ahead of it on PATH";

function isWindowsSandboxRunner(commandPath: string): boolean {
  const segments = commandPath.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return (segments.at(-1) ?? "").startsWith("codex-command-runner") || segments.slice(0, -1).includes(".sandbox-bin");
}

/**
 * `shim` when OAR runs it without cmd.exe, else undefined (the OAR host then
 * hands the start back to the driver). OAR's `parseWindowsShim`
 * (windows-shim.ts, OAR 0.101.1; not exported) takes a shim that forwards
 * `%*` to exactly one shim-relative (`%dp0%` / `%~dp0`) Node script or native
 * program, as npm and pnpm write them; anything else it runs through cmd.exe.
 */
function oarRunnableShim(shim: string, deps: ProbeDeps): string | undefined {
  const readFileSyncFn = deps.readFileSyncFn ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  let text: string;
  try {
    text = String(readFileSyncFn(shim, "utf8"));
  } catch {
    return undefined;
  }
  if (!text.includes("%*")) return undefined;
  const dir = path.win32.dirname(shim);
  const targets = [...new Set([...text.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((token) => /%(?:~)?dp0%?/i.test(token))
    .map((token) => path.win32.normalize(token.replaceAll(/%dp0%|%~dp0/gi, `${dir}\\`))))];
  const scripts = targets.filter((target) => /\.(?:c|m)?js$/i.test(target)).length;
  const natives = targets.filter((target) => /\.(?:exe|com)$/i.test(target) && !/(?:^|[\\/])node\.exe$/i.test(target)).length;
  return (scripts === 1 && natives === 0) || (natives === 1 && scripts === 0) ? shim : undefined;
}

function resolveWindowsNpmCodexEntry(deps: ProbeDeps = {}): { entry: string | null; shim?: string; note?: string } {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  let note: string | undefined;

  try {
    const globalRoot = String(execFileSyncFn("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout: CODEX_NPM_ROOT_TIMEOUT_MS,
    })).trim();
    const candidate = winPath.join(globalRoot, "@openai", "codex", "bin", "codex.js");
    // npm's global shims sit in the prefix, one level above `npm root -g`.
    const shim = winPath.join(winPath.dirname(globalRoot), "codex.cmd");
    if (existsSyncFn(candidate)) return { entry: candidate, shim: existsSyncFn(shim) ? oarRunnableShim(shim, deps) : undefined };
  } catch (error) {
    // A missing or failing npm is an expected state and stays silent; only a
    // child killed at the budget is worth a (path-free) note, because the global
    // npm install was then not searched at all rather than found empty.
    if ((error as { code?: unknown }).code === "ETIMEDOUT") {
      note = `npm_global discovery: \`npm root -g\` did not finish within ${CODEX_NPM_ROOT_TIMEOUT_MS} ms, so the global npm install was not searched and a Codex installed only there is not ruled out`;
    }
  }

  const cmdPath = resolveCommandOnPath("codex", deps);
  if (cmdPath) {
    const candidate = winPath.join(winPath.dirname(cmdPath), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSyncFn(candidate)) return { entry: candidate, shim: isWindowsBatchFile(cmdPath) ? oarRunnableShim(cmdPath, deps) : undefined, ...(note ? { note } : {}) };
  }

  return { entry: null, ...(note ? { note } : {}) };
}

/**
 * The Codex Desktop CLIs on this machine, as OAR lists them
 * (`codexInstalledExecutableCandidates`, OAR 0.101.1): per Desktop `bin`
 * folder, the fixed `bin\codex.exe`, then the newest three
 * `bin\<build hash>\codex.exe` builds (#proj-raft-computer:#66), most
 * recently written first, sandbox helpers' dot folders excluded. Each that
 * exists is its own discovery candidate, so the normal probe and version
 * arbitration choose among them and a half-installed or broken build falls
 * through to the next. OAR's list also names npm's `%APPDATA%\npm\codex.cmd`
 * shim; Raft finds npm installs through `npm root -g` and PATH instead
 * (resolveWindowsNpmCodexEntry), so only the Desktop `codex.exe` entries are
 * taken. PATH and `CODEX_BIN` stay Raft's own, as OAR leaves them out too.
 */
function windowsCodexDesktopEntries(deps: ProbeDeps = {}): string[] {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const env = deps.env ?? ambientProcessEnv();
  // OAR searches LOCALAPPDATA, then USERPROFILE and `<home>` AppData\Local, deduplicated.
  const home = deps.homeDir ?? env.USERPROFILE ?? os.homedir();
  const listed = codexInstalledExecutableCandidates("win32", home, env, deps.codexDesktopBuildsFn);
  return [...new Set(listed.filter((candidate) => path.win32.basename(candidate).toLowerCase() === "codex.exe"
    && !isWindowsSandboxRunner(candidate)
    && existsSyncFn(candidate)))];
}

function resolveWindowsCodexDesktopEntry(deps: ProbeDeps = {}): string | null {
  return windowsCodexDesktopEntries(deps)[0] ?? null;
}

/**
 * Automatic discovery candidates only. Explicit `CODEX_BIN` is never mixed into
 * this list — it is a separate authoritative decision before version arbitration.
 */
function codexSpawnCandidates(deps: ProbeDeps = {}): CodexSpawnCandidateDiscovery {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const candidates: CodexSpawnCandidate[] = [];
    const rejected: string[] = [];

    const npm = resolveWindowsNpmCodexEntry(deps);
    const notes = npm.note ? [npm.note] : [];
    const npmEntry = npm.entry;
    if (npmEntry) {
      try {
        const nodeHost = resolveNodeHostLaunch({
          env: deps.env ?? ambientProcessEnv(),
          execPath: deps.execPath,
          execIsElectron: deps.execIsElectron,
          execIsSea: deps.execIsSea,
          hasNodeRuntime: deps.hasNodeRuntime,
        });
        candidates.push({
          source: "npm_global",
          command: nodeHost.command,
          argsPrefix: [...nodeHost.execArgv, npmEntry],
          shell: false,
          env: nodeHost.env,
          ...(npm.shim ? { windowsShim: npm.shim } : {}),
        });
      } catch (error) {
        if (!(error instanceof NodeHostUnavailableError)) throw error;
        // The npm package exists, but this host cannot execute its JavaScript
        // entry. That rejects only this candidate: a cmd shim or native Codex
        // executable may still be usable. Keep the reason path-free because it
        // is emitted through runtime inventory diagnostics.
        rejected.push(
          `npm_global JavaScript entry rejected: ${error.kind} (host_kind=${error.hostKind})`,
        );
      }
    }

    const { command, missReason: pathMissReason } = lookupCommandOnPath("codex", deps);
    if (command && isWindowsSandboxRunner(command)) rejected.push(CODEX_PATH_SANDBOX_HELPER_REJECTION);
    if (command && !isWindowsSandboxRunner(command)) {
      const direct = windowsDirectCodexCandidate("path", command, deps);
      if (typeof direct === "string") rejected.push(direct);
      else candidates.push(direct);
    }

    for (const desktopEntry of windowsCodexDesktopEntries(deps)) {
      if (candidates.some((candidate) => candidate.command === desktopEntry)) continue;
      candidates.push({
        source: "desktop_install",
        command: desktopEntry,
        argsPrefix: [],
        shell: false,
      });
    }

    return { candidates, rejected, notes, ...(pathMissReason ? { pathMissReason } : {}) };
  }

  const candidates: CodexSpawnCandidate[] = [];

  const { command: pathCommand, missReason: pathMissReason } = lookupCommandOnPath("codex", deps);
  if (pathCommand) {
    candidates.push({
      source: "path",
      command: pathCommand,
      argsPrefix: [],
      shell: false,
    });
  }

  if (platform === "darwin") {
    const existsSyncFn = deps.existsSyncFn ?? existsSync;
    for (const bundlePath of darwinDesktopCodexPaths(deps)) {
      if (!existsSyncFn(bundlePath)) continue;
      if (candidates.some((candidate) => candidate.command === bundlePath)) continue;
      candidates.push({
        source: "desktop_bundle",
        command: bundlePath,
        argsPrefix: [],
        shell: false,
      });
    }
  }

  return { candidates, rejected: [], notes: [], ...(pathMissReason ? { pathMissReason } : {}) };
}

export function resolveCodexCommand(deps: ProbeDeps = {}): string | null {
  const explicit = resolveExplicitCodexBin(deps);
  if (explicit.status === "resolved") return explicit.candidate.command;
  if (explicit.status === "invalid") return null;

  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const npmEntry = resolveWindowsNpmCodexEntry(deps).entry;
    if (npmEntry) return npmEntry;

    const command = resolveCommandOnPath("codex", deps);
    if (command && !isWindowsSandboxRunner(command)) return command;

    return resolveWindowsCodexDesktopEntry(deps);
  }

  const pathCommand = resolveCommandOnPath("codex", deps);
  if (pathCommand) return pathCommand;

  if (platform === "darwin") {
    return firstExistingPath(darwinDesktopCodexPaths(deps), deps);
  }

  return null;
}

function formatCodexCandidate(candidate: CodexSpawnCandidate): string {
  return [candidate.command, ...candidate.argsPrefix].join(" ");
}

function codexCandidateCacheKey(candidate: CodexSpawnCandidate): string {
  return `${candidate.shell ? "shell" : "exec"}\0${candidate.command}\0${candidate.argsPrefix.join("\0")}`;
}

function readCandidateStat(candidate: CodexSpawnCandidate, deps: ProbeDeps): { mtimeMs: number; size: number } | null {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const statSyncFn = deps.statSyncFn ?? ((filePath: string) => {
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  });
  // A JS entry is the last prefix element; Node options may come before it.
  const entry = candidate.argsPrefix.at(-1);
  const statPath = entry && candidate.command !== entry ? entry : candidate.command;
  if (!existsSyncFn(statPath)) return null;
  try {
    return statSyncFn(statPath);
  } catch {
    return null;
  }
}

/** Parsed Codex CLI version for ordering (core triple + optional prerelease numeric trail). */
type ParsedCodexVersion = {
  core: [number, number, number];
  /** null = release build (ranks above any prerelease with the same core). */
  pre: number[] | null;
};

/**
 * Parse real Codex version strings, including:
 * - `codex-cli 0.144.6`
 * - `0.147.0-alpha.6.5` / `codex-cli 0.147.0-alpha.1`
 */
export function parseCodexVersion(raw: string | null | undefined): ParsedCodexVersion | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  const core: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4]) return { core, pre: null };
  // Keep only numeric segments from the prerelease trail (alpha.6.5 → [6, 5]).
  const pre = m[4]
    .split(/[.-]/)
    .map((part) => {
      const n = Number(part);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n !== null);
  // Non-numeric-only labels (e.g. bare "alpha") still rank below release via empty pre [].
  return { core, pre };
}

/** Compare Codex versions; returns >0 if a newer than b. Unparseable → null. */
export function compareCodexVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseCodexVersion(a);
  const pb = parseCodexVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i]! > pb.core[i]!) return 1;
    if (pa.core[i]! < pb.core[i]!) return -1;
  }
  // Release (pre=null) > any prerelease with the same core.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa.pre[i] ?? 0;
    const bv = pb.pre[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/** Test hook: empty the process-local app-server/version probe cache. */
export function clearCodexProbeCacheForTests(): void {
  codexProbeCache.clear();
}

function describeSearchPath(deps: ProbeDeps): string {
  const env = deps.env ?? ambientProcessEnv();
  const pathValue = env.PATH ?? env.Path ?? "(unset)";
  if ((deps.platform ?? process.platform) === "win32") {
    return pathValue === "(unset)" || pathValue.trim().length === 0
      ? "PATH=(unset)"
      : "PATH=present";
  }
  const preview = pathValue.length > 240 ? `${pathValue.slice(0, 240)}…` : pathValue;
  return `PATH=${preview}`;
}

function darwinDesktopCodexPaths(deps: ProbeDeps): string[] {
  const env = deps.env ?? ambientProcessEnv();
  const home = deps.homeDir ?? env.HOME ?? os.homedir();
  return [
    ...CODEX_DESKTOP_BUNDLE_PATHS,
    path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"),
  ];
}

/**
 * Authoritative override from `CODEX_BIN`. Distinct from automatic discovery:
 * when set, resolution either uses this binary (after probe) or fails closed —
 * it never competes in multi-candidate version arbitration.
 */
function resolveExplicitCodexBin(deps: ProbeDeps): ExplicitCodexBinResolution {
  const env = deps.env ?? ambientProcessEnv();
  const raw = env[CODEX_BIN_ENV]?.trim();
  if (!raw) return { status: "unset" };

  const platform = deps.platform ?? process.platform;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;

  let command: string | null = null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    command = existsSyncFn(raw) ? raw : null;
    if (!command) {
      return { status: "invalid", raw, reason: "path does not exist" };
    }
  } else {
    command = resolveCommandOnPath(raw, deps);
    if (!command) {
      return { status: "invalid", raw, reason: "not found on PATH" };
    }
  }

  if (platform === "win32" && isWindowsSandboxRunner(command)) {
    return {
      status: "invalid",
      raw,
      reason: "points at a Codex sandbox helper (codex-command-runner or .sandbox-bin), not the Codex CLI",
    };
  }

  if (platform === "win32") {
    const direct = windowsDirectCodexCandidate("explicit_bin", command, deps);
    if (typeof direct === "string") return { status: "invalid", raw, reason: direct };
    return { status: "resolved", candidate: direct };
  }

  return {
    status: "resolved",
    candidate: {
      source: "explicit_bin",
      command,
      argsPrefix: [],
      shell: false,
    },
  };
}

/**
 * A Windows command as a direct launch: a .cmd/.bat shim is resolved to the
 * program it runs, never started through cmd.exe. Returns a path-free
 * rejection reason when the shim cannot be resolved.
 */
function windowsDirectCodexCandidate(
  source: CodexSpawnCandidate["source"],
  command: string,
  deps: ProbeDeps,
): CodexSpawnCandidate | string {
  try {
    const launch = resolveWindowsDirectLaunch("codex", command, [], deps);
    return {
      source,
      command: launch.command,
      argsPrefix: launch.args,
      shell: false,
      ...(launch.env ? { env: launch.env } : {}),
      ...(isWindowsBatchFile(command) && oarRunnableShim(command, deps) ? { windowsShim: command } : {}),
    };
  } catch (error) {
    if (!(error instanceof RuntimeExecutableNotFoundError)) throw error;
    return `${source} batch wrapper rejected: ${error.reason ?? "unresolved"}`;
  }
}

function describeCodexProbeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      status?: unknown;
      signal?: unknown;
      code?: unknown;
    };
    if (typeof candidate.status === "number") return `exit status ${candidate.status}`;
    if (typeof candidate.signal === "string") return `terminated by ${candidate.signal}`;
    if (typeof candidate.code === "string") return candidate.code;
  }
  return "probe failed";
}

function probeCodexCandidate(
  candidate: CodexSpawnCandidate,
  deps: ProbeDeps = {},
): CodexProbeOutcome {
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const env = withWindowsUserEnvironment(candidate.env ?? deps.env ?? ambientProcessEnv(), deps);
  const stat = readCandidateStat(candidate, deps);
  const cacheKey = codexCandidateCacheKey(candidate);
  const cached = readCodexProbeCache(cacheKey, stat, deps);
  if (cached) return cached;

  let failure: string | null = null;
  let versionFailed = false;
  let timedOut = false;
  try {
    execFileSyncFn(candidate.command, [...candidate.argsPrefix, ...CODEX_APP_SERVER_PROBE_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: CODEX_PROBE_CHILD_TIMEOUT_MS,
      shell: candidate.shell,
    });
  } catch (error) {
    ({ failure, timedOut } = classifyCodexProbeError(error));
  }

  let version: string | null = null;
  if (!failure) {
    try {
      const output = execFileSyncFn(candidate.command, [...candidate.argsPrefix, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        timeout: CODEX_PROBE_CHILD_TIMEOUT_MS,
        shell: candidate.shell,
      });
      version = (Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "")).trim().split(/\r?\n/)[0] || null;
    } catch {
      version = null;
      // A failed version read must not pin "unknown" (it ranks this candidate
      // in version arbitration).
      versionFailed = true;
    }
  }

  writeCodexProbeCache(cacheKey, stat, deps, { failure, version, timedOut, transient: failure !== null || versionFailed });
  return { failure, version, timedOut };
}

function validateCodexAppServer(candidate: CodexSpawnCandidate, deps: ProbeDeps = {}): string | null {
  return probeCodexCandidate(candidate, deps).failure;
}

function readCodexCandidateVersion(candidate: CodexSpawnCandidate, deps: ProbeDeps = {}): string | null {
  return probeCodexCandidate(candidate, deps).version;
}

function resolveCompatibleCodexCandidate(deps: ProbeDeps = {}): {
  candidate: CodexSpawnCandidate | null;
  rejected: string[];
  version: string | null;
  notes: string[];
  /** When CODEX_BIN was set but unusable — callers must fail closed, not fall through. */
  explicitOverrideFailed: boolean;
  /** Automatic discovery only: why the `codex` PATH lookup resolved nothing. */
  pathMissReason?: RuntimeProbeUnavailableReason;
  /** task #1358 — no candidate, and every rejection was an app-server check that timed out. */
  allRejectionsTimedOut?: true;
} {
  const rejected: string[] = [];
  const notes: string[] = [];

  // 1) Explicit override is an authoritative, cross-platform decision.
  const explicit = resolveExplicitCodexBin(deps);
  if (explicit.status === "invalid") {
    return {
      candidate: null,
      rejected: [`${CODEX_BIN_ENV}=${explicit.raw} rejected: ${explicit.reason}`],
      version: null,
      notes: [],
      explicitOverrideFailed: true,
    };
  }
  if (explicit.status === "resolved") {
    const outcome = probeCodexCandidate(explicit.candidate, deps);
    const { failure, version } = outcome;
    if (failure) {
      return {
        candidate: null,
        rejected: [codexRejection(`${CODEX_BIN_ENV}=${formatCodexCandidate(explicit.candidate)}`, outcome)],
        version: null,
        notes: [],
        explicitOverrideFailed: true,
        ...(outcome.timedOut ? { allRejectionsTimedOut: true as const } : {}),
      };
    }
    notes.push(
      `using ${CODEX_BIN_ENV} override ${formatCodexCandidate(explicit.candidate)}` +
      (version ? ` (${version})` : "") +
      "; automatic PATH/desktop discovery skipped",
    );
    return {
      candidate: explicit.candidate,
      rejected: [],
      version,
      notes,
      explicitOverrideFailed: false,
    };
  }

  // 2) Automatic discovery only — version-arbitrate among app-server-capable candidates.
  let best: { candidate: CodexSpawnCandidate; version: string | null } | null = null;

  const discovery = codexSpawnCandidates(deps);
  rejected.push(...discovery.rejected);
  notes.push(...discovery.notes);
  let timedOutRejections = 0;
  for (const candidate of discovery.candidates) {
    const outcome = probeCodexCandidate(candidate, deps);
    const { failure, version } = outcome;
    if (failure) {
      rejected.push(codexRejection(`${candidate.source} ${formatCodexCandidate(candidate)}`, outcome));
      if (outcome.timedOut) timedOutRejections += 1;
      continue;
    }
    if (!best) {
      best = { candidate, version };
      continue;
    }
    const cmp = compareCodexVersions(version, best.version);
    if (cmp !== null && cmp > 0) {
      notes.push(
        `selected ${formatCodexCandidate(candidate)} (${version ?? "unknown"}) over ` +
        `${formatCodexCandidate(best.candidate)} (${best.version ?? "unknown"}) by version`,
      );
      best = { candidate, version };
    }
  }

  return {
    candidate: best?.candidate ?? null,
    rejected,
    version: best?.version ?? null,
    notes,
    explicitOverrideFailed: false,
    ...(discovery.pathMissReason ? { pathMissReason: discovery.pathMissReason } : {}),
    ...(!best && rejected.length > 0 && timedOutRejections === rejected.length ? { allRejectionsTimedOut: true as const } : {}),
  };
}

export function probeCodex(deps: ProbeDeps = {}): RuntimeProbeResult {
  const { candidate, rejected, version, notes, explicitOverrideFailed, pathMissReason, allRejectionsTimedOut } = resolveCompatibleCodexCandidate(deps);
  const parts = [
    ...rejected,
    ...notes,
  ];
  if (!candidate) {
    parts.push(describeSearchPath(deps));
    parts.push("Restart the Raft daemon after changing PATH or installing Codex so the new environment is picked up.");
    // Nothing discovered at all (no CODEX_BIN override, no candidate found and
    // none rejected) carries the PATH lookup's own verdict, so an undecided
    // lookup (e.g. a timeout) is not "not installed". Any rejected candidate or
    // failed override is an installed-but-unusable Codex.
    const nothingDiscovered = !explicitOverrideFailed && rejected.length === 0;
    return {
      available: false,
      unavailableReason: (nothingDiscovered ? pathMissReason : undefined) ??
        (allRejectionsTimedOut ? "probe_timeout" : "probe_failed"),
      diagnostic: parts.length > 0
        ? parts.join("; ")
        : "No Codex CLI app-server candidate was found.",
    };
  }
  return {
    available: true,
    version: version ?? undefined,
    ...(parts.length > 0 ? { diagnostic: parts.join("; ") } : {}),
  };
}

/**
 * Path-free category of one candidate rejection, for telemetry
 * (`node_host_launch` `rejection_kind`, #oar-raft:#7).
 */
export function codexRejectionKind(rejection: string): "timeout" | "node_host" | "batch_wrapper" | "probe_failed" | "other" {
  if (/app-server probe ETIMEDOUT/.test(rejection)) return "timeout";
  if (/JavaScript entry rejected/.test(rejection)) return "node_host";
  if (/batch wrapper rejected/.test(rejection)) return "batch_wrapper";
  if (/app-server probe /.test(rejection)) return "probe_failed";
  return "other";
}

/** The rejections of a resolution that still picked a candidate: count and sorted kinds joined by `+`. */
function codexRejectionSummary(rejected: readonly string[]): { rejectedCandidateCount: number; rejectionKind?: string } {
  const kinds = [...new Set(rejected.map(codexRejectionKind))].sort();
  return { rejectedCandidateCount: rejected.length, ...(kinds.length > 0 ? { rejectionKind: kinds.join("+") } : {}) };
}

export function resolveCodexSpawn(commandArgs: string[], deps: ProbeDeps = {}): {
  command: string;
  args: string[];
  shell: false;
  source: CodexSpawnCandidate["source"];
  env?: NodeJS.ProcessEnv;
  /** Windows: the `.cmd` shim the launch was resolved from (CodexSpawnCandidate.windowsShim). */
  windowsShim?: string;
  /** Candidates rejected before this one was picked (automatic discovery). */
  rejectedCandidateCount?: number;
  rejectionKind?: string;
} {
  const { candidate, rejected, explicitOverrideFailed, allRejectionsTimedOut } = resolveCompatibleCodexCandidate(deps);
  if (candidate) {
    return {
      command: candidate.command,
      args: [...candidate.argsPrefix, ...commandArgs],
      shell: candidate.shell,
      source: candidate.source,
      ...(candidate.env ? { env: candidate.env } : {}),
      ...(candidate.windowsShim ? { windowsShim: candidate.windowsShim } : {}),
      ...codexRejectionSummary(rejected),
    };
  }

  // task #1358: found, but the check timed out — a typed timeout, not "not found".
  if (allRejectionsTimedOut) throw codexProbeTimeoutError(explicitOverrideFailed);

  const search = describeSearchPath(deps);
  const rejectedNote = rejected.length > 0 ? ` Rejected candidates: ${rejected.join("; ")}.` : "";
  const restartNote = " Restart the Raft daemon after changing PATH or installing Codex so the new environment is picked up.";

  if (explicitOverrideFailed) {
    throw new Error(
      `${CODEX_BIN_ENV} is set but does not resolve to a usable Codex CLI app-server entry point.` +
      rejectedNote +
      ` (${search}).` +
      " Fix or unset CODEX_BIN; automatic PATH/desktop discovery is not used while the override is set." +
      restartNote,
    );
  }

  if ((deps.platform ?? process.platform) === "win32") {
    // Surface why a found .cmd wrapper was turned away (launch_unresolved event).
    const wrapperReason = rejected.map((note) => /batch wrapper rejected: (\w+)/.exec(note)?.[1]).find(Boolean);
    throw new RuntimeExecutableNotFoundError({ runtimeId: "codex", reason: wrapperReason, message:
      "Cannot resolve a compatible Codex CLI app-server entry point on Windows. " +
      "Install Codex Desktop or install @openai/codex globally via npm (npm i -g @openai/codex). " +
      "Ignoring .codex/.sandbox-bin/codex-command-runner because it is a sandbox helper, not the Codex CLI." +
      ` (${search}).` +
      rejectedNote +
      restartNote });
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "codex", message:
    `Cannot resolve a compatible Codex CLI app-server entry point (${search}).` +
    rejectedNote +
    restartNote });
}

/** Holds the managed MCP token for Codex, so it is not in the app-server's arguments (#proj-runtime:#40). */
export const CODEX_MANAGED_MCP_TOKEN_ENV = "RAFT_MANAGED_MCP_TOKEN";

export function withCodexManagedMcpToken(
  env: NodeJS.ProcessEnv,
  managedMcp: { token: string } | null | undefined,
): NodeJS.ProcessEnv {
  return managedMcp ? { ...env, [CODEX_MANAGED_MCP_TOKEN_ENV]: managedMcp.token } : env;
}

/** The app-server's `-c` overrides that attach the managed MCP endpoint (both hosts pass these). */
export function codexManagedMcpConfigArgs(managedMcp?: { name: string; endpointUrl: string } | null): string[] {
  if (!managedMcp) return [];
  // Other OS users can read a process's arguments; only its owner can read its environment.
  return [
    "-c", `mcp_servers.${managedMcp.name}.url=${JSON.stringify(managedMcp.endpointUrl)}`,
    "-c", `mcp_servers.${managedMcp.name}.bearer_token_env_var=${JSON.stringify(CODEX_MANAGED_MCP_TOKEN_ENV)}`,
  ];
}

export function buildCodexAppServerArgs(managedMcp?: { name: string; endpointUrl: string } | null): string[] {
  return ["app-server", ...codexManagedMcpConfigArgs(managedMcp), "--listen", "stdio://"];
}

function isCodexMissingRolloutError(message: string): boolean {
  return /\bno\s+rollout\s+found\b/i.test(message)
    || /\bmissing\s+rollout\b/i.test(message)
    || /\brollout\b.*\b(not found|missing)\b/i.test(message)
    || /\bthread\b.*\b(not found|missing)\b/i.test(message)
    || /\bmissing\s+thread\b/i.test(message);
}

function isCodexThreadWriterBusyError(message: string): boolean {
  return /\bthread\b.*\balready\s+has\s+an\s+active\s+writer\b/i.test(message)
    || /\balready\s+has\s+an\s+active\s+writer\b/i.test(message);
}

// task #14: a thread the user archived in the Codex app refuses resume with
// "session <id> is archived. Run `codex unarchive <id>` ...".
function isCodexThreadArchivedError(message: string): boolean {
  return /\bis\s+archived\b/i.test(message);
}

type CodexRecoverableResumeErrorKind = "missing_rollout" | "thread_writer_busy" | "archived";
type CodexResumeRecoverySource =
  | "codex_resume_missing_rollout"
  | "codex_resume_thread_writer_busy"
  | "codex_resume_archived";

export type CodexResumeErrorClassification =
  | {
      kind: CodexRecoverableResumeErrorKind;
      resumeErrorClass: CodexRecoverableResumeErrorKind;
      recoveryAction: "fallback_fresh_thread";
      telemetry: Extract<ParsedEvent, { kind: "telemetry" }>;
      recovery: Extract<ParsedEvent, { kind: "runtime_recovery" }>;
    }
  | {
      kind: "terminal_error";
      resumeErrorClass: "permission_denied" | "unknown";
      recoveryAction?: undefined;
    };

function codexResumeRecoverySource(kind: CodexRecoverableResumeErrorKind): CodexResumeRecoverySource {
  if (kind === "missing_rollout") return "codex_resume_missing_rollout";
  if (kind === "archived") return "codex_resume_archived";
  return "codex_resume_thread_writer_busy";
}

function codexResumeRecoveryMessage(kind: CodexRecoverableResumeErrorKind): string {
  if (kind === "thread_writer_busy") {
    return "Codex could not resume its previous thread because another writer is active; Raft started a fresh Codex thread.";
  }
  if (kind === "archived") {
    return "Codex could not resume its previous thread because it is archived and could not be unarchived; Raft started a fresh Codex thread.";
  }
  return "Codex could not resume its previous thread; Raft started a fresh Codex thread.";
}

function codexResumeRecoveryDetails(): string {
  return "Use Raft conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.";
}

function prependCodexRecoveryNotice(prompt: string, recovery: Extract<ParsedEvent, { kind: "runtime_recovery" }>): string {
  return `${recovery.message}\n\n${recovery.details}\n\n${prompt}`;
}

function buildCodexResumeRecovery(
  kind: CodexRecoverableResumeErrorKind,
  requestedSessionId?: string,
): Extract<CodexResumeErrorClassification, { recoveryAction: "fallback_fresh_thread" }> {
  const source = codexResumeRecoverySource(kind);
  return {
    kind,
    resumeErrorClass: kind,
    recoveryAction: "fallback_fresh_thread",
    telemetry: {
      kind: "telemetry",
      name: "recovery",
      source,
      attrs: {
        resume_error_class: kind,
        recovery_action: "fallback_fresh_thread",
      },
    },
    recovery: {
      kind: "runtime_recovery",
      source,
      resumeErrorClass: kind,
      recoveryAction: "fallback_fresh_thread",
      message: codexResumeRecoveryMessage(kind),
      details: codexResumeRecoveryDetails(),
      ...(requestedSessionId ? { requestedSessionId } : {}),
    },
  };
}

export function classifyCodexResumeError(message: string, requestedSessionId?: string): CodexResumeErrorClassification {
  if (isCodexThreadArchivedError(message)) {
    return buildCodexResumeRecovery("archived", requestedSessionId);
  }

  if (isCodexMissingRolloutError(message)) {
    return buildCodexResumeRecovery("missing_rollout", requestedSessionId);
  }

  if (isCodexThreadWriterBusyError(message)) {
    return buildCodexResumeRecovery("thread_writer_busy", requestedSessionId);
  }

  if (/\b(no\s+permission|permission\s+denied|forbidden|unauthorized)\b/i.test(message)) {
    return {
      kind: "terminal_error",
      resumeErrorClass: "permission_denied",
    };
  }

  return {
    kind: "terminal_error",
    resumeErrorClass: "unknown",
  };
}

export function codexThreadName(agentName: string | null | undefined): string | null {
  const trimmed = agentName?.trim();
  return trimmed ? `Raft · ${trimmed}` : null;
}

function hasJsonRpcField(message: JsonRpcMessage, field: "result" | "error"): boolean {
  return Object.prototype.hasOwnProperty.call(message, field);
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return message.id !== undefined && (hasJsonRpcField(message, "result") || hasJsonRpcField(message, "error"));
}

function isCodexServerRequest(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId; method: string } {
  return message.id !== undefined && typeof message.method === "string" && !isJsonRpcResponse(message);
}

function payloadBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function extractCodexHome(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const candidate = (result as { codexHome?: unknown }).codexHome;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function isCompatibleInitializeResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const userAgent = (result as { userAgent?: unknown }).userAgent;
  return typeof userAgent === "string" && userAgent.trim().length > 0;
}

function unsupportedInitializeResultMessage(): string {
  return "Codex app-server initialize response is missing the expected userAgent handshake field; upgrade Codex CLI to a compatible app-server build.";
}

export type CodexThreadRequest = { method: "thread/start" | "thread/resume"; params: Record<string, any> };

/**
 * What a Codex app-server launch needs before its child exists: the CLI
 * transport env, the managed MCP endpoint (its URL in argv, its token in the
 * env only), the resolved command, and the env the app-server itself gets.
 * The legacy driver spawns from it; the OAR host's Codex launch reuses it, so
 * both hosts start the same app-server (#wg-ax:#3).
 */
export interface CodexLaunchPreparation {
  /** The CLI transport env (discovery probes run with it, without the MCP token). */
  spawnEnv: NodeJS.ProcessEnv;
  managedMcp: ManagedMcpRuntimeEndpoint | null;
  /** `app-server …` before candidate resolution. */
  appServerArgs: string[];
  command: string;
  args: string[];
  shell: ReturnType<typeof resolveCodexSpawn>["shell"];
  source: ReturnType<typeof resolveCodexSpawn>["source"];
  /** #oar-raft:#7: candidates rejected before this one, and their path-free kinds (`timeout+probe_failed`). */
  rejectedCandidateCount: number;
  rejectionKind: string | undefined;
  /** The env the candidate resolution chose for the child, if any (a Windows npm node host); else undefined. */
  candidateEnv: NodeJS.ProcessEnv | undefined;
  /** Windows: the `.cmd` shim the command was resolved from, if any (the OAR host launches it). */
  windowsShim: string | undefined;
  /** The env the app-server child gets: the candidate's (or the transport's) plus the managed MCP token. */
  appServerEnv: NodeJS.ProcessEnv;
  codexHomeRoot: string | null;
}

/**
 * Which Codex install a launch picked, path-free (#14189, #oar-raft:#7): the
 * chosen candidate's source, how many candidates were rejected before it, and
 * their kinds. Both hosts record it on `daemon.runtime.node_host_launch`.
 */
export function codexCandidateTraceAttrs(
  prep: Pick<CodexLaunchPreparation, "source" | "rejectedCandidateCount" | "rejectionKind">,
): { candidate_source: CodexLaunchPreparation["source"]; rejected_candidate_count: number; rejection_kind?: string } {
  return {
    candidate_source: prep.source,
    rejected_candidate_count: prep.rejectedCandidateCount,
    ...(prep.rejectionKind ? { rejection_kind: prep.rejectionKind } : {}),
  };
}

export async function prepareCodexLaunch(ctx: SpawnContext): Promise<CodexLaunchPreparation> {
  const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  const managedMcp = await prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    processInstanceId: ctx.processInstanceId,
    readTurnOrigin: ctx.readTurnOrigin,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
  });
  const codexHomeRoot = resolveCodexHomeRootFromEnv(spawnEnv, {
    defaultHomeDir: os.homedir(),
    cwd: ctx.workingDirectory,
  });
  const appServerArgs = buildCodexAppServerArgs(managedMcp);
  // task #1277: candidate discovery and the app-server probes run as bounded
  // probe children under this start attempt's signal; a cancelled lookup is
  // rethrown, never a verdict, and nothing is written to the probe cache.
  const { command, args, shell, source, env, windowsShim, rejectedCandidateCount, rejectionKind } = await resolveCodexSpawnAsync(appServerArgs, { env: spawnEnv, signal: ctx.launchSignal });
  return {
    spawnEnv,
    managedMcp,
    appServerArgs,
    command,
    args,
    shell,
    source,
    rejectedCandidateCount: rejectedCandidateCount ?? 0,
    rejectionKind,
    candidateEnv: env,
    windowsShim,
    // Only the app-server itself needs the token, not the discovery probes.
    appServerEnv: withCodexManagedMcpToken(env ?? spawnEnv, managedMcp),
    codexHomeRoot,
  };
}

/**
 * What Raft decides about a Codex thread, before any wire shape: the OAR
 * host's Codex launch maps these to OAR's session options, the legacy driver
 * to its JSON-RPC params (buildCodexThreadRequest).
 */
export interface CodexThreadFields {
  cwd: string;
  /** The standing prompt, sent as `developerInstructions` (additive, not `baseInstructions`). */
  developerInstructions: string;
  model?: string;
  reasoningEffort?: string;
  /** Raft's mode decides the tier on start and resume alike (#11175). */
  fast: boolean;
  /** The thread to resume; absent for a fresh thread. */
  resumeThreadId?: string;
}

export function codexThreadFields(ctx: Pick<SpawnContext, "workingDirectory" | "standingPrompt" | "config">): CodexThreadFields {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  return {
    cwd: ctx.workingDirectory,
    developerInstructions: ctx.standingPrompt,
    ...(launchRuntimeFields.model ? { model: launchRuntimeFields.model } : {}),
    ...(launchRuntimeFields.reasoningEffort ? { reasoningEffort: launchRuntimeFields.reasoningEffort } : {}),
    fast: launchRuntimeFields.mode.kind === "fast",
    ...(ctx.config.sessionId ? { resumeThreadId: ctx.config.sessionId } : {}),
  };
}

export function buildCodexThreadRequest(ctx: Pick<SpawnContext, "workingDirectory" | "standingPrompt" | "config">): CodexThreadRequest {
  // We pass the standing prompt as `developerInstructions` (additive, injected
  // as a developer-role message per turn) rather than `baseInstructions`
  // (replaces Codex's default base). Resume works because we always re-send
  // on start/resume. Compaction/session-level persistence is less certain
  // than `baseInstructions` and needs follow-up validation.
  const fields = codexThreadFields(ctx);
  const threadParams: Record<string, any> = {
    cwd: fields.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    sandbox_mode: "danger-full-access",
    developerInstructions: fields.developerInstructions,
    // Raw response items are used only as payload-free liveness signals in
    // the daemon. They replace the previous transcript-mtime heuristic.
    experimentalRawEvents: true,
  };
  if (fields.model) {
    threadParams.model = fields.model;
  }
  if (fields.reasoningEffort) {
    threadParams.config = { model_reasoning_effort: fields.reasoningEffort };
  }
  // Codex 0.164+ resumes with the tier saved in the session when none is sent
  // (a session started fast stayed fast after fast mode was turned off), and a
  // fresh start would follow a tier set in the Codex config. `null` clears it
  // to the default tier (an explicit clear in the 0.163 and 0.164 protocol).
  threadParams.serviceTier = fields.fast ? "fast" : null;

  if (fields.resumeThreadId) {
    return {
      method: "thread/resume",
      params: {
        threadId: fields.resumeThreadId,
        ...threadParams,
        // Resume model context without returning history the daemon does not consume.
        excludeTurns: true,
      },
    };
  }

  return {
    method: "thread/start",
    params: threadParams,
  };
}

export class CodexDriver implements RuntimeDriver {
  readonly id = "codex";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly stdoutChannel = "structured_protocol" as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // CodexEventNormalizer emits the compaction events.
    compaction: "reported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  } as const;
  readonly startupReadiness = "initial_turn" as const;
  readonly requiresSessionInitForDelivery = true as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;
  // A sub-agent that finishes after the turn ended is queued for the next turn, never woken.
  readonly needsWakeAfterSubagents = true;
  // Codex's `spawn_agent` (`multi_agent`, on by default) tells the model not to
  // spawn unless the user or AGENTS.md explicitly asks for sub-agents; the
  // delegation section is that ask (#proj-raft-computer:#41).
  readonly supportsSubagents = true;

  probe(): RuntimeProbeResult {
    return probeCodex();
  }

  buildThreadRequest(ctx: SpawnContext): CodexThreadRequest {
    return buildCodexThreadRequest(ctx);
  }

  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingInitialPrompt: string | null = null;
  private initializeRequestId: JsonRpcId | null = null;
  private pendingThreadRequest: CodexThreadRequest | null = null;
  private pendingThreadRequestId: JsonRpcId | null = null;
  private pendingThreadRequestMethod: "thread/start" | "thread/resume" | null = null;
  private lastThreadRequestMethod: "thread/start" | "thread/resume" | null = null;
  private pendingResumeFallbackParams: Record<string, any> | null = null;
  private pendingResumeThreadId: string | null = null;
  private pendingResumeParams: Record<string, unknown> | null = null;
  // task #14: one unarchive attempt per spawn; the retried resume (or the
  // fresh-thread fallback when unarchive fails) waits on this request.
  private archivedUnarchiveAttempted = false;
  private pendingUnarchive: {
    requestId: JsonRpcId;
    resumeParams: Record<string, unknown>;
    freshParams: Record<string, unknown>;
    classification: Extract<CodexResumeErrorClassification, { recoveryAction: "fallback_fresh_thread" }>;
  } | null = null;
  // task #14: "Raft · <agent>" so Raft threads are recognisable in the Codex
  // app sidebar; responses are ignored (older app-servers lack the method).
  private threadName: string | null = null;
  private threadNameRequestIds = new Set<JsonRpcId>();
  private pendingInitialTurnRequestId: JsonRpcId | null = null;
  private pendingInitialTurnInput: unknown = null;
  private pendingDeliveryRequests = new Map<JsonRpcId, { method: "turn/start" | "turn/steer"; input: unknown; turnId: string | null }>();
  private initialTurnStarted = false;
  private normalizer = new CodexEventNormalizer();
  private codexHomeRoot: string | null = null;
  private spawnWorkingDirectory: string | null = null;
  private managedMcpServerName: string | null = null;
  private managedMcpReady = true;
  private managedMcpStatus: Extract<ParsedEvent, { kind: "runtime_tooling" }>["managedMcpStatus"] = "not_configured";
  private instructionShapeTracer: Tracer | null = null;
  private instructionShapeIdentityAttrs: Record<string, unknown> = {};
  private instructionShapeConfiguredSessionId: string | null = null;
  private instructionShapeStandingInstructions: unknown = undefined;
  private instructionShapeStaticAttrs: CodexInstructionShapeStaticAttrs | null = null;
  private instructionShapeRequestAttrs: Record<string, string | number | boolean> | null = null;
  private instructionShapeCompactionStarts = 0;
  private instructionShapeCompactionFinishes = 0;
  private instructionShapePostCompactionRequestPending = false;

  get currentRuntimeHomeDir(): string | null {
    return this.codexHomeRoot;
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const launch = await prepareCodexLaunch(ctx);
    const { managedMcp } = launch;

    this.process = null;
    this.requestId = 0;
    this.pendingInitialPrompt = ctx.prompt;
    this.initializeRequestId = null;
    this.pendingThreadRequest = null;
    this.pendingThreadRequestId = null;
    this.pendingThreadRequestMethod = null;
    this.lastThreadRequestMethod = null;
    this.pendingResumeFallbackParams = null;
    this.pendingResumeThreadId = null;
    this.pendingResumeParams = null;
    this.archivedUnarchiveAttempted = false;
    this.pendingUnarchive = null;
    this.threadName = codexThreadName(ctx.config.displayName || ctx.config.name);
    this.threadNameRequestIds.clear();
    this.pendingInitialTurnRequestId = null;
    this.pendingInitialTurnInput = null;
    this.pendingDeliveryRequests.clear();
    this.initialTurnStarted = false;
    this.normalizer.reset();
    this.spawnWorkingDirectory = ctx.workingDirectory;
    this.managedMcpServerName = managedMcp?.name ?? null;
    this.managedMcpReady = !managedMcp;
    this.managedMcpStatus = managedMcp ? "pending" : "not_configured";
    this.instructionShapeTracer = ctx.tracer ?? null;
    this.instructionShapeIdentityAttrs = {
      agent_id: ctx.agentId,
      server_id: ctx.config.runtimeContext?.serverId,
      machine_id: ctx.config.runtimeContext?.machineId,
      launch_id: ctx.launchId || undefined,
      process_instance_id: ctx.processInstanceId || undefined,
      runtime: ctx.config.runtime,
      runtime_version: ctx.config.runtimeContext?.daemonVersion,
    };
    this.instructionShapeConfiguredSessionId = ctx.config.sessionId || null;
    this.instructionShapeStandingInstructions = this.instructionShapeTracer
      ? ctx.standingPrompt
      : undefined;
    this.instructionShapeStaticAttrs = null;
    this.instructionShapeRequestAttrs = null;
    this.instructionShapeCompactionStarts = 0;
    this.instructionShapeCompactionFinishes = 0;
    this.instructionShapePostCompactionRequestPending = false;
    this.codexHomeRoot = launch.codexHomeRoot;
    const { command, args: spawnArgs, shell, candidateEnv, appServerEnv } = launch;
    const launchSpan = ctx.tracer?.startSpan("daemon.runtime.node_host_launch", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId: ctx.agentId,
        launchId: ctx.launchId || undefined,
        runtime: this.id,
        ...codexCandidateTraceAttrs(launch),
        // Reports the host we actually detected. The previous attribute was
        // `exec_path_is_node: !versions.electron`, which inferred "is node"
        // from "is not Electron" — so on the official SEA installs, where
        // execPath is the bundled app and cannot run a JS entry, it reported
        // that the exec path WAS node. The one shape most likely to be broken
        // was the one it called healthy.
        host_kind: detectNodeHostKind(),
        electron_run_as_node: candidateEnv?.ELECTRON_RUN_AS_NODE === "1",
      },
    });
    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    // A start stopped while the candidate search ran must not create a child.
    if (ctx.launchSignal?.aborted) throw new ProbeChildError("codex launch cancelled before the child was created", { code: "ABORT_ERR" });
    let proc: ChildProcess;
    try {
      proc = spawnRuntimeChild(command, spawnArgs, {
        cwd: ctx.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: appServerEnv,
        shell,
      });
      launchSpan?.end("ok");
    } catch (error) {
      launchSpan?.end("error", {
        attrs: { error_class: error instanceof Error ? error.name : "Error" },
      });
      throw error;
    }

    this.process = proc;

    queueMicrotask(() => {
      this.initializeRequestId = this.sendRequest("initialize", {
        clientInfo: { name: "slock-daemon", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });

      this.pendingThreadRequest = this.buildThreadRequest(ctx);
    });

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    const message = parseCodexJsonRpcLine(line);
    if (!message) {
      return [];
    }

    const events: ParsedEvent[] = [];
    if (isCodexServerRequest(message)) {
      this.sendErrorResponse(
        message.id,
        `Codex app-server request "${message.method}" is not supported by the non-interactive Raft daemon`,
      );
      return events;
    }

    const isResponse = isJsonRpcResponse(message);
    if (isResponse && hasJsonRpcField(message, "result")) {
      if (message.id === this.initializeRequestId) {
        if (!isCompatibleInitializeResult(message.result)) {
          this.initializeRequestId = null;
          this.pendingThreadRequest = null;
          this.pendingThreadRequestId = null;
          this.pendingThreadRequestMethod = null;
          this.pendingResumeFallbackParams = null;
          this.pendingResumeThreadId = null;
          this.instructionShapeStandingInstructions = undefined;
          events.push({
            kind: "error",
            message: unsupportedInitializeResultMessage(),
            startupRequestMethod: "initialize",
          });
          return events;
        }
        const codexHome = extractCodexHome(message.result);
        if (codexHome) {
          this.codexHomeRoot = path.resolve(this.spawnWorkingDirectory ?? process.cwd(), codexHome);
        }
        this.initializeRequestId = null;
        this.sendNotification("initialized", {});
        if (this.pendingThreadRequest) {
          const appServerUserAgent = (message.result as { userAgent?: unknown }).userAgent;
          this.sendThreadRequest(
            this.pendingThreadRequest.method,
            this.pendingThreadRequest.params,
            appServerUserAgent,
          );
          this.pendingThreadRequest = null;
        }
        return events;
      }
    }

    if (isResponse && hasJsonRpcField(message, "error") && message.id === this.initializeRequestId) {
      this.initializeRequestId = null;
      this.pendingThreadRequest = null;
      this.pendingThreadRequestId = null;
      this.pendingThreadRequestMethod = null;
      this.pendingResumeFallbackParams = null;
      this.pendingResumeThreadId = null;
      this.instructionShapeStandingInstructions = undefined;
      events.push({
        kind: "error",
        message: message.error?.message || "Codex app-server request failed",
        startupRequestMethod: "initialize",
      });
      return events;
    }

    if (isResponse && message.id !== undefined && this.threadNameRequestIds.delete(message.id)) {
      return events;
    }

    if (isResponse && this.pendingUnarchive && message.id === this.pendingUnarchive.requestId) {
      const { resumeParams, freshParams, classification } = this.pendingUnarchive;
      this.pendingUnarchive = null;
      if (hasJsonRpcField(message, "error")) {
        events.push(classification.telemetry);
        events.push(classification.recovery);
        if (this.pendingInitialPrompt) {
          this.pendingInitialPrompt = prependCodexRecoveryNotice(this.pendingInitialPrompt, classification.recovery);
        }
        this.sendThreadRequest("thread/start", freshParams);
        return events;
      }
      events.push({
        kind: "telemetry",
        name: "recovery",
        source: "codex_resume_unarchived",
        attrs: {
          resume_error_class: "archived",
          recovery_action: "unarchive_resume",
        },
      });
      this.sendThreadRequest("thread/resume", resumeParams);
      return events;
    }

    if (isResponse && message.id === this.pendingThreadRequestId) {
      if (hasJsonRpcField(message, "error")) {
        const errorMessage = message.error?.message || "Codex app-server request failed";
        const requestMethod = this.pendingThreadRequestMethod;
        const resumeErrorClassification = requestMethod === "thread/resume"
          ? classifyCodexResumeError(errorMessage, this.pendingResumeThreadId || undefined)
          : null;
        if (
          resumeErrorClassification?.kind === "archived"
          && resumeErrorClassification.recoveryAction === "fallback_fresh_thread"
          && !this.archivedUnarchiveAttempted
          && this.pendingResumeThreadId
          && this.pendingResumeParams
          && this.pendingResumeFallbackParams
        ) {
          // task #14: the user archived this thread in the Codex app. Unarchive
          // and resume it so the agent keeps its context (the thread reappears
          // in the sidebar); start fresh only if unarchive fails.
          this.archivedUnarchiveAttempted = true;
          this.pendingUnarchive = {
            requestId: this.sendRequest("thread/unarchive", { threadId: this.pendingResumeThreadId }),
            resumeParams: this.pendingResumeParams,
            freshParams: this.pendingResumeFallbackParams,
            classification: resumeErrorClassification,
          };
          this.pendingThreadRequestId = null;
          return events;
        }
        if (
          this.pendingResumeFallbackParams &&
          resumeErrorClassification?.recoveryAction === "fallback_fresh_thread"
        ) {
          events.push(resumeErrorClassification.telemetry);
          events.push(resumeErrorClassification.recovery);
          if (this.pendingInitialPrompt) {
            this.pendingInitialPrompt = prependCodexRecoveryNotice(
              this.pendingInitialPrompt,
              resumeErrorClassification.recovery,
            );
          }
          this.sendThreadRequest("thread/start", this.pendingResumeFallbackParams);
          this.pendingResumeFallbackParams = null;
          return events;
        }

        this.pendingThreadRequestId = null;
        this.pendingThreadRequestMethod = null;
        this.pendingResumeFallbackParams = null;
        this.pendingResumeThreadId = null;
        events.push(requestMethod
          ? { kind: "error", message: errorMessage, startupRequestMethod: requestMethod }
          : { kind: "error", message: errorMessage });
        return events;
      }

      const requestMethod = this.pendingThreadRequestMethod;
      this.pendingThreadRequestId = null;
      this.pendingThreadRequestMethod = null;
      this.pendingResumeFallbackParams = null;
      this.pendingResumeThreadId = null;
      this.pendingResumeParams = null;
      if (requestMethod) {
        events.push(this.runtimeToolingObservation(requestMethod));
      }
      this.nameThreadIfUnnamed(message.result);
    }

    if (isResponse && message.id === this.pendingInitialTurnRequestId) {
      this.pendingInitialTurnRequestId = null;
      if (hasJsonRpcField(message, "error")) {
        events.push({
          kind: "error",
          message: message.error?.message || "Codex app-server request failed",
          startupRequestMethod: "turn/start",
        });
      } else {
        if (hasNonEmptyCodexTextInput(this.pendingInitialTurnInput)) {
          this.normalizer.markNonEmptyTurnInput(resultTurnId(message));
        }
        this.pendingInitialPrompt = null;
      }
      this.pendingInitialTurnInput = null;
      return events;
    }

    if (isResponse && message.id !== undefined && this.pendingSubagentInterruptRequests.delete(message.id)) {
      // A refused sub-agent stop leaves that sub-agent running; nothing else to do.
      return events;
    }

    if (isResponse && message.id !== undefined && this.pendingInterruptRequests.delete(message.id)) {
      // A refused interrupt leaves the turn running: the daemon's interrupt
      // timeout restarts the runtime (daemon.agent.turn_interrupt.native_fallback).
      return events;
    }

    if (isResponse && message.id !== undefined && this.pendingDeliveryRequests.has(message.id)) {
      const deliveryRequest = this.pendingDeliveryRequests.get(message.id)!;
      this.pendingDeliveryRequests.delete(message.id);
      if (hasJsonRpcField(message, "error")) {
        const params = message.error ?? {};
        events.push({
          kind: "delivery_error",
          message: message.error?.message || "Codex app-server request failed",
          requestMethod: deliveryRequest.method,
          source: "codex_app_server_response",
          payloadBytes: payloadBytes(params),
        });
      } else if (hasNonEmptyCodexTextInput(deliveryRequest.input)) {
        this.normalizer.markNonEmptyTurnInput(deliveryRequest.turnId ?? resultTurnId(message));
      }
      return events;
    }

    if (
      message.method === "mcpServer/startupStatus/updated"
      && message.params?.name === this.managedMcpServerName
    ) {
      const status = message.params?.status;
      if (status === "ready") {
        this.managedMcpReady = true;
        this.managedMcpStatus = "ready";
        if (this.lastThreadRequestMethod) {
          events.push(this.runtimeToolingObservation(this.lastThreadRequestMethod));
        }
        this.startInitialTurn();
      } else if (status === "failed" || status === "cancelled") {
        this.managedMcpReady = true;
        this.managedMcpStatus = "failed";
        if (this.lastThreadRequestMethod) {
          events.push(this.runtimeToolingObservation(this.lastThreadRequestMethod));
        }
        this.startInitialTurn();
      }
      return events;
    }

    const result = this.normalizer.normalizeMessage(message);
    if (result.turnStarted) {
      this.pendingInitialPrompt = null;
    }
    if (result.threadReady) {
      this.startInitialTurn();
    }
    this.observeInstructionShapeCompactionEvents(result.events);
    return [...events, ...result.events];
  }

  get currentSessionId(): string | null {
    return this.normalizer.threadId;
  }

  get hasLiveTurn(): boolean {
    return this.normalizer.hasLiveTurn;
  }

  encodeStdinMessage(
    text: string,
    _sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    if (!this.normalizer.threadId) return null;

    const mode = opts?.mode || "busy";
    if (mode === "busy") {
      if (!this.normalizer.canSteerBusy) return null;
      const id = this.nextRequestId();
      const input = [{ type: "text", text }];
      const turnId = this.normalizer.activeTurnId;
      this.pendingDeliveryRequests.set(id, { method: "turn/steer", input, turnId });
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "turn/steer",
        params: {
          threadId: this.normalizer.threadId,
          expectedTurnId: this.normalizer.activeTurnId,
          input,
        },
      });
    }

    const id = this.nextRequestId();
    const input = [{ type: "text", text }];
    this.pendingDeliveryRequests.set(id, { method: "turn/start", input, turnId: null });
    const encoded = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: {
        threadId: this.normalizer.threadId,
        input,
      },
    });
    this.observePostCompactionFirstRequest("turn/start");
    return encoded;
  }

  /**
   * Codex's native `turn/interrupt` for the running turn. Codex answers with
   * `turn/completed` status `interrupted`; the daemon falls back to a restart
   * when no turn has started yet or the turn does not end in time.
   */
  encodeInterruptRequest(): string | null {
    // Codex leaves the interrupted command running and the daemon cannot kill a
    // turn's processes on Windows, so a Stop there keeps restarting the runtime.
    if (process.platform === "win32") return null;
    const threadId = this.normalizer.threadId;
    const turnId = this.normalizer.activeTurnId;
    if (!threadId || !turnId) return null;
    this.normalizer.noteInterruptRequested();
    const id = this.nextRequestId();
    this.pendingInterruptRequests.add(id);
    return JSON.stringify({ jsonrpc: "2.0", id, method: "turn/interrupt", params: { threadId, turnId } });
  }

  private readonly pendingInterruptRequests = new Set<JsonRpcId>();

  /**
   * #proj-runtime:#41: `turn/interrupt` for one sub-agent's running turn.
   * Verified on Codex 0.166: that thread's turn ends `interrupted`; the
   * agent's turn and its other sub-agents carry on. Its answer is ignored.
   */
  encodeSubagentInterruptRequest(subagentTaskId: string): string | null {
    const turn = this.normalizer.runningSubagentTurn(subagentTaskId);
    if (!turn) return null;
    const id = this.nextRequestId();
    this.pendingSubagentInterruptRequests.add(id);
    return JSON.stringify({ jsonrpc: "2.0", id, method: "turn/interrupt", params: turn });
  }

  private readonly pendingSubagentInterruptRequests = new Set<JsonRpcId>();

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      supportsSubagents: this.supportsSubagents,
    });
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private startInitialTurn() {
    if (!this.managedMcpReady || this.initialTurnStarted || this.pendingInitialTurnRequestId !== null || !this.pendingInitialPrompt || !this.normalizer.threadId) return;
    this.initialTurnStarted = true;
    const prompt = this.pendingInitialPrompt;
    const input = [{ type: "text", text: prompt }];
    this.pendingInitialTurnInput = input;
    this.pendingInitialTurnRequestId = this.sendRequest("turn/start", {
      threadId: this.normalizer.threadId,
      input,
    });
  }

  private sendRequest(method: string, params: Record<string, any>): JsonRpcId {
    const id = this.nextRequestId();
    this.process?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }) + "\n");
    this.observePostCompactionFirstRequest(method);
    return id;
  }

  /** Names the thread unless it already has a name (the user's rename wins). */
  private nameThreadIfUnnamed(result: unknown): void {
    if (!this.threadName) return;
    const thread = (result as { thread?: { id?: unknown; name?: unknown } } | null)?.thread;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) return;
    if (typeof thread?.name === "string" && thread.name.trim()) return;
    this.threadNameRequestIds.add(this.sendRequest("thread/name/set", { threadId, name: this.threadName }));
  }

  private sendErrorResponse(id: JsonRpcId, message: string) {
    this.process?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message,
      },
    }) + "\n");
  }

  private sendThreadRequest(
    method: CodexThreadRequestMethod,
    params: Record<string, any>,
    appServerUserAgent?: unknown,
  ): JsonRpcId {
    const id = this.sendRequest(method, params);
    this.recordInstructionShape(
      "thread_request_sent",
      method,
      { params, appServerUserAgent },
    );
    this.pendingThreadRequestId = id;
    this.pendingThreadRequestMethod = method;
    this.lastThreadRequestMethod = method;
    this.pendingResumeFallbackParams = null;
    this.pendingResumeThreadId = null;
    this.pendingResumeParams = null;
    if (method === "thread/resume") {
      this.pendingResumeParams = params;
      // excludeTurns only applies to resume; do not forward it to thread/start.
      const { threadId: _threadId, excludeTurns: _excludeTurns, ...freshParams } = params;
      this.pendingResumeFallbackParams = freshParams;
      this.pendingResumeThreadId = typeof _threadId === "string" && _threadId.trim()
        ? _threadId.trim()
        : null;
    }
    return id;
  }

  private recordInstructionShape(
    observationPhase: CodexInstructionObservationPhase,
    requestMethod: CodexThreadRequestMethod,
    fresh?: { params: Record<string, unknown>; appServerUserAgent?: unknown },
  ): void {
    if (!this.instructionShapeTracer) return;

    if (fresh) {
      if (!this.instructionShapeStaticAttrs) {
        this.instructionShapeStaticAttrs = buildCodexInstructionShapeStaticAttrs({
          standingInstructions: this.instructionShapeStandingInstructions,
          appServerUserAgent: fresh.appServerUserAgent,
        });
        this.instructionShapeStandingInstructions = undefined;
      }
      this.instructionShapeRequestAttrs = buildCodexInstructionShapeAttrs({
        staticAttrs: this.instructionShapeStaticAttrs,
        requestParams: fresh.params,
        requestMethod,
        observationPhase,
        compactionStarts: this.instructionShapeCompactionStarts,
        compactionFinishes: this.instructionShapeCompactionFinishes,
      });
    }
    if (!this.instructionShapeRequestAttrs) return;

    const sessionId = this.normalizer.threadId || this.instructionShapeConfiguredSessionId;
    this.instructionShapeTracer.emitEvent("daemon.codex.request_instruction_shape", {
      surface: "daemon",
      attrs: {
        ...this.instructionShapeIdentityAttrs,
        session_id: sessionId || undefined,
        session_id_present: Boolean(sessionId),
        ...this.instructionShapeRequestAttrs,
        observation_phase: observationPhase,
        session_request_method: requestMethod,
        compaction_starts_count: this.instructionShapeCompactionStarts,
        compaction_finishes_count: this.instructionShapeCompactionFinishes,
        status: "ok",
      },
    });
  }

  private observeInstructionShapeCompactionEvents(events: ParsedEvent[]): void {
    if (!this.lastThreadRequestMethod) return;
    for (const event of events) {
      if (event.kind === "compaction_started") {
        this.instructionShapeCompactionStarts += 1;
        this.recordInstructionShape("compaction_started", this.lastThreadRequestMethod);
      } else if (event.kind === "compaction_finished") {
        this.instructionShapeCompactionFinishes += 1;
        this.instructionShapePostCompactionRequestPending = true;
        this.recordInstructionShape("compaction_finished", this.lastThreadRequestMethod);
      }
    }
  }

  private observePostCompactionFirstRequest(method: string): void {
    if (
      method !== "turn/start"
      || !this.instructionShapePostCompactionRequestPending
      || !this.lastThreadRequestMethod
    ) return;
    this.instructionShapePostCompactionRequestPending = false;
    this.recordInstructionShape("post_compaction_first_request", this.lastThreadRequestMethod);
  }

  private runtimeToolingObservation(
    sessionRequestMethod: "thread/start" | "thread/resume",
  ): Extract<ParsedEvent, { kind: "runtime_tooling" }> {
    return {
      kind: "runtime_tooling",
      source: "codex_app_server",
      sessionRequestMethod,
      // The current app-server handshake does not report the built-in tool
      // inventory. Preserve that negative fact instead of inferring exposure
      // from a successful resume or from later model behavior.
      nativeToolInventoryObservation: "unreported_by_app_server",
      cliTransportConfigured: true,
      managedMcpConfigured: this.managedMcpServerName !== null,
      managedMcpStatus: this.managedMcpStatus,
    };
  }

  private sendNotification(method: string, params: Record<string, any>) {
    this.process?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n");
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return runtimeModelSourceOutcomeFromSet(
      await detectCodexModelsFromAppServer() ?? detectCodexModels(resolveCodexHomeRootFromEnv()),
    );
  }
}

interface CodexModelListDetectionOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** task #1277 — probe seams and the operation-scoped cancel (`signal`) for the candidate search. */
  deps?: ProbeDeps;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function modelListPage(result: unknown): { entries: unknown[]; nextCursor: string | null } | null {
  if (!result || typeof result !== "object") return null;
  const object = result as { data?: unknown; models?: unknown; nextCursor?: unknown };
  const entries = Array.isArray(object.data)
    ? object.data
    : Array.isArray(object.models)
      ? object.models
      : null;
  if (!entries) return null;
  return {
    entries,
    nextCursor: asNonEmptyString(object.nextCursor),
  };
}

function modelListRequestParams(cursor: string | null): Record<string, unknown> {
  return cursor ? { cursor } : {};
}

function stringArray(values: unknown[], read: (value: unknown) => string | null): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = read(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function codexReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return stringArray(value, (entry) => {
    if (typeof entry === "string") return asNonEmptyString(entry);
    if (!entry || typeof entry !== "object") return null;
    const object = entry as { reasoningEffort?: unknown; id?: unknown };
    return asNonEmptyString(object.reasoningEffort) ?? asNonEmptyString(object.id);
  });
}

function codexServiceTierIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return stringArray(value, (entry) => {
    if (typeof entry === "string") return asNonEmptyString(entry);
    if (!entry || typeof entry !== "object") return null;
    const object = entry as { id?: unknown; serviceTier?: unknown };
    return asNonEmptyString(object.id) ?? asNonEmptyString(object.serviceTier);
  });
}

function codexModelInfoFromAppServer(entry: unknown): RuntimeModelInfo | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const object = entry as Record<string, unknown>;
  if (object.hidden === true) return null;

  const id = asNonEmptyString(object.id)
    ?? asNonEmptyString(object.model)
    ?? asNonEmptyString(object.slug);
  if (!id) return null;

  const label = asNonEmptyString(object.displayName)
    ?? asNonEmptyString(object.display_name)
    ?? asNonEmptyString(object.label)
    ?? id;
  const supportedReasoningEfforts = codexReasoningEfforts(object.supportedReasoningEfforts);
  const serviceTiers = codexServiceTierIds(object.serviceTiers);
  const additionalSpeedTiers = codexServiceTierIds(object.additionalSpeedTiers);
  const runtimeServiceTiers = serviceTiers.length > 0 ? serviceTiers : additionalSpeedTiers;
  const defaultReasoningEffort = asNonEmptyString(object.defaultReasoningEffort);
  const defaultServiceTier = asNonEmptyString(object.defaultServiceTier);

  return {
    id,
    label,
    verified: "launchable",
    ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(runtimeServiceTiers.length > 0 ? { serviceTiers: runtimeServiceTiers } : {}),
    ...(defaultServiceTier ? { defaultServiceTier } : {}),
  };
}

function codexModelSetFromAppServerEntries(entries: unknown[]): RuntimeModelSet | null {
  const models: RuntimeModelInfo[] = [];
  let defaultModel: string | undefined;

  for (const entry of entries) {
    const model = codexModelInfoFromAppServer(entry);
    if (!model) continue;
    models.push(model);
    if (!defaultModel && typeof entry === "object" && entry && (entry as { isDefault?: unknown }).isDefault === true) {
      defaultModel = model.id;
    }
  }

  return models.length > 0 ? { models, default: defaultModel } : null;
}

// ── task #1277: asynchronous twins of the candidate discovery above ─────────
//
// Used by the form's model detection (detectCodexModelsFromAppServer): the
// same candidates, arbitration, probe cache and rejection texts as the
// synchronous resolver, with every child (`npm root -g`, the PATH lookups,
// the app-server probe, the --version read) run through runProbeChild instead
// of execFileSync. The synchronous resolver stays for the launch path and the
// detection child until their own PRs.

async function resolveWindowsNpmCodexEntryAsync(deps: ProbeDeps = {}): Promise<{ entry: string | null; shim?: string; note?: string }> {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const env = deps.env ?? ambientProcessEnv();
  const winPath = path.win32;
  let note: string | undefined;

  try {
    const globalRoot = (await runChild("npm", ["root", "-g"], {
      env,
      timeoutMs: CODEX_NPM_ROOT_TIMEOUT_MS,
      stderr: "ignore",
      platform: deps.platform ?? process.platform,
      signal: deps.signal,
    })).stdout.trim();
    const candidate = winPath.join(globalRoot, "@openai", "codex", "bin", "codex.js");
    // npm's global shims sit in the prefix, one level above `npm root -g`.
    const shim = winPath.join(winPath.dirname(globalRoot), "codex.cmd");
    if (existsSyncFn(candidate)) return { entry: candidate, shim: existsSyncFn(shim) ? oarRunnableShim(shim, deps) : undefined };
  } catch (error) {
    // A cancelled discovery stops here, with the runner's cleanup evidence
    // intact (an unconfirmed cleanup must not be replaced by a later, cleaner
    // error); nothing below runs on its behalf.
    if (error instanceof ProbeChildError && error.code === "ABORT_ERR") throw error;
    if ((error as { code?: unknown }).code === "ETIMEDOUT") {
      note = `npm_global discovery: \`npm root -g\` did not finish within ${CODEX_NPM_ROOT_TIMEOUT_MS} ms, so the global npm install was not searched and a Codex installed only there is not ruled out`;
    }
  }

  const cmdPath = await resolveCommandOnPathAsync("codex", deps);
  if (cmdPath) {
    const candidate = winPath.join(winPath.dirname(cmdPath), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSyncFn(candidate)) return { entry: candidate, shim: isWindowsBatchFile(cmdPath) ? oarRunnableShim(cmdPath, deps) : undefined, ...(note ? { note } : {}) };
  }

  return { entry: null, ...(note ? { note } : {}) };
}

async function windowsDirectCodexCandidateAsync(
  source: CodexSpawnCandidate["source"],
  command: string,
  deps: ProbeDeps,
): Promise<CodexSpawnCandidate | string> {
  try {
    const launch = await resolveWindowsDirectLaunchAsync("codex", command, [], deps);
    return {
      source,
      command: launch.command,
      argsPrefix: launch.args,
      shell: false,
      ...(launch.env ? { env: launch.env } : {}),
      ...(isWindowsBatchFile(command) && oarRunnableShim(command, deps) ? { windowsShim: command } : {}),
    };
  } catch (error) {
    if (!(error instanceof RuntimeExecutableNotFoundError)) throw error;
    return `${source} batch wrapper rejected: ${error.reason ?? "unresolved"}`;
  }
}

async function resolveExplicitCodexBinAsync(deps: ProbeDeps): Promise<ExplicitCodexBinResolution> {
  const env = deps.env ?? ambientProcessEnv();
  const raw = env[CODEX_BIN_ENV]?.trim();
  if (!raw) return { status: "unset" };

  const platform = deps.platform ?? process.platform;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;

  let command: string | null = null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    command = existsSyncFn(raw) ? raw : null;
    if (!command) return { status: "invalid", raw, reason: "path does not exist" };
  } else {
    command = await resolveCommandOnPathAsync(raw, deps);
    if (!command) return { status: "invalid", raw, reason: "not found on PATH" };
  }

  if (platform === "win32" && isWindowsSandboxRunner(command)) {
    return { status: "invalid", raw, reason: "points at a Codex sandbox helper (codex-command-runner or .sandbox-bin), not the Codex CLI" };
  }

  if (platform === "win32") {
    const direct = await windowsDirectCodexCandidateAsync("explicit_bin", command, deps);
    if (typeof direct === "string") return { status: "invalid", raw, reason: direct };
    return { status: "resolved", candidate: direct };
  }

  return { status: "resolved", candidate: { source: "explicit_bin", command, argsPrefix: [], shell: false } };
}

async function codexSpawnCandidatesAsync(deps: ProbeDeps = {}): Promise<CodexSpawnCandidateDiscovery> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const candidates: CodexSpawnCandidate[] = [];
    const rejected: string[] = [];

    const npm = await resolveWindowsNpmCodexEntryAsync(deps);
    const notes = npm.note ? [npm.note] : [];
    const npmEntry = npm.entry;
    if (npmEntry) {
      try {
        const nodeHost = resolveNodeHostLaunch({
          env: deps.env ?? ambientProcessEnv(),
          execPath: deps.execPath,
          execIsElectron: deps.execIsElectron,
          execIsSea: deps.execIsSea,
          hasNodeRuntime: deps.hasNodeRuntime,
        });
        candidates.push({ source: "npm_global", command: nodeHost.command, argsPrefix: [...nodeHost.execArgv, npmEntry], shell: false, env: nodeHost.env, ...(npm.shim ? { windowsShim: npm.shim } : {}) });
      } catch (error) {
        if (!(error instanceof NodeHostUnavailableError)) throw error;
        rejected.push(`npm_global JavaScript entry rejected: ${error.kind} (host_kind=${error.hostKind})`);
      }
    }

    const { command, missReason: pathMissReason } = await lookupCommandOnPathAsync("codex", deps);
    if (command && isWindowsSandboxRunner(command)) rejected.push(CODEX_PATH_SANDBOX_HELPER_REJECTION);
    if (command && !isWindowsSandboxRunner(command)) {
      const direct = await windowsDirectCodexCandidateAsync("path", command, deps);
      if (typeof direct === "string") rejected.push(direct);
      else candidates.push(direct);
    }

    for (const desktopEntry of windowsCodexDesktopEntries(deps)) {
      if (candidates.some((candidate) => candidate.command === desktopEntry)) continue;
      candidates.push({ source: "desktop_install", command: desktopEntry, argsPrefix: [], shell: false });
    }

    return { candidates, rejected, notes, ...(pathMissReason ? { pathMissReason } : {}) };
  }

  const candidates: CodexSpawnCandidate[] = [];
  const { command: pathCommand, missReason: pathMissReason } = await lookupCommandOnPathAsync("codex", deps);
  if (pathCommand) candidates.push({ source: "path", command: pathCommand, argsPrefix: [], shell: false });

  if (platform === "darwin") {
    const existsSyncFn = deps.existsSyncFn ?? existsSync;
    for (const bundlePath of darwinDesktopCodexPaths(deps)) {
      if (!existsSyncFn(bundlePath)) continue;
      if (candidates.some((candidate) => candidate.command === bundlePath)) continue;
      candidates.push({ source: "desktop_bundle", command: bundlePath, argsPrefix: [], shell: false });
    }
  }

  return { candidates, rejected: [], notes: [], ...(pathMissReason ? { pathMissReason } : {}) };
}

/** Shares `codexProbeCache` with the synchronous probe: the two can never disagree on a cached verdict. */
async function probeCodexCandidateAsync(
  candidate: CodexSpawnCandidate,
  deps: ProbeDeps = {},
  probeTimeoutMs: number = CODEX_PROBE_CHILD_TIMEOUT_MS,
): Promise<CodexProbeOutcome> {
  const runChild = deps.runProbeChildFn ?? runProbeChild;
  const platform = deps.platform ?? process.platform;
  const env = await withWindowsUserEnvironmentAsync(candidate.env ?? deps.env ?? ambientProcessEnv(), deps);
  const stat = readCandidateStat(candidate, deps);
  const cacheKey = codexCandidateCacheKey(candidate);
  const cached = readCodexProbeCache(cacheKey, stat, deps, probeTimeoutMs);
  if (cached) return cached;

  let failure: string | null = null;
  let versionFailed = false;
  let timedOut = false;
  try {
    await runChild(candidate.command, [...candidate.argsPrefix, ...CODEX_APP_SERVER_PROBE_ARGS], {
      env,
      timeoutMs: probeTimeoutMs,
      shell: candidate.shell,
      platform,
      signal: deps.signal,
    });
  } catch (error) {
    // A cancelled probe is not a verdict about the candidate: it must not be
    // classified, and above all not written to the shared cache, where it
    // would reject this candidate for every later resolution.
    if (error instanceof ProbeChildError && error.code === "ABORT_ERR") throw error;
    ({ failure, timedOut } = classifyCodexProbeError(error));
  }

  let version: string | null = null;
  if (!failure) {
    try {
      const { stdout } = await runChild(candidate.command, [...candidate.argsPrefix, "--version"], {
        env,
        // The same budget as the app-server check: a slow machine's retry must not lose its version.
        timeoutMs: probeTimeoutMs,
        shell: candidate.shell,
        platform,
        signal: deps.signal,
      });
      version = stdout.trim().split(/\r?\n/)[0] || null;
    } catch (error) {
      // Same rule for the version read: a cancel is not "unknown version".
      if (error instanceof ProbeChildError && error.code === "ABORT_ERR") throw error;
      version = null;
      versionFailed = true;
    }
  }

  writeCodexProbeCache(cacheKey, stat, deps, { failure, version, timedOut, transient: failure !== null || versionFailed, probeTimeoutMs });
  return { failure, version, timedOut };
}

async function resolveCompatibleCodexCandidateAsync(deps: ProbeDeps = {}): Promise<ReturnType<typeof resolveCompatibleCodexCandidate>> {
  const rejected: string[] = [];
  const notes: string[] = [];

  const explicit = await resolveExplicitCodexBinAsync(deps);
  if (explicit.status === "invalid") {
    return { candidate: null, rejected: [`${CODEX_BIN_ENV}=${explicit.raw} rejected: ${explicit.reason}`], version: null, notes: [], explicitOverrideFailed: true };
  }
  if (explicit.status === "resolved") {
    const outcome = await probeCodexCandidateAsync(explicit.candidate, deps);
    const { failure, version } = outcome;
    if (failure) {
      return {
        candidate: null,
        rejected: [codexRejection(`${CODEX_BIN_ENV}=${formatCodexCandidate(explicit.candidate)}`, outcome)],
        version: null,
        notes: [],
        explicitOverrideFailed: true,
        ...(outcome.timedOut ? { allRejectionsTimedOut: true as const } : {}),
      };
    }
    notes.push(
      `using ${CODEX_BIN_ENV} override ${formatCodexCandidate(explicit.candidate)}` +
      (version ? ` (${version})` : "") +
      "; automatic PATH/desktop discovery skipped",
    );
    return { candidate: explicit.candidate, rejected: [], version, notes, explicitOverrideFailed: false };
  }

  const discovery = await codexSpawnCandidatesAsync(deps);
  rejected.push(...discovery.rejected);
  notes.push(...discovery.notes);
  let timedOutRejections = 0;
  /** Discovery order; `version` is set for a candidate whose check passed. */
  const results: Array<{ candidate: CodexSpawnCandidate; passed: boolean; version: string | null; rejection?: string }> = [];
  // Candidates are probed one after another, as the synchronous resolver does,
  // so version arbitration sees them in the same order.
  for (const candidate of discovery.candidates) {
    const outcome = await probeCodexCandidateAsync(candidate, deps);
    if (outcome.failure) {
      const rejection = codexRejection(`${candidate.source} ${formatCodexCandidate(candidate)}`, outcome);
      rejected.push(rejection);
      if (outcome.timedOut) {
        timedOutRejections += 1;
        results.push({ candidate, passed: false, version: null, rejection });
      }
      continue;
    }
    results.push({ candidate, passed: true, version: outcome.version });
  }

  // #oar-raft:#7: a timed-out candidate does not simply lose to whatever else
  // passed. One longer check each (cached, so once per failure TTL); one that
  // passes competes by version in its discovery place, as if it had passed first time.
  for (const entry of results) {
    if (entry.passed || entry.rejection === undefined) continue;
    const retry = await probeCodexCandidateAsync(entry.candidate, deps, CODEX_PROBE_RETRY_TIMEOUT_MS);
    const label = `${entry.candidate.source} ${formatCodexCandidate(entry.candidate)}`;
    const index = rejected.indexOf(entry.rejection);
    if (retry.failure) {
      if (index >= 0) rejected[index] = codexRejection(label, retry);
      if (!retry.timedOut) timedOutRejections -= 1;
      continue;
    }
    if (index >= 0) rejected.splice(index, 1);
    timedOutRejections -= 1;
    notes.push(`${label} (${retry.version ?? "unknown"}) passed a longer app-server check after timing out`);
    entry.passed = true;
    entry.version = retry.version;
  }

  let best: { candidate: CodexSpawnCandidate; version: string | null } | null = null;
  for (const { candidate, passed, version } of results) {
    if (!passed) continue;
    if (!best) {
      best = { candidate, version };
      continue;
    }
    const cmp = compareCodexVersions(version, best.version);
    if (cmp !== null && cmp > 0) {
      notes.push(
        `selected ${formatCodexCandidate(candidate)} (${version ?? "unknown"}) over ` +
        `${formatCodexCandidate(best.candidate)} (${best.version ?? "unknown"}) by version`,
      );
      best = { candidate, version };
    }
  }

  return {
    candidate: best?.candidate ?? null,
    rejected,
    version: best?.version ?? null,
    notes,
    explicitOverrideFailed: false,
    ...(discovery.pathMissReason ? { pathMissReason: discovery.pathMissReason } : {}),
    ...(!best && rejected.length > 0 && timedOutRejections === rejected.length ? { allRejectionsTimedOut: true as const } : {}),
  };
}

/** task #1277 — {@link resolveCodexSpawn} off the event loop; same selection and the same error texts. */
export async function resolveCodexSpawnAsync(commandArgs: string[], deps: ProbeDeps = {}): Promise<ReturnType<typeof resolveCodexSpawn>> {
  const { candidate, rejected, explicitOverrideFailed, allRejectionsTimedOut } = await resolveCompatibleCodexCandidateAsync(deps);
  if (candidate) {
    return {
      command: candidate.command,
      args: [...candidate.argsPrefix, ...commandArgs],
      shell: candidate.shell,
      source: candidate.source,
      ...(candidate.env ? { env: candidate.env } : {}),
      ...(candidate.windowsShim ? { windowsShim: candidate.windowsShim } : {}),
      ...codexRejectionSummary(rejected),
    };
  }

  // task #1358: found, but the check timed out — a typed timeout, not "not found".
  if (allRejectionsTimedOut) throw codexProbeTimeoutError(explicitOverrideFailed);

  const search = describeSearchPath(deps);
  const rejectedNote = rejected.length > 0 ? ` Rejected candidates: ${rejected.join("; ")}.` : "";
  const restartNote = " Restart the Raft daemon after changing PATH or installing Codex so the new environment is picked up.";

  if (explicitOverrideFailed) {
    throw new Error(
      `${CODEX_BIN_ENV} is set but does not resolve to a usable Codex CLI app-server entry point.` +
      rejectedNote +
      ` (${search}).` +
      " Fix or unset CODEX_BIN; automatic PATH/desktop discovery is not used while the override is set." +
      restartNote,
    );
  }

  if ((deps.platform ?? process.platform) === "win32") {
    const wrapperReason = rejected.map((note) => /batch wrapper rejected: (\w+)/.exec(note)?.[1]).find(Boolean);
    throw new RuntimeExecutableNotFoundError({ runtimeId: "codex", reason: wrapperReason, message:
      "Cannot resolve a compatible Codex CLI app-server entry point on Windows. " +
      "Install Codex Desktop or install @openai/codex globally via npm (npm i -g @openai/codex). " +
      "Ignoring .codex/.sandbox-bin/codex-command-runner because it is a sandbox helper, not the Codex CLI." +
      ` (${search}).` +
      rejectedNote +
      restartNote });
  }

  throw new RuntimeExecutableNotFoundError({ runtimeId: "codex", message:
    `Cannot resolve a compatible Codex CLI app-server entry point (${search}).` +
    rejectedNote +
    restartNote });
}

export async function detectCodexModelsFromAppServer(
  options: CodexModelListDetectionOptions = {},
): Promise<RuntimeModelSet | null> {
  const env = options.env ?? ambientProcessEnv();
  const signal = options.deps?.signal;
  let launch: { command: string; args: string[]; shell: boolean; env?: NodeJS.ProcessEnv };
  try {
    // task #1277: the candidate search and probes run as bounded probe
    // children, so a form request no longer blocks the daemon on them.
    launch = await resolveCodexSpawnAsync(["app-server", "--listen", "stdio://"], { ...options.deps, env });
  } catch (error) {
    // A cancelled detection is not a verdict: the abort travels up unchanged.
    if (error instanceof ProbeChildError && error.code === "ABORT_ERR") throw error;
    return null;
  }
  if (signal?.aborted) throw new ProbeChildError("codex model detection aborted before the app-server started", { code: "ABORT_ERR" });

  return await new Promise<RuntimeModelSet | null>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 5000;
    const proc = spawn(launch.command, launch.args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
      env: launch.env ?? env,
      shell: launch.shell,
      // task #1277: its own process group, so a cancel can end the whole
      // app-server tree, not only the direct child.
      detached: process.platform !== "win32",
    });
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Cancel holds the operation until the bounded tree cleanup settles; the
      // rejection says whether the exit was observed.
      void killProbeTreeAndSettle(proc).then((cleanup) => {
        reject(new ProbeChildError("codex model detection aborted", { code: "ABORT_ERR", cleanup }));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    let requestId = 0;
    let initializeRequestId: JsonRpcId | null = null;
    let modelListRequestId: JsonRpcId | null = null;
    let pageCount = 0;
    const entries: unknown[] = [];

    const finish = (result: RuntimeModelSet | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      proc.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const sendRequest = (method: string, params: Record<string, unknown>): JsonRpcId => {
      requestId += 1;
      const id = requestId;
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return id;
    };
    const sendNotification = (method: string, params: Record<string, unknown>) => {
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    };
    const requestModelPage = (cursor: string | null) => {
      pageCount += 1;
      modelListRequestId = sendRequest("model/list", modelListRequestParams(cursor));
    };

    proc.once("error", () => finish(null));
    proc.once("exit", () => finish(null));
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const message = parseCodexJsonRpcLine(line);
        if (!message || !isJsonRpcResponse(message)) continue;
        if (message.id === initializeRequestId) {
          if (!hasJsonRpcField(message, "result") || !isCompatibleInitializeResult(message.result)) {
            finish(null);
            return;
          }
          sendNotification("initialized", {});
          requestModelPage(null);
          continue;
        }

        if (message.id === modelListRequestId) {
          if (!hasJsonRpcField(message, "result")) {
            finish(null);
            return;
          }
          const page = modelListPage(message.result);
          if (!page) {
            finish(null);
            return;
          }
          entries.push(...page.entries);
          if (page.nextCursor && pageCount < 5) {
            requestModelPage(page.nextCursor);
            continue;
          }
          finish(codexModelSetFromAppServerEntries(entries));
          return;
        }
      }
    });

    initializeRequestId = sendRequest("initialize", {
      clientInfo: { name: "slock-daemon", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
  });
}

/**
 * Codex caches its model catalog at `<CODEX_HOME>/models_cache.json` and
 * persists the selected default in `<CODEX_HOME>/config.toml`; without
 * CODEX_HOME the root is `~/.codex`. Legacy callers may still pass the OS home
 * and we fall back to `<home>/.codex`.
 */
export function detectCodexModels(home: string = resolveCodexHomeRootFromEnv()): RuntimeModelSet | null {
  let cachePath: string | null = null;
  let configPath: string | null = null;
  for (const root of codexStateRootCandidates(home)) {
    const candidate = path.join(root, "models_cache.json");
    if (existsSync(candidate)) {
      cachePath = candidate;
      configPath = path.join(root, "config.toml");
      break;
    }
  }

  if (!cachePath || !configPath) return null;

  let models: RuntimeModelInfo[] = [];
  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.models) ? parsed.models : [];
    for (const entry of entries) {
      const slug = typeof entry?.slug === "string" ? entry.slug : null;
      if (!slug) continue;
      if (entry?.visibility && entry.visibility !== "public" && entry.visibility !== "list") continue;
      if (entry?.supported_in_api === false) continue;
      const label = typeof entry?.display_name === "string" && entry.display_name.length > 0
        ? entry.display_name
        : slug;
      models.push({ id: slug, label, verified: "launchable" });
    }
  } catch {
    return null;
  }

  if (models.length === 0) return null;

  let defaultModel: string | undefined;
  try {
    const raw = readFileSync(configPath, "utf8");
    // Minimal TOML lookup — `model = "..."` at top level (not inside a table).
    const match = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (match) defaultModel = match[1];
  } catch {
    // Missing config.toml is fine; we just skip the default hint.
  }

  return { models, default: defaultModel };
}
