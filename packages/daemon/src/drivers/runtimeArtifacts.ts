import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { ambientProcessEnv } from "../processEnvPatch";
import os from "node:os";
import path from "node:path";
import {
  currentDate,
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  type AgentConfig,
  type AgentRuntimeProfileRef,
} from "@botiverse/raft-shared";
import { buildRuntimeErrorDiagnosticEnvelope } from "../runtimeErrorDiagnostics";
import {
  codexSessionRootCandidates,
  resolveCodexHomeRootFromConfig,
} from "./codexHome";
import { resolveGrokHomeFromEnv } from "./grokHome";
import { newestPiSessionFile, piSessionParentChain, type PiSessionChain } from "./piSessionRotation";
import { kimiSdkHomeFromEnv } from "./kimiCodeHome";

/**
 * Homes a transcript lookup needs besides `homeDir` (the runtime's
 * resolveRuntimeHomeDir value, which stays the OS home for kimi-sdk because
 * skill lookup reads it too). Today only kimi-sdk's: its SDK home.
 */
export interface RuntimeTranscriptHomes {
  /** kimi-sdk: the Kimi Code SDK home the driver runs the harness with. */
  kimiCodeHome?: string;
}

export function resolveKimiSdkHomeFromConfig(
  config: AgentConfig,
  defaultHomeDir: string,
  baseEnv: Record<string, string | undefined> = ambientProcessEnv(),
): string {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  return kimiSdkHomeFromEnv({ ...baseEnv, ...(launchRuntimeFields.envVars || {}) }, defaultHomeDir);
}

/** The transcript homes of an agent's config (see RuntimeTranscriptHomes). */
export function runtimeTranscriptHomesForConfig(
  config: AgentConfig,
  defaultHomeDir: string,
  baseEnv: Record<string, string | undefined> = ambientProcessEnv(),
): RuntimeTranscriptHomes {
  return config.runtime === "kimi-sdk"
    ? { kimiCodeHome: resolveKimiSdkHomeFromConfig(config, defaultHomeDir, baseEnv) }
    : {};
}

export function allowedTranscriptRootsForRuntime(
  runtime: string,
  homeDir: string,
  workspaceDir: string,
  homes: RuntimeTranscriptHomes = {},
): string[] {
  const roots: string[] = [workspaceDir];
  switch (runtime) {
    case "claude":
      roots.push(path.join(homeDir, ".claude"));
      break;
    case "codex":
      // Only the rollouts: `homeDir` is the Codex home (CODEX_HOME, else
      // ~/.codex), which also holds auth.json, history.jsonl and logs.
      roots.push(...codexSessionRootCandidates(homeDir));
      break;
    case "grok":
      roots.push(homeDir, path.join(homeDir, ".grok"));
      break;
    case "kimi":
      roots.push(path.join(homeDir, ".kimi"));
      break;
    case "kimi-sdk":
      roots.push(homes.kimiCodeHome ?? kimiSdkHomeFromEnv(ambientProcessEnv(), homeDir));
      break;
    case "pi":
      roots.push(path.join(homeDir, ".pi"), path.join(homeDir, ".pi", "agent"));
      break;
  }
  return roots;
}

/**
 * The first file (newest name first, depth-first) `rank` accepts; among the
 * files of one directory the lowest rank wins. `rank` returns null to reject.
 */
function findSessionJsonl(root: string, rank: (filename: string) => number | null): string | null {
  let visited = 0;
  const maxEntries = 10_000;
  const maxDepth = 8;

  const visit = (dir: string, depth: number): string | null => {
    if (depth < 0 || visited >= maxEntries) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      return null;
    }

    let best: { name: string; rank: number } | null = null;
    for (const entry of entries) {
      if (++visited > maxEntries) return null;
      if (!entry.isFile()) continue;
      const entryRank = rank(entry.name);
      if (entryRank === null || (best && best.rank <= entryRank)) continue;
      best = { name: entry.name, rank: entryRank };
    }
    if (best) return path.join(dir, best.name);

    for (const entry of entries) {
      if (++visited > maxEntries) return null;
      if (!entry.isDirectory()) continue;
      const found = visit(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }

    return null;
  };

  return visit(root, maxDepth);
}

/** Accept exactly `filename` (rank 0). */
function exactFilename(filename: string): (candidate: string) => number | null {
  return (candidate) => (candidate === filename ? 0 : null);
}

/**
 * A codex rollout of the session: `rollout-...-<id>.jsonl`, or the
 * `rollout-...-<id>.jsonl.zst` codex 0.16x compresses a cold one to
 * (rollout/src/compression.rs). The plain file wins when both are present;
 * `.jsonl.tmp`, lock and other side files never match.
 */
export function codexRolloutRank(filename: string, sessionId: string): number | null {
  if (!filename.includes(sessionId)) return null;
  if (filename.endsWith(".jsonl")) return 0;
  if (filename.endsWith(".jsonl.zst")) return 1;
  return null;
}

/** A session id that is one path segment (it is joined into scanned paths). */
function isSinglePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/** The session id's directory per `<kimiHome>/session_index.jsonl` (last entry wins; a deletion clears it). */
function kimiSdkIndexedSessionDir(kimiHome: string, sessionId: string): string | null {
  let index: string;
  try {
    index = readFileSync(path.join(kimiHome, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  let sessionDir: string | null = null;
  for (const line of index.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown; deleted?: unknown };
      if (entry.sessionId !== sessionId) continue;
      sessionDir = entry.deleted === true ? null : typeof entry.sessionDir === "string" ? entry.sessionDir : sessionDir;
    } catch {
      // Ignore malformed index lines.
    }
  }
  return sessionDir && isDirectory(sessionDir) ? sessionDir : null;
}

/** `<kimiHome>/sessions/<workspaceId>/<sessionId>`, scanning the workspace directories. */
function kimiSdkScannedSessionDir(sessionsRoot: string, sessionId: string): string | null {
  if (!isSinglePathSegment(sessionId)) return null;
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, entry.name, sessionId);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/**
 * The kimi-sdk session's conversation log: the Kimi Code SDK keeps a session
 * in `<kimiHome>/sessions/<workspaceId>/<sessionId>` (recorded in
 * `<kimiHome>/session_index.jsonl`), the main agent's event log in
 * `agents/main/wire.jsonl` (sub-agents in `agents/<agentId>/wire.jsonl`; a v1
 * session in the directory's own `wire.jsonl`). A session directory without
 * a wire log has no conversation to read: not found.
 */
function findKimiSdkSessionTranscript(kimiHome: string, sessionId: string): string | null {
  const sessionDir = kimiSdkIndexedSessionDir(kimiHome, sessionId)
    ?? kimiSdkScannedSessionDir(path.join(kimiHome, "sessions"), sessionId);
  if (!sessionDir) return null;
  for (const candidate of [path.join(sessionDir, "agents", "main", "wire.jsonl"), path.join(sessionDir, "wire.jsonl")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** The legacy kimi CLI layout under `~/.kimi` (runtime `kimi`). */
function findKimiSdkSessionDir(sessionId: string, agentId: string | undefined, homeDir: string): string | null {
  const indexPath = path.join(homeDir, ".kimi", "session_index.jsonl");
  try {
    const index = readFileSync(indexPath, "utf8");
    for (const line of index.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { sessionId?: string; sessionDir?: string; workDir?: string };
        if (entry.sessionId === sessionId && entry.sessionDir && existsSync(entry.sessionDir)) {
          return entry.sessionDir;
        }
      } catch {
        // Ignore malformed index lines.
      }
    }
  } catch {
    // Index missing or unreadable; fall through to heuristic discovery.
  }

  const sessionsRoot = path.join(homeDir, ".kimi", "sessions");
  try {
    const prefix = agentId ? `wd_${agentId}_` : "wd_";
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const candidate = path.join(sessionsRoot, entry.name, `session_${sessionId}`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Directory missing.
  }

  return null;
}

function findGrokSessionTranscript(root: string, sessionId: string): string | null {
  let visited = 0;
  const maxEntries = 10_000;
  const maxDepth = 4;
  const preferredFiles = ["updates.jsonl", "events.jsonl", "chat_history.jsonl"];

  const visit = (dir: string, depth: number): string | null => {
    if (depth < 0 || visited >= maxEntries) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (++visited > maxEntries) return null;
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === sessionId) {
        for (const filename of preferredFiles) {
          const candidate = path.join(child, filename);
          try {
            if (statSync(candidate).isFile()) return candidate;
          } catch {
            // Keep checking the bounded set of known transcript files.
          }
        }
      }
      const found = visit(child, depth - 1);
      if (found) return found;
    }
    return null;
  };

  return visit(root, maxDepth);
}

function findPiSessionFile(sessionId: string, workingDirectory: string | undefined, homeDir: string): string | null {
  if (workingDirectory) {
    const piSessionsDir = path.join(workingDirectory, ".pi-sessions");
    // The file the pi driver resumes (rotation leaves older ones beside it).
    const resumed = newestPiSessionFile(piSessionsDir, sessionId);
    if (resumed) return resumed;
    try {
      const files = readdirSync(piSessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => ({
          name: entry.name,
          path: path.join(piSessionsDir, entry.name),
          stat: statSync(path.join(piSessionsDir, entry.name)),
        }))
        .filter((entry) => entry.stat.isFile() && entry.name.includes(sessionId))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      if (files[0]) return files[0].path;
    } catch {
      // Missing or unreadable.
    }
  }

  const legacyRoots = [path.join(homeDir, ".pi", "agent"), path.join(homeDir, ".pi")];
  for (const root of legacyRoots) {
    const found = findSessionJsonl(root, (filename) => (filename.endsWith(".jsonl") && filename.includes(sessionId) ? 0 : null));
    if (found) return found;
  }
  return null;
}

function safeSessionFilename(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "unknown-session";
}

function runtimeSessionHandoffPath(fallbackDir: string, runtime: string, sessionId: string): string {
  return path.join(fallbackDir, ".slock", "runtime-sessions", `${runtime}-${safeSessionFilename(sessionId)}.jsonl`);
}

export type RuntimeTerminalCausePhase =
  | "session_start"
  | "prompt_request"
  | "steer_request"
  | "message_stream"
  | "message_end"
  | "sdk_event";

export interface WriteRuntimeTerminalCauseOptions {
  runtime: string;
  sessionId: string;
  fallbackDir: string;
  agentId?: string;
  launchId?: string | null;
  processInstanceId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  phase: RuntimeTerminalCausePhase;
  message: string;
}

export type RuntimeLifecycleDiagnosticEvent =
  | {
      kind: "session_start";
      phase: "started" | "ready" | "failed";
      errorClass?: string;
      errorCode?: string;
    }
  | {
      kind: "model_resolved";
      requestedModel: string;
      providerId: string | null;
      modelId: string | null;
      modelApi: string | null;
      configSource: string | null;
    }
  | {
      kind: "provider_request";
      requestId: string;
      providerId: string;
      phase: "waiting" | "responding" | "failed" | "cancelled";
      httpStatus?: number;
      cancelSource?: "requested_stop" | "requested_interrupt" | "dispose" | "sdk_internal_or_unknown";
    }
  | {
      kind: "compaction";
      phase: "started" | "succeeded" | "failed" | "aborted";
      reason?: "manual" | "threshold" | "overflow" | "unknown";
      failureReason?: "recovery_exhausted" | "input_too_large" | "compaction_failed";
      willRetry?: boolean;
    }
  | {
      kind: "transcript_persist";
      outcome: "deferred" | "persisted" | "failed";
      entryType:
        | "message"
        | "thinking_level_change"
        | "model_change"
        | "compaction"
        | "branch_summary"
        | "custom"
        | "custom_message"
        | "label"
        | "session_info"
        | "unknown";
      errorClass?: string;
      errorCode?: string;
    }
  | {
      /**
       * pi session rotation: the session moved to a seed file under the same
       * id. File names only (both are in the session directory); no content.
       */
      kind: "session_rotated";
      /** The old file, now `<timestamp>_<id>.jsonl.rotated`. */
      fromFile: string;
      /** The seed the session resumed, `<timestamp>_<id>.jsonl`; its header's parentSession is `fromFile`. */
      toFile: string;
      entriesBefore: number;
      bytesBefore: number;
      entriesAfter: number;
      bytesAfter: number;
    }
  | {
      kind: "cancel_requested";
      source: "requested_stop" | "requested_interrupt" | "dispose";
      signal: NodeJS.Signals | null;
      providerRequestActive: boolean;
    };

export interface WriteRuntimeLifecycleDiagnosticOptions {
  runtime: string;
  sessionId: string;
  fallbackDir: string;
  agentId?: string;
  launchId?: string | null;
  processInstanceId?: string | null;
  event: RuntimeLifecycleDiagnosticEvent;
}

const MAX_RUNTIME_LIFECYCLE_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

/**
 * Persist a content-free runtime lifecycle fact next to the existing terminal
 * cause handoff. This file is intentionally independent of the native runtime
 * transcript: a transcript write failure must not erase the evidence needed to
 * distinguish model resolution, provider transport, compaction, and shutdown.
 */
export function writeRuntimeLifecycleDiagnosticRecord(
  opts: WriteRuntimeLifecycleDiagnosticOptions,
): AgentRuntimeProfileRef | null {
  try {
    const filePath = runtimeSessionHandoffPath(opts.fallbackDir, opts.runtime, opts.sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const joinKey = [
      "runtime_lifecycle",
      opts.agentId ?? "unknown_agent",
      opts.launchId ?? "missing_launch",
      opts.processInstanceId ?? "missing_process",
      opts.sessionId,
    ].join(":");
    const record = JSON.stringify({
      type: "runtime_lifecycle",
      artifactVersion: 1,
      runtime: opts.runtime,
      agentId: opts.agentId ?? null,
      sessionId: opts.sessionId,
      launchId: opts.launchId ?? null,
      processInstanceId: opts.processInstanceId ?? null,
      joinKey,
      event: opts.event,
      createdAt: currentDate().toISOString(),
    }) + "\n";

    const currentSize = existsSync(filePath) ? statSync(filePath).size : 0;
    if (currentSize + Buffer.byteLength(record, "utf8") > MAX_RUNTIME_LIFECYCLE_DIAGNOSTIC_BYTES) {
      writeFileSync(filePath, JSON.stringify({
        type: "runtime_lifecycle_history_truncated",
        artifactVersion: 1,
        runtime: opts.runtime,
        agentId: opts.agentId ?? null,
        sessionId: opts.sessionId,
        launchId: opts.launchId ?? null,
        processInstanceId: opts.processInstanceId ?? null,
        joinKey,
        createdAt: currentDate().toISOString(),
      }) + "\n", { mode: 0o600 });
    }
    appendFileSync(filePath, record, { mode: 0o600 });
    return {
      label: opts.sessionId,
      path: filePath,
      runtime: opts.runtime,
      reachable: true,
      reason: "daemon lifecycle diagnostic written independently of native transcript",
    };
  } catch {
    return null;
  }
}
export function writeRuntimeTerminalCauseRecord(opts: WriteRuntimeTerminalCauseOptions): AgentRuntimeProfileRef | null {
  try {
    const filePath = runtimeSessionHandoffPath(opts.fallbackDir, opts.runtime, opts.sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(opts.message);
    const joinKey = [
      "runtime_terminal_cause",
      opts.agentId ?? "unknown_agent",
      opts.launchId ?? "missing_launch",
      opts.processInstanceId ?? "missing_process",
      opts.sessionId,
    ].join(":");
    appendFileSync(filePath, JSON.stringify({
      type: "runtime_terminal_cause",
      artifactVersion: 1,
      runtime: opts.runtime,
      agentId: opts.agentId ?? null,
      sessionId: opts.sessionId,
      launchId: opts.launchId ?? null,
      processInstanceId: opts.processInstanceId ?? null,
      joinKey,
      providerId: opts.providerId ?? null,
      modelId: opts.modelId ?? null,
      phase: opts.phase,
      errorClass: diagnostics.spanAttrs.runtime_error_class,
      errorReason: diagnostics.spanAttrs.turn_reason,
      errorAction: diagnostics.spanAttrs.runtime_error_action,
      errorFingerprint: diagnostics.spanAttrs.runtime_error_fingerprint,
      ...(diagnostics.spanAttrs.runtime_error_http_status
        ? { httpStatus: diagnostics.spanAttrs.runtime_error_http_status }
        : {}),
      errorMessageExcerpt: diagnostics.eventAttrs.runtime_error_message_excerpt,
      errorMessageTruncated: diagnostics.spanAttrs.runtime_error_message_truncated,
      createdAt: currentDate().toISOString(),
    }) + "\n", { mode: 0o600 });
    return {
      label: opts.sessionId,
      path: filePath,
      runtime: opts.runtime,
      reachable: true,
      reason: "daemon terminal cause record written before terminal runtime error activity",
    };
  } catch {
    return null;
  }
}

function writeRuntimeSessionHandoff(
  runtime: string,
  sessionId: string,
  fallbackDir: string,
  join?: { launchId?: string; processInstanceId?: string },
  resolve?: { lookupMethod?: string; searchedPaths?: string[] },
): AgentRuntimeProfileRef | null {
  try {
    const filePath = runtimeSessionHandoffPath(fallbackDir, runtime, sessionId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const searchedPaths = resolve?.searchedPaths ?? [];
    const line = JSON.stringify({
      type: "runtime_session_handoff",
      runtime,
      sessionId,
      launchId: join?.launchId ?? null,
      processInstanceId: join?.processInstanceId ?? null,
      resolveStatus: "transcript_resolve_missing",
      lookupMethod: resolve?.lookupMethod ?? "none",
      searchedPaths,
      createdAt: new Date().toISOString(),
      note: "The native runtime transcript file was not found on this machine; this daemon-created handoff records the runtime session identity + the directories checked for diagnostics.",
    }) + "\n";
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    if (
      existing.includes("\"type\":\"runtime_terminal_cause\"") ||
      existing.includes("\"type\":\"runtime_lifecycle\"") ||
      existing.includes("\"type\":\"runtime_lifecycle_history_truncated\"")
    ) {
      appendFileSync(filePath, line, { mode: 0o600 });
    } else {
      writeFileSync(filePath, line, { mode: 0o600 });
    }
    return {
      label: sessionId,
      path: filePath,
      runtime,
      reachable: true,
      reason: `native session file path not found; using daemon handoff file; searched=[${searchedPaths.join(", ")}]`,
    };
  } catch {
    return null;
  }
}

export function resolveRuntimeHomeDir(
  config: AgentConfig,
  defaultHomeDir: string,
  workspacePath: string,
  opts: { agentId?: string; slockHome?: string } = {},
): string {
  if (config.runtime === "codex") {
    return resolveCodexHomeRootFromConfig(config, defaultHomeDir, workspacePath, ambientProcessEnv(), opts);
  }
  if (config.runtime === "grok") {
    return resolveGrokHomeFromEnv({ ...ambientProcessEnv(), ...(config.envVars ?? {}) }, {
      cwd: workspacePath,
      homeDir: defaultHomeDir,
    });
  }
  return defaultHomeDir;
}

export function ensureRuntimeHomeDir(
  config: AgentConfig,
  defaultHomeDir: string,
  workspacePath: string,
  opts: { agentId?: string; slockHome?: string } = {},
): string {
  const home = resolveRuntimeHomeDir(config, defaultHomeDir, workspacePath, opts);
  if (config.runtime === "codex" && opts.agentId) mkdirSync(home, { recursive: true });
  return home;
}

export interface ResolveRuntimeSessionRefOptions extends RuntimeTranscriptHomes {
  agentId?: string;
  workingDirectory?: string;
  launchId?: string;
  processInstanceId?: string;
}

/**
 * How a session ref was resolved, decided by the resolver itself (never parsed
 * back out of `reason`): the runtime's own file, the daemon-written workspace
 * handoff placeholder, or nothing.
 */
export type RuntimeSessionResolution = "native" | "daemon_handoff" | "not_found";

export interface RuntimeSessionRefResolution {
  ref: AgentRuntimeProfileRef;
  resolution: RuntimeSessionResolution;
  lookupMethod: string;
  searchedPaths: string[];
  /**
   * pi / Built-in only, for a native hit: the files a rotated session
   * continues (piSessionParentChain), oldest first. `ref.path` stays the
   * current file, the one the driver resumes.
   */
  sessionChain?: PiSessionChain;
}

/** The chain in the ref's free-text reason (the only ref field the server keeps besides the path). */
function sessionChainReason(chain: PiSessionChain): string | undefined {
  // No earlier file and nothing refused: not a rotated session (a current
  // file without a pi header is not one either).
  if (chain.earlier.length === 0 && (chain.end === "root" || chain.end === "unreadable_header")) return undefined;
  const names = chain.earlier.map((file) => path.basename(file));
  return `rotated session: continues ${names.length} earlier file(s), oldest first: [${names.join(", ")}]; chain_end=${chain.end}`;
}

/**
 * The runtime-profile resolver (unchanged behaviour: a native miss with a
 * fallback dir writes and returns the handoff file as a reachable ref). Thin
 * wrapper over resolveRuntimeSessionRefDetailed.
 */
export function resolveRuntimeSessionRef(
  runtime: string,
  sessionId: string,
  homeDir = os.homedir(),
  fallbackDir?: string,
  opts?: ResolveRuntimeSessionRefOptions,
): AgentRuntimeProfileRef {
  return resolveRuntimeSessionRefDetailed(runtime, sessionId, homeDir, fallbackDir, opts).ref;
}

export function resolveRuntimeSessionRefDetailed(
  runtime: string,
  sessionId: string,
  homeDir = os.homedir(),
  fallbackDir?: string,
  opts?: ResolveRuntimeSessionRefOptions,
): RuntimeSessionRefResolution {
  let resolvedPath: string | null = null;
  let lookupMethod = "none";
  const searchedPaths: string[] = [];

  if (runtime === "claude") {
    lookupMethod = "claude_jsonl";
    const claudeRoot = path.join(homeDir, ".claude", "projects");
    searchedPaths.push(claudeRoot);
    resolvedPath = findSessionJsonl(claudeRoot, exactFilename(`${sessionId}.jsonl`));
  } else if (runtime === "codex") {
    // `.jsonl` or the compressed `.jsonl.zst` (read by sessionTranscriptReader).
    lookupMethod = "codex_jsonl";
    for (const root of codexSessionRootCandidates(homeDir)) {
      searchedPaths.push(root);
      resolvedPath = findSessionJsonl(root, (filename) => codexRolloutRank(filename, sessionId));
      if (resolvedPath) break;
    }
  } else if (runtime === "grok") {
    lookupMethod = "grok_session_jsonl";
    const roots = [...new Set([path.join(homeDir, "sessions"), path.join(homeDir, ".grok", "sessions")])];
    for (const root of roots) {
      searchedPaths.push(root);
      resolvedPath = findGrokSessionTranscript(root, sessionId);
      if (resolvedPath) break;
    }
  } else if (runtime === "kimi-sdk") {
    // The SDK home the driver runs the harness with (never ~/.kimi).
    lookupMethod = "kimi_sdk_index";
    const kimiHome = opts?.kimiCodeHome ?? kimiSdkHomeFromEnv(ambientProcessEnv(), homeDir);
    searchedPaths.push(path.join(kimiHome, "sessions"));
    resolvedPath = findKimiSdkSessionTranscript(kimiHome, sessionId);
  } else if (runtime === "kimi") {
    lookupMethod = "kimi_sdk_index";
    resolvedPath = findKimiSdkSessionDir(sessionId, opts?.agentId, homeDir);
  } else if (runtime === "pi") {
    lookupMethod = "pi_jsonl";
    resolvedPath = findPiSessionFile(sessionId, opts?.workingDirectory, homeDir);
  } else if (runtime === "builtin") {
    // Builtin sessions (Pi SDK, managed) land under .builtin-sessions in the
    // agent workspace (pi.ts BUILTIN_SESSION_DIR), separate from pi's
    // .pi-sessions: the file the driver resumes, the newest-named
    // <timestamp>_<sessionId>.jsonl (rotation leaves older ones beside it).
    lookupMethod = "builtin_jsonl";
    const builtinSessionRoot = opts?.workingDirectory
      ? path.join(opts.workingDirectory, ".builtin-sessions")
      : null;
    if (builtinSessionRoot) {
      searchedPaths.push(builtinSessionRoot);
      resolvedPath = newestPiSessionFile(builtinSessionRoot, sessionId);
    }
  }

  if (!resolvedPath && fallbackDir) {
    const fallback = writeRuntimeSessionHandoff(
      runtime,
      sessionId,
      fallbackDir,
      { launchId: opts?.launchId, processInstanceId: opts?.processInstanceId },
      { lookupMethod, searchedPaths },
    );
    if (fallback) {
      return {
        ref: { ...fallback, reason: `${fallback.reason}; attempted_lookup=${lookupMethod}` },
        resolution: "daemon_handoff",
        lookupMethod,
        searchedPaths,
      };
    }
  }

  const ref: AgentRuntimeProfileRef = {
    label: sessionId,
    path: resolvedPath ?? sessionId,
    runtime,
    reachable: Boolean(resolvedPath),
  };
  if (!resolvedPath) {
    ref.reason = `session file path not found; attempted_lookup=${lookupMethod}; searched=[${searchedPaths.join(", ")}]`;
    return { ref, resolution: "not_found", lookupMethod, searchedPaths };
  }
  if (runtime !== "pi" && runtime !== "builtin") return { ref, resolution: "native", lookupMethod, searchedPaths };
  const sessionChain = piSessionParentChain(resolvedPath, sessionId);
  const reason = sessionChainReason(sessionChain);
  if (reason) ref.reason = reason;
  return { ref, resolution: "native", lookupMethod, searchedPaths, sessionChain };
}
