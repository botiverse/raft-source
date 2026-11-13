import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ambientProcessEnv } from "../processEnvPatch";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CLI_STABLE_ENTRY_DIRNAME,
  enabledAppsEnvValue,
  hydrateRuntimeConfig,
  kPromotedSlotPath,
  RAFT_CLI_ENTRY_ENV,
  RAFT_CLI_STABLE_ENTRY,
  RAFT_ENABLED_APPS_ENV,
  runtimeConfigToLaunchFields,
  type AgentConfig,
} from "@botiverse/raft-shared";
import type { SpawnContext } from "./types";
import { buildCliSystemPrompt, type SystemPromptOptions } from "./systemPrompt";
import type { AxSurfaceText } from "@botiverse/raft-shared";
import { migrateLegacyBridgeArtifacts } from "../legacyBridgeArtifacts";
import { SLOCK_HOME_ENV, resolveRaftHome } from "../raftHome";
import { registerAgentCredentialProxy } from "../agentCredentialProxy";
import { configPassiveAx, publishSpawnContextGeneration } from "../contextGeneration";
import { LOOPBACK_NO_PROXY, applyLoopbackNoProxyEnv } from "../loopbackNoProxy";
import { detectNodeHostKind, resolveNodeHostLaunch, type NodeHostKind } from "./nodeHostLaunch";
import { liveHostExecutablePath } from "./liveHostExecutable";

// The live-path helper lives in its own module so light importers (the
// runtime detection round) can use it without this module's graph.
export { executableFileIdentity, liveHostExecutablePath, setProcSelfExeReaderForTests } from "./liveHostExecutable";

const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const powershellSingleQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const DEFAULT_ACTIVE_CAPABILITIES = "send,read,mentions,tasks,reactions,server,channels,knowledge";
const CLI_TRANSPORT_TRACE_DIR_ENV = "SLOCK_CLI_TRANSPORT_TRACE_DIR";
// The agent's runtime id, for the CLI's trace spans (`runtime` attr). New, so
// only the canonical RAFT_ name: a SLOCK_ alias exists only for names older
// readers already use.
export const RAFT_CURRENT_RUNTIME_ENV = "RAFT_CURRENT_RUNTIME";
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
// One Computer upgrade's own operation variables: the Computer sets them only on
// the installer it launches for a web upgrade, but an installer that started the
// Computer from its own env passed them on to the service, the daemon and every
// agent. An agent's `raft-computer upgrade` then reused that old operation id and
// `remote:` approval label (#proj-raft-computer:#32). Configuration such as
// RAFT_COMPUTER_INSTALLER_CHANNEL stays: an agent's upgrade keeps the user's channel.
const COMPUTER_UPGRADE_OPERATION_ENV_DENYLIST = [
  "RAFT_COMPUTER_OPERATION_ID",
  "RAFT_COMPUTER_APPROVED_BY",
  "RAFT_COMPUTER_NON_INTERACTIVE",
  "RAFT_COMPUTER_INSTALLER_CALLER",
] as const;
const WORKSPACE_CLI_TRANSPORT_FILENAMES = [
  "agent-token",
  "slock",
  "slock.cmd",
  "slock.ps1",
  "raft",
  "raft.cmd",
  "raft.ps1",
  "cont",
  "cont.cmd",
  "cont.ps1",
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
const LAUNCH_CREATED_AT_FILENAME = ".slock-launch-created-at";

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
    `SLOCK_LAUNCH_CREATED_AT_FILE=${shellSingleQuote(LAUNCH_CREATED_AT_FILENAME)}`,
    'SLOCK_LAUNCH_CREATED_AT_RE=\'^[0-9]{13}$\'',
    'if [ -n "${SLOCK_AGENT_LAUNCH_DIR:-}" ] && [ "$SLOCK_AGENT_LAUNCH_DIR" != "$SLOCK_OWN_LAUNCH_DIR" ]; then',
    '  SLOCK_LAUNCH_FORWARD_SKIP_REASON=invalid_selector',
    '  if [ "$SLOCK_AGENT_LAUNCH_DIR" != "." ] && [ "$SLOCK_AGENT_LAUNCH_DIR" != ".." ] && [[ ! "$SLOCK_AGENT_LAUNCH_DIR" =~ [/\\] ]]; then',
    '    SLOCK_FORWARD_DIR="$SLOCK_AGENT_ROOT/$SLOCK_AGENT_LAUNCH_DIR"',
    '    SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_dir_missing',
    '    if [ -d "$SLOCK_FORWARD_DIR" ] && [ ! -L "$SLOCK_FORWARD_DIR" ]; then',
    '      SLOCK_FORWARD_WRAPPER="$SLOCK_FORWARD_DIR/$(basename "$0")"',
    '      SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_wrapper_missing',
    '      if [ -f "$SLOCK_FORWARD_WRAPPER" ] && [ ! -L "$SLOCK_FORWARD_WRAPPER" ]; then',
    '        SLOCK_FORWARD_MARKER="$SLOCK_FORWARD_DIR/$SLOCK_LAUNCH_CREATED_AT_FILE"',
    '        SLOCK_OWN_MARKER="$SLOCK_AGENT_ROOT/$SLOCK_OWN_LAUNCH_DIR/$SLOCK_LAUNCH_CREATED_AT_FILE"',
    '        SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_marker_missing',
    '        if [ -f "$SLOCK_FORWARD_MARKER" ] && [ ! -L "$SLOCK_FORWARD_MARKER" ]; then',
    '          SLOCK_FORWARD_CREATED_AT=""',
    '          IFS= read -r SLOCK_FORWARD_CREATED_AT < "$SLOCK_FORWARD_MARKER"',
    '          SLOCK_OWN_CREATED_AT=""',
    '          SLOCK_OWN_MARKER_PRESENT=""',
    '          SLOCK_OWN_MARKER_VALID=""',
    '          if [ -f "$SLOCK_OWN_MARKER" ] && [ ! -L "$SLOCK_OWN_MARKER" ]; then',
    '            SLOCK_OWN_MARKER_PRESENT=1',
    '            IFS= read -r SLOCK_OWN_CREATED_AT < "$SLOCK_OWN_MARKER"',
    '            if [[ "$SLOCK_OWN_CREATED_AT" =~ $SLOCK_LAUNCH_CREATED_AT_RE ]]; then',
    '              SLOCK_OWN_MARKER_VALID=1',
    '            fi',
    '          fi',
    '          SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_marker_invalid',
    '          if [[ "$SLOCK_FORWARD_CREATED_AT" =~ $SLOCK_LAUNCH_CREATED_AT_RE ]]; then',
    '            SLOCK_LAUNCH_FORWARD_SKIP_REASON=own_marker_invalid',
    '            if [ -z "$SLOCK_OWN_MARKER_PRESENT" ]; then',
    '              exec "$SLOCK_FORWARD_WRAPPER" "$@"',
    '            elif [ "$SLOCK_OWN_MARKER_VALID" = "1" ]; then',
    '              SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_not_newer',
    '              if [ "$SLOCK_FORWARD_CREATED_AT" \\> "$SLOCK_OWN_CREATED_AT" ]; then',
    '                exec "$SLOCK_FORWARD_WRAPPER" "$@"',
    '              fi',
    '            fi',
    '          fi',
    '        fi',
    '      fi',
    '    fi',
    '  fi',
    '  printf \'[cliTransport] launch-forwarding skipped reason=%s\\n\' "$SLOCK_LAUNCH_FORWARD_SKIP_REASON" >&2',
    'fi',
  ].join("\n");
}

function buildCmdLaunchForwardingGuard(ownSlockDir: string): string {
  // The selector is a single launch-directory basename. The wrapper bakes its
  // own agent root and launch part so it can only forward to a sibling launch
  // dir under the same agent. Reject empty, ".", "..", or any selector
  // containing "/" or "\\". The nested IF block only computes the target. The
  // actual .cmd handoff uses the same undefined-goto pattern as cmd-shim so the
  // target wrapper is the final command observed by cmd.exe /c. The normal path
  // jumps to the current wrapper body, leaving its node invocation as the last
  // command just like pre-forwarding wrappers.
  const agentRoot = path.dirname(ownSlockDir);
  const ownLaunchPart = path.basename(ownSlockDir);
  return [
    "@REM slock-daemon-generated",
    "setlocal enabledelayedexpansion",
    `set "SLOCK_AGENT_ROOT=${agentRoot}"`,
    `set "SLOCK_OWN_LAUNCH_DIR=${ownLaunchPart}"`,
    `set "SLOCK_LAUNCH_CREATED_AT_FILE=${LAUNCH_CREATED_AT_FILENAME}"`,
    'set "SLOCK_FORWARD_TARGET="',
    "if defined SLOCK_AGENT_LAUNCH_DIR (",
    '  if /I not "!SLOCK_AGENT_LAUNCH_DIR!"=="!SLOCK_OWN_LAUNCH_DIR!" (',
    '    set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=invalid_selector"',
    '    set "SLOCK_SEL=!SLOCK_AGENT_LAUNCH_DIR!"',
    '    set "SLOCK_INVALID="',
    '    if "!SLOCK_SEL!"=="" set SLOCK_INVALID=1',
    '    if "!SLOCK_SEL!"=="." set SLOCK_INVALID=1',
    '    if "!SLOCK_SEL!"==".." set SLOCK_INVALID=1',
    '    if not "!SLOCK_SEL:/=!"=="!SLOCK_SEL!" set SLOCK_INVALID=1',
    '    if not "!SLOCK_SEL:\\=!"=="!SLOCK_SEL!" set SLOCK_INVALID=1',
    '    if not defined SLOCK_INVALID (',
    '      set "SLOCK_FORWARD_DIR=!SLOCK_AGENT_ROOT!\\!SLOCK_SEL!"',
    '      set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_dir_missing"',
    '      if exist "!SLOCK_FORWARD_DIR!\\" (',
    '        fsutil reparsepoint query "!SLOCK_FORWARD_DIR!" >nul 2>&1',
    '        if errorlevel 1 (',
    '          set "SLOCK_FORWARD_WRAPPER=!SLOCK_FORWARD_DIR!\\%~nx0"',
    '          set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_wrapper_missing"',
    '          if exist "!SLOCK_FORWARD_WRAPPER!" if not exist "!SLOCK_FORWARD_WRAPPER!\\" (',
    '            set "SLOCK_FORWARD_MARKER=!SLOCK_FORWARD_DIR!\\!SLOCK_LAUNCH_CREATED_AT_FILE!"',
    '            set "SLOCK_OWN_MARKER=!SLOCK_AGENT_ROOT!\\!SLOCK_OWN_LAUNCH_DIR!\\!SLOCK_LAUNCH_CREATED_AT_FILE!"',
    '            set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_marker_missing"',
    '            if exist "!SLOCK_FORWARD_MARKER!" if not exist "!SLOCK_FORWARD_MARKER!\\" (',
    '              set "SLOCK_FORWARD_CREATED_AT="',
    '              set /p SLOCK_FORWARD_CREATED_AT=<"!SLOCK_FORWARD_MARKER!"',
    '              set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_marker_invalid"',
    '              set "SLOCK_FORWARD_MARKER_VALID="',
    '              set "SLOCK_FORWARD_DIGITS=!SLOCK_FORWARD_CREATED_AT!"',
    '              for %%D in (0 1 2 3 4 5 6 7 8 9) do set "SLOCK_FORWARD_DIGITS=!SLOCK_FORWARD_DIGITS:%%D=!"',
    '              if "!SLOCK_FORWARD_DIGITS!"=="" if not "!SLOCK_FORWARD_CREATED_AT:~12,1!"=="" if "!SLOCK_FORWARD_CREATED_AT:~13!"=="" set "SLOCK_FORWARD_MARKER_VALID=1"',
    '              set "SLOCK_OWN_CREATED_AT="',
    '              set "SLOCK_OWN_MARKER_PRESENT="',
    '              set "SLOCK_OWN_MARKER_VALID="',
    '              if exist "!SLOCK_OWN_MARKER!" if not exist "!SLOCK_OWN_MARKER!\\" (',
    '                set "SLOCK_OWN_MARKER_PRESENT=1"',
    '                set /p SLOCK_OWN_CREATED_AT=<"!SLOCK_OWN_MARKER!"',
    '                set "SLOCK_OWN_DIGITS=!SLOCK_OWN_CREATED_AT!"',
    '                for %%D in (0 1 2 3 4 5 6 7 8 9) do set "SLOCK_OWN_DIGITS=!SLOCK_OWN_DIGITS:%%D=!"',
    '                if "!SLOCK_OWN_DIGITS!"=="" if not "!SLOCK_OWN_CREATED_AT:~12,1!"=="" if "!SLOCK_OWN_CREATED_AT:~13!"=="" set "SLOCK_OWN_MARKER_VALID=1"',
    '              )',
    '              if defined SLOCK_FORWARD_MARKER_VALID (',
    '                set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=own_marker_invalid"',
    '                if not defined SLOCK_OWN_MARKER_PRESENT (',
    '                  set "SLOCK_FORWARD_TARGET=!SLOCK_FORWARD_WRAPPER!"',
    '                ) else if defined SLOCK_OWN_MARKER_VALID (',
    '                  set "SLOCK_LAUNCH_FORWARD_SKIP_REASON=selected_not_newer"',
    '                  if "!SLOCK_FORWARD_CREATED_AT!" GTR "!SLOCK_OWN_CREATED_AT!" (',
    '                    set "SLOCK_FORWARD_TARGET=!SLOCK_FORWARD_WRAPPER!"',
    '                  )',
    '                )',
    '              )',
    '            )',
    '          )',
    '        )',
    '      )',
    '    )',
    '  )',
    ')',
    'if defined SLOCK_FORWARD_TARGET goto :slock_forward',
    'if defined SLOCK_LAUNCH_FORWARD_SKIP_REASON >&2 echo [cliTransport] launch-forwarding skipped reason=!SLOCK_LAUNCH_FORWARD_SKIP_REASON!',
    'endlocal',
    'goto :slock_current',
    ':slock_forward',
    'for %%F in ("%SLOCK_FORWARD_TARGET%") do endlocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%%~fF" %*',
    ':slock_current',
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
    `$SlockLaunchCreatedAtFile = ${powershellSingleQuote(LAUNCH_CREATED_AT_FILENAME)}`,
    '$SlockLaunchDir = $env:SLOCK_AGENT_LAUNCH_DIR',
    'if ($SlockLaunchDir -and ($SlockLaunchDir -ne $SlockOwnLaunchDir)) {',
    '    $invalid = ($SlockLaunchDir -in "", ".", "..") -or ($SlockLaunchDir -match "[/\\\\]")',
    '    if (-not $invalid) {',
    '        $ForwardDir = Join-Path $SlockAgentRoot $SlockLaunchDir',
    '        $SkipReason = "selected_dir_missing"',
    '        $dirItem = Get-Item $ForwardDir -ErrorAction SilentlyContinue',
    '        if ($dirItem -and $dirItem.PSIsContainer -and (-not $dirItem.LinkType)) {',
    '            $ForwardTarget = Join-Path $ForwardDir (Split-Path -Leaf $PSCommandPath)',
    '            $SkipReason = "selected_wrapper_missing"',
    '            $item = Get-Item $ForwardTarget -ErrorAction SilentlyContinue',
    '            if ($item -and ($item.PSIsContainer -eq $false) -and (-not $item.LinkType)) {',
    '                $ForwardMarker = Join-Path $ForwardDir $SlockLaunchCreatedAtFile',
    '                $SkipReason = "selected_marker_missing"',
    '                $forwardMarkerItem = Get-Item $ForwardMarker -ErrorAction SilentlyContinue',
    '                if ($forwardMarkerItem -and ($forwardMarkerItem.PSIsContainer -eq $false) -and (-not $forwardMarkerItem.LinkType)) {',
    '                    $ForwardCreatedAt = Get-Content -LiteralPath $ForwardMarker -TotalCount 1 -ErrorAction SilentlyContinue',
    '                    $OwnMarker = Join-Path (Join-Path $SlockAgentRoot $SlockOwnLaunchDir) $SlockLaunchCreatedAtFile',
    '                    $OwnCreatedAt = $null',
    '                    $ownMarkerItem = Get-Item $OwnMarker -ErrorAction SilentlyContinue',
    '                    if ($ownMarkerItem -and ($ownMarkerItem.PSIsContainer -eq $false) -and (-not $ownMarkerItem.LinkType)) {',
    '                        $OwnCreatedAt = Get-Content -LiteralPath $OwnMarker -TotalCount 1 -ErrorAction SilentlyContinue',
    '                    }',
    '                    $ForwardMarkerValid = $ForwardCreatedAt -match "^\\d{13}$"',
    '                    $OwnMarkerPresent = $null -ne $ownMarkerItem',
    '                    $OwnMarkerValid = $OwnCreatedAt -match "^\\d{13}$"',
    '                    $SkipReason = "selected_marker_invalid"',
    '                    if ($ForwardMarkerValid -and ((-not $OwnMarkerPresent) -or ($OwnMarkerValid -and ([string]::CompareOrdinal($ForwardCreatedAt, $OwnCreatedAt) -gt 0)))) {',
    '                        & $ForwardTarget @args',
    '                        exit $LASTEXITCODE',
    '                    }',
    '                    if ($ForwardMarkerValid) {',
    '                        if ($OwnMarkerPresent -and $OwnMarkerValid) { $SkipReason = "selected_not_newer" }',
    '                        elseif ($OwnMarkerPresent) { $SkipReason = "own_marker_invalid" }',
    '                    }',
    '                }',
    '            }',
    '        }',
    '    } else {',
    '        $SkipReason = "invalid_selector"',
    '    }',
    '    if ($SkipReason) { [Console]::Error.WriteLine("[cliTransport] launch-forwarding skipped reason=$SkipReason") }',
    '}',
  ].join("\r\n");
}

/**
 * `cont <id> [choice]` (the answer's text on stdin) answers a command that
 * paused to ask the agent something (exit 10, shared/src/continuations). It
 * runs the `raft` wrapper beside it as `raft __continue`, so it holds no
 * credentials of its own and follows raft's launch forwarding. Phase 1:
 * every continuation is the raft CLI's, so cont only dispatches to raft;
 * routing an id to the program that paused it comes when the continuation
 * framework is extracted into its own package.
 */
function writeContWrappers(slockDir: string, platform: NodeJS.Platform): void {
  writeFileSync(
    path.join(slockDir, "cont"),
    `#!/usr/bin/env bash\n# cont <id> [choice]: answer a paused raft command (raft __continue).\nexec "$(dirname "$0")/raft" __continue "$@"\n`,
    { mode: 0o755 },
  );
  if (platform !== "win32") return;
  writeFileSync(path.join(slockDir, "cont.cmd"), [
    "@echo off",
    "@REM cont <id> [choice]: answer a paused raft command (raft __continue).",
    '"%~dp0raft.cmd" __continue %*',
    "",
  ].join("\r\n"));
  writeFileSync(path.join(slockDir, "cont.ps1"), [
    "# cont <id> [choice]: answer a paused raft command (raft __continue).",
    "$raft = Join-Path $PSScriptRoot 'raft.ps1'",
    "if ($MyInvocation.ExpectingInput) {",
    "  $input | & $raft __continue @args",
    "} else {",
    "  & $raft __continue @args",
    "}",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n"));
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
    // The stable entry is not a launch: its wrappers never forward.
    if (entry === CLI_STABLE_ENTRY_DIRNAME) continue;
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
export function resolveOpencliBinPath(): string | null {
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

/** The transport directory a spawn with `ctx` uses (what prepareCliTransport creates). */
export function spawnCliTransportDir(ctx: Pick<SpawnContext, "slockHome" | "agentId" | "launchId">): string {
  return buildCliTransportDir(ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome(), ctx.agentId, ctx.launchId);
}

/** The per-launch transport directory `prepareCliTransport` creates and injects as SLOCK_CLI_TRANSPORT_DIR. */
export function buildCliTransportDir(slockHome: string, agentId: string, launchId?: string | null): string {
  return path.join(slockHome, "cli-transport", safePathPart(agentId), buildCliTransportLaunchPart(launchId));
}

/**
 * The agent's stable CLI entry (#proj-raft-computer:#58): one directory per
 * agent that every launch rewrites with `raft`/`slock` wrappers using that
 * launch's own proxy credential. A process that outlives its session (nohup,
 * a background job) calls it instead of a launch's wrapper; the proxy serves
 * it with the agent's current launch and refuses it once no launch is live.
 */
export function buildCliStableEntryDir(slockHome: string, agentId: string): string {
  return path.join(slockHome, "cli-transport", safePathPart(agentId), CLI_STABLE_ENTRY_DIRNAME);
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
    ? resolveNodeHostLaunch({ env: ambientProcessEnv(), execIsElectron, seaProbe })
    : { command: liveHostExecutablePath(), env: ambientProcessEnv(), execArgv: [] };
  const electronNodeMode = execIsElectron && nodeHost.env.ELECTRON_RUN_AS_NODE === "1";
  // opencli parses with commander's argument-less parse(), which misreads
  // Electron's Node mode; see ELECTRON_NODE_SCRIPT_EXEC_ARGV (task #159).
  const hostExecArgv = electronNodeMode ? nodeHost.execArgv : [];
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
  writeReplacingFile(
    path.join(slockDir, "opencli"),
    `#!/usr/bin/env bash\nOPENCLI_BIN=${shellSingleQuote(binPath)}\n${posixFallbackBlock}${electronNodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}exec ${[nodeHost.command, ...hostExecArgv].map(shellSingleQuote).join(" ")} "$OPENCLI_BIN" "$@"\n`,
    0o755,
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
      `${[nodeHost.command, ...hostExecArgv].map((arg) => `"${arg}"`).join(" ")} "%OPENCLI_BIN%" %*`,
      "",
    ].join("\r\n") + "\r\n";
    writeReplacingFile(path.join(slockDir, "opencli.cmd"), opencliCmdBody, 0o644);
  }
}

/**
 * Replace `file` with `body`: a fresh temp file nobody can guess, created
 * exclusively, then renamed over it. A rename replaces a link at `file`
 * instead of writing through it, so a link planted there never redirects
 * the write.
 */
function writeReplacingFile(file: string, body: string, mode: number): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, body, { mode, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A real directory and, in it, a plain file or nothing: what the restart refresh may rewrite in a workspace. */
function isPlainWorkspaceWrapper(slockDir: string, names: readonly string[]): boolean {
  try {
    if (!lstatSync(slockDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return names.every((name) => {
    try {
      return lstatSync(path.join(slockDir, name)).isFile();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
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
): { scanned: number; rewritten: number; skipped: number } {
  if (!opencliBinPath) return { scanned: 0, rewritten: 0, skipped: 0 };
  let entries: string[];
  try {
    entries = readdirSync(agentsRoot);
  } catch {
    return { scanned: 0, rewritten: 0, skipped: 0 };
  }
  let scanned = 0;
  let rewritten = 0;
  let skipped = 0;
  const names = platform === "win32" ? ["opencli", "opencli.cmd"] : ["opencli"];
  for (const entry of entries) {
    // These are in the agents' workspaces, which the agents can write: a
    // `.slock` or wrapper that is a link would turn this refresh, run at every
    // daemon start, into a write anywhere the daemon can write.
    const slockDir = path.join(agentsRoot, entry, ".slock");
    let wrapper;
    try {
      wrapper = lstatSync(path.join(slockDir, "opencli"));
    } catch {
      continue;
    }
    scanned++;
    if (!wrapper.isFile() || !isPlainWorkspaceWrapper(slockDir, names)) {
      skipped++;
      continue;
    }
    try {
      writeOpencliWrapper(slockDir, opencliBinPath, platform);
      rewritten++;
    } catch {
      /* tolerate a single bad workspace */
    }
  }
  return { scanned, rewritten, skipped };
}

/**
 * Daemon-startup pass: remove every `agent-token` older daemons left behind,
 * in each launch directory under `<slockHome>/cli-transport/<agentId>/` and in
 * each agent workspace's `.slock/` (the location before that). Such a file may
 * hold the Computer's own key, readable by the agent's runtime, and nothing
 * else prunes old launch directories; current daemons never write one.
 *
 * Only a regular file named exactly `agent-token` is removed. A symlink, at the
 * file or at any directory on the way, is left alone and never followed: a
 * race that swaps a checked directory could only make the daemon unlink an
 * `agent-token` the same-uid agent can already unlink itself. Never throws;
 * returns counts only.
 */
export function removeStaleAgentTokenFiles(slockHome: string, agentsRoot: string): { removed: number; skipped: number } {
  const counts = { removed: 0, skipped: 0 };
  const removeIn = (dir: string): void => {
    const tokenFile = path.join(dir, "agent-token");
    try {
      if (!lstatSync(tokenFile).isFile()) {
        counts.skipped++;
        return;
      }
      rmSync(tokenFile);
      counts.removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") counts.skipped++;
    }
  };
  for (const agentDir of plainSubdirectories(path.join(slockHome, "cli-transport"))) {
    for (const launchDir of plainSubdirectories(agentDir)) removeIn(launchDir);
  }
  for (const workspace of plainSubdirectories(agentsRoot)) {
    const slockDir = path.join(workspace, ".slock");
    if (isPlainDirectory(slockDir)) removeIn(slockDir);
  }
  return counts;
}

/** Directories directly inside `dir`, symlinks excluded; none when `dir` is not itself a plain directory. */
function plainSubdirectories(dir: string): string[] {
  if (!isPlainDirectory(dir)) return [];
  try {
    return readdirSync(dir).map((name) => path.join(dir, name)).filter(isPlainDirectory);
  } catch {
    return [];
  }
}

function isPlainDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
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
  // Windows aliases environment-variable names case-insensitively, so reading
  // both spellings would append the same caller value twice.
  return [
    `set "SLOCK_LOOPBACK_NO_PROXY=${LOOPBACK_NO_PROXY}"`,
    `set "SLOCK_EXISTING_NO_PROXY=%NO_PROXY%"`,
    `if defined SLOCK_EXISTING_NO_PROXY (set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%,%SLOCK_EXISTING_NO_PROXY%") else set "NO_PROXY=%SLOCK_LOOPBACK_NO_PROXY%"`,
    `set "no_proxy=%NO_PROXY%"`,
  ];
}

/**
 * Every process environment variable the PowerShell wrapper sets or removes
 * (task #384). The wrapper snapshots these before the call and restores them
 * after it; a contract test fails if the wrapper touches a name not listed.
 */
export const POWERSHELL_WRAPPER_ENV_NAMES = [
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "LANG",
  "LC_ALL",
  "RAFT_PROFILE",
  "SLOCK_PROFILE",
  "RAFT_PROFILE_DIR",
  "SLOCK_PROFILE_DIR",
  "NO_PROXY",
  "SLOCK_AGENT_ID",
  "SLOCK_SERVER_URL",
  "SLOCK_AGENT_PROXY_URL",
  "SLOCK_AGENT_PROXY_TOKEN_FILE",
  "SLOCK_AGENT_ACTIVE_CAPABILITIES",
  "ELECTRON_RUN_AS_NODE",
  // The stable entry's own (cli-transport/<agent>/current/raft.ps1).
  RAFT_CLI_ENTRY_ENV,
  "SLOCK_HOME",
  "SLOCK_CLI_TRANSPORT_DIR",
  "SLOCK_AGENT_LAUNCH_DIR",
] as const;

function powershellLoopbackNoProxyLines(): string[] {
  // Keep the caller's bypasses, but normalize them with the same Windows
  // case-insensitive semantics so repeated wrapper calls are idempotent.
  return [
    `$loopbackNoProxy = ${powershellSingleQuote(LOOPBACK_NO_PROXY)}`,
    "$existingNoProxy = if ($env:NO_PROXY) { $env:NO_PROXY -split ',' } else { @() }",
    "$seenNoProxy = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "$mergedNoProxy = [System.Collections.Generic.List[string]]::new()",
    "foreach ($entry in (@($loopbackNoProxy -split ',') + @($existingNoProxy))) {",
    "  $trimmed = $entry.Trim()",
    "  if ($trimmed -and $seenNoProxy.Add($trimmed)) { [void]$mergedNoProxy.Add($trimmed) }",
    "}",
    "$env:NO_PROXY = $mergedNoProxy -join ','",
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

/** PATH from an env object; on Windows the name matches in any case. */
function readEnvPath(env: Record<string, string | undefined> | undefined, caseInsensitive: boolean): string | undefined {
  if (!env) return undefined;
  if (!caseInsensitive) return env.PATH;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && value !== undefined) return value;
  }
  return undefined;
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
  /**
   * Local proxy URL for the daemon-held sk_agent_* credential, or null when
   * the launch has none (the runtime then gets no Raft credential at all).
   * The spawned runtime env and daemon-owned wrapper never receive the
   * proxy token value; the wrapper points the short-lived CLI process at a
   * daemon-owned 0600 token file outside the workspace.
   */
  agentCredentialProxyUrl: string | null;
  wrapperPath: string;
  spawnEnv: NodeJS.ProcessEnv;
  /**
   * The part of `spawnEnv` the launch sets itself, without the daemon's own
   * environment under it: the agent's configured env vars, the driver's extra
   * variables, Raft's identity and CLI transport variables, PATH with the
   * wrapper dir in front, and NO_PROXY with the loopback entries. The same
   * removals apply. For a runtime that starts from an empty environment
   * (Cursor on OAR, `envBase: "clean"`; oarCursorLaunch.ts).
   */
  launchEnv: Record<string, string>;
  slockHome: string;
}> {
  // Same reasoning as the wrapper writer above: a SEA reaches its own `__cli`
  // path a few lines down, so it must not be stopped here for lacking a
  // separate Node host.
  const hostKind = detectNodeHostKind({ execIsElectron, seaProbe });
  const nodeHost = hostKind === "electron" || hostKind === "node"
    ? resolveNodeHostLaunch({ env: ambientProcessEnv(), execIsElectron, seaProbe })
    : { command: liveHostExecutablePath(), env: ambientProcessEnv() };
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
  // 1. Keep the agent's runner credential in the daemon behind a local proxy;
  //    the runtime gets only a proxy token file outside the model workspace.
  // 2. Write a local `slock` wrapper that execs the bundled monorepo CLI via
  //    an absolute path, so agent behavior does not depend on a host-global
  //    `slock` install or PATH ordering.
  // 3. Prepend that wrapper directory to PATH for the spawned runtime.
  cleanupWorkspaceCliTransportFiles(ctx.workingDirectory);
  // Older daemons wrote an MCP entry launching `chat-bridge --auth-token
  // <machine bearer>` into the workspace (#proj-raft-computer task #38). Remove
  // exactly that entry; user MCP servers and other settings stay. Never throws.
  migrateLegacyBridgeArtifacts(ctx.workingDirectory, ctx.agentId, { machineKey: ctx.daemonApiKey || null });
  const slockDir = spawnCliTransportDir(ctx);
  mkdirSync(slockDir, { recursive: true });
  // RFC 072 §7.2: this spawn's context id (new, or the resumed session's),
  // written before the process exists so the CLI's first invocation reads it.
  // Planned by whoever holds the driver (its compaction declaration).
  publishSpawnContextGeneration(slockDir, {
    runtime: ctx.config.runtime,
    passiveAx: configPassiveAx(ctx.config),
    plan: ctx.contextGeneration,
  });
  const launchCreatedAtFile = path.join(slockDir, LAUNCH_CREATED_AT_FILENAME);
  if (!existsSync(launchCreatedAtFile)) {
    writeFileSync(launchCreatedAtFile, Date.now().toString().padStart(13, "0"), { mode: 0o644 });
  }

  // Older daemons wrote the Computer's own key (`sk_computer_*` /
  // `sk_machine_*`) here for the wrapper. Never leave it readable to the
  // runtime or its tool shell.
  rmSync(path.join(slockDir, "agent-token"), { force: true });

  // `rfcs/034-slock-credential-rfc.zh.html#section-credential-isolation` —
  // server session worker runner credential wiring.
  //
  // Every launch carries an `sk_agent_*` credential the Computer minted for
  // it: `buildSpawnConfig` mints one or fails the start
  // (`runner_credential_mint_failed`). Keep the bearer in the daemon process
  // and expose only a localhost proxy affordance to the `slock` wrapper. The
  // spawned runtime env and model workspace never receive the raw key, the
  // proxy token value, or a readable key-file pointer. The Computer's own key
  // is never a stand-in: a launch without a runner credential (only a caller
  // that skips `buildSpawnConfig`, such as a driver test) gets no Raft
  // credential, and the CLI says so when it runs.
  const agentCredentialKey = ctx.config.agentCredentialKey;
  const stableEntryDir = buildCliStableEntryDir(slockHome, ctx.agentId);
  const stableEntryPath = path.join(stableEntryDir, platform === "win32" ? "raft.cmd" : "raft");
  let agentCredentialProxy: { proxyUrl: string; proxyToken: string } | null = null;
  let agentCredentialProxyTokenFile: string | null = null;
  if (typeof agentCredentialKey === "string" && agentCredentialKey.length > 0) {
    agentCredentialProxy = await registerAgentCredentialProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      serverUrl: ctx.config.serverUrl,
      apiKey: agentCredentialKey,
      activeCapabilities: DEFAULT_ACTIVE_CAPABILITIES,
      inboxCoordinator: ctx.agentCredentialProxyInboxCoordinator,
      recordMessageCommitted: ctx.agentCredentialProxyMessageCommitted,
      recordSendOutcome: ctx.agentCredentialProxySendOutcome,
      inboxItems: ctx.agentCredentialProxyInboxItems,
      appInbox: ctx.agentAppInbox,
      tracer: ctx.tracer,
      daemonVersion: ctx.daemonVersion,
      computerVersion: ctx.computerVersion,
      runtime: ctx.config.runtime,
      stableEntryPath,
    });
    const launchPart = buildCliTransportLaunchPart(ctx.launchId);
    const proxyTokenDir = path.join(slockHome, "agent-proxy-tokens", safePathPart(ctx.agentId));
    mkdirSync(proxyTokenDir, { recursive: true, mode: 0o700 });
    agentCredentialProxyTokenFile = path.join(proxyTokenDir, `${launchPart}.token`);
    writeFileSync(agentCredentialProxyTokenFile, agentCredentialProxy.proxyToken, { mode: 0o600 });
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
  // Credential vars (only with a runner credential; none otherwise):
  //   SLOCK_AGENT_PROXY_URL + SLOCK_AGENT_PROXY_TOKEN_FILE
  //   + SLOCK_AGENT_ACTIVE_CAPABILITIES
  // We never inline raw token *contents* — only the path to the proxy token
  // file (file mode 0o600, written above).
  const posixIdentityPrefix = `SLOCK_AGENT_ID=${shellSingleQuote(ctx.agentId)} SLOCK_SERVER_URL=${shellSingleQuote(ctx.config.serverUrl)} `;
  const posixCredentialPrefix = posixIdentityPrefix + (agentCredentialProxy
    ? `SLOCK_AGENT_PROXY_URL=${shellSingleQuote(agentCredentialProxy.proxyUrl)} SLOCK_AGENT_PROXY_TOKEN_FILE=${shellSingleQuote(agentCredentialProxyTokenFile!)} SLOCK_AGENT_ACTIVE_CAPABILITIES=${shellSingleQuote(DEFAULT_ACTIVE_CAPABILITIES)} `
    : "");
  // Exec-time fallback mirrors the spawn-time one: the tree can mutate AFTER
  // the wrapper is written but before the agent's next command runs.
  const posixCliFallbackBlock = cliPath === "__cli" || cliFallbackCandidates.length === 0
    ? ""
    : `if [ ! -e "$SLOCK_CLI" ]; then\n${cliFallbackCandidates.map((candidate, i) =>
      `  ${i === 0 ? "if" : "elif"} [ -e ${shellSingleQuote(candidate)} ]; then SLOCK_CLI=${shellSingleQuote(candidate)};`).join("\n")}\n  fi\nfi\n`;
  // A wrapper written while the host still runs from K's experiment slot
  // outlives the promotion that renames that slot to stable; let it follow.
  const hostPromotedPath = kPromotedSlotPath(nodeHost.command);
  const posixHostPrelude = hostPromotedPath
    ? `RAFT_HOST=${shellSingleQuote(nodeHost.command)}\n[ -e "$RAFT_HOST" ] || RAFT_HOST=${shellSingleQuote(hostPromotedPath)}\n`
    : "";
  const posixHostRef = hostPromotedPath ? '"$RAFT_HOST"' : shellSingleQuote(nodeHost.command);
  const posixWrapperBody = (head: string, entryPrefix: string) =>
    `#!/usr/bin/env bash\n${head}\nunset RAFT_PROFILE SLOCK_PROFILE RAFT_PROFILE_DIR SLOCK_PROFILE_DIR\n${posixLoopbackNoProxyPrelude()}\nSLOCK_CLI=${shellSingleQuote(cliPath)}\n${posixCliFallbackBlock}${electronNodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}${posixHostPrelude}${posixCredentialPrefix}${entryPrefix}exec ${posixHostRef} "$SLOCK_CLI" "$@"\n`;
  const posixBody = posixWrapperBody(buildPosixLaunchForwardingGuard(slockDir), "");
  writeFileSync(posixWrapper, posixBody, { mode: 0o755 });
  writeFileSync(posixRaftWrapper, posixBody, { mode: 0o755 });
  // The stable entry runs the CLI exactly as this launch's wrapper does, as
  // this launch (its transport dir, so the CLI reads this launch's context),
  // and says so to the proxy. It has no launch-forwarding guard: it is the
  // one entry a process that outlived its launch should call.
  const stableEntryEnv: Array<[string, string]> = [
    [RAFT_CLI_ENTRY_ENV, RAFT_CLI_STABLE_ENTRY],
    [SLOCK_HOME_ENV, slockHome],
    [SLOCK_CLI_TRANSPORT_DIR_ENV, slockDir],
    [SLOCK_AGENT_LAUNCH_DIR_ENV, path.basename(slockDir)],
  ];
  const stableEntryHead = `# ${DAEMON_GENERATED_MARKER} stable entry: rewritten at every launch of this agent; uses only that launch's credential`;
  const stableEntryBodies: Array<[string, string, number]> = [];
  if (agentCredentialProxy) {
    const posixStableBody = posixWrapperBody(
      stableEntryHead,
      stableEntryEnv.map(([name, value]) => `${name}=${shellSingleQuote(value)} `).join(""),
    );
    stableEntryBodies.push(["slock", posixStableBody, 0o755], ["raft", posixStableBody, 0o755]);
  }

  if (platform === "win32") {
    const cmdWrapper = path.join(slockDir, "slock.cmd");
    const cmdRaftWrapper = path.join(slockDir, "raft.cmd");
    const cmdIdentityLines =
      `set "SLOCK_AGENT_ID=${ctx.agentId}"\r\nset "SLOCK_SERVER_URL=${ctx.config.serverUrl}"\r\n`;
    const cmdCredentialLine = cmdIdentityLines + (agentCredentialProxy
      ? `set "SLOCK_AGENT_PROXY_URL=${agentCredentialProxy.proxyUrl}"\r\nset "SLOCK_AGENT_PROXY_TOKEN_FILE=${agentCredentialProxyTokenFile!}"\r\nset "SLOCK_AGENT_ACTIVE_CAPABILITIES=${DEFAULT_ACTIVE_CAPABILITIES}"\r\n`
      : "");
    const cmdCliFallbackLines = cliPath === "__cli"
      ? []
      : cliFallbackCandidates.map((candidate) =>
        `if not exist "%SLOCK_CLI%" set "SLOCK_CLI=${candidate}"`);
    const cmdWrapperBody = (head: string, entryLines: string[]) => [
      "@echo off",
      head,
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
      ...entryLines,
      `set "SLOCK_CLI=${cliPath}"`,
      ...cmdCliFallbackLines,
      ...(electronNodeMode ? [`set "ELECTRON_RUN_AS_NODE=1"`] : []),
      ...(hostPromotedPath
        ? [`set "RAFT_HOST=${nodeHost.command}"`, `if not exist "%RAFT_HOST%" set "RAFT_HOST=${hostPromotedPath}"`, `"%RAFT_HOST%" "%SLOCK_CLI%" %*`]
        : [`"${nodeHost.command}" "%SLOCK_CLI%" %*`]),
      "",
    ].filter((line) => line.length > 0).join("\r\n") + "\r\n";
    const cmdBody = cmdWrapperBody(buildCmdLaunchForwardingGuard(slockDir), []);
    writeFileSync(cmdWrapper, cmdBody);
    writeFileSync(cmdRaftWrapper, cmdBody);
    if (agentCredentialProxy) {
      const cmdStableBody = cmdWrapperBody(
        `@REM ${stableEntryHead.slice(2)}\r\nsetlocal`,
        stableEntryEnv.map(([name, value]) => `set "${name}=${value}"`),
      );
      stableEntryBodies.push(["slock.cmd", cmdStableBody, 0o644], ["raft.cmd", cmdStableBody, 0o644]);
    }

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
        : []),
    ];
    const psWrapperBody = (head: string, entryLines: string[]) => [
      head,
      "$ErrorActionPreference = 'Stop'",
      "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      // task #384: a .ps1 runs in the caller's PowerShell process, so every
      // `$env:` write and `[Console]::OutputEncoding` change outlives the call.
      // Snapshot each touched name (unset stays unset) and restore it in the
      // finally below, so a session looks the same before and after `raft`.
      `$raftSavedEnv = @{}`,
      `foreach ($raftEnvName in @(${POWERSHELL_WRAPPER_ENV_NAMES.map(powershellSingleQuote).join(", ")})) { $raftSavedEnv[$raftEnvName] = [Environment]::GetEnvironmentVariable($raftEnvName, 'Process') }`,
      "$raftSavedConsoleEncoding = [Console]::OutputEncoding",
      "try {",
      "  [Console]::OutputEncoding = $utf8NoBom",
      "  $OutputEncoding = $utf8NoBom",
      "  $env:PYTHONIOENCODING = 'utf-8'",
      "  $env:PYTHONUTF8 = '1'",
      "  $env:LANG = 'C.UTF-8'",
      "  $env:LC_ALL = 'C.UTF-8'",
      "  Remove-Item Env:RAFT_PROFILE,Env:SLOCK_PROFILE,Env:RAFT_PROFILE_DIR,Env:SLOCK_PROFILE_DIR -ErrorAction SilentlyContinue",
      ...powershellLoopbackNoProxyLines().map((line) => `  ${line}`),
      ...psCredentialLines.map((line) => `  ${line}`),
      ...entryLines.map((line) => `  ${line}`),
      ...(electronNodeMode ? ["  $env:ELECTRON_RUN_AS_NODE = '1'"] : []),
      `  $node = ${powershellSingleQuote(nodeHost.command)}`,
      ...(hostPromotedPath ? [`  if (-not (Test-Path $node)) { $node = ${powershellSingleQuote(hostPromotedPath)} }`] : []),
      `  $cli = ${powershellSingleQuote(cliPath)}`,
      ...(cliPath === "__cli" || cliFallbackCandidates.length === 0 ? [] : [
        "  if (-not (Test-Path $cli)) {",
        `    foreach ($candidate in @(${cliFallbackCandidates.map(powershellSingleQuote).join(", ")})) {`,
        "      if (Test-Path $candidate) { $cli = $candidate; break }",
        "    }",
        "  }",
      ]),
      "  if ($MyInvocation.ExpectingInput) {",
      "    $input | & $node $cli @args",
      "  } else {",
      "    & $node $cli @args",
      "  }",
      "  $raftExitCode = $LASTEXITCODE",
      "} finally {",
      "  foreach ($raftEnvName in $raftSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($raftEnvName, $raftSavedEnv[$raftEnvName], 'Process') }",
      "  [Console]::OutputEncoding = $raftSavedConsoleEncoding",
      "}",
      "exit $raftExitCode",
      "",
    ].join("\r\n");
    const psBody = psWrapperBody(buildPs1LaunchForwardingGuard(slockDir), []);
    writeFileSync(psWrapper, psBody);
    writeFileSync(psRaftWrapper, psBody);
    if (agentCredentialProxy) {
      const psStableBody = psWrapperBody(
        stableEntryHead,
        stableEntryEnv.map(([name, value]) => `$env:${name}=${powershellSingleQuote(value)}`),
      );
      stableEntryBodies.push(["slock.ps1", psStableBody, 0o644], ["raft.ps1", psStableBody, 0o644]);
    }
  }
  writeContWrappers(slockDir, platform);
  if (stableEntryBodies.length > 0) {
    // Last writer wins: the newest launch of the agent. Each file is replaced
    // atomically, so a process running the entry meanwhile reads one whole
    // wrapper, the previous launch's or this one's.
    mkdirSync(stableEntryDir, { recursive: true });
    for (const [name, body, mode] of stableEntryBodies) {
      writeReplacingFile(path.join(stableEntryDir, name), body, mode);
    }
    writeContWrappers(stableEntryDir, platform);
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
  // The wrapper dir goes in front of the PATH the runtime would otherwise get,
  // with the same precedence as every other variable here: driver extraEnv, then
  // the agent's configured env vars, then the daemon's own PATH. Prefixing
  // process.env.PATH unconditionally discarded an agent-configured PATH — the
  // documented workaround for a minimal service PATH (slock#8610).
  // The daemon's own env, never a Pi session-create patch in flight (task #28).
  const daemonEnv = ambientProcessEnv();
  // Windows env names are case-insensitive, but ambientProcessEnv() is a plain
  // copy whose key is usually `Path`: reading `.PATH` there found nothing and
  // left the runtime with only the wrapper dir on its PATH.
  const caseInsensitive = platform === "win32";
  const basePath = readEnvPath(extraEnv, caseInsensitive)
    ?? readEnvPath(launchRuntimeFields.envVars ?? undefined, caseInsensitive)
    ?? readEnvPath(daemonEnv, caseInsensitive)
    ?? "";
  // Everything the launch sets over the daemon's own environment.
  const launchOwned: Record<string, string | undefined> = {
    FORCE_COLOR: "0",
    ...(launchRuntimeFields.envVars || {}),
    ...extraEnv,
    ...(platform === "win32" ? windowsUtf8Env() : {}),
    ...runtimeContextEnv(ctx.config),
    // After the agent's configured env vars: the daemon's value wins.
    [RAFT_CURRENT_RUNTIME_ENV]: ctx.config.runtime || "claude",
    // The first-party apps on for its Server, so the CLI skips asking an app
    // that is off (shared enabledAppsEnv.ts); unset when the Server didn't say.
    ...(ctx.config.enabledApps ? { [RAFT_ENABLED_APPS_ENV]: enabledAppsEnvValue(ctx.config.enabledApps) } : {}),
    [SLOCK_HOME_ENV]: slockHome,
    SLOCK_AGENT_ID: ctx.agentId,
    ...(ctx.launchId ? { SLOCK_AGENT_LAUNCH_ID: ctx.launchId } : {}),
    ...(ctx.cliTransportTraceDir ? { [CLI_TRANSPORT_TRACE_DIR_ENV]: ctx.cliTransportTraceDir } : {}),
    SLOCK_SERVER_URL: ctx.config.serverUrl,
    [SLOCK_AGENT_LAUNCH_DIR_ENV]: path.basename(slockDir),
    [SLOCK_CLI_TRANSPORT_DIR_ENV]: slockDir,
    PATH: `${slockDir}${path.delimiter}${basePath}`,
  };
  const spawnEnv: Record<string, string | undefined> = { ...daemonEnv, ...launchOwned };
  if (caseInsensitive) {
    // One PATH only: a child given both `Path` and `PATH` keeps whichever
    // sorts first, which is `PATH` here, but leave no second copy to pick.
    for (const key of Object.keys(spawnEnv)) {
      if (key !== "PATH" && key.toLowerCase() === "path") delete spawnEnv[key];
    }
  }
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
  for (const key of COMPUTER_UPGRADE_OPERATION_ENV_DENYLIST) {
    delete spawnEnv[key];
  }
  delete spawnEnv.SLOCK_AGENT_PROXY_URL;
  delete spawnEnv.SLOCK_AGENT_PROXY_TOKEN;
  delete spawnEnv.SLOCK_AGENT_PROXY_TOKEN_FILE;
  delete spawnEnv.SLOCK_AGENT_ACTIVE_CAPABILITIES;
  delete spawnEnv.SLOCK_AGENT_TOKEN_FILE;
  applyLoopbackNoProxyEnv(spawnEnv);
  const launchEnv: Record<string, string> = {};
  for (const key of [...Object.keys(launchOwned), "NO_PROXY", "no_proxy"]) {
    const value = spawnEnv[key];
    if (value !== undefined) launchEnv[key] = value;
  }

  return {
    slockDir,
    slockHome,
    agentCredentialProxyUrl: agentCredentialProxy?.proxyUrl ?? null,
    wrapperPath,
    spawnEnv: spawnEnv as NodeJS.ProcessEnv,
    launchEnv,
  };
}
