/**
 * Terminal-equivalent environment capture (task #326, contract v4).
 *
 * Product contract: the whole Computer process tree gets the environment a
 * user's real login+interactive shell would produce ("整棵 Computer 用户进程树
 * = Terminal 启动环境", xxchan 7/19). The service captures it ONCE at boot,
 * before any env consumer module evaluates (bootstrap seam in index.ts), and
 * replaces its own process.env; runners/runtimes/tools inherit naturally.
 *
 * Mechanics (Sora review B1/B2/SF1/SF2, ruling 586f11ab):
 *  - The user's login shell (os.userInfo().shell, passwd truth — never $SHELL
 *    from the possibly-minimal supervisor env) runs `-ilc` and execs THIS
 *    binary's hidden `__print-env` mode, which serializes its own environment
 *    (post-rc) over a private Unix domain socket the parent listens on. The
 *    sink is established by the helper AFTER the rc chain completes — a fixed
 *    inherited fd does not survive real rc files (command substitution
 *    reuses/closes descriptors; Sora Linux-bed RED 91a16cbc). rc stdout/
 *    stderr noise cannot corrupt the frame; a fake `env` on PATH is bypassed
 *    because the serializer is our exact binary.
 *  - Bounded: no TTY, stdin closed, hard timeout, output size cap. Any
 *    violation is a typed failure; the caller falls back to the baseline env
 *    and the machine enters an explicit degraded state (never silent).
 *  - Replace-not-merge: parent keys absent from the snapshot are deleted;
 *    the snapshot is applied verbatim; a closed set of Raft control keys is
 *    re-applied last so rc files cannot alter machine identity/ownership.
 *    One exception: when the shell sets no proxy, the proxy variables the
 *    service was started with are kept (withInheritedProxyEnv).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Narrow subpath: this module is the pre-service-graph boot seam (shell-env
// entry), so it must not evaluate the whole shared barrel.
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared/src/clock";

export const SHELL_ENV_STATE_ENV_VAR = "RAFT_COMPUTER_SHELL_ENV_STATE";
/** Set to "1" in the macOS login-carrier plist: marks a launchd login boot so
 * the service re-reads the user's login shell environment (the source of
 * truth for proxy settings) instead of relying on the plist snapshot. */
export const LOGIN_CARRIER_ENV_VAR = "RAFT_COMPUTER_LOGIN_CARRIER";
/** Set to "0" to keep an unsupervised `__service` on the env it was started
 * with (dev harnesses that configure the service through env and want no rc
 * involvement). Login-carrier boots ignore it. */
export const SHELL_ENV_IMPORT_ENV_VAR = "RAFT_COMPUTER_SHELL_ENV_IMPORT";
export const SHELL_ENV_CAPTURE_TIMEOUT_MS = 10_000;
export const SHELL_ENV_CAPTURE_MAX_BYTES = 1024 * 1024;

/** Raft control keys a user rc must never override (re-applied last). */
export const SHELL_ENV_PROTECTED_KEYS = [
  "SLOCK_HOME",
  "RAFT_HOME",
  "RAFT_COMPUTER_CLI_PATH",
  "RAFT_COMPUTER_SUPERVISOR_OWNER",
  "RAFT_COMPUTER_PARENT_MUTATION_LOCK_HELD",
  "RAFT_COMPUTER_SOURCE_SERVICE_PID",
] as const;

export const SHELL_ENV_CAPTURE_FAILURE_CODES = [
  "SHELL_ENV_UNSUPPORTED_PLATFORM",
  "SHELL_ENV_UNSUPPORTED_SHELL",
  "SHELL_ENV_SPAWN_FAILED",
  "SHELL_ENV_TIMEOUT",
  "SHELL_ENV_OUTPUT_TOO_LARGE",
  "SHELL_ENV_BAD_FRAME",
  "SHELL_ENV_SHELL_EXITED_NONZERO",
] as const;

export type ShellEnvCaptureFailureCode = (typeof SHELL_ENV_CAPTURE_FAILURE_CODES)[number];

/** Closed set of persistable shell-env outcomes ("inherited" + 7 failures). */
export function isShellEnvOutcome(value: string): boolean {
  if (value === "inherited") return true;
  if (!value.startsWith("unavailable:")) return false;
  return (SHELL_ENV_CAPTURE_FAILURE_CODES as readonly string[]).includes(
    value.slice("unavailable:".length),
  );
}

export type ShellEnvCaptureResult =
  | { ok: true; env: Record<string, string>; shell: string; durationMs: number }
  | { ok: false; code: ShellEnvCaptureFailureCode; detail: string; shell?: string };

/** Shells whose `-l -i -c` contract we have verified. */
const SUPPORTED_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

export function resolveLoginShell(
  userInfoFn: () => { shell?: string | null } = () => os.userInfo(),
): string | null {
  try {
    const shell = userInfoFn().shell;
    return shell && shell.startsWith("/") ? shell : null;
  } catch {
    return null;
  }
}

/**
 * Serialize this process's environment for the capture pipe. Format:
 *   RAFT-ENV1 <nonce>\n
 *   <key>=<value>\0  (repeated; values may contain any byte except NUL)
 *   RAFT-ENV1-END <nonce>\n
 * Executed in `__print-env` mode AFTER the user's rc chain has run (we are
 * exec'd by the interactive login shell), so process.env IS the shell env.
 */
export function serializeEnvFrame(nonce: string, env: NodeJS.ProcessEnv): Buffer {
  const parts: Buffer[] = [Buffer.from(`RAFT-ENV1 ${nonce}\n`, "utf8")];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.length === 0 || key.includes("=") || key.includes("\0")) continue;
    if (value.includes("\0")) continue;
    parts.push(Buffer.from(`${key}=${value}\0`, "utf8"));
  }
  parts.push(Buffer.from(`RAFT-ENV1-END ${nonce}\n`, "utf8"));
  return Buffer.concat(parts);
}

/** Strict frame parse: any bytes before the header or after the trailer fail. */
export function parseEnvFrame(
  raw: Buffer,
  nonce: string,
): Record<string, string> | null {
  const header = Buffer.from(`RAFT-ENV1 ${nonce}\n`, "utf8");
  const trailer = Buffer.from(`RAFT-ENV1-END ${nonce}\n`, "utf8");
  if (!raw.subarray(0, header.length).equals(header)) return null;
  if (!raw.subarray(raw.length - trailer.length).equals(trailer)) return null;
  const body = raw.subarray(header.length, raw.length - trailer.length);
  const env: Record<string, string> = {};
  let start = 0;
  while (start < body.length) {
    const nul = body.indexOf(0, start);
    if (nul === -1) return null;
    const entry = body.subarray(start, nul).toString("utf8");
    const eq = entry.indexOf("=");
    if (eq <= 0) return null;
    const key = entry.slice(0, eq);
    // Duplicate keys are ambiguous, not last-wins: reject the whole frame.
    if (key in env) return null;
    env[key] = entry.slice(eq + 1);
    start = nul + 1;
  }
  return env;
}

export interface CaptureShellEnvDeps {
  /**
   * Argv vector that re-executes THIS Computer entry (Hao blocker fix):
   * SEA = [execPath]; npm wrapper / TS-loader dev = [execPath, ...execArgv,
   * scriptPath]. Each element is POSIX-quoted individually; a bare
   * process.execPath would exec Node without our entry in non-SEA forms and
   * permanently degrade every npm-form supervised service.
   */
  selfExec?: string[];
  spawnFn?: typeof spawn;
  /** Test seam: environment for the probe shell (e.g. fixture $HOME). */
  spawnEnv?: NodeJS.ProcessEnv;
  resolveShell?: () => string | null;
  /** Test seam: raw signal sender (observes the no-target no-KILL rule). */
  killFn?: typeof process.kill;
  timeoutMs?: number;
  maxBytes?: number;
  platform?: NodeJS.Platform;
  nowMs?: () => number;
}

/**
 * Run the user's login shell interactively and capture the environment our
 * own `__print-env` helper observes after rc initialization.
 */
export function captureShellEnv(
  deps: CaptureShellEnvDeps = {},
): Promise<ShellEnvCaptureResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return Promise.resolve({
      ok: false,
      code: "SHELL_ENV_UNSUPPORTED_PLATFORM",
      detail: `shell environment capture is POSIX-only (platform=${platform})`,
    });
  }
  const shell = (deps.resolveShell ?? resolveLoginShell)();
  const shellName = shell ? path.basename(shell) : "";
  if (!shell || !SUPPORTED_SHELLS.has(shellName)) {
    return Promise.resolve({
      ok: false,
      code: "SHELL_ENV_UNSUPPORTED_SHELL",
      detail: `unsupported or missing login shell: ${shell ?? "(none)"}`,
      ...(shell ? { shell } : {}),
    });
  }

  const selfExec = deps.selfExec ?? [process.execPath];
  const timeoutMs = deps.timeoutMs ?? SHELL_ENV_CAPTURE_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? SHELL_ENV_CAPTURE_MAX_BYTES;
  const nowMs = deps.nowMs ?? currentTimeMs;
  const killFn = deps.killFn ?? process.kill.bind(process);
  const nonce = randomUUID();
  // Private socket dir (0700 via umask-independent mkdtemp mode on POSIX);
  // short name keeps the path under the AF_UNIX limit.
  let sockDir: string;
  try {
    sockDir = mkdtempSync(path.join(os.tmpdir(), "raft-se-"));
  } catch (error) {
    return Promise.resolve({
      ok: false,
      code: "SHELL_ENV_SPAWN_FAILED",
      detail: error instanceof Error ? error.message : String(error),
      shell,
    });
  }
  const sockPath = path.join(sockDir, "s");
  // Single-quote every argv element for the shell command line; POSIX shells
  // take no interpolation inside single quotes, and quotes are escaped.
  const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;
  const command = `exec ${selfExec.map(quote).join(" ")} __print-env --nonce ${nonce} --sock ${quote(sockPath)}`;

  return new Promise((resolve) => {
    const startedAt = nowMs();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    // Two-authority join (Hao c8aced7c): success requires BOTH a valid
    // complete frame AND child close 0 — a writer that flushes a frame and
    // exits nonzero must still fail, exactly as the fd transport did.
    let parsedEnv: Record<string, string> | null = null;
    let childClosedZero = false;

    const server = net.createServer();
    const cleanup = () => {
      try { server.close(); } catch { /* already closed */ }
      try { rmSync(sockDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    let groupKillArmed = false;
    const killGroup = () => {
      // TERM the whole probe process group first, then KILL after a short
      // grace. Killing only the shell would leave rc-spawned grandchildren
      // alive. Idempotent: a post-settle error must not arm a second timer.
      if (groupKillArmed) return;
      groupKillArmed = true;
      const pid = child?.pid;
      if (!pid) return;
      let delivered = false;
      try {
        killFn(-pid, "SIGTERM");
        delivered = true;
      } catch {
        delivered = child?.kill("SIGTERM") === true;
      }
      // ESRCH on the group AND a dead child mean there is nothing left to
      // reap. Arming the delayed SIGKILL anyway would target whatever
      // process group the kernel hands that pgid next (Sora 33911406).
      if (!delivered) return;
      const killTimer = setClockTimeout(() => {
        try { killFn(-pid, "SIGKILL"); } catch { child?.kill("SIGKILL"); }
      }, 1000) as { unref?: () => void };
      killTimer.unref?.();
    };
    const settle = (result: ShellEnvCaptureResult) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      cleanup();
      resolve(result);
    };
    const timer = setClockTimeout(() => {
      killGroup();
      settle({
        ok: false,
        code: "SHELL_ENV_TIMEOUT",
        detail: `no complete environment frame within ${timeoutMs}ms`,
        shell,
      });
    }, timeoutMs);

    let framePromise: Promise<Buffer | null> | null = null;
    server.on("connection", (socket) => {
      if (framePromise !== null) {
        // One frame source only; late/extra connections are dropped.
        socket.destroy();
        return;
      }
      framePromise = new Promise((resolveFrame) => {
        socket.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            socket.destroy();
            killGroup();
            settle({
              ok: false,
              code: "SHELL_ENV_OUTPUT_TOO_LARGE",
              detail: `environment frame exceeded ${maxBytes} bytes`,
              shell,
            });
            resolveFrame(null);
            return;
          }
          chunks.push(chunk);
        });
        socket.on("error", () => resolveFrame(null));
        socket.on("end", () => resolveFrame(Buffer.concat(chunks)));
      });
      void framePromise.then((frame) => {
        if (settled || frame === null) return;
        const env = parseEnvFrame(frame, nonce);
        if (!env) {
          killGroup();
          settle({
            ok: false,
            code: "SHELL_ENV_BAD_FRAME",
            detail: "environment frame failed strict nonce/framing parse",
            shell,
          });
          return;
        }
        parsedEnv = env;
        if (childClosedZero) {
          killGroup();
          settle({ ok: true, env, shell, durationMs: nowMs() - startedAt });
        }
        // Otherwise wait for child close: nonzero must win over a flushed
        // frame; a hang keeps the hard timeout in charge.
      });
    });
    server.on("error", (error) => {
      // Post-spawn terminal failure: reap the probe group BEFORE settling —
      // settle clears the hard timeout, so nothing else would ever clean a
      // detached grandchild (Hao HOLD 290fa91f).
      killGroup();
      settle({
        ok: false,
        code: "SHELL_ENV_SPAWN_FAILED",
        detail: `capture socket failed: ${error.message}`,
        shell,
      });
    });

    server.listen(sockPath, () => {
      try {
        // New process group (detached) so timeout can kill the WHOLE tree:
        // rc files may spawn arbitrary grandchildren.
        child = (deps.spawnFn ?? spawn)(shell, ["-i", "-l", "-c", command], {
          stdio: ["ignore", "ignore", "ignore"],
          detached: true,
          ...(deps.spawnEnv ? { env: deps.spawnEnv } : {}),
        });
      } catch (error) {
        settle({
          ok: false,
          code: "SHELL_ENV_SPAWN_FAILED",
          detail: error instanceof Error ? error.message : String(error),
          shell,
        });
        return;
      }
      child.on("error", (error) => {
        killGroup();
        settle({
          ok: false,
          code: "SHELL_ENV_SPAWN_FAILED",
          detail: error.message,
          shell,
        });
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        if (exitCode !== 0) {
          // Nonzero close wins even over an already-flushed valid frame
          // (fd-transport parity); reap the group before settlement clears
          // the only remaining cleanup trigger.
          killGroup();
          settle({
            ok: false,
            code: "SHELL_ENV_SHELL_EXITED_NONZERO",
            detail: `login shell exited with ${exitCode}`,
            shell,
          });
          return;
        }
        childClosedZero = true;
        if (parsedEnv) {
          killGroup();
          settle({ ok: true, env: parsedEnv, shell, durationMs: nowMs() - startedAt });
        }
        // Exit 0 with no (complete) frame: the helper's write may still be
        // in flight — the frame join or the hard timeout decides.
      });
    });
  });
}

/**
 * Replace-not-merge application (review B2): delete parent-only keys, apply
 * the snapshot verbatim, then re-apply the protected Raft control keys from
 * their pre-capture values.
 */
export function applyCapturedEnv(
  target: NodeJS.ProcessEnv,
  captured: Record<string, string>,
): void {
  const protectedValues: Array<[string, string | undefined]> =
    SHELL_ENV_PROTECTED_KEYS.map((key) => [key, target[key]]);
  for (const key of Object.keys(target)) {
    if (!(key in captured)) delete target[key];
  }
  for (const [key, value] of Object.entries(captured)) {
    target[key] = value;
  }
  for (const [key, value] of protectedValues) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

/** Variables that pick a proxy (any non-blank one means "this env has a proxy"). */
export const PROXY_URL_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
export const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;

function hasProxyUrl(env: Readonly<Record<string, string | undefined>>): boolean {
  return PROXY_URL_ENV_KEYS.some((key) => (env[key] ?? "").trim() !== "");
}

function setValues(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Array<[string, string]> {
  return keys.flatMap((key): Array<[string, string]> => {
    const value = env[key];
    return value !== undefined && value.trim() !== "" ? [[key, value]] : [];
  });
}

/**
 * The login shell is the proxy authority only when it defines a proxy. A proxy
 * that lives only outside the shell (e.g. the macOS system proxy, which Raft
 * Desktop resolves and passes in as HTTPS_PROXY/HTTP_PROXY/NO_PROXY) would
 * otherwise be erased by the replace-not-merge apply. So: when the captured
 * env sets no proxy URL variable and the inherited env does, the inherited
 * proxy URL variables are kept, and so is its NO_PROXY (both spellings
 * replace the shell's, since it was chosen together with that proxy). A
 * shell that sets any proxy URL variable wins wholesale, as before; with no
 * inherited proxy the captured env is returned unchanged (direct).
 */
export function withInheritedProxyEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  captured: Record<string, string>,
): Record<string, string> {
  if (hasProxyUrl(captured) || !hasProxyUrl(inherited)) return captured;
  const merged: Record<string, string> = { ...captured };
  for (const [key, value] of setValues(inherited, PROXY_URL_ENV_KEYS)) merged[key] = value;
  const inheritedNoProxy = setValues(inherited, NO_PROXY_ENV_KEYS);
  if (inheritedNoProxy.length > 0) {
    for (const key of NO_PROXY_ENV_KEYS) delete merged[key];
    for (const [key, value] of inheritedNoProxy) merged[key] = value;
  }
  return merged;
}

// ── Service boot seam (moved from index.ts so hosts other than the CLI entry —
// Raft Desktop's app-hosted `__service` — can apply the SAME contract:
// "the whole Computer process tree = Terminal launch environment", task #326).

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Capture + apply the login-shell environment for a `__service` boot: a login
 * carrier boot (a host that sets LOGIN_CARRIER_ENV_VAR), or a CLI-detached one
 * on macOS and Linux. Must run BEFORE the service module graph loads.
 */
export async function bootstrapServiceEnv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  capture: () => Promise<ShellEnvCaptureResult>,
  platform: NodeJS.Platform = process.platform,
): Promise<"skipped" | "inherited" | `unavailable:${string}`> {
  if (!argv.includes("__service")) return "skipped";
  // The macOS login carrier is launchd-driven; its plist sets
  // LOGIN_CARRIER_ENV_VAR so boot re-reads the user's login shell environment
  // (fresh proxy config wins over the plist snapshot, which remains the floor
  // when capture fails).
  const loginCarrier = env[LOGIN_CARRIER_ENV_VAR] === "1";
  // A detached service otherwise inherits whatever env started it: a
  // non-login ssh command, an agent's shell, or (through self-replacement on
  // restart/upgrade) the env of the service it replaces. One start from a
  // minimal PATH then hides every runtime installed in ~/.local/bin until a
  // login-shell stop+start. Read the login shell here too, so the result does
  // not depend on who started the service.
  if (!loginCarrier) {
    if (platform !== "darwin" && platform !== "linux") return "skipped";
    if (env[SHELL_ENV_IMPORT_ENV_VAR] === "0") return "skipped";
  }
  // One-shot boot control bit: consume it BEFORE capture so the inherited
  // login-shell frame cannot carry it back into the long-lived service
  // environment (and from there into every agent/runtime child).
  delete env[LOGIN_CARRIER_ENV_VAR];

  // H2/S1: freeze argv's truth into the CANONICAL env keys BEFORE capture, so
  // the protected snapshot carries argv authority — a rc can neither poison
  // nor omit them.
  const slockHomeArg = argvValue(argv, "--slock-home") ?? argvValue(argv, "--raft-home");
  if (slockHomeArg) env.SLOCK_HOME = slockHomeArg;

  const result = await capture();
  if (result.ok) {
    // A proxy only the starter knew (system proxy) survives a proxy-less shell.
    applyCapturedEnv(env, withInheritedProxyEnv(env, result.env));
    env[SHELL_ENV_STATE_ENV_VAR] = "inherited";
    return "inherited";
  }
  env[SHELL_ENV_STATE_ENV_VAR] = `unavailable:${result.code}`;
  process.stderr.write(
    `raft-computer: shell environment import failed during service boot (${result.code}: ${result.detail}); ` +
      `continuing with the ${loginCarrier ? "login carrier" : "inherited"} environment. Runtime discovery may ` +
      "miss tools available in your terminal until this is resolved.\n",
  );
  return `unavailable:${result.code}`;
}

/**
 * `__print-env`: serialize post-rc env over the parent's private capture
 * socket and exit. The sink is established HERE, after the rc chain has
 * fully run — an inherited fd would not survive real rc files (command
 * substitution reuses/closes descriptors).
 */
export function printEnvMode(argv: string[]): void {
  const nonce = argvValue(argv, "--nonce") ?? "";
  const sockPath = argvValue(argv, "--sock") ?? "";
  const frame = serializeEnvFrame(nonce, process.env);
  const socket = net.connect(sockPath, () => {
    socket.end(frame, () => process.exit(0));
  });
  socket.on("error", () => process.exit(8));
}

