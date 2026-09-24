import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentDate, type AgentConfig, type AgentRuntimeProfileRef } from "@botiverse/raft-shared";
import { buildRuntimeErrorDiagnosticEnvelope } from "../runtimeErrorDiagnostics.js";
import {
  codexSessionRootCandidates,
  resolveCodexHomeRootFromConfig,
} from "./codexHome.js";
import { resolveGrokHomeFromEnv } from "./grokHome.js";

export function allowedTranscriptRootsForRuntime(
  runtime: string,
  homeDir: string,
  workspaceDir: string,
): string[] {
  const roots: string[] = [workspaceDir];
  switch (runtime) {
    case "claude":
      roots.push(path.join(homeDir, ".claude"));
      break;
    case "codex":
      roots.push(homeDir, path.join(homeDir, ".codex"));
      break;
    case "grok":
      roots.push(homeDir, path.join(homeDir, ".grok"));
      break;
    case "kimi":
    case "kimi-sdk":
      roots.push(path.join(homeDir, ".kimi"));
      break;
    case "pi":
      roots.push(path.join(homeDir, ".pi"), path.join(homeDir, ".pi", "agent"));
      break;
  }
  return roots;
}

function findSessionJsonl(root: string, predicate: (filename: string) => boolean): string | null {
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

    for (const entry of entries) {
      if (++visited > maxEntries) return null;
      if (!entry.isFile() || !predicate(entry.name)) continue;
      return path.join(dir, entry.name);
    }

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
    const found = findSessionJsonl(root, (filename) => filename.endsWith(".jsonl") && filename.includes(sessionId));
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
    if (existing.includes("\"type\":\"runtime_terminal_cause\"")) {
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
    return resolveCodexHomeRootFromConfig(config, defaultHomeDir, workspacePath, process.env, opts);
  }
  if (config.runtime === "grok") {
    return resolveGrokHomeFromEnv({ ...process.env, ...(config.envVars ?? {}) }, {
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

export interface ResolveRuntimeSessionRefOptions {
  agentId?: string;
  workingDirectory?: string;
  launchId?: string;
  processInstanceId?: string;
}

export function resolveRuntimeSessionRef(
  runtime: string,
  sessionId: string,
  homeDir = os.homedir(),
  fallbackDir?: string,
  opts?: ResolveRuntimeSessionRefOptions,
): AgentRuntimeProfileRef {
  let resolvedPath: string | null = null;
  let lookupMethod = "none";
  const searchedPaths: string[] = [];

  if (runtime === "claude") {
    lookupMethod = "claude_jsonl";
    const claudeRoot = path.join(homeDir, ".claude", "projects");
    searchedPaths.push(claudeRoot);
    resolvedPath = findSessionJsonl(claudeRoot, (filename) => filename === `${sessionId}.jsonl`);
  } else if (runtime === "codex") {
    lookupMethod = "codex_jsonl";
    for (const root of codexSessionRootCandidates(homeDir)) {
      searchedPaths.push(root);
      resolvedPath = findSessionJsonl(root, (filename) => filename.endsWith(".jsonl") && filename.includes(sessionId));
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
  } else if (runtime === "kimi-sdk" || runtime === "kimi") {
    lookupMethod = "kimi_sdk_index";
    resolvedPath = findKimiSdkSessionDir(sessionId, opts?.agentId, homeDir);
  } else if (runtime === "pi") {
    lookupMethod = "pi_jsonl";
    resolvedPath = findPiSessionFile(sessionId, opts?.workingDirectory, homeDir);
  } else if (runtime === "builtin") {
    // Builtin sessions (Pi SDK, managed) land under .builtin-sessions in the
    // agent workspace (pi.ts BUILTIN_SESSION_DIR), separate from pi's
    // .pi-sessions. The SDK writes session files as <display>_<sessionId>.jsonl
    // (see pi.ts findPiSessionFile), so match that exact suffix to avoid
    // picking a different session.
    lookupMethod = "builtin_jsonl";
    const builtinSessionRoot = opts?.workingDirectory
      ? path.join(opts.workingDirectory, ".builtin-sessions")
      : null;
    if (builtinSessionRoot) {
      searchedPaths.push(builtinSessionRoot);
      const suffix = `_${sessionId}.jsonl`;
      resolvedPath = findSessionJsonl(builtinSessionRoot, (filename) => filename.endsWith(suffix));
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
    if (fallback) return { ...fallback, reason: `${fallback.reason}; attempted_lookup=${lookupMethod}` };
  }

  const ref: AgentRuntimeProfileRef = {
    label: sessionId,
    path: resolvedPath ?? sessionId,
    runtime,
    reachable: Boolean(resolvedPath),
  };
  if (!resolvedPath) {
    ref.reason = `session file path not found; attempted_lookup=${lookupMethod}; searched=[${searchedPaths.join(", ")}]`;
  }
  return ref;
}
