// command.guidance (RFC 072 §7.4): an agent does not run a consequential
// command whose usage guidance it has not had in its current model context.
//
// - `--help` always prints the guidance in full, before Usage, and counts as
//   delivery once flushed.
// - Hold: the first run in a context does not execute. "Not executed" comes
//   first (truncation must never hide it), then the guidance — byte-identical
//   to the `--help` section — then the equivalent active command.
// - Attach: when delivery cannot be tracked or recorded, the command executes
//   and the guidance precedes its output on every run.
//
// Delivery is recorded from a stdout write callback (stdout flushed), under
// the contextId read when the decision was made.
import { createHash } from "node:crypto";

import type { Command } from "commander";

import {
  confirmPassiveDelivery,
  enabledContextSignal,
  decidePassiveDelivery,
  passiveAgentId,
  type AttachReason,
  type PassiveTouch,
} from "./passiveEngine";
import { countRendered } from "./renderCounts";
import { cliTraceRuntime, emitCliTraceSpan } from "../transportTrace";

/** Longest guidance a command may carry: it is printed on held and attached runs. */
export const MAX_GUIDANCE_LINES = 12;
export const MAX_GUIDANCE_CHARS = 1200;

type Stdout = Pick<NodeJS.WriteStream, "write">;

export const GUIDANCE_HOLD_HEADER =
  "Not executed: guidance for this command is new to this context. Read it, then run this raft command again unchanged. (GUIDANCE_DELIVERED)";

const ATTACH_HEADERS: Record<AttachReason, string> = {
  no_compaction_reports: "Executed. Guidance attached: this runtime does not report context compaction, so it is shown on every use.",
  ledger_unwritable: "Executed. Guidance attached: this agent's local record cannot be written, so it is shown on every use.",
};

/**
 * Guidance is printed whole on held and attached runs, so its size is a
 * contract, enforced where a command is registered: an oversized guidance
 * fails every test that builds the CLI, instead of being truncated at run time.
 */
export function assertGuidanceWithinLimits(commandName: string, guidance: string): void {
  const lines = guidance.split("\n").length;
  if (lines > MAX_GUIDANCE_LINES || guidance.length > MAX_GUIDANCE_CHARS) {
    throw new Error(
      `Guidance for "${commandName}" is ${lines} lines / ${guidance.length} characters; the limit is ${MAX_GUIDANCE_LINES} / ${MAX_GUIDANCE_CHARS}.`,
    );
  }
}

export function guidanceRev(guidance: string): string {
  return createHash("sha256").update(guidance).digest("hex").slice(0, 16);
}

export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

function touchFor(path: string, guidance: string): PassiveTouch {
  return { type: "command.guidance", id: path, rev: guidanceRev(guidance) };
}

/**
 * One span per run of a command that carries guidance, wherever passive AX is
 * on (#wg-ax:#25): whether it was held, attached or passed, the command, a
 * hash of its arguments, and the context, the one the decision used. A held
 * run followed by the next run in the same context shows whether the hold
 * changed what the agent did (same hash) or not. Tracing never affects the
 * command: any failure here is dropped.
 */
function traceGuidanceDecision(
  path: string,
  decision: ReturnType<typeof decidePassiveDelivery>,
  agentId: string | undefined,
  argsHash: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  try {
    if (!agentId || !decision.contextId) return;
    emitCliTraceSpan("cli.guidance.decision", {
      producer: "cli",
      command: path,
      decision: decision.deliver,
      reason: decision.deliver === "attach" ? decision.reason : undefined,
      args_hash: argsHash,
      context_id: decision.contextId,
      runtime: cliTraceRuntime(env),
      agentId,
    }, { status: "ok", kind: "internal" }, env);
  } catch {
    // Tracing must never affect the command.
  }
}

/** `--help`: always the full guidance, before Usage; recorded once flushed. */
export function attachGuidanceToHelp(
  command: Command,
  guidance: string,
  options: { env?: NodeJS.ProcessEnv; stdout?: Stdout } = {},
): void {
  const env = options.env ?? process.env;
  let pending: { agentId: string; contextId: string } | null = null;
  command.addHelpText("before", () => {
    const agentId = passiveAgentId(env);
    // Printed regardless; booked only when passive AX is on for this launch.
    const signal = agentId ? enabledContextSignal(env) : undefined;
    pending = agentId && signal?.compactionReported
      ? { agentId, contextId: signal.contextId }
      : null;
    return `${guidance}\n`;
  });
  command.on("afterHelp", () => {
    const delivered = pending;
    pending = null;
    if (!delivered) return;
    const touch = touchFor(commandPath(command), guidance);
    // A failed write (EPIPE from `| head`, a closed pipe) delivered nothing:
    // record only when the flush succeeded.
    (options.stdout ?? process.stdout).write("", (error?: Error | null) => {
      if (!error) confirmPassiveDelivery(delivered.agentId, touch, delivered.contextId, env);
    });
  });
}

/**
 * Before the handler: "execute" (after writing the guidance first, in attach
 * mode) or "held" (the guidance was delivered instead; the caller raises
 * GUIDANCE_DELIVERED and nothing is sent).
 */
export function gateCommandGuidance(
  path: string,
  guidance: string,
  stdout: Stdout,
  env: NodeJS.ProcessEnv = process.env,
  /** A hash of this run's arguments, so a held run and the run after it can be compared (same or changed). */
  argsHash?: string,
): "execute" | "held" {
  const agentId = passiveAgentId(env);
  const touch = touchFor(path, guidance);
  const decision = decidePassiveDelivery(agentId, touch, env);
  traceGuidanceDecision(path, decision, agentId, argsHash, env);
  switch (decision.deliver) {
    case "pass":
      return "execute";
    case "attach": {
      const text = `${ATTACH_HEADERS[decision.reason]}\n${guidance}\n\n`;
      stdout.write(text);
      countRendered(agentId, "command_guidance", text, env);
      return "execute";
    }
    case "hold": {
      const text = `${GUIDANCE_HOLD_HEADER}\n\n${guidance}\n\nEquivalent: raft ${path} --help\n`;
      stdout.write(text);
      countRendered(agentId, "command_guidance", text, env);
      stdout.write("", (error?: Error | null) => {
        if (!error) confirmPassiveDelivery(agentId, touch, decision.contextId, env);
      });
      return "held";
    }
  }
}
