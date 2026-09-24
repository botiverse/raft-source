import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "./types.js";
import { buildCliSystemPrompt, type SystemPromptOptions } from "./systemPrompt.js";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { SLOCK_HOME_ENV, resolveRaftHome } from "../raftHome.js";
import { registerAgentCredentialProxy } from "../agentCredentialProxy.js";
import { LOOPBACK_NO_PROXY, applyLoopbackNoProxyEnv } from "../loopbackNoProxy.js";
import { detectNodeHostKind, resolveNodeHostLaunch, type NodeHostKind } from "./nodeHostLaunch.js";

const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const powershellSingleQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const DEFAULT_ACTIVE_CAPABILITIES = "send,read,mentions,tasks,reactions,server,channels,knowledge";
const CLI_TRANSPORT_TRACE_DIR_ENV = "SLOCK_CLI_TRANSPORT_TRACE_DIR";
const safePathPart = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");
const RAW_CREDENTIAL_ENV_DENYLIST = [
  "SLOCK_AGENT_CREDENTIAL_KEY",
] as const;
const EXTERNAL_PROFILE_ENV_DENYLIST = [
  "RAFT_PROFILE",
  "SLOCK_PROFILE",
  "RAFT_PROFILE_DIR",
  "SLOCK_PROFILE_DIR",
] as const;
const WORKSPACE_CLI_TRANSPORT_FILENAMES = [
  "agent-token",
  "slock",
  "slock.cmd",
  "slock.ps1",
  "raft",
  "raft.cmd",
  "raft.ps1",
  "opencli",
  "opencli.cmd",
] as const;

// Selector env var used by the per-launch forwarding guard embedded in every
// daemon-generated slock/raft wrapper. A Kimi SDK Bash tool passes its own
// current launch directory basename here; if a legacy absolute wrapper from a
// previous launch is invoked, the guard forwards to the current launch's wrapper
// before any stale credential/proxy env is read. The value is non-secret (it is
// a directory basename) and is scoped per agent, so a foreign-agent or traversal
// selector is rejected.
export const SLOCK_AGENT_LAUNCH_DIR_ENV = "SLOCK_AGENT_LAUNCH_DIR";
export const SLOCK_CLI_TRANSPORT_DIR_ENV = "SLOCK_CLI_TRANSPORT_DIR";
const DAEMON_GENERATED_MARKER = "slock-daemon-generated";
const AGENT_CLI_TRANSPORT_WRAPPER_NAMES = [
  "slock",
  "slock.cmd",
  "slock.ps1",
  "raft",
  "raft.cmd",
  "raft.ps1",
] as const;

function buildPosixLaunchForwardingGuard(ownSlockDir: string): string {
  // The selector passed via SLOCK_AGENT_LAUNCH_DIR is a single launch-directory
  // basename (e.g. "pid-12345" or a launch UUID). The wrapper bakes its own
  // agent root and launch part so it can only forward to a sibling launch dir
  // under the same agent. Selectors that are empty, ".", "..", or contain "/"
  // or "\\" are rejected to prevent traversal out of the agent root. The target
  // launch directory must itself be a real directory (not a symlink/junction)
  // and the wrapper inside it must be a regular file, so a symlink parent cannot
  // route execution into a foreign agent tree.
  const agentRoot = path.dirname(ownSlockDir);
  const ownLaunchPart = path.basename(ownSlockDir);
  return [
    `# ${DAEMON_GENERATED_MARKER}`,
    `SLOCK_AGENT_ROOT=${shellSingleQuote(agentRoot)}`,
    `SLOCK_OWN_LAUNCH_DIR=${shellSingleQuote(ownLaunchPart)}`,
    'if [ -n "${SLOCK_AGENT_LAUNCH_DIR:-}" ] && [ "$SLOCK_AGENT_LAUNCH_DIR" != "$SLOCK_OWN_LAUNCH_DIR" ]; then',
    '  if [ "$SLOCK_AGENT_LAUNCH_DIR" != "." ] && [ "$SLOCK_AGENT_LAUNCH_DIR" != ".." ] && [[ ! "$SLOCK_AGENT_LAUNCH_DIR" =~ [/\\] ]]; then',
    '    SLOCK_FORWARD_DIR="$SLOCK_AGENT_ROOT/$SLOCK_AGENT_LAUNCH_DIR"',
    '    if [ -d "$SLOCK_FORWARD_DIR" ] && [ ! -L "$SLOCK_FORWARD_DIR" ]; then',
    '      SLOCK_FORWARD_WRAPPER="$SLOCK_FORWARD_DIR/$(basename "$0")"',
    '      if [ -f "$SLOCK_FORWARD_WRAPPER" ] && [ ! -L "$SLOCK_FORWARD_WRAPPER" ]; then',
    '        exec "$SLOCK_FORWARD_WRAPPER" "$@"',
    '      fi',
    '    fi',
    '  fi',
    'fi',
  ].join("\n");
}

function buildCmdLaunchForwardingGuard(ownSlockDir: string): string {
  // The selector is a single launch-directory basename. The wrapper bakes its
  // own agent root and launch part so it can only forward to a sibling launch
  // dir under the same agent. Reject empty, ".", "..", or any selector
  // containing "/" or "\\". The forward call and exit must stay inside the
  // same setlocal/delayed-expansion scope so the resolved wrapper path and the
  // called command's exit code are not lost across `endlocal`.
  const agentRoot = path.dirname(ownSlockDir);
  const ownLaunchPart = path.basename(ownSlockDir);
  return [
    "@REM slock-daemon-generated",
    "setlocal enabledelayedexpansion",
    `set "SLOCK_AGENT_ROOT=${agentRoot}"`,
    `set "SLOCK_OWN_LAUNCH_DIR=${ownLaunchPart}"`,
    "if defined SLOCK_AGENT_LAUNCH_DIR (",
    '  if /I not "!SLOCK_AGENT_LAUNCH_DIR!"=="!SLOCK_OWN_LAUNCH_DIR!" (',
    '    set "SLOCK_SEL=!SLOCK_AGENT_LAUNCH_DIR!"',
    '    set "SLOCK_INVALID="',
    '    if "!SLOCK_SEL!"=="" set SLOCK_INVALID=1',
    '    if "!SLOCK_SEL!"=="." set SLOCK_INVALID=1',
    '    if "!SLOCK_SEL!"==".." set SLOCK_INVALID=1',
    '    if not "!SLOCK_SEL:/=!"=="!SLOCK_SEL!" set SLOCK_INVALID=1',
    '    if not "!SLOCK_SEL:\\=!"=="!SLOCK_SEL!" set SLOCK_INVALID=1',
    '    if not defined SLOCK_INVALID (',
    '      set "SLOCK_FORWARD_DIR=!SLOCK_AGENT_ROOT!\\!SLOCK_SEL!"',
    '      if exist "!SLOCK_FORWARD_DIR!\\" (',
    '        fsutil reparsepoint query "!SLOCK_FORWARD_DIR!" >nul 2>&1',
    '        if errorlevel 1 (',
    '          set "SLOCK_FORWARD_WRAPPER=!SLOCK_FORWARD_DIR!\\%~nx0"',
    '          if exist "!SLOCK_FORWARD_WRAPPER!" if not exist "!SLOCK_FORWARD_WRAPPER!\\" (',
    '            call "!SLOCK_FORWARD_WRAPPER!" %*',
    '            exit /b !errorlevel!',
    '          )',
    '        )',
    '      )',
    '    )',
    '  )',
    ')',
    'endlocal',
  ].join("\r\n");
}

function buildPs1LaunchForwardingGuard(ownSlockDir: string): string {
  // The selector is a single launch-directory basename. The wrapper bakes its
  // own agent root and launch part so it can only forward to a sibling launch
  // dir under the same agent. Reject empty, ".", "..", or any selector
  // containing "/" or "\\". The selected launch directory must be a real
  // directory (not a symlink/junction) and the wrapper inside it must not be a
  // link, so a symlink parent cannot route execution into a foreign agent tree.
  const agentRoot = path.dirname(ownSlockDir);
  const ownLaunchPart = path.basename(ownSlockDir);
  return [
    `# ${DAEMON_GENERATED_MARKER}`,
    `$SlockAgentRoot = ${powershellSingleQuote(agentRoot)}`,
    `$SlockOwnLaunchDir = ${powershellSingleQuote(ownLaunchPart)}`,
    '$SlockLaunchDir = $env:SLOCK_AGENT_LAUNCH_DIR',
    'if ($SlockLaunchDir -and ($SlockLaunchDir -ne $SlockOwnLaunchDir)) {',
    '    $invalid = ($SlockLaunchDir -in "", ".", "..") -or ($SlockLaunchDir -match "[/\\\\]")',
    '    if (-not $invalid) {',
    '        $ForwardDir = Join-Path $SlockAgentRoot $SlockLaunchDir',
    '        $dirItem = Get-Item $ForwardDir -ErrorAction SilentlyContinue',
    '        if ($dirItem -and $dirItem.PSIsContainer -and (-not $dirItem.LinkType)) {',
    '            $ForwardTarget = Join-Path $ForwardDir (Split-Path -Leaf $PSCommandPath)',
    '            $item = Get-Item $ForwardTarget -ErrorAction SilentlyContinue',
    '            if ($item -and ($item.PSIsContainer -eq $false) -and (-not $item.LinkType)) {',
    '                & $ForwardTarget @args',
    '                exit $LASTEXITCODE',
    '            }',
    '        }',
    '    }',
    '}',
  ].join("\r\n");
}

function isDaemonGeneratedWrapper(filePath: string): boolean {
  try {
    const body = readFileSync(filePath, "utf8");
    // Marker present on wrappers generated after this change.
    if (body.includes(DAEMON_GENERATED_MARKER)) return true;
    // Pre-change wrappers carry the daemon's per-agent identity assignment and
    // the server URL. This shape is common across POSIX / .cmd / .ps1 wrappers
    // and is the only shape we are allowed to upgrade.
    return body.includes("SLOCK_AGENT_ID=") && body.includes("SLOCK_SERVER_URL=");
  } catch {
    return false;
  }
}

function upgradeWrapperWithLaunchGuard(filePath: string, platform: NodeJS.Platform): boolean {
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  if (body.includes(DAEMON_GENERATED_MARKER)) return false;
  if (!isDaemonGeneratedWrapper(filePath)) return false;

  const ownSlockDir = path.dirname(filePath);
  let newBody: string;
  if (filePath.endsWith(".cmd")) {
    const guard = buildCmdLaunchForwardingGuard(ownSlockDir);
    const firstNewline = body.indexOf("\r\n");
    if (firstNewline !== -1 && body.slice(0, firstNewline).trim().toLowerCase() === "@echo off") {
      newBody = "@echo off\r\n" + guard + "\r\n" + body.slice(firstNewline + 2);
    } else {
      newBody = guard + "\r\n" + body;
    }
  } else if (filePath.endsWith(".ps1")) {
    newBody = buildPs1LaunchForwardingGuard(ownSlockDir) + "\r\n" + body;
  } else {
    const guard = buildPosixLaunchForwardingGuard(ownSlockDir);
    const firstNewline = body.indexOf("\n");
    if (firstNewline !== -1 && body.slice(0, firstNewline).startsWith("#!")) {
      newBody = body.slice(0, firstNewline) + "\n" + guard + "\n" + body.slice(firstNewline + 1);
    } else {
      newBody = guard + "\n" + body;
    }
  }

  const tmpPath = `${filePath}.guard-upgrade.tmp`;
  const mode = statSync(filePath).mode;
  writeFileSync(tmpPath, newBody, { mode });
  renameSync(tmpPath, filePath);
  return true;
}

export function upgradeExistingAgentWrappers(
  agentRoot: string,
  currentSlockDir: string,
  platform: NodeJS.Platform = process.platform,
): { scanned: number; upgraded: number } {
  let scanned = 0;
  let upgraded = 0;
  let entries: string[];
  try {
    entries = readdirSync(agentRoot);
  } catch {
    return { scanned, upgraded };
  }
  for (const entry of entries) {
    const launchDir = path.join(agentRoot, entry);
    if (launchDir === currentSlockDir) continue;
    let launchDirStats;
    try {
      launchDirStats = lstatSync(launchDir);
    } catch {
      continue;
    }
    if (!launchDirStats.isDirectory() || launchDirStats.isSymbolicLink()) continue;
    let launchEntries: string[];
    try {
      launchEntries = readdirSync(launchDir);
    } catch {
      continue;
    }
    for (const name of AGENT_CLI_TRANSPORT_WRAPPER_NAMES) {
      const filePath = path.join(launchDir, name);
      if (!launchEntries.includes(name)) continue;
      let stats;
      try {
        stats = lstatSync(filePath);
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      scanned++;
      if (upgradeWrapperWithLaunchGuard(filePath, platform)) upgraded++;
    }
  }
  return { scanned, upgraded };
}

// A daemon launched from a package tree that later mutates under it (e.g. the
// @botiverse/raft-computer -> @botiverse/raft-daemon migration deleting the nested
// node_modules the daemon was started from) keeps running from memory but its
// baked-in CLI path points at deleted files, so every wrapper it writes is
// broken (field samples: Huarong/Cody/Stone, #proj-aiax 2026-06-12). Derive
// top-level global-install candidates from the broken path's FIRST
// node_modules segment so both the spawn-time re-resolution and the wrapper's
// exec-time fallback can recover without a daemon restart.
export function deriveCliFallbackCandidates(cliPath: string): string[] {
  if (!cliPath || cliPath === "__cli") return [];
  const normalized = cliPath.split(path.sep).join("/");
  const marker = "/node_modules/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return [];
  const globalRoot = cliPath.slice(0, idx + marker.length - 1);
  const tail = path.join("dist", "cli", "index.js");
  return [
    path.join(globalRoot, "@botiverse", "raft-daemon", tail),
    path.join(globalRoot, "@slock-ai", "daemon", tail),
  ].filter((candidate) => candidate !== cliPath);
}

// Same recovery shape for the opencli wrapper: re-root the broken nested
// path's in-package suffix at the global node_modules top level. XX's SEA
// migration sample (#wg-raft-computer 2026-06-13) broke 25 opencli wrappers
// this way — @botiverse/raft-computer's nested node_modules vanished while the
// top-level @jackwener/opencli install stayed valid.
export function deriveOpencliFallbackCandidates(binPath: string): string[] {
  if (!binPath) return [];
  const normalized = binPath.split(path.sep).join("/");
  const marker = "/node_modules/";
  const first = normalized.indexOf(marker);
  if (first === -1) return [];
  const pkgMarker = "/node_modules/@jackwener/opencli/";
  const last = normalized.lastIndexOf(pkgMarker);
  if (last === -1) return [];
  const suffix = normalized.slice(last + pkgMarker.length);
  const candidate = path.join(binPath.slice(0, first + marker.length - 1), "@jackwener", "opencli", ...suffix.split("/"));
  return candidate === binPath ? [] : [candidate];
}

// Resolve the @jackwener/opencli bin entry once per daemon process. The
// package is a daemon dependency (`packages/daemon/package.json`), so it is
// present in the daemon's own node_modules at startup; we don't need to
// re-resolve per-spawn. Returns null if resolution fails (older daemon
// builds without the dep, broken install) so the spawn can still proceed
// without opencli on PATH.
let cachedOpencliBinPath: string | null | undefined;
function resolveOpencliBinPath(): string | null {
  if (cachedOpencliBinPath !== undefined) return cachedOpencliBinPath;
  try {
    const require = createRequire(import.meta.url);
    // The package's `exports` block restricts `./package.json`, so resolve
    // the main entry and walk up to find package.json.
    const mainPath = require.resolve("@jackwener/opencli");
    let dir = path.dirname(mainPath);
    const root = path.parse(dir).root;
    while (dir && dir !== root) {
      const candidate = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          bin?: string | Record<string, string>;
        };
        if (pkg.name === "@jackwener/opencli") {
          const binEntry =
            typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencli;
          if (!binEntry) {
            cachedOpencliBinPath = null;
            return null;
          }
          cachedOpencliBinPath = path.resolve(dir, binEntry);
          return cachedOpencliBinPath;
        }
      } catch {
        // keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cachedOpencliBinPath = null;
    return null;
  } catch {
    cachedOpencliBinPath = null;
    return null;
  }
}

function buildCliTransportDir(slockHome: string, agentId: string, launchId?: string | null): string {
  return path.join(slockHome, "cli-transport", safePathPart(agentId), buildCliTransportLaunchPart(launchId));
}

function buildCliTransportLaunchPart(launchId?: string | null): string {
  return safePathPart(launchId || `pid-${process.pid}`);
}

function cleanupWorkspaceCliTransportFiles(workingDirectory: string): void {
  const legacySlockDir = path.join(workingDirectory, ".slock");
  for (const filename of WORKSPACE_CLI_TRANSPORT_FILENAMES) {
    rmSync(path.join(legacySlockDir, filename), { force: true });
  }
}

/**
 * Write the credential-free `opencli` wrapper(s) into `slockDir`, pointing at
 * the daemon-resolved opencli main script with the same exec-time self-heal the
 * slock/raft wrapper uses (re-root a nested computer-tree path to the top-level
 * install when the cached path vanished under the running daemon). Shared by
 * `prepareCliTransport` (per spawn) and `regenerateExistingOpencliWrappers`
 * (daemon-startup batch). The opencli wrapper carries no credentials, so it is
 * safe to (re)write blindly — unlike the slock wrapper.
 */
export function writeOpencliWrapper(
  slockDir: string,
  opencliBinPath: string,
  platform: NodeJS.Platform = process.platform,
  // When the daemon host process IS the Electron binary (packaged Computer
  // app), the wrappers exec `process.execPath` = that Electron binary. Without
  // ELECTRON_RUN_AS_NODE=1, Electron boots its GUI app lifecycle (the
  // NSApplication run loop) instead of running as plain Node, so the
  // short-lived CLI process finishes its command logic but its main thread
  // parks in the Cocoa run loop and never exits — every `raft`/opencli helper
  // hangs and the managed agent turn silently stalls (task #402). Plain Node
  // ignores this env var, so non-Electron hosts are unaffected.
  execIsElectron: boolean = Boolean(process.versions.electron),
  // Test seam — the PROBE, not a derived host kind. Injecting the conclusion
  // stops at this function's local variable: delete the guard and the resolver
  // re-probes the real host, so the injected SEA disappears together with the
  // guard and the regression cannot reproduce. Injecting the probe keeps
  // caller and resolver observing the same host, which is what production does.
  seaProbe?: () => boolean | undefined,
): void {
  // Writing a wrapper is not the same as needing a Node host to execute a JS
  // entry. On a SEA the Computer re-execs itself in CLI mode (the `__cli`
  // sentinel below), so "no separate node" is a supported shape here, not a
  // failure — resolveNodeHostLaunch would throw and cut that path off before
  // it is reached. Ask what the host is, and only ask for a Node host when
  // this host is one.
  const hostKind = detectNodeHostKind({ execIsElectron, seaProbe });
  // `unknown` is decided explicitly rather than inheriting either neighbour:
  // an unrecognised host gets the plain execPath the wrapper always used, and
  // notably NOT the Electron flag, which would be a guess about a host we
  // could not identify.
  const nodeHost = hostKind === "electron" || hostKind === "node"
    ? resolveNodeHostLaunch({ env: process.env, execIsElectron, seaProbe })
    : { command: process.execPath, env: process.env };
  const electronNodeMode = execIsElectron && nodeHost.env.ELECTRON_RUN_AS_NODE === "1";
  const fallbacks = deriveOpencliFallbackCandidates(opencliBinPath);
  // If the resolved path is already gone, bake the best existing fallback as
  // the primary so the wrapper works even before the exec-time block runs.
  let binPath = opencliBinPath;
  if (!existsSync(binPath)) {
    const fallback = fallbacks.find((candidate) => existsSync(candidate));
    if (fallback) binPath = fallback;
  }
  const posixFallbackBlock = fallbacks.length === 0
    ? ""
    : `if [ ! -e "$OPENCLI_BIN" ]; then\n${fallbacks.map((candidate, i) =>
      `  ${i === 0 ? "if" : "elif"} [ -e ${shellSingleQuote(candidate)} ]; then OPENCLI_BIN=${shellSingleQuote(candidate)};`).join("\n")}\n  fi\nfi\n`;
  writeFileSync(
    path.join(slockDir, "opencli"),
    `#!/usr/bin/env bash\nOPENCLI_BIN=${shellSingleQuote(binPath)}\n${posixFallbackBlock}${electronNodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}exec ${shellSingleQuote(nodeHost.command)} "$OPENCLI_BIN" "$@"\n`,
    { mode: 0o755 },
  );
  if (platform === "win32") {
    const opencliCmdBody = [
      "@echo off",
      "set PYTHONIOENCODING=utf-8",
      "set PYTHONUTF8=1",
      "set LANG=C.UTF-8",
      "set LC_ALL=C.UTF-8",
      "chcp 65001 >NUL 2>NUL",
      `set "OPENCLI_BIN=${binPath}"`,
      ...fallbacks.map((candidate) => `if not exist "%OPENCLI_BIN%" set "OPENCLI_BIN=${candidate}"`),
      ...(electronNodeMode ? [`set "ELECTRON_RUN_AS_NODE=1"`] : []),
      `"${nodeHost.command}" "%OPENCLI_BIN%" %*`,
      "",
    ].join("\r\n") + "\r\n";
    writeFileSync(path.join(slockDir, "opencli.cmd"), opencliCmdBody);
  }
}

/**
 * Daemon-startup batch pass: rewrite EXISTING `opencli` wrappers under
 * `<agentsRoot>/<agentId>/.slock/` to the current self-healing form.
 *
 * Per-spawn regeneration (`prepareCliTransport`) only refreshes an agent's
 * wrapper when that agent next launches. A long-running agent whose wrapper was
 * generated before a package-tree mutation (e.g. the npm→SEA computer switch
 * that moved `@botiverse/raft-computer/node_modules/@jackwener/opencli` out from under
 * the hardcoded path) therefore keeps a stale, non-self-healing wrapper until it
 * respawns — the exact #wg-raft-computer 2026-06-13 incident (25 broken opencli
 * wrappers). Running this once on daemon start (which a SEA switch triggers via
 * the daemon restart) brings every existing wrapper current without a respawn.
 *
 * Only rewrites wrappers that already exist (never creates one for a runtime
 * that doesn't use opencli). Failures are tolerated — this is robustness, not a
 * gate on daemon liveness.
 */
export function regenerateExistingOpencliWrappers(
  agentsRoot: string,
  platform: NodeJS.Platform = process.platform,
  // Injectable for tests; production resolves the daemon's opencli once.
  opencliBinPath: string | null = resolveOpencliBinPath(),
): { scanned: number; rewritten: number } {
  if (!opencliBinPath) return { scanned: 0, rewritten: 0 };
  let entries: string[];
  try {
    entries = readdirSync(agentsRoot);
  } catch {
    return { scanned: 0, rewritten: 0 };
  }
  let scanned = 0;
  let rewritten = 0;
  for (const entry of entries) {
    const slockDir = path.join(agentsRoot, entry, ".slock");
    if (!existsSync(path.join(slockDir, "opencli"))) continue;
    scanned++;
    try {
      writeOpencliWrapper(slockDir, opencliBinPath, platform);
      rewritten++;
    } catch {
      /* tolerate a single bad workspace */
    }
  }
  return { scanned, rewritten };
}

function windowsUtf8Env(): Record<string, string> {
  // Windows terminals commonly default to a legacy code page such as GBK.
  // Force UTF-8 for runtimes and their nested slock CLI sends so message bytes
  // written back to the server do not become mojibake.
  return {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

function posixLoopbackNoProxyPrelude(): string {
  return [
    `SLOCK_LOOPBACK_NO_PROXY=${shellSingleQuote(LOOPBACK_NO_PROXY)}`,
    `SLOCK_EXISTING_NO_PROXY="\${NO_PROXY:-}"`,
    `if [ -n "\${no_proxy:-}" ]; then SLOCK_EXISTING_NO_PROXY="\${SLOCK_EXISTING_NO_PROXY:+$SLOCK_EXISTING_NO_PROXY,}$no_proxy"; fi`,
    `NO_PROXY="\${SLOCK_LOOPBACK_NO_PROXY}\${SLOCK_EXISTING_NO_PROXY:+,$SLOCK_EXISTING_NO_PROXY}"`,
    `no_proxy="$NO_PROXY"`,
    "export NO_PROXY no_proxy",
  ].join("\n");
}

function cmdLoopbackNoProxyLines(): string[] {
  return [
    `set "SLOCK_LOOPBACK_NO_PROXY=${LOOPBACK_NO_PROXY}"`,
    `set "SLOCK_EXISTING_NO_PROXY=%NO_PROXY%"`,
    `if defined no_proxy (if defined SLOCK_EXISTING_NO_PROXY (set "SLOCK_EXISTING_NO_PROXY=%SLOCK_EXISTING_NO_PROXY%,%no_proxy%") else set "SLOCK_EXISTING_NO_PROXY=%no_proxy%")`,
    `if defined SLOCK_EXISTING_NO_PROXY (set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%,%SLOCK_EXISTING_NO_PROXY%") else set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%"`,
    `set "no_proxy=%NO_PROXY%"`,
  ];
}

function powershellLoopbackNoProxyLines(): string[] {
  return [
    `$loopbackNoProxy = ${powershellSingleQuote(LOOPBACK_NO_PROXY)}`,
    "$existingNoProxy = @($env:NO_PROXY, $env:no_proxy) | Where-Object { $_ }",
    "if ($existingNoProxy.Count -gt 0) { $mergedNoProxy = \"$loopbackNoProxy,$($existingNoProxy -join ',')\" } else { $mergedNoProxy = $loopbackNoProxy }",
    "$env:NO_PROXY = $mergedNoProxy",
    "$env:no_proxy = $mergedNoProxy",
  ];
}

function runtimeContextEnv(config: AgentConfig): Record<string, string> {
  const ctx = config.runtimeContext;
  if (!ctx) return {};
  return {
    ...(ctx.agentId ? { SLOCK_CURRENT_AGENT_ID: ctx.agentId } : {}),
    ...(ctx.serverId ? { SLOCK_CURRENT_SERVER_ID: ctx.serverId } : {}),
    ...(ctx.machineId ? { RAFT_CURRENT_COMPUTER_ID: ctx.machineId } : {}),
    ...(ctx.machineName ? { RAFT_CURRENT_COMPUTER_NAME: ctx.machineName } : {}),
    ...(ctx.machineHostname ? { RAFT_CURRENT_COMPUTER_HOSTNAME: ctx.machineHostname } : {}),
    ...(ctx.machineOs ? { RAFT_CURRENT_COMPUTER_OS: ctx.machineOs } : {}),
    ...(ctx.daemonVersion ? { SLOCK_CURRENT_DAEMON_VERSION: ctx.daemonVersion } : {}),
    ...(ctx.workspacePath ? { SLOCK_CURRENT_WORKSPACE_PATH: ctx.workspacePath } : {}),
  };
}

export function buildCliTransportSystemPrompt(
  config: AgentConfig,
  opts: SystemPromptOptions,
): AxSurfaceText {
  return buildCliSystemPrompt(config, opts);
}

export async function prepareCliTransport(
  ctx: SpawnContext,
  extraEnv: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = process.platform,
  // See writeOpencliWrapper: when the daemon host is the Electron binary
  // (packaged Computer), the generated `raft`/`slock` wrappers must run the CLI
  // as Node, not boot the Electron GUI app — otherwise the CLI helper hangs in
  // the NSApplication run loop and the managed turn stalls (task #402).
  execIsElectron: boolean = Boolean(process.versions.electron),
  // Test seam, mirroring writeOpencliWrapper: the probe, not a host kind.
  seaProbe?: () => boolean | undefined,
): Promise<{
  slockDir: string;
  tokenFile: string;
  /**
   * Local proxy URL for the daemon-held sk_agent_* credential, or null when
   * the daemon has not been provisioned with one (legacy sk_machine_* path).
   * The spawned runtime env and daemon-owned wrapper never receive the
   * proxy token value; the wrapper points the short-lived CLI process at a
   * daemon-owned 0600 token file outside the workspace.
   */
  agentCredentialProxyUrl: string | null;
  wrapperPath: string;
  spawnEnv: NodeJS.ProcessEnv;
  slockHome: string;
}> {
  // Same reasoning as the wrapper writer above: a SEA reaches its own `__cli`
  // path a few lines down, so it must not be stopped here for lacking a
  // separate Node host.
  const hostKind = detectNodeHostKind({ execIsElectron, seaProbe });
  const nodeHost = hostKind === "electron" || hostKind === "node"
    ? resolveNodeHostLaunch({ env: process.env, execIsElectron, seaProbe })
    : { command: process.execPath, env: process.env };
  const electronNodeMode = execIsElectron && nodeHost.env.ELECTRON_RUN_AS_NODE === "1";
  // slockCliPath is the path to the bundled `slock` CLI script, OR the literal
  // `__cli` sentinel for a SEA single-binary Computer (the daemon re-execs
  // itself in CLI mode — see runBundledRaftCli). Either way it must be present.
  if (!ctx.slockCliPath) {
    throw new Error(`${ctx.config.runtime} driver: slockCliPath is required (daemon must inject it)`);
  }

  // Re-validate the baked CLI path at every spawn: a zombie daemon whose
  // package tree mutated underneath it would otherwise keep writing wrappers
  // that point at deleted files. Fall back to a top-level global install of
  // the daemon CLI when one exists, and say so loudly — the real fix is
  // restarting the daemon from the new package.
  let cliPath = ctx.slockCliPath;
  const cliFallbackCandidates = deriveCliFallbackCandidates(cliPath);
  if (cliPath !== "__cli" && !existsSync(cliPath)) {
    const fallback = cliFallbackCandidates.find((candidate) => existsSync(candidate));
    if (fallback) {
      console.error(
        `[cliTransport] bundled CLI missing at ${cliPath} (package tree mutated under a running daemon?); ` +
        `using ${fallback}. Restart the daemon from its current install to clear this.`,
      );
      cliPath = fallback;
    } else {
      console.error(
        `[cliTransport] bundled CLI missing at ${cliPath} and no global fallback found; ` +
        `wrappers will be broken until the daemon is restarted from a valid install.`,
      );
    }
  }

  const slockHome = ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome();

  // Transport bootstrap, shared by every CLI-swapped runtime:
  // 1. Keep the auth token out of child-process args / env by writing it to a
  //    daemon-owned file outside the model workspace.
  // 2. Write a local `slock` wrapper that execs the bundled monorepo CLI via
  //    an absolute path, so agent behavior does not depend on a host-global
  //    `slock` install or PATH ordering.
  // 3. Prepend that wrapper directory to PATH for the spawned runtime.
  cleanupWorkspaceCliTransportFiles(ctx.workingDirectory);
  const slockDir = buildCliTransportDir(slockHome, ctx.agentId, ctx.launchId);
  mkdirSync(slockDir, { recursive: true });

  const tokenFile = path.join(slockDir, "agent-token");

  // `rfcs/034-slock-credential-rfc.zh.html#section-credential-isolation` —
  // server session worker runner credential wiring.
  //
  // When the server attaches an `sk_agent_*` credential to AgentConfig
  // (minted by the Computer per Computer RFC §5.1 / step 3d), keep the bearer
  // in the daemon process and expose only a localhost proxy affordance to the
  // `slock` wrapper. The spawned runtime env and model workspace never receive
  // the raw key, the proxy token value, or a readable key-file pointer. Legacy
  // `agent-token` is reserved for old daemon / legacy-machine launches, not
  // for managed-runner mint failure fallback.
  const agentCredentialKey = ctx.config.agentCredentialKey;
  let agentCredentialProxy: { proxyUrl: string; proxyToken: string } | null = null;
  let agentCredentialProxyTokenFile: string | null = null;
  if (typeof agentCredentialKey === "string" && agentCredentialKey.length > 0) {
    // A workspace may have a legacy token from a previous daemon version or a
    // prior legacy-machine launch. A successful managed-runner launch must not
    // leave that machine bearer readable to the runtime/tool shell.
    rmSync(tokenFile, { force: true });
    agentCredentialProxy = await registerAgentCredentialProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      serverUrl: ctx.config.serverUrl,
      apiKey: agentCredentialKey,
      activeCapabilities: DEFAULT_ACTIVE_CAPABILITIES,
      inboxCoordinator: ctx.agentCredentialProxyInboxCoordinator,
      appInbox: ctx.agentAppInbox,
      tracer: ctx.tracer,
      daemonVersion: ctx.daemonVersion,
      computerVersion: ctx.computerVersion,
    });
    const launchPart = buildCliTransportLaunchPart(ctx.launchId);
    const proxyTokenDir = path.join(slockHome, "agent-proxy-tokens", safePathPart(ctx.agentId));
    mkdirSync(proxyTokenDir, { recursive: true, mode: 0o700 });
    agentCredentialProxyTokenFile = path.join(proxyTokenDir, `${launchPart}.token`);
    writeFileSync(agentCredentialProxyTokenFile, agentCredentialProxy.proxyToken, { mode: 0o600 });
  } else {
    writeFileSync(tokenFile, ctx.config.authToken || ctx.daemonApiKey, { mode: 0o600 });
  }

  // Write wrappers so `raft ...` (canonical) and `slock ...` (legacy alias)
  // both resolve in the spawned runtime's native command environment. Always
  // write the POSIX wrappers (Git Bash on Windows prefers the extensionless
  // file); on win32, also write .cmd so native cmd.exe / PowerShell resolve
  // them via PATHEXT. Both names exec the same bundled CLI.
  const posixWrapper = path.join(slockDir, "slock");
  const posixRaftWrapper = path.join(slockDir, "raft");
  // Wrapper must be self-sufficient — a child-process driver inherits these
  // from `spawnEnv` automatically, but an in-process SDK driver (kimi-sdk,
  // pi) executes the wrapper from a bash tool whose env is `process.env` of
  // the daemon, NOT spawnEnv. The daemon process doesn't have agent-specific
  // identity vars (those are per-spawn), so the wrapper script itself has
  // to inline-export them. Reported by @Xinran on Kimi SDK first-launch
  // setup (#proj-runtime:6eaa9ce1) — `MISSING_AGENT_ID` / `MISSING_SERVER_URL`
  // until the agent manually re-exported these.
  //
  // Identity-side vars (always required):
  //   SLOCK_AGENT_ID   — which agent the CLI should act as
  //   SLOCK_SERVER_URL — which server the CLI should reach
  // Credential vars (one of two paths, mutually exclusive):
  //   proxy path     → SLOCK_AGENT_PROXY_URL + SLOCK_AGENT_PROXY_TOKEN_FILE
  //                    + SLOCK_AGENT_ACTIVE_CAPABILITIES
  //   non-proxy path → SLOCK_AGENT_TOKEN_FILE (legacy daemon-token fallback)
  // We never inline raw token *contents* — only the path to the token file
  // (file mode 0o600, written elsewhere). Same secret surface as before.
  const posixIdentityPrefix = `SLOCK_AGENT_ID=${shellSingleQuote(ctx.agentId)} SLOCK_SERVER_URL=${shellSingleQuote(ctx.config.serverUrl)} `;
  const posixCredentialPrefix = posixIdentityPrefix + (agentCredentialProxy
    ? `SLOCK_AGENT_PROXY_URL=${shellSingleQuote(agentCredentialProxy.proxyUrl)} SLOCK_AGENT_PROXY_TOKEN_FILE=${shellSingleQuote(agentCredentialProxyTokenFile!)} SLOCK_AGENT_ACTIVE_CAPABILITIES=${shellSingleQuote(DEFAULT_ACTIVE_CAPABILITIES)} `
    : `SLOCK_AGENT_TOKEN_FILE=${shellSingleQuote(tokenFile)} `);
  // Exec-time fallback mirrors the spawn-time one: the tree can mutate AFTER
  // the wrapper is written but before the agent's next command runs.
  const posixCliFallbackBlock = cliPath === "__cli" || cliFallbackCandidates.length === 0
    ? ""
    : `if [ ! -e "$SLOCK_CLI" ]; then\n${cliFallbackCandidates.map((candidate, i) =>
      `  ${i === 0 ? "if" : "elif"} [ -e ${shellSingleQuote(candidate)} ]; then SLOCK_CLI=${shellSingleQuote(candidate)};`).join("\n")}\n  fi\nfi\n`;
  const posixBody =
    `#!/usr/bin/env bash\n${buildPosixLaunchForwardingGuard(slockDir)}\nunset RAFT_PROFILE SLOCK_PROFILE RAFT_PROFILE_DIR SLOCK_PROFILE_DIR\n${posixLoopbackNoProxyPrelude()}\nSLOCK_CLI=${shellSingleQuote(cliPath)}\n${posixCliFallbackBlock}${electronNodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}${posixCredentialPrefix}exec ${shellSingleQuote(nodeHost.command)} "$SLOCK_CLI" "$@"\n`;
  writeFileSync(posixWrapper, posixBody, { mode: 0o755 });
  writeFileSync(posixRaftWrapper, posixBody, { mode: 0o755 });

  if (platform === "win32") {
    const cmdWrapper = path.join(slockDir, "slock.cmd");
    const cmdRaftWrapper = path.join(slockDir, "raft.cmd");
    const cmdIdentityLines =
      `set "SLOCK_AGENT_ID=${ctx.agentId}"\r\nset "SLOCK_SERVER_URL=${ctx.config.serverUrl}"\r\n`;
    const cmdCredentialLine = cmdIdentityLines + (agentCredentialProxy
      ? `set "SLOCK_AGENT_PROXY_URL=${agentCredentialProxy.proxyUrl}"\r\nset "SLOCK_AGENT_PROXY_TOKEN_FILE=${agentCredentialProxyTokenFile!}"\r\nset "SLOCK_AGENT_ACTIVE_CAPABILITIES=${DEFAULT_ACTIVE_CAPABILITIES}"\r\n`
      : `set "SLOCK_AGENT_TOKEN_FILE=${tokenFile}"\r\n`);
    const cmdCliFallbackLines = cliPath === "__cli"
      ? []
      : cliFallbackCandidates.map((candidate) =>
        `if not exist "%SLOCK_CLI%" set "SLOCK_CLI=${candidate}"`);
    const cmdBody = [
      "@echo off",
      buildCmdLaunchForwardingGuard(slockDir),
      "set PYTHONIOENCODING=utf-8",
      "set PYTHONUTF8=1",
      "set LANG=C.UTF-8",
      "set LC_ALL=C.UTF-8",
      "chcp 65001 >NUL 2>NUL",
      'set "RAFT_PROFILE="',
      'set "SLOCK_PROFILE="',
      'set "RAFT_PROFILE_DIR="',
      'set "SLOCK_PROFILE_DIR="',
      ...cmdLoopbackNoProxyLines(),
      cmdCredentialLine.trimEnd(),
      `set "SLOCK_CLI=${cliPath}"`,
      ...cmdCliFallbackLines,
      ...(electronNodeMode ? [`set "ELECTRON_RUN_AS_NODE=1"`] : []),
      `"${nodeHost.command}" "%SLOCK_CLI%" %*`,
      "",
    ].filter((line) => line.length > 0).join("\r\n") + "\r\n";
    writeFileSync(cmdWrapper, cmdBody);
    writeFileSync(cmdRaftWrapper, cmdBody);

    const psWrapper = path.join(slockDir, "slock.ps1");
    const psRaftWrapper = path.join(slockDir, "raft.ps1");
    const psIdentityLines = [
      `$env:SLOCK_AGENT_ID=${powershellSingleQuote(ctx.agentId)}`,
      `$env:SLOCK_SERVER_URL=${powershellSingleQuote(ctx.config.serverUrl)}`,
    ];
    const psCredentialLines = [
      ...psIdentityLines,
      ...(agentCredentialProxy
        ? [
          `$env:SLOCK_AGENT_PROXY_URL=${powershellSingleQuote(agentCredentialProxy.proxyUrl)}`,
          `$env:SLOCK_AGENT_PROXY_TOKEN_FILE=${powershellSingleQuote(agentCredentialProxyTokenFile!)}`,
          `$env:SLOCK_AGENT_ACTIVE_CAPABILITIES=${powershellSingleQuote(DEFAULT_ACTIVE_CAPABILITIES)}`,
        ]
        : [
          `$env:SLOCK_AGENT_TOKEN_FILE=${powershellSingleQuote(tokenFile)}`,
        ]),
    ];
    const psBody = [
      buildPs1LaunchForwardingGuard(slockDir),
      "$ErrorActionPreference = 'Stop'",
      "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = $utf8NoBom",
      "$OutputEncoding = $utf8NoBom",
      "$env:PYTHONIOENCODING = 'utf-8'",
      "$env:PYTHONUTF8 = '1'",
      "$env:LANG = 'C.UTF-8'",
      "$env:LC_ALL = 'C.UTF-8'",
      "Remove-Item Env:RAFT_PROFILE,Env:SLOCK_PROFILE,Env:RAFT_PROFILE_DIR,Env:SLOCK_PROFILE_DIR -ErrorAction SilentlyContinue",
      ...powershellLoopbackNoProxyLines(),
      ...psCredentialLines,
      ...(electronNodeMode ? ["$env:ELECTRON_RUN_AS_NODE = '1'"] : []),
      `$node = ${powershellSingleQuote(nodeHost.command)}`,
      `$cli = ${powershellSingleQuote(cliPath)}`,
      ...(cliPath === "__cli" || cliFallbackCandidates.length === 0 ? [] : [
        "if (-not (Test-Path $cli)) {",
        `  foreach ($candidate in @(${cliFallbackCandidates.map(powershellSingleQuote).join(", ")})) {`,
        "    if (Test-Path $candidate) { $cli = $candidate; break }",
        "  }",
        "}",
      ]),
      "if ($MyInvocation.ExpectingInput) {",
      "  $input | & $node $cli @args",
      "} else {",
      "  & $node $cli @args",
      "}",
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
    writeFileSync(psWrapper, psBody);
    writeFileSync(psRaftWrapper, psBody);
  }

  // Expose @jackwener/opencli on the spawned runtime's PATH via the same
  // wrapper mechanism. Mirrors the `slock` wrapper shape: exec node against
  // the daemon-resolved opencli main script so behavior does not depend on a
  // host-global `opencli` install.
  const opencliBinPath = resolveOpencliBinPath();
  if (opencliBinPath) {
    writeOpencliWrapper(slockDir, opencliBinPath, platform, execIsElectron);
  }

  // Upgrade wrappers from prior launches of this agent so that any cached
  // absolute path or stale shell alias forwards to the current launch's wrapper
  // before stale credential/proxy env is read. Only touches daemon-generated
  // regular files; failures are tolerated.
  upgradeExistingAgentWrappers(path.dirname(slockDir), slockDir, platform);

  const wrapperPath = platform === "win32"
    ? path.join(slockDir, "slock.cmd")
    : posixWrapper;

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    FORCE_COLOR: "0",
    ...(launchRuntimeFields.envVars || {}),
    ...extraEnv,
    ...(platform === "win32" ? windowsUtf8Env() : {}),
    ...runtimeContextEnv(ctx.config),
    [SLOCK_HOME_ENV]: slockHome,
    SLOCK_AGENT_ID: ctx.agentId,
    ...(ctx.launchId ? { SLOCK_AGENT_LAUNCH_ID: ctx.launchId } : {}),
    ...(ctx.cliTransportTraceDir ? { [CLI_TRANSPORT_TRACE_DIR_ENV]: ctx.cliTransportTraceDir } : {}),
    SLOCK_SERVER_URL: ctx.config.serverUrl,
    [SLOCK_AGENT_LAUNCH_DIR_ENV]: path.basename(slockDir),
    [SLOCK_CLI_TRANSPORT_DIR_ENV]: slockDir,
    PATH: `${slockDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete spawnEnv.SLOCK_AGENT_TOKEN;
  // RFC §9.1 step 3 — never let raw agent credentials leak via the runtime
  // env. The daemon-owned wrapper receives only a daemon-owned proxy token file
  // path for the short-lived CLI process.
  for (const key of RAW_CREDENTIAL_ENV_DENYLIST) {
    delete spawnEnv[key];
  }
  // A login-shell profile selector is valid for a user-started external
  // bridge, but never for a Computer-managed runtime. Strip every selector
  // and selector-root after all ambient/config/extra env merges so none can
  // replace the daemon-bound agent identity.
  for (const key of EXTERNAL_PROFILE_ENV_DENYLIST) {
    delete spawnEnv[key];
  }
  delete spawnEnv.SLOCK_AGENT_PROXY_URL;
  delete spawnEnv.SLOCK_AGENT_PROXY_TOKEN;
  delete spawnEnv.SLOCK_AGENT_PROXY_TOKEN_FILE;
  delete spawnEnv.SLOCK_AGENT_ACTIVE_CAPABILITIES;
  delete spawnEnv.SLOCK_AGENT_TOKEN_FILE;
  applyLoopbackNoProxyEnv(spawnEnv);

  return {
    slockDir,
    slockHome,
    tokenFile,
    agentCredentialProxyUrl: agentCredentialProxy?.proxyUrl ?? null,
    wrapperPath,
    spawnEnv: spawnEnv as NodeJS.ProcessEnv,
  };
}
