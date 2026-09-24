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
import net from "node:net";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  OS_SUPERVISOR_KIND_ENV_VAR,
  parseLegacyOsSupervisorInvocation,
} from "./osSupervisorLifecycle.js";
import {
  applyCapturedEnv,
  captureShellEnv,
  serializeEnvFrame,
  SHELL_ENV_STATE_ENV_VAR,
} from "./shellEnvCapture.js";
import { compareRealFiles, type ResolveRealPath } from "./realFileIdentity.js";

export { SHELL_ENV_STATE_ENV_VAR };

const POSIX_SUPERVISED_KINDS = new Set(["launchd-user", "systemd-user"]);

const seaRequire = createRequire(import.meta.url);
function isSeaEntry(): boolean {
  try {
    return (seaRequire("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

type Execve = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => void;

type SpawnReplacement = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<number>;

async function spawnReplacementChild(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  const child = spawn(file, args, {
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function bootstrapRaftHome(
  env: NodeJS.ProcessEnv,
  homeDir = os.homedir(),
): string {
  const configured = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  const raw = configured && configured.length > 0 ? configured : path.join(homeDir, ".slock");
  const expanded = raw === "~"
    ? homeDir
    : raw.startsWith("~/")
      ? path.join(homeDir, raw.slice(2))
      : raw;
  return path.resolve(expanded);
}

/** Published bin name (package.json "bin", install.sh BIN_NAME). */
const PRODUCT_BIN_NAME = "raft-computer";
const RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR =
  "RAFT_COMPUTER_DISPATCHER_PATH";

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
 * Replace an installed pre-K carrier with K's stable SEA before the stale
 * carrier imports its own CLI/service graph. Stable and experiment binaries
 * recognize their own exact paths, so the handoff cannot recurse.
 */
export async function dispatchToKResident(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    isSea?: () => boolean;
    currentBinary?: string;
    resolveResident?: (
      slockHome: string,
      currentBinary: string,
      isSea: boolean,
    ) => Promise<string>;
    /** null forces the Node-20/no-execve test path. */
    execve?: Execve | null;
    platform?: NodeJS.Platform;
    resolveRealPath?: ResolveRealPath;
    spawnReplacement?: SpawnReplacement;
    setExitCode?: (code: number) => void;
  } = {},
): Promise<boolean> {
  const isSea = (deps.isSea ?? isSeaEntry)();
  if (!isSea) return false;

  const currentBinary = path.resolve(deps.currentBinary ?? process.execPath);
  const platform = deps.platform ?? process.platform;
  const resolveRealPath = deps.resolveRealPath ?? realpathSync.native;
  // Node SEA exposes the invoked executable as argv[1] on the native carrier;
  // ordinary Node-style tests/embedders start user args there instead. Drop
  // only a token that references this binary (exact path, or the bare name a
  // PATH launch passes through — task #423), never a positional by index
  // alone. No subcommand shares the binary's name, so the bare-name form
  // cannot swallow a real argument.
  const forwardedArgs = isSelfArgvToken(
    argv[1],
    currentBinary,
    platform,
    resolveRealPath,
  )
    ? argv.slice(2)
    : argv.slice(1);
  // The official installer executes the newly verified candidate itself so
  // that K can consume those exact bytes. Handing this private mode to the
  // old stable resident would make the candidate identity unverifiable and
  // could re-enter the stale binary that the installer is repairing.
  if (forwardedArgs[0] === "__installer-converge") return false;
  const resolveResident = deps.resolveResident ?? (async (slockHome, binary, sea) => {
    const { resolveKResidentBinary } = await import("./kResidentBinary.js");
    return resolveKResidentBinary(slockHome, binary, sea);
  });
  const resident = path.resolve(await resolveResident(
    bootstrapRaftHome(env),
    currentBinary,
    true,
  ));
  const residentIdentity = compareRealFiles(
    resident,
    currentBinary,
    resolveRealPath,
    platform === "win32",
  );
  if (residentIdentity !== "different") return false;

  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  // The K resident must never persist its replaceable slot path as the macOS
  // login carrier. Bind the pre-dispatch executable before exec/spawn so the
  // resident can prove the stable PATH dispatcher identity.
  cleanEnv[RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR] = currentBinary;
  const nativeExecve = typeof process.execve === "function"
    ? ((file: string, args: string[], childEnv: Record<string, string>) => {
        process.execve!(file, args, childEnv);
      })
    : undefined;
  const execve = deps.execve === null ? undefined : (deps.execve ?? nativeExecve);
  if (platform === "win32" || execve === undefined) {
    // Windows and the Node 20 SEA carrier have no execve. Keep the installed
    // carrier as a transient wrapper, wait for the K-owned child and preserve
    // its CLI exit status. Long-lived service/runner children are spawned
    // directly from the K slot elsewhere, so wrappers do not accumulate.
    const exitCode = await (deps.spawnReplacement ?? spawnReplacementChild)(
      resident,
      forwardedArgs,
      cleanEnv,
    );
    (deps.setExitCode ?? ((code) => { process.exitCode = code; }))(exitCode);
    return true;
  }
  execve(resident, [resident, ...forwardedArgs], cleanEnv);
  return true;
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

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * `__print-env`: serialize post-rc env over the parent's private capture
 * socket and exit. The sink is established HERE, after the rc chain has
 * fully run — an inherited fd would not survive real rc files (command
 * substitution reuses/closes descriptors).
 */
function printEnvMode(argv: string[]): void {
  const nonce = argvValue(argv, "--nonce") ?? "";
  const sockPath = argvValue(argv, "--sock") ?? "";
  const frame = serializeEnvFrame(nonce, process.env);
  const socket = net.connect(sockPath, () => {
    socket.end(frame, () => process.exit(0));
  });
  socket.on("error", () => process.exit(8));
}

/**
 * Argv vector that re-executes this exact entry (SEA binary or Node +
 * execArgv + script) — see CaptureShellEnvDeps.selfExec.
 */
export function buildSelfExecArgv(): string[] {
  if (isSeaEntry()) return [process.execPath];
  return [
    process.execPath,
    ...process.execArgv,
    ...(process.argv[1] !== undefined ? [process.argv[1]] : []),
  ];
}

export async function bootstrapSupervisedServiceEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  capture: typeof captureShellEnv = () => captureShellEnv({ selfExec: buildSelfExecArgv() }),
): Promise<"skipped" | "inherited" | `unavailable:${string}`> {
  if (!argv.includes("__service")) return "skipped";
  const kind = argv.includes("--os-supervised")
    ? argvValue(argv, "--os-supervised")
    : env[OS_SUPERVISOR_KIND_ENV_VAR];
  if (!kind || !POSIX_SUPERVISED_KINDS.has(kind)) return "skipped";

  // H2/S1: freeze the supervisor's truth into the CANONICAL env keys BEFORE
  // capture, so the protected snapshot carries argv authority — a rc can
  // neither poison nor omit them.
  const slockHomeArg = argvValue(argv, "--slock-home") ?? argvValue(argv, "--raft-home");
  if (slockHomeArg) env.SLOCK_HOME = slockHomeArg;
  env[OS_SUPERVISOR_KIND_ENV_VAR] = kind;

  const result = await capture();
  if (result.ok) {
    applyCapturedEnv(env, result.env);
    env[SHELL_ENV_STATE_ENV_VAR] = "inherited";
    return "inherited";
  }
  env[SHELL_ENV_STATE_ENV_VAR] = `unavailable:${result.code}`;
  process.stderr.write(
    `raft-computer: shell environment import failed during service boot (${result.code}: ${result.detail}); ` +
      "continuing with the baseline supervisor environment. Runtime discovery may " +
      "miss tools available in your terminal until this is resolved.\n",
  );
  return `unavailable:${result.code}`;
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
  importCli: () => Promise<CliEntryModule> = () => import("./cli.js"),
  writeDiagnostic: (message: string) => void = (message) =>
    process.stderr.write(message),
  dispatch: (
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<boolean> = dispatchToKResident,
  stripCarrierName: (argv: string[]) => boolean = stripForwardedCarrierName,
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
  if (await dispatch(argv, env)) return;
  // Running as the K resident (or as an already-current carrier): repair a
  // pre-fix carrier's double-forwarded self name BEFORE the CLI graph parses
  // argv. `argv` defaults to process.argv, which Commander reads, so the
  // in-place strip is what makes the rescue reach the parser.
  stripCarrierName(argv);
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
    runCliAsMain();
  }
}
