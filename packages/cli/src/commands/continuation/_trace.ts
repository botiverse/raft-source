// Continuation spans (`cli.continuation.*`), written to the CLI trace file
// the daemon ships (transportTrace.ts), so a pause can be followed to its
// answer, its expiry or a refusal: every span carries the continuation id
// and the agent's runtime. Never the command's arguments, an answer's text
// or the journal: the choice is an option key, the rest are ids, codes and
// times.
import type { AskSpec } from "@botiverse/raft-shared/src/continuations/index";

import { cliTraceRuntime, emitCliTraceSpan } from "../../transportTrace";
import { normalizeVersion, readCliVersion } from "../../version";

export interface ContinuationTraceScope {
  agentId: string;
  serverId: string | null;
  env: NodeJS.ProcessEnv;
}

/** Which kind of ask paused the command: options only, options one of which takes text, or text alone. */
export function continuationAskKind(ask: AskSpec): "choice" | "choice_with_input" | "input" {
  if (ask.options === undefined) return "input";
  return Object.values(ask.options).some((option) => typeof option === "object" && option.input === "stdin")
    ? "choice_with_input"
    : "choice";
}

function emit(
  scope: ContinuationTraceScope,
  name: "cli.continuation.created" | "cli.continuation.answered" | "cli.continuation.refused",
  attrs: Record<string, string | number | boolean | undefined>,
  status: "ok" | "error" = "ok",
): void {
  try {
    emitCliTraceSpan(
      name,
      // `cli_version`: readings split by CLI version (the span's resource carries none).
      { producer: "cli", ...attrs, runtime: cliTraceRuntime(scope.env), cli_version: normalizeVersion(readCliVersion()) ?? undefined, serverId: scope.serverId, agentId: scope.agentId },
      { status, kind: "internal" },
      scope.env,
    );
  } catch {
    // Tracing must never affect the user-visible CLI command result.
  }
}

/** A command paused: the agent was given a continuation to answer. */
export function emitContinuationCreated(
  scope: ContinuationTraceScope,
  fields: {
    id: string;
    rootId: string;
    command: string;
    ask: AskSpec;
    expiresInMs: number;
    /** The command's own attrs (`pilot` for the message send pilot); never content. */
    extra?: Readonly<Record<string, string | number | boolean>>;
  },
): void {
  emit(scope, "cli.continuation.created", {
    ...fields.extra,
    continuation_id: fields.id,
    root_id: fields.rootId,
    command: fields.command,
    ask_kind: continuationAskKind(fields.ask),
    expires_in_ms: fields.expiresInMs,
  });
}

/** An answer ran to an outcome in this call: the command finished, or paused again under a new continuation. */
export function emitContinuationAnswered(
  scope: ContinuationTraceScope,
  fields: { id: string; rootId: string; command: string; choice: string | undefined; outcome: "done" | "paused_again"; elapsedMs: number },
): void {
  emit(scope, "cli.continuation.answered", {
    continuation_id: fields.id,
    root_id: fields.rootId,
    command: fields.command,
    choice: fields.choice,
    outcome: fields.outcome,
    elapsed_ms: Math.max(0, Math.round(fields.elapsedMs)),
  });
}

/**
 * Answering was refused (`code` as the runtime gives it, with the category of
 * an invalid answer), or the store failed (`STORE_FAILED`, status error).
 * `id` is absent when what was typed is not a continuation id at all.
 */
export function emitContinuationRefused(
  scope: ContinuationTraceScope,
  fields: { id: string | undefined; code: string; invalidAnswerCategory?: string },
): void {
  emit(
    scope,
    "cli.continuation.refused",
    { continuation_id: fields.id, code: fields.code, invalid_answer_category: fields.invalidAnswerCategory },
    fields.code === "STORE_FAILED" ? "error" : "ok",
  );
}
