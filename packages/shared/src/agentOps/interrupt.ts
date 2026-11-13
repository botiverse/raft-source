// Interrupt: the one shape for "this call stopped because the model has to
// decide" (today: unread messages in the conversation the call writes to). The
// SDK operations (messages.send, tasks.claim / updateStatus / amend) return
// the same `RaftInterrupted` outcome, whose resume/cancel are `raft` CLI argv
// (`message send --send-draft` / `--discard-draft`, the repeated task
// command), so a gateway handles it without knowing which call it came from:
//
// - show `interrupt.context` to the model (CLI-canonical text);
// - if the model goes ahead, run `interrupt.resume.argv` (the exact `raft`
//   argv; a send's resume reuses the original idempotency key, which is stored
//   with the draft and also given as `resume.idempotencyKey`). An interrupt
//   from an in-process SDK call has no argv: nothing was stored, so resuming
//   is calling the same SDK method again with the same input and
//   `resume.idempotencyKey`;
// - if the model drops it, run `interrupt.cancel.argv` when present. An absent
//   `cancel` means cancelling needs no request: just don't execute `resume`.
//
// `resume` and `cancel` are plain data, never closures. Only the model may run
// them, with one exception: a gateway replaying a call a person already approved
// has no model to ask, and that person made the decision this would put to the
// model, so it may resend once with the same input and key, attesting
// `seenUpToSeq` (docs/contracts/hosted-agent-approvals.md).

import type { AgentApiHeldFreshnessResponse } from "../agentApiMessageContract";
import { projectRaftMessagesInTarget, type RaftMessage } from "./message";
import { hintStep, RAFT_HINTS, type RaftHintStyle } from "./hint";
import type { RaftNextStep } from "./outcome";
import type { ChannelCard, PeerCard } from "./passiveResources";

/**
 * Why the call stopped: `unread_messages` (newer messages in the conversation;
 * any unseen cards ride along in `cards`), `unseen_card` (no new messages:
 * this context has not seen the conversation's card, `conversationCards`), or
 * `thread_target` (a top-level send right after this context read one of the
 * target's threads: `threadTarget`; nothing was sent).
 */
export type RaftInterruptReason = "unread_messages" | "unseen_card" | "thread_target";

export interface RaftInterruptResume {
  /**
   * The exact `raft` argv that carries out the interrupted call (for example
   * `["message", "send", "--send-draft", …]`), when the call ran as a command
   * (the `raft` CLI) and its input is stored. Absent for an
   * in-process SDK call: then resuming means calling the same SDK method again
   * with the same input and `idempotencyKey`.
   */
  argv?: string[];
  /** The interrupted call's original idempotency key, when it has one (a send); resuming reuses it. */
  idempotencyKey?: string;
  /** Fields to add to the original input when resuming (`thread_target`: `targetConfirmed: true`). */
  with?: { targetConfirmed?: true };
}

export interface RaftInterruptCancel {
  /** The exact `raft` argv that releases what the interrupted call left behind (a held send's saved draft). */
  argv: string[];
}

export interface RaftInterrupt {
  reason: RaftInterruptReason;
  /** What happened and what is new, as the CLI prints it; enough for the model to decide in one turn. */
  context: string;
  /** How to go ahead. Always present. */
  resume: RaftInterruptResume;
  /**
   * How to drop the call when it left something to clean up (today: the draft
   * a held send saved). Absent `cancel` means cancelling needs no request:
   * just don't execute `resume`.
   */
  cancel?: RaftInterruptCancel;
  /** The conversation the unread messages are in. */
  target: string;
  /** Cards this context has not seen (`conversationCards`), shown in `context`; `frontier.recordHeld` books them. */
  cards?: { channel?: ChannelCard; peer?: PeerCard };
  /** `thread_target`: the thread under `target` this context read most recently. */
  threadTarget?: string;
  /**
   * The model context the call was made in (`setContext`, or `invoke`'s
   * `contextId`), when there was one: `frontier.recordHeld(interrupt)` books
   * under it whichever view it is called on.
   */
  contextId?: string;
  /** How many newer messages the agent has not seen in this conversation. */
  newMessageCount: number;
  /** The newest of them, previewed; the Server may omit older ones. Empty when withheld. */
  heldMessages: RaftMessage[];
  omittedMessageCount: number;
  /** How many of the unread messages formally @mention this agent. */
  formalMentionCount: number;
  /** The seq the Server considers current for this conversation; attesting it says the model saw the context (or, on an approved replay, that a person decided). */
  seenUpToSeq: number | null;
  /** Reviewer isolation: bodies withheld, only a count. */
  withheld: boolean;
  /**
   * Whether `heldMessages` plus `omittedMessageCount` account for every one of
   * `newMessageCount`. When false the model cannot have seen all of them:
   * `frontier.recordHeld(interrupt)` records nothing, and the model should
   * read the conversation before resuming.
   */
  contextComplete: boolean;
}

/** The outcome of an interrupted call. */
export interface RaftInterrupted {
  ok: true;
  state: "interrupted";
  interrupt: RaftInterrupt;
  next: RaftNextStep | null;
  /** The canonical text; the same as `interrupt.context`. */
  text: string;
}

/** Narrow any outcome (SDK or command registry) to an interrupt, without knowing the command. */
export function isInterrupted(outcome: unknown): outcome is RaftInterrupted {
  return Boolean(outcome) && typeof outcome === "object"
    && (outcome as { state?: unknown }).state === "interrupted"
    && typeof (outcome as { interrupt?: unknown }).interrupt === "object";
}

/** The Server's freshness hold fields an interrupt reads (send, claim and task-write holds share them). */
export type UnreadMessagesHold = Pick<
  AgentApiHeldFreshnessResponse,
  "heldMessages" | "newMessageCount" | "omittedMessageCount" | "mentionAnnotation" | "freshnessContextMode" | "withheldMessageCount" | "seenUpToSeq"
>;

export interface UnreadMessagesInterruptInput {
  target: string;
  hold: UnreadMessagesHold;
  /** Bodies withheld (reviewer isolation requested by the caller, or the Server withheld them). */
  withheld?: boolean;
  context: string;
  resume: RaftInterruptResume;
  cancel?: RaftInterruptCancel;
  /** How hints in the held messages' `text` render (default `cli`). */
  hints?: RaftHintStyle;
}

/** Build the `unread_messages` interrupt from a Server freshness hold. */
export function unreadMessagesInterrupt(input: UnreadMessagesInterruptInput): RaftInterrupt {
  const { hold, target } = input;
  const withheld = input.withheld === true || hold.freshnessContextMode === "withheld";
  const heldMessages = withheld ? [] : projectRaftMessagesInTarget(hold.heldMessages ?? [], target, input.hints);
  const newMessageCount = withheld
    ? (hold.withheldMessageCount ?? hold.newMessageCount ?? 0)
    : (hold.newMessageCount ?? heldMessages.length);
  const omittedMessageCount = withheld ? 0 : (hold.omittedMessageCount ?? 0);
  return {
    reason: "unread_messages",
    context: input.context,
    resume: input.resume,
    ...(input.cancel ? { cancel: input.cancel } : {}),
    target,
    newMessageCount,
    heldMessages,
    omittedMessageCount,
    formalMentionCount: withheld ? 0 : (hold.mentionAnnotation?.formalMentionCount ?? 0),
    seenUpToSeq: typeof hold.seenUpToSeq === "number" ? hold.seenUpToSeq : null,
    withheld,
    contextComplete: !withheld && heldMessages.length + omittedMessageCount >= newMessageCount,
  };
}

/** Resume of an in-process SDK send: no argv (the SDK stores no draft), only the original key to call again with. */
export function inProcessSendResume(idempotencyKey: string): RaftInterruptResume {
  return { idempotencyKey };
}

/** `raft message send --send-draft` for the draft a held send saved, under its original key. */
export function sendDraftResume(target: string, idempotencyKey: string, extraArgv: readonly string[] = []): RaftInterruptResume {
  return {
    argv: ["message", "send", "--send-draft", "--target", target, "--expected-draft-key", idempotencyKey, ...extraArgv],
    idempotencyKey,
  };
}

/** `raft message send --discard-draft` for the draft a held send saved (compare-and-clear on its key). */
export function discardDraftCancel(target: string, idempotencyKey: string, extraArgv: readonly string[] = []): RaftInterruptCancel {
  return { argv: ["message", "send", "--discard-draft", "--target", target, "--expected-draft-key", idempotencyKey, ...extraArgv] };
}

/** `raft task claim` argv for a claim request (resume of a held claim). */
export function taskClaimArgv(target: string, taskNumbers: readonly number[], messageIds: readonly string[], extraArgv: readonly string[] = []): string[] {
  return [
    "task", "claim", "--target", target,
    ...taskNumbers.flatMap((n) => ["--number", String(n)]),
    ...messageIds.flatMap((id) => ["--message-id", id]),
    ...extraArgv,
  ];
}

/** `raft task update` argv (resume of a held status update). */
export function taskUpdateArgv(target: string, taskNumber: number, status: string, extraArgv: readonly string[] = []): string[] {
  return ["task", "update", "--target", target, "--number", String(taskNumber), "--status", status, ...extraArgv];
}

/**
 * A hold's next step. It names the read only when the held text points to
 * one (`renderAgentHold`'s `pointsToRead`: bodies withheld, or the window
 * leaves something out) or the shown messages do not account for the count;
 * otherwise `context` already shows all of it and the step carries no
 * command, so following it never prints the same messages again.
 */
export function heldNextStep(
  kind: string,
  interrupt: RaftInterrupt,
  pointsToRead: boolean,
  why: { read: string; shown: string },
  style: RaftHintStyle,
): RaftNextStep {
  const target = interrupt.target;
  return pointsToRead || !interrupt.contextComplete
    ? hintStep(kind, RAFT_HINTS.messageRead({ target }), why.read, style, { target })
    : { kind, args: { target }, why: why.shown };
}
