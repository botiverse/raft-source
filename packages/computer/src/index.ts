/**
 * Thin binary entry (task #326, contract v4 bootstrap seam).
 *
 * Loading order is the whole point of this file (review B1/H2): for an
 * OS-supervised POSIX service boot, the user's terminal-equivalent
 * environment must be captured and applied to process.env BEFORE any module
 * of the service graph evaluates — home/path constants, lock markers and
 * runtime registries read env at module init. So this entry:
 *
 *   1. serves the hidden `__print-env` serializer with no service imports;
 *   2. for `__service` under launchd-user/systemd-user, freezes the
 *      protected control snapshot (canonical home from argv/supervisor env),
 *      captures the login-shell environment (bounded, nonce-framed), applies
 *      it replace-not-merge with protected keys re-applied last, and records
 *      the outcome in RAFT_COMPUTER_SHELL_ENV_STATE;
 *   3. only then dynamically imports the CLI graph (`./cli.js`).
 *
 * Foreground/CLI-detached service and Windows keep byte-identical inherited
 * env (review H1): the capture gate is the OS-supervised kind marker, never
 * a blanket rule. Capture failure falls back to the baseline env and marks
 * the state `unavailable:<code>` — explicit degraded, never silent.
 *
 * The published bin wrapper imports this module and calls `runCliAsMain()`
 * itself (write-dist-bins.mjs contract), so top-level auto-run stays behind
 * the same main guard the previous entry used.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseLegacyOsSupervisorInvocation } from "./osSupervisorLifecycle";
import {
  bootstrapServiceEnv,
  captureShellEnv,
  printEnvMode,
  SHELL_ENV_STATE_ENV_VAR,
} from "./shellEnvCapture";
import { compareRealFiles, type ResolveRealPath } from "./realFileIdentity";
import { resolveSelfExec, selfExecHostFromProcess } from "@botiverse/raft-shared/src/selfExec";
import { runContextViewRestoreChildEntry, runRuntimeDetectionChildEntry } from "./runtimeDetectionEntry";

export { SHELL_ENV_STATE_ENV_VAR };


const seaRequire = createRequire(import.meta.url);
function isSeaEntry(): boolean {
  try {
    return (seaRequire("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

/** Published bin name (package.json "bin", install.sh BIN_NAME). */
const PRODUCT_BIN_NAME = "raft-computer";

/** Basename that works on both separator conventions regardless of host. */
function binaryBasename(binaryPath: string): string {
  return binaryPath.slice(
    Math.max(binaryPath.lastIndexOf("/"), binaryPath.lastIndexOf("\\")) + 1,
  );
}

/**
 * Does this argv token reference the running binary itself? Node SEA copies
 * the OS argv[0] spelling into argv[1]: an absolute launch carries the full
 * path, but a shell PATH launch carries the bare command name (task #423).
 * A separator-free token is compared by on-disk basename; anything with a
 * separator must resolve to the same on-disk file. The real-file comparison
 * matters on macOS, where mktemp spells a candidate under /var/folders while
 * process.execPath can expose the same file under /private/var/folders. If
 * either lookup fails, treat the token as non-self: swallowing an unproven
 * absolute argument is worse than forwarding it. Windows PATH lookup is
 * case-insensitive and appends .exe, so tolerate both there — nowhere else.
 */
function isSelfArgvToken(
  token: string | undefined,
  currentBinary: string,
  platform: NodeJS.Platform,
  resolveRealPath: ResolveRealPath,
): boolean {
  if (token === undefined) return false;
  if (token.includes("/") || token.includes("\\")) {
    return compareRealFiles(
      token,
      currentBinary,
      resolveRealPath,
      platform === "win32",
    ) === "same";
  }
  const binaryName = binaryBasename(currentBinary);
  if (token === binaryName) return true;
  if (platform !== "win32") return false;
  const fold = (name: string) => name.toLowerCase().replace(/\.exe$/, "");
  return fold(token) === fold(binaryName);
}

/**
 * Rescue argv double-forwarded by an installed pre-fix carrier (task #423).
 *
 * A ≤1.0.17 carrier launched via PATH failed to recognize its own bare name
 * in the SEA self slot and forwarded it as the first argument, so the K
 * resident received ["raft-computer", <real args…>] and Commander reported
 * an unknown command. K upgrades replace slots, never the installed carrier
 * bytes, so the fixed carrier predicate alone cannot reach machines that
 * already installed a broken carrier — the receiving side must strip the
 * stray token itself. Mutates `argv` in place (at most one token) and only
 * when every leg holds: SEA entry, argv[1] references this binary, and
 * argv[2] is exactly the separator-free published bin name — a slot no real
 * subcommand or positional can legally occupy. A renamed carrier forwards a
 * different token and stays unrescued: this is deliberately narrow, because
 * the strip runs on every startup and over-stripping would out-cost the bug.
 */
export function stripForwardedCarrierName(
  argv: string[],
  deps: {
    isSea?: () => boolean;
    currentBinary?: string;
    platform?: NodeJS.Platform;
    resolveRealPath?: ResolveRealPath;
  } = {},
): boolean {
  if (!(deps.isSea ?? isSeaEntry)()) return false;
  const currentBinary = path.resolve(deps.currentBinary ?? process.execPath);
  const platform = deps.platform ?? process.platform;
  const resolveRealPath = deps.resolveRealPath ?? realpathSync.native;
  if (!isSelfArgvToken(argv[1], currentBinary, platform, resolveRealPath)) return false;
  const token = argv[2];
  if (token === undefined || token.includes("/") || token.includes("\\")) return false;
  const matchesProductName = token === PRODUCT_BIN_NAME ||
    (platform === "win32" &&
      token.toLowerCase().replace(/\.exe$/, "") === PRODUCT_BIN_NAME);
  if (!matchesProductName) return false;
  argv.splice(2, 1);
  return true;
}



/**
 * Argv vector that re-executes this exact entry (SEA binary or Node +
 * execArgv + script) — see CaptureShellEnvDeps.selfExec.
 */
export function buildSelfExecArgv(): string[] {
  const { command, args } = resolveSelfExec([], selfExecHostFromProcess(process, isSeaEntry()));
  return [command, ...args];
}

export async function bootstrapSupervisedServiceEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  capture: typeof captureShellEnv = () => captureShellEnv({ selfExec: buildSelfExecArgv() }),
): Promise<"skipped" | "inherited" | `unavailable:${string}`> {
  return bootstrapServiceEnv(argv, env, capture);
}

export interface CliEntryModule {
  runCliAsMain(): void;
}

/**
 * The composed production boot path, injectable so the B1 ordering tooth can
 * execute THIS function (task #328): the supervised bootstrap must settle
 * before the CLI graph's first module-scope evaluation. All defaults are the
 * production values — runMain is a pure delegation.
 */
export async function bootstrapThenRun(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  capture?: typeof captureShellEnv,
  importCli: () => Promise<CliEntryModule> = () => import("./cli"),
  writeDiagnostic: (message: string) => void = (message) =>
    process.stderr.write(message),
  stripCarrierName: (argv: string[]) => boolean = stripForwardedCarrierName,
  runBundledCli: (argv: string[]) => Promise<void> = async (cliArgv) => {
    const { runBundledRaftCli } = await import("@botiverse/raft-daemon/bundled-cli");
    await runBundledRaftCli(cliArgv);
  },
  runRuntimeDetectionChild: () => Promise<number> = runRuntimeDetectionChildEntry,
): Promise<void> {
  const legacyInvocation = parseLegacyOsSupervisorInvocation(argv);
  if (legacyInvocation) {
    // Historical manager definitions may briefly retry after a best-effort
    // uninstall fails. Refuse that retired entry before shell capture, CLI
    // import, or Computer ownership state so it can never become a peer.
    writeDiagnostic(
      `raft-computer: retired_os_supervisor_entry_ignored kind=${legacyInvocation.kind}\n`,
    );
    return;
  }
  // Repair a pre-fix carrier's double-forwarded self name BEFORE the CLI graph
  // parses argv. `argv` defaults to process.argv, which Commander reads, so the
  // in-place strip is what makes the rescue reach the parser.
  stripCarrierName(argv);
  // Hidden `__cli` mode (every agent `raft` call on a SEA Computer): load ONLY
  // the bundled CLI. Going through the Computer CLI graph (`./cli`) and the
  // daemon core first cost ~0.3 GiB and seconds per call.
  if (argv[2] === "__cli") {
    await runBundledCli(argv.slice(3));
    return;
  }
  // task #1268: `<exe> __detect-runtimes` is the runtime detection child the
  // hosted daemon spawns for one detection round (streams JSON lines, exits).
  // `<exe> __restore-context-view`: one View Context restore, out of the daemon's heap.
  if (argv[2] === "__restore-context-view") {
    process.exitCode = await runContextViewRestoreChildEntry();
    return;
  }
  if (argv[2] === "__detect-runtimes") {
    process.exitCode = await runRuntimeDetectionChild();
    return;
  }
  await bootstrapSupervisedServiceEnv(argv, env, capture);
  const cli = await importCli();
  cli.runCliAsMain();
}

async function runMain(): Promise<void> {
  await bootstrapThenRun();
}

/** Wrapper-compatible sync launcher (write-dist-bins.mjs contract). */
export function runCliAsMain(): void {
  void runMain();
}

if (process.argv.includes("__print-env")) {
  printEnvMode(process.argv);
} else {
  runEntryMainGuard();
}

function runEntryMainGuard(): void {
  const invokedAsMain =
    isSeaEntry() ||
    (process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(process.argv[1]).href);
  if (invokedAsMain) {
    // The daemon's per-address connect attempt (daemon connectAttemptTimeout.ts,
    // #proj-raft-computer:#47) for this process too: attach, login, upgrade and
    // installer calls to the server go out from here, not from a daemon.
    if (net.getDefaultAutoSelectFamilyAttemptTimeout() < 2_500) net.setDefaultAutoSelectFamilyAttemptTimeout(2_500);
    runCliAsMain();
  }
}
