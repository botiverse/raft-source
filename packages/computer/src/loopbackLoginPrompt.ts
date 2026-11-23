// The terminal side of the loopback login (loopback login design §6, §9),
// shared by every command that asks for an approval (`login`, `attach`,
// `setup`): decide whether this environment can finish an approval in this
// machine's browser, open it, print the waiting lines, let the person press
// c for a code instead, and trace `login.mode` / `login.loopback.result`.
// The service (services/login.ts) never reads env or stdio; this does.
import { readFileSync } from "node:fs";
import { startBrowser } from "./browserHandoff";
import { info } from "./output";
import type { ComputerApiEvent, LoginModeFallbackReason } from "./lib/events";
import type { ComputerTracer } from "./lib/traceTypes";
import type { LoopbackLoginOptions } from "./services/login";

export interface LoopbackEnvironment {
  /** `--device-code` was given. */
  deviceCodeFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** /proc/sys/kernel/osrelease (Linux): tells WSL apart. */
  readKernelRelease?: () => string;
}

function readKernelRelease(): string {
  return readFileSync("/proc/sys/kernel/osrelease", "utf8");
}

/** WSL: WSL_DISTRO_NAME / WSL_INTEROP, or a Microsoft kernel (as daemon osVariant.ts reads it). */
function isWsl(env: NodeJS.ProcessEnv, read: () => string): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(read());
  } catch {
    return false;
  }
}

/**
 * Why this environment cannot finish an approval by loopback, or undefined
 * when it can (design §6). The server's support, the port and the browser
 * are checked later, by the service.
 */
export function loopbackUnavailableReason(input: LoopbackEnvironment = {}): LoginModeFallbackReason | undefined {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (input.deviceCodeFlag) return "flag";
  const stdinIsTTY = input.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = input.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) return "no_tty";
  if (env.SSH_CONNECTION || env.SSH_TTY) return "ssh";
  if (platform === "linux") {
    // WSL first: WSLg sets DISPLAY, but the Windows browser cannot always
    // reach WSL's 127.0.0.1 (the approval would go through and be lost).
    if (isWsl(env, input.readKernelRelease ?? readKernelRelease)) return "wsl";
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return "no_display";
  }
  return undefined;
}

type RawInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

/**
 * Read single keys on a TTY: `c` calls `onSwitch`; Ctrl-C restores the
 * terminal and interrupts the process as it would have without raw mode.
 * Returns the cleanup (idempotent) that restores the terminal, or null when
 * `input` is not a raw-mode-capable TTY. The terminal is also restored if
 * the process exits while it is installed.
 */
export function installSwitchToCodeKey(options: {
  input: NodeJS.ReadableStream | undefined;
  onSwitch: () => void;
  interrupt?: () => void;
}): (() => void) | null {
  const input = options.input as RawInput | undefined;
  if (!input || input.isTTY !== true || typeof input.setRawMode !== "function" || typeof input.on !== "function") return null;
  const wasRaw = input.isRaw === true;
  const interrupt = options.interrupt ?? (() => process.kill(process.pid, "SIGINT"));
  let active = true;
  const restore = () => {
    try {
      input.setRawMode?.(wasRaw);
    } catch {
      // The terminal is gone; nothing to restore.
    }
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    input.off("data", onData);
    process.off("exit", restore);
    restore();
    input.pause?.();
  };
  const onData = (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (const ch of text) {
      if (ch === "\u0003") {
        cleanup();
        interrupt();
        return;
      }
      if (ch === "c" || ch === "C") {
        cleanup();
        options.onSwitch();
        return;
      }
    }
  };
  input.setRawMode(true);
  process.on("exit", restore);
  input.on("data", onData);
  input.resume?.();
  return cleanup;
}

const FALLBACK_LINES: Partial<Record<LoginModeFallbackReason, string>> = {
  ssh: "Approving with a code: this terminal is an SSH session, so the browser is on another machine.",
  no_display: "Approving with a code: there is no display here to open a browser on.",
  wsl: "Approving with a code: in WSL the browser may not reach this terminal's machine.",
  bind_failed: "Approving with a code: no local port could be opened for the browser to come back to.",
  browser_open_failed: "Approving with a code: the browser could not be opened on this machine.",
  user_chose_code: "Getting a code you can enter on another device…",
};

export interface LoopbackLoginPresenter {
  /** Pass to the service as `LoginOptions.loopback`. */
  readonly options: LoopbackLoginOptions;
  /** Handles the loopback events; true when the event was one of them. */
  handleEvent(event: ComputerApiEvent): boolean;
  /** Stop reading keys and restore the terminal (idempotent). */
  cleanup(): void;
}

export function createLoopbackLoginPresenter(opts: {
  deviceCode?: boolean;
  input?: NodeJS.ReadableStream;
  tracer?: ComputerTracer;
  openBrowser?: (url: string) => Promise<boolean>;
  environment?: Omit<LoopbackEnvironment, "deviceCodeFlag">;
  interrupt?: () => void;
}): LoopbackLoginPresenter {
  const input = opts.input ?? process.stdin;
  const switchToCode = new AbortController();
  let stopKeys: (() => void) | null = null;
  const cleanup = () => {
    stopKeys?.();
    stopKeys = null;
  };
  const unavailableReason = loopbackUnavailableReason({
    // The keys are read from `input`, so it is the stdin that must be a TTY.
    stdinIsTTY: (input as RawInput).isTTY === true,
    ...opts.environment,
    deviceCodeFlag: opts.deviceCode === true,
  });
  const trace = (name: string, attrs: Record<string, string | number | boolean>) => {
    try {
      opts.tracer?.emitEvent(name, { surface: "computer", attrs });
    } catch {
      // Tracing never breaks a login.
    }
  };
  return {
    options: {
      ...(unavailableReason ? { unavailableReason } : {}),
      openBrowser: opts.openBrowser ?? ((url) => startBrowser(url)),
      switchToDeviceCode: switchToCode.signal,
    },
    cleanup,
    handleEvent(event) {
      if (event.kind === "login.mode") {
        trace("computer.login.mode", event.mode === "loopback" ? { mode: "loopback" } : { mode: "device_code", reason: event.reason });
        if (event.mode === "device_code") {
          cleanup();
          const line = FALLBACK_LINES[event.reason];
          if (line) info(line);
        }
        return true;
      }
      if (event.kind === "login.loopback-waiting") {
        info("Approve this Computer in the browser window that just opened.");
        info(`  (if it did not open, open this link in a browser on this machine: ${event.approvalUrl})`);
        if (event.canSwitchToCode) {
          cleanup();
          stopKeys = installSwitchToCodeKey({
            input,
            onSwitch: () => switchToCode.abort(),
            ...(opts.interrupt ? { interrupt: opts.interrupt } : {}),
          });
          if (stopKeys) info("No browser? Press c to get a code you can enter on another device.");
        }
        info(`Keep this command running — it finishes here automatically once you approve (expires in ${event.expiresInSeconds}s).`);
        return true;
      }
      if (event.kind === "login.loopback.result") {
        trace(
          "computer.login.loopback.result",
          event.result === "state_mismatch" ? { result: event.result } : { result: event.result, ms_to_result: event.msToResult },
        );
        if (event.result !== "state_mismatch") cleanup();
        return true;
      }
      if (event.kind === "login.device-code") {
        cleanup();
        // `--pair` was sent: whether the window got the request. Never the id.
        if (event.paired !== undefined) trace("computer.login.pairing", { pairing_sent: true, paired: event.paired });
      }
      return false;
    },
  };
}
