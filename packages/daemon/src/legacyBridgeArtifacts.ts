// Idempotent removal of legacy chat-bridge MCP artifacts (task #261, audit #259;
// redone on current staging as #proj-raft-computer task #38, after #8109 went stale).
//
// Three historical daemon generators wrote a credential-bearing MCP server entry
// named `chat` into files inside the agent workspace:
//
//   F1 <workspace>/.slock-claude-mcp.json            (a973a8e8 → removed 298c7563)
//   F2 <workspace>/.slock/claude-mcp-config.json     (1bbc0fc5 → removed 1a448890)
//   F3 <workspace>/.gemini/settings.json             (9b143503 → removed 96d6a845)
//
// The entry launched `chat-bridge` with `--auth-token <machine bearer>` in argv.
// Current source ships neither the generators nor the bridge, so the entry is a
// dangling reference that still carries a bearer on disk. This module removes
// exactly that entry and nothing else:
//
//   - provenance gate: contained path, no symlink on the file or its parent, a
//     regular file read through one no-follow, non-blocking open (checked on
//     the open file, at most 1 MiB), a JSON object, and `mcpServers.chat`
//     shaped like the bridge launch with `--auth-token` and either bound to
//     THIS agent (`--agent-id <agentId>`) or carrying this daemon's own machine
//     key; anything else is left untouched;
//   - edit: delete `mcpServers.chat` only; unlink the file only when nothing
//     else remains (the file was entirely ours); otherwise rewrite atomically
//     (same-directory random temp created exclusively, then rename) with mode
//     0600; no backup copy anywhere;
//   - the directory is PINNED for the whole edit (read, write, rename or
//     unlink), so an agent that swaps `.gemini` or `.slock` for a link to a
//     host directory mid-edit cannot make the daemon delete or plant a file
//     there (Tenny, #12651): on Linux the daemon opens the directory once and
//     works through `/proc/self/fd/<fd>/…`; elsewhere a small child process
//     runs with that directory as its cwd and checks `process.cwd()` is where
//     it should be before anything relative. Without either (a single-file
//     build off Linux) the file is left as it is, and counted;
//   - logging: file name, action and agent id only — never entry contents.
//
// It runs per spawn (prepareCliTransport) and once at daemon start over every
// agent workspace. Repeat runs are no-ops. It never throws into the caller.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { resolveNodeHostLaunch } from "./drivers/nodeHostLaunch";
import { logger } from "./logger";

export const LEGACY_BRIDGE_ARTIFACT_FILES: readonly string[] = [
  ".slock-claude-mcp.json",
  path.join(".slock", "claude-mcp-config.json"),
  path.join(".gemini", "settings.json"),
];

/** The daemon's own directories beside the workspaces (RFC 071 outbox, agent state): never a workspace. */
const DAEMON_DIR_NAMES: ReadonlySet<string> = new Set([".runtime-outcome-outbox", ".agent-state"]);

export type LegacyBridgeArtifactAction =
  | "absent"
  | "unchanged"
  | "removed-entry"
  | "unlinked"
  | `skipped:${string}`;

export interface LegacyBridgeArtifactResult {
  /** Workspace-relative path of the artifact. */
  file: string;
  action: LegacyBridgeArtifactAction;
  /** The removed entry carried this daemon's current machine key: the agent may have read it. */
  currentKey: boolean;
}

export interface LegacyBridgeArtifactBatchSummary {
  scanned: number;
  removedEntries: number;
  unlinked: number;
  skipped: number;
  /** Artifacts that held this daemon's current machine key. */
  currentKeyExposed: number;
}

/** How the artifact's directory is held while it is edited (tests choose; production picks per platform). */
export type PinMode = "proc-fd" | "child-cwd";

export interface LegacyBridgeArtifactOptions {
  machineKey?: string | null;
  pin?: PinMode | null;
  /** Test seam: runs once the directory is held, before the edit. */
  afterPin?: (dir: string) => void;
  /** Test seam: runs before the directory is held. */
  beforePin?: (dir: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True only for an entry that matches the historical bridge launch shape with
 * `--auth-token` AND is bound to `agentId` or carries `machineKey` (this
 * daemon's own bearer, whichever agent the entry names). Values are compared,
 * never logged or returned. Self-contained: it is also serialized into the
 * child editor, so it references nothing outside itself.
 */
export function isLegacyBridgeEntry(entry: unknown, agentId: string, machineKey?: string | null): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const record = entry as { command?: unknown; args?: unknown };
  if (record.command !== "node" && record.command !== "npx") return false;
  const args = record.args;
  if (!Array.isArray(args) || args.length === 0) return false;
  if (!args.every((value) => typeof value === "string")) return false;
  const tokenFlag = args.indexOf("--auth-token");
  if (tokenFlag < 0 || tokenFlag + 1 >= args.length) return false;
  if (machineKey && args[tokenFlag + 1] === machineKey) return true;
  const agentFlag = args.indexOf("--agent-id");
  if (agentFlag < 0 || agentFlag + 1 >= args.length) return false;
  return args[agentFlag + 1] === agentId;
}

interface PinnedEditInput {
  name: string;
  agentId: string;
  machineKey: string | null;
  nonce: string;
}

interface PinnedEditResult {
  action: string;
  currentKey: boolean;
}

/**
 * The edit of one artifact, with its directory already pinned: `at(name)` is
 * a path to `name` inside it that cannot be redirected. Self-contained (it is
 * serialized into the child editor): only its parameters and globals.
 */
function editPinnedArtifact(
  nodeFs: typeof fs,
  at: (name: string) => string,
  input: PinnedEditInput,
  isEntry: (entry: unknown, agentId: string, machineKey?: string | null) => boolean,
): PinnedEditResult {
  const result = (action: string, currentKey = false): PinnedEditResult => ({ action, currentKey });
  const code = (error: unknown): string => {
    const value = (error as { code?: unknown } | null)?.code;
    return typeof value === "string" ? value : "error";
  };
  const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = nodeFs.openSync(at(input.name), flags);
  } catch (error) {
    const c = code(error);
    return result(c === "ENOENT" ? "absent" : c === "ELOOP" ? "skipped:symlink" : `skipped:${c}`);
  }
  let text: string;
  try {
    const info = nodeFs.fstatSync(fd);
    if (!info.isFile()) return result("skipped:not-a-file");
    if (info.size > 1024 * 1024) return result("skipped:too-large");
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const n = nodeFs.readSync(fd, buffer, read, info.size - read, read);
      if (n === 0) break;
      read += n;
    }
    text = buffer.subarray(0, read).toString("utf8");
  } finally {
    nodeFs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result("skipped:invalid-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result("skipped:not-an-object");
  const document = parsed as Record<string, unknown>;
  const servers = document.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return result("unchanged");
  const serverMap = servers as Record<string, unknown>;
  if (!("chat" in serverMap)) return result("unchanged");
  const entry = serverMap.chat;
  if (!isEntry(entry, input.agentId, input.machineKey)) return result("skipped:unknown-provenance");
  const args = (entry as { args: string[] }).args;
  const currentKey = Boolean(input.machineKey) && args[args.indexOf("--auth-token") + 1] === input.machineKey;
  delete serverMap.chat;
  if (Object.keys(serverMap).length === 0) delete document.mcpServers;
  if (Object.keys(document).length === 0) {
    try {
      nodeFs.unlinkSync(at(input.name));
    } catch (error) {
      return result(`skipped:${code(error)}`, currentKey);
    }
    return result("unlinked", currentKey);
  }
  const temp = at(`.${input.name}.${input.nonce}.tmp`);
  try {
    nodeFs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    nodeFs.renameSync(temp, at(input.name));
  } catch (error) {
    try {
      nodeFs.unlinkSync(temp);
    } catch {
      /* the temp file may not exist */
    }
    return result(`skipped:${code(error)}`, currentKey);
  }
  return result("removed-entry", currentKey);
}

/**
 * The child editor: reads its input from stdin (the key never in argv), and
 * refuses to touch anything unless its cwd, as the kernel reports it, is the
 * directory the daemon meant. Bundlers may wrap functions in `__name`; the
 * prelude makes that a no-op.
 */
function childEditorScript(): string {
  return [
    "var __name = function (f) { return f; };",
    "var fs = require('node:fs');",
    "var chunks = [];",
    "process.stdin.on('data', function (c) { chunks.push(c); });",
    "process.stdin.on('end', function () {",
    "  var input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "  var here = process.cwd();",
    "  var same = process.platform === 'win32' ? here.toLowerCase() === input.expectedDir.toLowerCase() : here === input.expectedDir;",
    "  var out = same",
    `    ? (${editPinnedArtifact.toString()})(fs, function (n) { return './' + n; }, input, ${isLegacyBridgeEntry.toString()})`,
    "    : { action: 'skipped:moved-directory', currentKey: false };",
    "  process.stdout.write(JSON.stringify(out));",
    "});",
  ].join("\n");
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

function defaultPinMode(): PinMode | null {
  if (process.platform === "linux") return "proc-fd";
  try {
    resolveNodeHostLaunch();
    return "child-cwd";
  } catch {
    return null;
  }
}

function editWithProcFd(expectedDir: string, input: PinnedEditInput, options: LegacyBridgeArtifactOptions): PinnedEditResult {
  let dirFd: number;
  try {
    dirFd = fs.openSync(expectedDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    return { action: code === "ELOOP" || code === "ENOTDIR" ? "skipped:parent-symlink" : `skipped:${code}`, currentKey: false };
  }
  try {
    const held = `/proc/self/fd/${dirFd}`;
    if (fs.realpathSync(held) !== expectedDir) return { action: "skipped:moved-directory", currentKey: false };
    options.afterPin?.(expectedDir);
    return editPinnedArtifact(fs, (name) => `${held}/${name}`, input, isLegacyBridgeEntry);
  } finally {
    fs.closeSync(dirFd);
  }
}

function editWithChild(expectedDir: string, input: PinnedEditInput): PinnedEditResult {
  let host;
  try {
    host = resolveNodeHostLaunch();
  } catch {
    return { action: "skipped:no-pinned-editor", currentKey: false };
  }
  const child = spawnSync(host.command, [...host.execArgv, "-e", childEditorScript()], {
    cwd: expectedDir,
    env: host.env,
    input: JSON.stringify({ ...input, expectedDir }),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (child.error || child.status !== 0) return { action: "skipped:editor-failed", currentKey: false };
  try {
    const out = JSON.parse(child.stdout) as Partial<PinnedEditResult>;
    return typeof out.action === "string" ? { action: out.action, currentKey: out.currentKey === true } : { action: "skipped:editor-failed", currentKey: false };
  } catch {
    return { action: "skipped:editor-failed", currentKey: false };
  }
}

function migrateOne(rootReal: string, rel: string, agentId: string, options: LegacyBridgeArtifactOptions): PinnedEditResult {
  const relDir = path.dirname(rel);
  const expectedDir = relDir === "." ? rootReal : path.join(rootReal, relDir);
  // A cheap look first: most workspaces have none of these files, and nothing is held for them.
  let dirStat;
  try {
    dirStat = fs.lstatSync(expectedDir);
  } catch (err) {
    return { action: errorCode(err) === "ENOENT" ? "absent" : `skipped:${errorCode(err)}`, currentKey: false };
  }
  if (dirStat.isSymbolicLink()) return { action: "skipped:parent-symlink", currentKey: false };
  if (!dirStat.isDirectory()) return { action: "skipped:parent-not-directory", currentKey: false };
  try {
    fs.lstatSync(path.join(expectedDir, path.basename(rel)));
  } catch (err) {
    return { action: errorCode(err) === "ENOENT" ? "absent" : `skipped:${errorCode(err)}`, currentKey: false };
  }
  const input: PinnedEditInput = { name: path.basename(rel), agentId, machineKey: options.machineKey ?? null, nonce: randomBytes(6).toString("hex") };
  options.beforePin?.(expectedDir);
  const pin = options.pin === undefined ? defaultPinMode() : options.pin;
  if (pin === "proc-fd") return editWithProcFd(expectedDir, input, options);
  if (pin === "child-cwd") return editWithChild(expectedDir, input);
  return { action: "skipped:no-pinned-editor", currentKey: false };
}

/**
 * Migrate the three legacy artifacts of one agent workspace. Never throws.
 * `agentId` is the expected `--agent-id` binding; for daemon-managed
 * workspaces it is the workspace directory name.
 */
export function migrateLegacyBridgeArtifacts(
  workspacePath: string,
  agentId: string,
  options: LegacyBridgeArtifactOptions = {},
): LegacyBridgeArtifactResult[] {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(workspacePath));
  } catch {
    return LEGACY_BRIDGE_ARTIFACT_FILES.map((file) => ({ file, action: "absent" as const, currentKey: false }));
  }
  const results: LegacyBridgeArtifactResult[] = [];
  for (const rel of LEGACY_BRIDGE_ARTIFACT_FILES) {
    let outcome: PinnedEditResult;
    try {
      outcome = migrateOne(rootReal, rel, agentId, options);
    } catch (err) {
      outcome = { action: `skipped:${errorCode(err)}`, currentKey: false };
    }
    const action = outcome.action as LegacyBridgeArtifactAction;
    results.push({ file: rel, action, currentKey: outcome.currentKey });
    if (action !== "absent" && action !== "unchanged") {
      logger.info(`[LegacyBridge] agent ${agentId} ${rel}: ${action}${outcome.currentKey ? " (held this machine's current key)" : ""}`);
    }
  }
  return results;
}

/**
 * One-shot daemon-start pass over `<agentsRoot>/<agentId>/`. Directory names
 * are the agent ids. Symlinked workspace directories and the daemon's own
 * directories are skipped. Never throws.
 */
export function migrateAllLegacyBridgeArtifacts(agentsRoot: string, options: LegacyBridgeArtifactOptions = {}): LegacyBridgeArtifactBatchSummary {
  const summary: LegacyBridgeArtifactBatchSummary = { scanned: 0, removedEntries: 0, unlinked: 0, skipped: 0, currentKeyExposed: 0 };
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsRoot);
  } catch {
    return summary;
  }
  for (const entry of entries) {
    if (DAEMON_DIR_NAMES.has(entry)) continue;
    const workspace = path.join(agentsRoot, entry);
    try {
      const stat = fs.lstatSync(workspace);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    } catch {
      continue;
    }
    summary.scanned++;
    for (const { action, currentKey } of migrateLegacyBridgeArtifacts(workspace, entry, options)) {
      if (action === "removed-entry") summary.removedEntries++;
      else if (action === "unlinked") summary.unlinked++;
      else if (action.startsWith("skipped:")) summary.skipped++;
      if (currentKey) summary.currentKeyExposed++;
    }
  }
  return summary;
}
