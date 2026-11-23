// The answer tool (#wg-ax:#5, flag continuation_tool_v0): a daemon-local MCP
// tool, `answer_continuation`, on a launch's managed MCP proxy
// (managedMcpRuntimeProxy.ts). A command that paused (exit 10) printed a
// continuation id and its option keys; the tool answers it by running the
// launch's own `raft __continue <id> [choice]` (what `cont` runs) and returns
// that command's output, so an agent does not have to put a heredoc in a shell
// to answer. It is never a Server catalog tool and is never forwarded to the
// Server: the CLI it runs talks to the Server as the agent, as `cont` would.
//
// Boundaries:
// - Who answers is fixed by the launch. The runner (the launch's `raft`
//   wrapper, the runtime's environment, its working directory) is captured
//   when the driver registers the launch's proxy endpoint, and the per-launch
//   token picks the registration. Nothing in the tool's arguments chooses an
//   agent, a binary or an environment, and unknown argument keys are refused.
// - No shell: spawn with an argument array. The id is checked with the shared
//   parser (parseContinuationId) and the choice with the shared option-key
//   rule (isContinuationOptionKey) before anything runs. Text goes only on
//   stdin, capped at CONTINUATION_ANSWER_TOOL_MAX_TEXT_BYTES.
// - Bounded: a timeout (the child's process group gets SIGTERM, then SIGKILL
//   after a grace; the result says what to do next), a cap on the captured
//   stdout and stderr, and the MCP request's cancellation (an interrupted
//   turn) stops the child the same way.
// - The shell's exit-code contract: 0 the command's result, 10 the next
//   question (both normal results), 1 the refusal (an error result), anything
//   else an error result that says so.

import { spawn, type ChildProcess } from "node:child_process";
import { CONTINUATIONS_PILOT_RUNTIMES, type AgentConfig } from "@botiverse/raft-shared";
import {
  CONTINUATION_ANSWER_TOOL_NAME,
  CONTINUATION_PAUSED_EXIT_CODE,
  CONTINUATION_RUN_LEASE_MS,
  isContinuationOptionKey,
  parseContinuationId,
  RAFT_CONTINUATION_TOOL_ENV,
  RAFT_CONTINUATION_VIA_ENV,
} from "@botiverse/raft-shared/src/continuations/index";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** How long one answer may run before the child is killed: a held send's replay is a few server calls. */
export const CONTINUATION_ANSWER_TOOL_TIMEOUT_MS = 60_000;
/**
 * The most an answer's text may be, in UTF-8 bytes. 64 KiB: well above any
 * message an agent writes in one answer; no shared message-size constant fits
 * (the Server bounds a message itself, and refuses through the CLI).
 */
export const CONTINUATION_ANSWER_TOOL_MAX_TEXT_BYTES = 64 * 1024;
/** The most of each of stdout and stderr kept for the result; the rest is read and dropped. */
export const CONTINUATION_ANSWER_TOOL_MAX_OUTPUT_BYTES = 256 * 1024;
/**
 * How long a stopped child (timeout or cancellation) has between SIGTERM and
 * SIGKILL: long enough for the CLI to exit on its own, short enough that a
 * replay cannot carry on for long after the agent stopped waiting.
 */
export const CONTINUATION_ANSWER_TOOL_KILL_GRACE_MS = 2_000;
/** Longer than any option key an ask offers ("a" to "d" today); a choice past it is refused unrun. */
const MAX_CHOICE_LENGTH = 32;
/** The CLI's refusal exit (`cont` refused the answer, its paragraph on stderr). */
const CONTINUATION_REFUSED_EXIT_CODE = 1;

export interface ContinuationAnswerToolLimits {
  timeoutMs: number;
  maxTextBytes: number;
  maxOutputBytes: number;
  killGraceMs: number;
}

const DEFAULT_LIMITS: ContinuationAnswerToolLimits = {
  timeoutMs: CONTINUATION_ANSWER_TOOL_TIMEOUT_MS,
  maxTextBytes: CONTINUATION_ANSWER_TOOL_MAX_TEXT_BYTES,
  maxOutputBytes: CONTINUATION_ANSWER_TOOL_MAX_OUTPUT_BYTES,
  killGraceMs: CONTINUATION_ANSWER_TOOL_KILL_GRACE_MS,
};

/**
 * What runs an answer for one launch, captured when the launch registers its
 * proxy endpoint. Never built from a tool call.
 */
export interface ContinuationAnswerRunner {
  /** The launch's own `raft` wrapper (cliTransport.ts writes it in the launch's transport dir). */
  raftBin: string;
  /** The runtime's environment, with RAFT_CONTINUATION_TOOL and RAFT_CONTINUATION_VIA=tool. */
  env: Readonly<Record<string, string | undefined>>;
  /** The runtime's working directory. */
  cwd?: string;
  /** Test seam: smaller bounds. Production uses the constants above. */
  limits?: Partial<ContinuationAnswerToolLimits>;
}

/**
 * The launch's runner, or null when this launch does not offer the tool: the
 * Server's continuation_tool_v0 flag is off for the agent's server
 * (`AgentConfig.continuationTool`), the runtime is not one the continuation
 * pilot reaches (CONTINUATIONS_PILOT_RUNTIMES), or the host is Windows, where
 * the wrapper is a `.cmd` that only a shell can run.
 */
export function continuationAnswerRunnerForLaunch(input: {
  config: Pick<AgentConfig, "runtime" | "continuationTool">;
  raftBin: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
}): ContinuationAnswerRunner | null {
  if (input.config.continuationTool !== true) return null;
  if (!CONTINUATIONS_PILOT_RUNTIMES.has(input.config.runtime || "claude")) return null;
  if ((input.platform ?? process.platform) === "win32") return null;
  return {
    raftBin: input.raftBin,
    env: { ...input.env, [RAFT_CONTINUATION_TOOL_ENV]: CONTINUATION_ANSWER_TOOL_NAME, [RAFT_CONTINUATION_VIA_ENV]: "tool" },
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}

/** The tool as `tools/list` shows it. */
export function continuationAnswerToolDefinition(): Tool {
  return {
    name: CONTINUATION_ANSWER_TOOL_NAME,
    description:
      "Answers a question a raft command paused on. The id and the choice letters are printed in the question; text is for an option that takes text.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The continuation id printed in the question." },
        choice: { type: "string", description: "The letter of the option you pick." },
        text: { type: "string", description: "Your text, for an option that takes text." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const ALLOWED_KEYS = new Set(["id", "choice", "text"]);

type CheckedAnswer = { id: string; choice?: string; text?: string };

/** The arguments as the tool accepts them, or the error result that refuses them (nothing has run). */
function checkArguments(args: unknown, limits: ContinuationAnswerToolLimits): CheckedAnswer | CallToolResult {
  const usage = "Call answer_continuation with the id the question printed, the letter of your choice, and text only for an option that takes text.";
  if (!args || typeof args !== "object" || Array.isArray(args)) return errorResult(`The arguments must be an object. ${usage}`);
  const raw = args as Record<string, unknown>;
  // Unknown keys are refused rather than ignored: nothing but id, choice and
  // text reaches the command, and an `agentId` or `env` cannot look as if it
  // had been honoured. The launch alone decides who answers.
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) return errorResult(`answer_continuation takes only id, choice and text, not ${unknown.slice(0, 5).join(", ")}. ${usage}`);
  if (typeof raw.id !== "string") return errorResult(`The id is missing. ${usage}`);
  const id = parseContinuationId(raw.id);
  if (id === null) {
    return errorResult(`That is not a continuation id: an id is the 10 letters and digits after "continuation" in the question. ${usage}`);
  }
  let choice: string | undefined;
  if (raw.choice !== undefined) {
    if (typeof raw.choice !== "string" || raw.choice.length > MAX_CHOICE_LENGTH || !isContinuationOptionKey(raw.choice)) {
      return errorResult(`The choice must be one option letter from the question, such as a or b. ${usage}`);
    }
    choice = raw.choice;
  }
  let text: string | undefined;
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string") return errorResult(`The text must be a string. ${usage}`);
    if (Buffer.byteLength(raw.text, "utf8") > limits.maxTextBytes) {
      return errorResult(
        `The text is longer than ${bytesInWords(limits.maxTextBytes)}, so it was not sent and the question is still open. Shorten it and call answer_continuation again with the same id and choice.`,
      );
    }
    // Empty text is no text, as the CLI reads an empty stdin.
    if (raw.text.length > 0) text = raw.text;
  }
  return { id, ...(choice === undefined ? {} : { choice }), ...(text === undefined ? {} : { text }) };
}

const bytesInWords = (bytes: number): string => (bytes >= 1024 && bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`);
const durationInWords = (ms: number): string => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`);

const isResult = (value: CheckedAnswer | CallToolResult): value is CallToolResult => "content" in value;

/** Collects a stream up to `max` bytes; the rest is read and dropped. */
function capture(max: number): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  return {
    push(chunk) {
      const room = max - kept;
      if (room <= 0) {
        dropped += chunk.byteLength;
        return;
      }
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(part);
      kept += part.byteLength;
      dropped += chunk.byteLength - part.byteLength;
    },
    text() {
      const body = Buffer.concat(chunks).toString("utf8");
      return dropped > 0 ? `${body}\n[output cut at ${max} bytes; ${dropped} more bytes not shown]` : body;
    },
  };
}

/** Signal the child's process group (it is detached, so it leads one: the wrapper and the CLI it execs go together). */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Already gone, or no group: fall back to the child itself.
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Stop the child: SIGTERM to its group now, SIGKILL after the grace unless
 * it has closed by then. The caller does not wait for either.
 */
function stopTree(child: ChildProcess, graceMs: number): void {
  signalTree(child, "SIGTERM");
  let closed = child.exitCode !== null || child.signalCode !== null;
  child.once("close", () => {
    closed = true;
  });
  // Unref'd: a stopped child must not keep the daemon alive at shutdown.
  setTimeout(() => {
    // Only while it has not closed: once the leader is gone its pid (and
    // group id) may be reused by an unrelated process.
    if (!closed) signalTree(child, "SIGKILL");
  }, graceMs).unref();
}

const shellLine = (answer: CheckedAnswer): string => `cont ${answer.id}${answer.choice ? ` ${answer.choice}` : ""}`;

/**
 * What to do after a run was stopped part way: check, then wait out the run
 * lease the stopped run still holds (an answer before then is refused as
 * IN_PROGRESS), then answer again. Ends with the command.
 */
const afterStopped = (answer: CheckedAnswer): string =>
  `First check whether it did (for a message, raft message read on the conversation you were writing to). ` +
  `If it did not, wait ${durationInWords(CONTINUATION_RUN_LEASE_MS)} (the stopped run holds the continuation until then), then answer again with the same id and choice, or in a shell: ${shellLine(answer)}`;

/** Test seam and the proxy's cancellation: `signal` aborts the call (the MCP request was cancelled). */
export interface ContinuationAnswerCallOptions {
  signal?: AbortSignal;
}

/**
 * Answer a continuation for the launch `runner` belongs to: check the
 * arguments, run `raft __continue`, and map its exit code as a shell would
 * read it. Never throws and never outlives the timeout.
 */
export async function callContinuationAnswerTool(
  runner: ContinuationAnswerRunner,
  args: unknown,
  options: ContinuationAnswerCallOptions = {},
): Promise<CallToolResult> {
  const limits = { ...DEFAULT_LIMITS, ...runner.limits };
  const checked = checkArguments(args, limits);
  if (isResult(checked)) return checked;
  if (options.signal?.aborted) return cancelledBeforeStart(checked);
  const argv = ["__continue", checked.id, ...(checked.choice === undefined ? [] : [checked.choice])];
  const stdout = capture(limits.maxOutputBytes);
  const stderr = capture(limits.maxOutputBytes);

  return new Promise<CallToolResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      stopTree(child, limits.killGraceMs);
      settle(errorResult(`The answer to continuation ${checked.id} was cancelled and its command stopped; it may or may not have taken effect. ${afterStopped(checked)}`));
    };
    const settle = (result: CallToolResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(runner.raftBin, argv, {
        env: runner.env as NodeJS.ProcessEnv,
        ...(runner.cwd ? { cwd: runner.cwd } : {}),
        // stdin: without text it is /dev/null, not a pipe. The CLI waits up to
        // 1 s for a pipe to start (readAnswerText in the CLI's
        // continuation/_runtime.ts, for a harness that keeps stdin open);
        // /dev/null ends at once, so no text costs no wait and cannot be
        // taken for text. It is also the stdin Claude Code's Bash gives a
        // `cont` typed in a shell, so both ways read the same. With text, a
        // pipe that is written and closed at once.
        stdio: [checked.text === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      settle(spawnFailed(checked, error));
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      // Answered at the SIGTERM, not after the grace or at the child's close:
      // the call already used its whole budget, and the SIGKILL that follows
      // needs no one waiting for it.
      stopTree(child, limits.killGraceMs);
      settle(errorResult(
        `The answer to continuation ${checked.id} did not finish within ${durationInWords(limits.timeoutMs)} and was stopped; it may or may not have taken effect. ${afterStopped(checked)}`,
      ));
    }, limits.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      signalTree(child, "SIGKILL");
      settle(spawnFailed(checked, error));
    });
    child.once("close", (code, signal) => {
      settle(resultFor(checked, code, signal, stdout.text(), stderr.text()));
    });
    if (checked.text !== undefined && child.stdin) {
      // The child may exit before reading (a refusal): a closed pipe is not our error.
      child.stdin.on("error", () => {});
      child.stdin.end(checked.text, "utf8");
    }
  });
}

function cancelledBeforeStart(answer: CheckedAnswer): CallToolResult {
  return errorResult(`The answer to continuation ${answer.id} was cancelled before it ran, so the question is still open. Answer again with the same id and choice, or in a shell: ${shellLine(answer)}`);
}

function spawnFailed(answer: CheckedAnswer, error: unknown): CallToolResult {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return errorResult(
    `This agent's raft command could not be started${code ? ` (${code})` : ""}, so the question is still open. Answer it in a shell instead: ${shellLine(answer)}`,
  );
}

function joined(...parts: string[]): string {
  return parts.map((part) => part.replace(/\n+$/, "")).filter((part) => part.length > 0).join("\n");
}

/** stdout as the command printed it, then its stderr (a warning beside a result) when there is any, as a shell shows both. */
function withDiagnostics(stdout: string, stderr: string): string {
  return stderr.trim().length === 0 ? stdout : joined(stdout, stderr);
}

function resultFor(answer: CheckedAnswer, code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): CallToolResult {
  // Done: the original command's result, as `cont` prints it.
  if (code === 0) return textResult(withDiagnostics(stdout, stderr));
  // Paused again: the next question, which the agent answers the same way.
  if (code === CONTINUATION_PAUSED_EXIT_CODE) return textResult(withDiagnostics(stdout, stderr));
  // Refused: the CLI's paragraph, which ends with its next step, as a shell would show it.
  if (code === CONTINUATION_REFUSED_EXIT_CODE) {
    return errorResult(
      joined(stderr, stdout) ||
        `The answer to continuation ${answer.id} was refused without a reason. Run the original command again, or answer in a shell to see why: ${shellLine(answer)}`,
    );
  }
  const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
  // What the command printed first, the next step last.
  return errorResult(joined(
    stderr,
    stdout,
    `Answering continuation ${answer.id} ${how}, so it is not known whether it took effect. Check first, then answer again or in a shell: ${shellLine(answer)}`,
  ));
}
