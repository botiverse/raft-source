import { useEffect, useMemo, useState } from "react";
import {
  pollWeChatAttempt,
  refreshWeChatStatus,
  startWeChatAttempt,
  WECHAT_VERIFY_CODE_RE,
  WeChatRequestError,
} from "./wechatClient";
import type { WeChatAttempt, WeChatAttemptStatus } from "./wechatClient";

/** Why connecting stopped; each has its own sentence and offers a new code. */
export type WeChatConnectFailure =
  /** The QR code's few minutes ran out (here, or WeChat said so). */
  | "expired"
  /** The code was spent or replaced (a newer one was made elsewhere). */
  | "used"
  /** Too many wrong verification codes. */
  | "blocked"
  /** WeChat says this account is already connected (iLink `binded_redirect`). */
  | "already_bound"
  /** This WeChat account is connected to another assistant in Raft. */
  | "in_use"
  /** The poll came without this browser's binding cookie. */
  | "unbound"
  /** Too many QR codes in a minute. */
  | "rate_limited"
  /** WeChat couldn't be reached, or answered unexpectedly. */
  | "upstream"
  /** The server no longer offers WeChat here (flag off, no assistant). */
  | "unavailable"
  | "other";

export type WeChatConnectStep =
  | { kind: "disclosure" }
  | { kind: "starting" }
  /** The QR code is shown; `scanned` once WeChat says it was scanned. */
  | { kind: "qr"; attempt: WeChatAttempt; scanned: boolean }
  /** WeChat asked for the code it shows on the phone. */
  | { kind: "verify"; attempt: WeChatAttempt; error: "wrong" | "malformed" | null; checking: boolean }
  | { kind: "connected" }
  | { kind: "failed"; reason: WeChatConnectFailure };

const DEFAULT_DELAYS = Object.freeze({ pollGapMs: 1_000, retryMs: 3_000 });
let delays: { pollGapMs: number; retryMs: number } = DEFAULT_DELAYS;

/**
 * Each poll is itself a long poll (the server waits up to 15 s on WeChat), so
 * the next one goes a second after an answer; a refused-for-now poll (one
 * already running, WeChat unreachable, no network) is tried again after 3 s.
 */
export function setWeChatPollDelaysForTests(next: { pollGapMs: number; retryMs: number } | null): void {
  delays = next ?? DEFAULT_DELAYS;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function startFailure(error: unknown): WeChatConnectFailure | "connected" {
  if (!(error instanceof WeChatRequestError)) return "other";
  switch (error.code) {
    case "wechat_rate_limited": return "rate_limited";
    // Connected after all (another tab, or a status read before it was): show it.
    case "wechat_already_connected": return "connected";
    case "wechat_upstream_unavailable": return "upstream";
    case "wechat_unavailable":
    case "assistant_not_found": return "unavailable";
    default: return error.status === 429 ? "rate_limited" : "other";
  }
}

function pollFailure(error: unknown): WeChatConnectFailure | "retry" | "malformed" {
  if (!(error instanceof WeChatRequestError)) return "retry";
  switch (error.code) {
    case "invalid_verify_code": return "malformed";
    case "wechat_poll_in_flight":
    case "wechat_upstream_unavailable": return "retry";
    case "wechat_attempt_expired": return "expired";
    case "wechat_attempt_used":
    case "wechat_attempt_not_found": return "used";
    case "wechat_attempt_unbound": return "unbound";
    case "wechat_account_in_use": return "in_use";
    case "wechat_upstream_refused": return "upstream";
    case "wechat_unavailable":
    case "assistant_not_found": return "unavailable";
    default: return error.status === null || error.status >= 500 ? "retry" : "other";
  }
}

const FINAL: Partial<Record<WeChatAttemptStatus, WeChatConnectFailure>> = {
  expired: "expired",
  blocked: "blocked",
  already_bound: "already_bound",
};

type Run = {
  controller: AbortController;
  /** Null while the QR code is being made. */
  attempt: WeChatAttempt | null;
  scanned: boolean;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * One connect flow at a time: start (or Get New Code) makes a QR code and
 * polls it until WeChat answers for good, the code expires, or stop. A new
 * start ends the one before; nothing a stopped run learns reaches the view.
 */
class WeChatConnectController {
  private run: Run | null = null;

  constructor(private readonly emit: (step: WeChatConnectStep) => void) {}

  stop = (): void => {
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.controller.abort();
    if (run.timer !== null) clearTimeout(run.timer);
  };

  start = (): void => {
    this.stop();
    const run: Run = { controller: new AbortController(), attempt: null, scanned: false, polling: false, timer: null };
    this.run = run;
    this.emit({ kind: "starting" });
    startWeChatAttempt().then((attempt) => {
      if (this.run !== run) return;
      run.attempt = attempt;
      const left = Date.parse(attempt.expiresAt) - Date.now();
      if (Number.isFinite(left)) run.timer = setTimeout(() => this.fail(run, "expired"), Math.max(0, left));
      this.emit({ kind: "qr", attempt, scanned: false });
      void this.poll(run, null);
    }, (error: unknown) => {
      if (this.run !== run) return;
      const outcome = startFailure(error);
      if (outcome === "connected") this.connected(run);
      else this.fail(run, outcome);
    });
  };

  submitCode = (raw: string): void => {
    const run = this.run;
    if (!run?.attempt || run.polling) return;
    const code = raw.trim();
    if (!WECHAT_VERIFY_CODE_RE.test(code)) {
      this.emit({ kind: "verify", attempt: run.attempt, error: "malformed", checking: false });
      return;
    }
    this.emit({ kind: "verify", attempt: run.attempt, error: null, checking: true });
    void this.poll(run, code);
  };

  private live(run: Run): boolean {
    return this.run === run && !run.controller.signal.aborted;
  }

  private fail(run: Run, reason: WeChatConnectFailure): void {
    if (this.run !== run) return;
    this.stop();
    // No longer offered here: the settings entry follows the status.
    if (reason === "unavailable") void refreshWeChatStatus();
    this.emit({ kind: "failed", reason });
  }

  private connected(run: Run): void {
    if (this.run !== run) return;
    this.stop();
    // The settings entry and the DM notice read the new connection from the status.
    void refreshWeChatStatus().finally(() => this.emit({ kind: "connected" }));
  }

  /** Polls until a final answer, or until WeChat asks for its code (then submitCode goes on). */
  private async poll(run: Run, firstCode: string | null): Promise<void> {
    const attempt = run.attempt;
    if (!attempt) return;
    run.polling = true;
    let code = firstCode;
    try {
      while (this.live(run)) {
        let status: WeChatAttemptStatus;
        try {
          status = await pollWeChatAttempt(attempt.attemptId, { verifyCode: code, signal: run.controller.signal });
        } catch (error) {
          if (!this.live(run)) return;
          const outcome = pollFailure(error);
          if (outcome === "retry") {
            // The code, if one was sent, goes again with the retry.
            await wait(delays.retryMs, run.controller.signal);
            continue;
          }
          if (outcome === "malformed") {
            this.emit({ kind: "verify", attempt, error: "malformed", checking: false });
            return;
          }
          this.fail(run, outcome);
          return;
        }
        if (!this.live(run)) return;
        const sentCode = code !== null;
        code = null;
        if (status === "confirmed") {
          this.connected(run);
          return;
        }
        const final = FINAL[status];
        if (final) {
          this.fail(run, final);
          return;
        }
        if (status === "need_verify_code") {
          // Asked again right after a code: that code was wrong.
          this.emit({ kind: "verify", attempt, error: sentCode ? "wrong" : null, checking: false });
          return;
        }
        // `wait` also answers a long poll that timed out after the scan: scanned stays.
        const scanned = run.scanned || status === "scanned" || sentCode;
        run.scanned = scanned;
        this.emit({ kind: "qr", attempt, scanned });
        await wait(delays.pollGapMs, run.controller.signal);
      }
    } finally {
      run.polling = false;
    }
  }
}

/**
 * The Connect WeChat flow's state: from the disclosure, `start` makes a QR
 * code and follows it; `submitCode` sends WeChat's verification code; `stop`
 * (also on unmount) ends it. The step is what the dialog shows.
 */
export function useWeChatConnect(): {
  step: WeChatConnectStep;
  start: () => void;
  submitCode: (code: string) => void;
  stop: () => void;
} {
  const [step, setStep] = useState<WeChatConnectStep>({ kind: "disclosure" });
  const controller = useMemo(() => new WeChatConnectController(setStep), []);
  useEffect(() => controller.stop, [controller]);
  return { step, start: controller.start, submitCode: controller.submitCode, stop: controller.stop };
}
