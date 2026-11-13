// `raft message send --target <t> [--attachment-id <id>... | --card <file>]`
// → POST /internal/agent-api/v2/send

import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Command } from "commander";
import type {
  AgentApiHeldFreshnessResponse,
  AgentApiSendCommittedResponse,
  AgentApiSendV2Body,
  AgentApiSendSentResponse,
  AgentApiStructuredMention,
  MessageCardInput,
} from "@botiverse/raft-shared";
import {
  currentTimeMs,
  formatAgentThreadTargetCheck,
  MESSAGE_CARD_LIMITS,
  formatAgentDeliveredToAgentsLine,
  formatTaskTargetUseTaskCommand,
  heldSendNothing,
  normalizeAgentDeliveredToAgents,
  parseAgentTaskRef,
  renderAgentHoldPreview,
  structuredRaftMentionStillAppears,
  TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE,
  CONTINUATIONS_DRAFT_FLOW_RUNTIMES,
} from "@botiverse/raft-shared/src/agentCliSurface";
import { detectThreadTargetMismatch, type ThreadTargetMismatch } from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import {
  getConsumedReadOrder,
  getConsumedSeq,
  getConsumedExactSeqs,
  getMostRecentConsumedThreadForParent,
  getParentTargetForThread,
  recordConsumedSeqs,
  wasConsumedEvidenceWithheldForContext,
  type ConsumedThreadTarget,
} from "./_consumedSeqState";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { incrementMetaCounter } from "../../state/agentLedger";
import { channelCardForSend, recordChannelCardShown } from "../../ax/channelCard";
import { peerCardForSend, recordPeerCardShown } from "../../ax/peerCard";
import { countRendered } from "../../ax/renderCounts";
import { cliTraceRuntime } from "../../transportTrace";
import { attachOnEverySend, fetchSendAttachment } from "../../ax/sendAttachment";
import { rateLimitedCliError, rateLimitedResponse } from "../../core/apiFailure";
import { CliError, CliExit, cliError } from "../../core/errors";
import { adoptCliReplyText, writeDiagnostic, writeJson, writeText, NL, type CliReplyText } from "../../core/renderer";
import { elideSeenSenders } from "./_senderElision";
import {
  formatFreshnessHoldOutput,
  redactFreshnessHoldForReviewerIsolation,
  type FreshnessHoldOutputData,
} from "../freshness/_format";
import {
  formatPendingMentionActions,
  normalizePendingMentionActions,
  normalizeUnresolvedMentionHandles,
  toSenderPendingMentionAction,
  toSenderUnresolvedMentionWarning,
} from "../mention/_format";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation";
import {
  clearSavedDraftIfIdempotencyKeyMatches,
  clearSavedDraftIfSavedAt,
  getSavedDraft,
  LOCAL_DRAFT_TTL_MINUTES,
  lookupSavedDraft,
  setSavedDraft,
  type OnDraftExpired,
  type SavedDraft,
} from "./_continueDraftState";
import {
  SEND_DRAFT_STDIN_OBSERVATION_MS,
  formatDraftReplacedSuccess,
  formatDraftReplacedWarning,
  formatMessages,
  formatSendDraftStdinDeadlineDiagnostic,
  formatCardStdinDeadlineDiagnostic,
  formatMessageCardNotStored,
  formatMessageCardSentHint,
  formatSentChannelCard,
  formatSentPeerCard,
  formatSendAttachment,
  isThreadTargetRef,
} from "./_format";
import { archiveReplacedDraft } from "./_replacedDraftHistory";
import {
  assertCardFallback,
  cardMentionsWithoutTextError,
  cardWithAttachmentsError,
  loadCardFile,
  messageCardRefusal,
  shellQuoteArg,
  type LoadedCard,
} from "./_card";
import { emitDraftHeld, emitDraftResolved, type DraftTraceScope } from "./_draftResolvedTrace";
import {
  isContinuationRefusal,
  runContinuable,
  type CliContinuationCommand,
  type ContinuationInvocation,
} from "../continuation/_runtime";
import {
  createSendContinuation,
  type SendAttempt,
  type SendContinuationArgs,
  type SendStepResult,
} from "./_sendContinuation";
import type { SendContinuationOutcome } from "./_format";

// Re-exports for existing imports; canonical home is message/_format.ts.
export {
  DRAFT_REPLACED_EXCERPT_LIMIT,
  SEND_DRAFT_STDIN_OBSERVATION_MS,
  formatDraftReplacedWarning,
  formatSendDraftStdinDeadlineDiagnostic,
} from "./_format";

interface SendOpts extends ReviewerIsolationOpts {
  target: string;
  content?: string;
  attachmentId?: string[];
  mention?: string[];
  sendDraft?: boolean;
  discardDraft?: boolean;
  expectedDraftKey?: string;
  anyway?: boolean;
  targetConfirmed?: boolean;
  peerKind?: string;
  json?: boolean;
  /** RFC 082: post the message as a card read from this JSON file; stdin is then optional (the card's fallback text). */
  card?: string;
}

const MESSAGE_HEREDOC_DELIMITER = "RAFTMSG";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_PATTERN = /^[\p{L}\p{N}_-]+$/u;


interface OptionalSendContentOptions {
  observationWindowMs?: number;
  onNoBytesWithinWindow?: () => void;
}

type MessageSendOutcome =
  | { kind: "held"; data: AgentApiHeldFreshnessResponse }
  | { kind: "committed"; data: AgentApiSendCommittedResponse }
  | { kind: "sent"; data: AgentApiSendSentResponse };

export class SendContentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SendContentError";
  }
}

const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function attachmentIdError(problem: string, target: string | undefined): SendContentError {
  return new SendContentError(
    "ATTACHMENT_ID_INVALID",
    `Not sent: --attachment-id entry ${problem}. `
      + "Use the full ID from the \"Attachment ID:\" line that `raft attachment upload` printed, "
      + "not a file path, a file name, or the whole upload output. "
      + `Not uploaded yet? Run: raft attachment upload --path <file> --target ${JSON.stringify(target ?? "<target>")}`,
  );
}

/**
 * Agents often put several IDs in one flag (`--attachment-id "id1 id2"`), which
 * the server rejects. Split each value on whitespace and commas and drop
 * repeats (the server rejects an ID given twice). A value that yields nothing
 * (an empty variable) or a piece that is not one attachment ID fails before
 * anything is sent, naming the entry by position and never echoing it
 * (task #20, wording reviewed by Sage).
 */
export function normalizeAttachmentIdFlags(values: readonly string[], target?: string): string[] {
  const ids: string[] = [];
  let entry = 0;
  for (const value of values) {
    const pieces = value.split(/[\s,]+/).filter((piece) => piece.length > 0);
    if (pieces.length === 0) throw attachmentIdError(`${entry + 1} is empty`, target);
    for (const piece of pieces) {
      entry += 1;
      if (!ATTACHMENT_ID_PATTERN.test(piece)) throw attachmentIdError(`${entry} is not an attachment ID`, target);
      if (!ids.includes(piece)) ids.push(piece);
    }
  }
  return ids;
}

export function parseMentionSelector(value: string): AgentApiStructuredMention {
  const [rawType, id, name, ...extra] = value.split(":");
  const type = rawType === "human" ? "user" : rawType;
  if (
    (type !== "user" && type !== "agent")
    || !id
    || !UUID_PATTERN.test(id)
    || !name
    || name.length > 128
    || extra.length > 0
    || !HANDLE_PATTERN.test(name)
  ) {
    throw new SendContentError(
      "INVALID_MENTION_SELECTOR",
      "--mention must be human:<actor-uuid>:<handle> or agent:<actor-uuid>:<handle>.",
    );
  }
  return { type, id, name };
}

export function parseMentionSelectors(values: string[] | undefined): AgentApiStructuredMention[] {
  const mentions = (values ?? []).map(parseMentionSelector);
  const targetByName = new Map<string, string>();
  for (const mention of mentions) {
    const key = `${mention.type}:${mention.id}`;
    const existing = targetByName.get(mention.name);
    if (existing && existing !== key) {
      throw new SendContentError(
        "MENTION_BINDING_CONFLICT",
        `@${mention.name} cannot be bound to more than one actor in the same message.`,
      );
    }
    targetByName.set(mention.name, key);
  }
  return mentions;
}

export function classifyMessageSendOutcome(data: unknown): MessageSendOutcome {
  if (!data || typeof data !== "object") {
    throw cliError("INVALID_JSON_RESPONSE", "Agent API messageSend returned a non-object response body");
  }
  const state = (data as { state?: unknown }).state;
  if (state === "held") {
    return { kind: "held", data: data as AgentApiHeldFreshnessResponse };
  }
  if (state === "sent") {
    return { kind: "sent", data: data as AgentApiSendSentResponse };
  }
  if (state === "committed") {
    return { kind: "committed", data: data as AgentApiSendCommittedResponse };
  }
  throw cliError(
    "INVALID_JSON_RESPONSE",
    `Agent API messageSend returned unsupported state ${typeof state === "string" ? JSON.stringify(state) : String(state)}`,
  );
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let content = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream as Readable) {
    content += String(chunk);
  }
  return content;
}

function missingContentMessage(): string {
  return [
    "No message content received on stdin.",
    "Use a heredoc or pipe content into raft message send:",
    `  raft message send --target "#channel" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
    "  message body",
    `  ${MESSAGE_HEREDOC_DELIMITER}`,
  ].join("\n");
}

export async function resolveSendContent(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  if ((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) {
    throw new SendContentError("MISSING_CONTENT", missingContentMessage());
  }

  const content = await readStream(input);
  if (content.trim().length === 0) {
    throw new SendContentError("MISSING_CONTENT", missingContentMessage());
  }
  return content;
}

export async function resolveOptionalSendContent(
  input: NodeJS.ReadableStream = process.stdin,
  options: OptionalSendContentOptions = {},
): Promise<string | undefined> {
  const stream = input as Readable & { isTTY?: boolean };
  if (stream.isTTY) {
    return undefined;
  }

  stream.setEncoding("utf8");
  let content = "";
  const outcome = await new Promise<"data" | "end" | "deadline">((resolve, reject) => {
    const observationWindowMs =
      options.observationWindowMs ?? SEND_DRAFT_STDIN_OBSERVATION_MS;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const readAvailable = (): void => {
      let chunk: string | Buffer | null;
      while ((chunk = stream.read()) !== null) {
        content += String(chunk);
      }
    };
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (timer) clearTimeout(timer);
    };
    const absorbPostDeadlineError = (_err: Error): void => {
      // This stream is outside the observation window. Keep it inert without
      // consuming late bytes or letting a late error crash an in-flight send.
    };
    const finish = (result: "data" | "end" | "deadline") => {
      if (settled) return;
      settled = true;
      if (result === "deadline") {
        stream.on("error", absorbPostDeadlineError);
      }
      cleanup();
      resolve(result);
    };
    const onReadable = () => {
      readAvailable();
      if (content.length > 0) finish("data");
    };
    const onEnd = () => {
      readAvailable();
      finish(content.length > 0 ? "data" : "end");
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.on("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", onError);
    onReadable();
    if (!settled) {
      if (stream.readableEnded || stream.destroyed) {
        finish("end");
      } else {
        timer = setTimeout(() => finish("deadline"), observationWindowMs);
      }
    }
  });
  stream.pause();
  if (outcome === "deadline") {
    options.onNoBytesWithinWindow?.();
  }
  return content.length > 0 ? content : undefined;
}

export function rejectArgContent(positionalContent: string[], opts: Pick<SendOpts, "content">): void {
  if (positionalContent.length > 0) {
    throw new SendContentError(
      "POSITIONAL_CONTENT_UNSUPPORTED",
      [
        "Message content must be provided on stdin, not as positional arguments.",
        "Use:",
        `  raft message send --target "#channel" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
        "  message body",
        `  ${MESSAGE_HEREDOC_DELIMITER}`,
      ].join("\n"),
    );
  }

  if (opts.content !== undefined) {
    throw new SendContentError(
      "CONTENT_FLAG_UNSUPPORTED",
      [
        "--content is no longer supported. Pipe message content to stdin.",
        "Use:",
        "  printf 'hello' | raft message send --target \"#channel\"",
      ].join("\n"),
    );
  }
}

export function validateDraftSendFlags(
  opts: Pick<SendOpts, "sendDraft" | "discardDraft" | "expectedDraftKey" | "anyway" | "attachmentId" | "mention" | "card">,
): void {
  if (opts.card !== undefined && (opts.sendDraft || opts.discardDraft)) {
    throw new SendContentError(
      "CARD_WITH_SAVED_DRAFT_UNSUPPORTED",
      `--card cannot be used with ${opts.sendDraft ? "--send-draft" : "--discard-draft"}: a saved draft keeps the card it was saved with. To change the card, send again normally with --card.`,
    );
  }
  if (opts.discardDraft && opts.sendDraft) {
    throw new SendContentError(
      "DISCARD_DRAFT_WITH_SEND_DRAFT",
      "--discard-draft and --send-draft cannot be used together: one sends the saved draft, the other deletes it.",
    );
  }
  if (opts.discardDraft && ((opts.attachmentId?.length ?? 0) > 0 || (opts.mention?.length ?? 0) > 0)) {
    throw new SendContentError(
      "DISCARD_DRAFT_OPTIONS_UNSUPPORTED",
      "--attachment-id and --mention cannot be used with --discard-draft, which only deletes the saved draft.",
    );
  }
  if (opts.anyway && !opts.sendDraft) {
    throw new SendContentError(
      "SEND_DRAFT_ANYWAY_REQUIRES_SEND_DRAFT",
      "--anyway can only be used together with --send-draft.",
    );
  }
  if (opts.sendDraft && opts.attachmentId && opts.attachmentId.length > 0) {
    throw new SendContentError(
      "SEND_DRAFT_ATTACHMENTS_UNSUPPORTED",
      "--attachment-id cannot be used with --send-draft. Use a normal send to replace the draft.",
    );
  }
  if (opts.expectedDraftKey !== undefined && !opts.sendDraft && !opts.discardDraft) {
    throw new SendContentError(
      "EXPECTED_DRAFT_KEY_REQUIRES_SEND_DRAFT",
      "--expected-draft-key can only be used together with --send-draft or --discard-draft.",
    );
  }
}

export function rejectSendDraftStdin(content: string | undefined, target: string): void {
  if (content === undefined) return;
  throw new SendContentError(
    "SEND_DRAFT_STDIN_UNSUPPORTED",
    [
      "--send-draft sends the current saved draft and does not accept stdin.",
      "To update the draft, send the revised content normally without --send-draft:",
      `  raft message send --target "${target}" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
      "  revised message",
      `  ${MESSAGE_HEREDOC_DELIMITER}`,
    ].join("\n"),
  );
}

export function formatHeldSendOutput(
  target: string,
  data: FreshnessHoldOutputData,
  reviewerIsolation = false,
  draftSaved = true,
  /** RFC 082: the held message is a card (`--card`); `file` is its card file when this run was given one. */
  card?: { file: string | null },
): CliReplyText {
  const withholdContext = reviewerIsolation || data.freshnessContextMode === "withheld";
  const sendNothing = heldSendNothing((data.newMessageCount ?? 0) > 0);
  // A card message is sent again with its card; its text on stdin is optional.
  const cardFlag = card ? ` --card ${card.file ? shellQuoteArg(card.file) : "<file>"}` : "";
  const bodyLine = (text: string) => card ? `${text} (optional with --card)` : text;
  if (!draftSaved) {
    return formatFreshnessHoldOutput(target, data, {
      ...(withholdContext ? { withholdContext: true } : {}),
      heldAction: "Your message was not delivered, and no draft was kept: this agent's local record cannot be written.",
      draftInstructions:
        `${sendNothing}\n` +
        `Otherwise, send the full content again${withholdContext ? " (with --reviewer-isolation)" : ""}:\n` +
        `  raft message send --target "${target}"${cardFlag} <<'${MESSAGE_HEREDOC_DELIMITER}'\n` +
        `  ${bodyLine("message")}\n` +
        `  ${MESSAGE_HEREDOC_DELIMITER}\n`,
    });
  }
  if (withholdContext) {
    return formatFreshnessHoldOutput(target, data, {
      withholdContext: true,
      heldAction: `Your message has been saved as a draft (kept for ${LOCAL_DRAFT_TTL_MINUTES} minutes).`,
      draftInstructions:
        `To preserve reviewer isolation and send this exact draft despite unseen context:\n` +
        `  raft message send --reviewer-isolation --send-draft --anyway --target "${target}"\n` +
        `To change the draft, send revised content normally with --reviewer-isolation.\n` +
        `Only leave the review seat and use raft message read if the review authority explicitly permits seeing the withheld context.\n`,
    });
  }
  return formatFreshnessHoldOutput(target, data, {
    heldAction: `Your message has been saved as a draft (kept for ${LOCAL_DRAFT_TTL_MINUTES} minutes).`,
    draftInstructions:
      `${sendNothing} Delete the draft:\n` +
      `  raft message send --discard-draft --target \"${target}\"\n` +
      `Otherwise, to update the draft, send revised content normally:\n` +
      `  raft message send --target "${target}"${cardFlag} <<'${MESSAGE_HEREDOC_DELIMITER}'\n` +
      `  ${bodyLine("revised message")}\n` +
      `  ${MESSAGE_HEREDOC_DELIMITER}\n` +
      `To send the current draft unchanged (within ${LOCAL_DRAFT_TTL_MINUTES} minutes; after that the draft is discarded and --send-draft reports SEND_DRAFT_EXPIRED):\n` +
      `  raft message send --send-draft --target \"${target}\"\n` +
      `  (this sends the stored copy — do not use it if you meant to change the content)\n`,
    continueAnywayInstruction:
      `If repeated updates keep blocking the same draft and this is still the right reply, you may use:\n` +
      `  raft message send --send-draft --anyway --target \"${target}\"\n`,
  });
}

export function formatDriveByJoinedToPostTip(target: string, data: AgentApiSendSentResponse): string {
  const attention = data.attention?.driveByJoinedToPost;
  if (!attention) return "";

  const muteCommand = attention.muteCommand?.trim() || `raft channel mute "${target}"`;
  const stillArrives = attention.stillArrives?.[0]?.trim() ||
    "@mentions still reach you, and threads you started stay followed.";
  return [
    "Tip: you joined this channel to post this message. If you don't need its ordinary updates:",
    `  ${muteCommand}`,
    stillArrives,
  ].join("\n");
}

/** The shared thread-target check (glimpse G2-5) over this agent's consumed-seq ledger. */
export function detectThreadContextParentSend(
  agentId: string,
  target: string,
): ThreadTargetMismatch | null {
  if (getParentTargetForThread(target) !== null) return null;
  return detectThreadTargetMismatch(
    target,
    getMostRecentConsumedThreadForParent(agentId, target),
    getConsumedReadOrder(agentId, target),
  );
}

export function formatThreadContextParentSendMessage(
  target: string,
  latestThread: Pick<ConsumedThreadTarget, "target" | "seq">,
): string {
  return formatAgentThreadTargetCheck(target, latestThread.target, {
    toThread: [
      `  raft message send --target "${latestThread.target}" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
      "  message body",
      `  ${MESSAGE_HEREDOC_DELIMITER}`,
    ],
    confirm: {
      label: "If the top-level channel message is intentional, send the saved draft unchanged:",
      lines: [`  raft message send --send-draft --target "${target}"`],
    },
  });
}

export function markSendFailureDraftSaved(
  err: unknown,
  draftSaved: boolean,
  forceDeliveryUnknown = false,
): Error {
  const transportAmbiguous = forceDeliveryUnknown || (err instanceof CliError
    ? err.fault_domain === "agent_api_transport"
    : true);
  const suggestedNextAction = draftSaved && transportAmbiguous
    ? "Delivery state is UNKNOWN: the send failed after the draft was saved, so the message may or may not have been committed. Reading CANNOT settle this. Only an authoritative identity reconciliation can — an idempotency/request/correlation identity bound by the failed request or by a server receipt, confirmed committed by an authoritative record. The CLI attempted its keyed reconciliation, but the lookup was unavailable or did not return an authoritative result, so the honest state is CANNOT_CONFIRM. Reading is still worth doing, but it settles nothing on its own: `raft message read --target <target>` can only show that A message matching what you looked for is present, which is not the same as YOUR send having been committed unless you identified it by an authoritative identity. Wait about 90s before looking, because delivery to readable lags; that is a hint against looking too early, not a bound on visibility and not a safety gate. Not seeing it proves nothing: absence is equally consistent with committed-but-not-yet-visible, however many times and however far apart you read, and however wide the window. Matching your own text is not identity either: a hit can be someone else quoting the same string, and a miss can be a committed message you cannot see yet. So the outcome stays unknown and not retryable. Do not resend on this evidence. You may keep waiting, or reconcile out of band. Sending the draft again is a decision by a person to accept a duplicate, not a finding that the original failed, so this guidance does not direct you to it."
    : undefined;
  if (err instanceof CliError) {
    if (err.draftSaved !== undefined && !forceDeliveryUnknown) return err;
    return new CliError({
      code: err.code,
      message: err.message,
      exitCode: err.exitCode,
      cause: err.cause,
      suggestedNextAction: forceDeliveryUnknown ? suggestedNextAction : (err.suggestedNextAction ?? suggestedNextAction),
      textDetailMode: err.textDetailMode,
      draftSaved: err.draftSaved ?? draftSaved,
      effect: err.effect,
      layer: err.layer,
      correlationId: err.correlationId,
      proxyFailureClass: err.proxyFailureClass,
      proxyCauseCode: err.proxyCauseCode,
      proxyRouteFamily: err.proxyRouteFamily,
      proxyUpstreamLayer: err.proxyUpstreamLayer,
      proxyUpstreamStatus: err.proxyUpstreamStatus,
      proxyResponseStarted: err.proxyResponseStarted,
      proxyResponseComplete: err.proxyResponseComplete,
      retryable: forceDeliveryUnknown ? false : (err.retryable ?? (transportAmbiguous ? false : undefined)),
      faultDomain: err.fault_domain,
      effectState: err.effect_state,
      details: err.details,
      outputMode: err.outputMode,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new CliError({
    code: "INTERNAL_BUG",
    message: `Unexpected error: ${message}`,
    cause: err,
    suggestedNextAction,
    draftSaved,
    retryable: transportAmbiguous ? false : undefined,
  });
}

/**
 * A send refused by a message budget (429 RATE_LIMITED): the Server's
 * sentence, and, when this send's copy is the saved draft, the wait and the
 * command that sends that draft (the agent needn't write the message again;
 * under reviewer isolation, bound to this send's key, as its other retry
 * steps are); else the wait and the same command again.
 */
function rateLimitedSendError(
  rateLimited: { message: string; retryAfterSeconds: number },
  agentId: string,
  target: string,
  idempotencyKey: string,
  reviewerIsolation: boolean,
): CliError {
  const draftSaved = getSavedDraft(agentId, target)?.idempotencyKey === idempotencyKey;
  if (!draftSaved) return rateLimitedCliError(rateLimited, null);
  const seconds = rateLimited.retryAfterSeconds;
  const command = reviewerIsolation
    ? `raft message send --reviewer-isolation --send-draft --expected-draft-key "${idempotencyKey}" --target "${target}"`
    : `raft message send --send-draft --target "${target}"`;
  return new CliError({
    code: "RATE_LIMITED",
    message: rateLimited.message,
    retryable: true,
    draftSaved: true,
    suggestedNextAction: `Nothing was sent; your message is saved as a draft. Wait ${seconds} second${seconds === 1 ? "" : "s"}, then send it:\n${command}`,
  });
}

export function isPreResponseTransportAmbiguity(err: unknown): boolean {
  return err instanceof CliError
    && err.fault_domain === "agent_api_transport"
    && err.proxyResponseStarted !== true
    && (err.proxyFailureClass === undefined || err.proxyFailureClass === "pre_response_transport");
}

function markIdempotentReplayFailure(
  err: unknown,
  target: string,
  idempotencyKey: string,
  originalDraftStillSaved: boolean,
): CliError {
  const suggestedNextAction = originalDraftStillSaved
    ? "Delivery is still UNKNOWN after the server authoritatively reported the idempotency key absent and the same-key replay then failed. "
      + "The saved draft retains that same key, so retrying the saved draft cannot create a second message: "
      + `\`raft message send --send-draft --expected-draft-key "${idempotencyKey}" --target "${target}"\`. `
      + "The command verifies the expected key again before making any request and refuses if another send replaced the draft."
    : "Delivery is still UNKNOWN after the server authoritatively reported the idempotency key absent and the same-key replay then failed. "
      + "The saved draft slot no longer contains this send's idempotency key, so the CLI cannot preserve or safely retry this logical send. "
      + "The current draft, if any, belongs to a different send. The honest state is CANNOT_CONFIRM and not retryable; do not resend on this evidence.";
  if (err instanceof CliError) {
    return new CliError({
      code: err.code,
      message: err.message,
      exitCode: err.exitCode,
      cause: err.cause,
      suggestedNextAction,
      textDetailMode: err.textDetailMode,
      draftSaved: originalDraftStillSaved,
      effect: err.effect,
      layer: err.layer,
      correlationId: err.correlationId,
      proxyFailureClass: err.proxyFailureClass,
      proxyCauseCode: err.proxyCauseCode,
      proxyRouteFamily: err.proxyRouteFamily,
      proxyUpstreamLayer: err.proxyUpstreamLayer,
      proxyUpstreamStatus: err.proxyUpstreamStatus,
      proxyResponseStarted: err.proxyResponseStarted,
      proxyResponseComplete: err.proxyResponseComplete,
      retryable: originalDraftStillSaved,
      faultDomain: err.fault_domain,
      effectState: err.effect_state,
      details: err.details,
      outputMode: err.outputMode,
    });
  }
  return cliError("CHECK_FAILED", err instanceof Error ? err.message : String(err), {
    cause: err,
    suggestedNextAction,
    draftSaved: originalDraftStillSaved,
    retryable: originalDraftStillSaved,
    faultDomain: "agent_api_transport",
  });
}

/**
 * `--discard-draft`: delete the target's saved draft without sending it. With
 * `--expected-draft-key` it is compare-and-clear: only the draft carrying that
 * key is deleted, a different one is left untouched
 * (SAVED_DRAFT_IDENTITY_CHANGED, exit 1). Without a key it clears the current
 * draft, as `--send-draft` without a key sends it. No draft (or an expired
 * one) is not an error: nothing to discard, exit 0, so a repeated cancel is
 * harmless. No stdin is read and no request is made.
 */
function discardSavedDraft(
  ctx: CommandContext,
  target: string,
  opts: Pick<SendOpts, "expectedDraftKey" | "json">,
): void {
  const agentContext = ctx.loadAgentContext();
  const traceScope = draftTraceScope(ctx, agentContext, target);
  const draft = getSavedDraft(agentContext.agentId, target, (expired) => emitDraftResolved(traceScope, expired, "expired"));
  const report = (state: "discarded" | "no_draft", text: string): void => {
    if (opts.json) writeJson(ctx.io, { ok: true, state, target });
    else writeText(ctx.io, adoptCliReplyText(`${text}\n`));
  };
  if (!draft) {
    report("no_draft", `No saved draft for ${target}; nothing was discarded.`);
    return;
  }
  const identityChanged = () => cliError(
    "SAVED_DRAFT_IDENTITY_CHANGED",
    [
      "The saved draft no longer matches the expected idempotency key.",
      "Nothing was discarded: the current draft belongs to a different logical send.",
    ].join(" "),
    {
      draftSaved: true,
      retryable: false,
      suggestedNextAction: "Review the current draft before deciding whether to send or discard it; do not treat it as the earlier logical send.",
    },
  );
  if (opts.expectedDraftKey !== undefined && draft.idempotencyKey !== opts.expectedDraftKey) throw identityChanged();
  let deleted: boolean;
  try {
    // Compare-and-clear: with a key only that draft; without one only the draft just read (not a fresher one).
    deleted = opts.expectedDraftKey !== undefined
      ? clearSavedDraftIfIdempotencyKeyMatches(agentContext.agentId, target, opts.expectedDraftKey)
      : clearSavedDraftIfSavedAt(agentContext.agentId, target, draft.savedAt);
  } catch (err) {
    throw cliError("LOCAL_WRITE_FAILED", "The saved draft could not be discarded: this agent's local record cannot be written.", {
      cause: err,
      draftSaved: true,
      retryable: true,
      suggestedNextAction: "Nothing was sent and the draft is still saved; run the same --discard-draft command again.",
    });
  }
  if (!deleted) throw identityChanged();
  emitDraftResolved(traceScope, draft, "discarded");
  report("discarded", `Discarded the saved draft for ${target}. Nothing was sent.`);
}

function draftTraceScope(
  ctx: CommandContext,
  agentContext: { agentId: string; serverId?: string | null },
  target: string,
): DraftTraceScope {
  return { agentId: agentContext.agentId, serverId: agentContext.serverId, env: ctx.env, target };
}

/**
 * Send, reconciling a lost response by its idempotency key (replaying once
 * with the same key when the server says it never committed), and classify
 * the answer: held, sent, or committed under a lost response.
 */
async function sendWithReconciliation(
  agentApi: ReturnType<typeof createAgentApiSurfaceClient>,
  body: AgentApiSendV2Body,
  { agentId, target, idempotencyKey, reviewerIsolation, cardFile = null }: {
    agentId: string;
    target: string;
    idempotencyKey: string;
    reviewerIsolation: boolean;
    /** A card send (RFC 082): its card file, for the next step of a card refusal ("<file>" when unknown). */
    cardFile?: string | null;
  },
): Promise<MessageSendOutcome> {
  let res;
  try {
    let initialFailure: unknown;
    try {
      res = await agentApi.messages.sendV2(body);
    } catch (err) {
      if (!isPreResponseTransportAmbiguity(err)) throw err;
      initialFailure = err;
    }

    if (initialFailure !== undefined || (res && !res.ok && res.status >= 500)) {
      const originalResponse = res;
      let reconciliation;
      try {
        reconciliation = await agentApi.messages.sendV2({
          target,
          idempotencyKey,
          reconcileOnly: true,
        });
      } catch {
        if (initialFailure !== undefined) throw initialFailure;
      }

      if (!reconciliation?.ok || !reconciliation.data) {
        if (initialFailure !== undefined) throw initialFailure;
        throw markSendFailureDraftSaved(
          cliError(
            originalResponse && originalResponse.status >= 500 ? "SERVER_5XX" : "SEND_FAILED",
            originalResponse?.error ?? `HTTP ${originalResponse?.status ?? 500}`,
          ),
          true,
          true,
        );
      } else if (reconciliation.data.state === "committed") {
        res = reconciliation;
      } else if (reconciliation.data.state === "not_found") {
        try {
          res = await agentApi.messages.sendV2(body);
        } catch (err) {
          const originalDraftStillSaved =
            getSavedDraft(agentId, target)?.idempotencyKey === idempotencyKey;
          throw markIdempotentReplayFailure(err, target, idempotencyKey, originalDraftStillSaved);
        }
        if (!res.ok) {
          // The same-key replay over the message budget: refused before it ran, so nothing is unknown.
          const replayRateLimited = rateLimitedResponse(res);
          if (replayRateLimited) throw rateLimitedSendError(replayRateLimited, agentId, target, idempotencyKey, reviewerIsolation);
          const originalDraftStillSaved =
            getSavedDraft(agentId, target)?.idempotencyKey === idempotencyKey;
          throw markIdempotentReplayFailure(
            cliError(res.status >= 500 ? "SERVER_5XX" : "SEND_FAILED", res.error ?? `HTTP ${res.status}`),
            target,
            idempotencyKey,
            originalDraftStillSaved,
          );
        }
      } else {
        if (initialFailure !== undefined) throw initialFailure;
        throw markSendFailureDraftSaved(
          cliError(
            originalResponse && originalResponse.status >= 500 ? "SERVER_5XX" : "SEND_FAILED",
            originalResponse?.error ?? `HTTP ${originalResponse?.status ?? 500}`,
          ),
          true,
          true,
        );
      }
    }
  } catch (err) {
    if (reviewerIsolation) {
      const retryable = err instanceof CliError && err.retryable === true;
      throw cliError(
        "SEND_FAILED",
        "Reviewer-isolation send failed; upstream response detail was withheld.",
        {
          cause: err,
          draftSaved: retryable ? true : undefined,
          retryable: retryable ? true : undefined,
          suggestedNextAction: retryable
            ? `The saved draft retains the same idempotency key, so retrying it cannot create a second message: \`raft message send --reviewer-isolation --send-draft --expected-draft-key "${idempotencyKey}" --target "${target}"\`. The command verifies the expected key again before making any request and refuses if another send replaced the draft.`
            : undefined,
        },
      );
    }
    throw err;
  }
  if (!res) {
    throw cliError("INVALID_JSON_RESPONSE", "Agent API messageSend did not return a response");
  }
  if (!res.ok) {
    // RFC 082: a refusal because of the card (nothing was posted), with its
    // next step. It says nothing about the conversation, so reviewer isolation
    // shows it too.
    const cardRefusal = body.card !== undefined ? messageCardRefusal(res, "send", cardFile ?? "<file>") : null;
    if (cardRefusal) throw cardRefusal;
    // Over the agent's or the Server's message budget: nothing was posted.
    // Retryable after the Server's wait; the agent decides, the CLI doesn't
    // resend behind its back.
    const rateLimited = rateLimitedResponse(res);
    if (rateLimited) throw rateLimitedSendError(rateLimited, agentId, target, idempotencyKey, reviewerIsolation);
    // Task v2 (flag-on server): a task conversation target is refused with the
    // `raft task reply` command; keep its code so callers can branch on it.
    const code = res.status >= 500
      ? "SERVER_5XX"
      : res.errorCode === TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE ? TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE : "SEND_FAILED";
    throw cliError(
      code,
      reviewerIsolation
        ? `Reviewer-isolation send failed (HTTP ${res.status}); upstream error detail was withheld.`
        : res.error ?? `HTTP ${res.status}`,
    );
  }
  const rawData = res.data;
  if (!rawData) {
    throw cliError("INVALID_JSON_RESPONSE", "Agent API messageSend returned an empty response body");
  }
  return classifyMessageSendOutcome(rawData);
}

/**
 * A hold's bookkeeping in the draft flow, before its context is shown: the
 * observability counters, and the shown boundary recorded as consumed.
 */
function bookHeldContext(
  agentId: string,
  target: string,
  data: AgentApiHeldFreshnessResponse,
  held: { reviewerIsolation: boolean; seenUpToSeq: number | undefined },
): { heldForCardOnly: boolean; contextWasWithheld: boolean } {
  const counted = countHold(agentId, target, data, held);
  recordHeldShown(agentId, target, data, counted.contextWasWithheld);
  return counted;
}

/** The hold's observability counters, and what kind of hold it is. */
function countHold(
  agentId: string,
  target: string,
  data: AgentApiHeldFreshnessResponse,
  { reviewerIsolation, seenUpToSeq }: { reviewerIsolation: boolean; seenUpToSeq: number | undefined },
): { heldForCardOnly: boolean; contextWasWithheld: boolean } {
  // RFC 072 §7.10 observability: a hold because this context has not read
  // the thread (evidence from another context withheld) vs. a hold that
  // came with evidence (there really were newer messages).
  const holdReasons = data.holdReasons ?? [];
  const heldForCardOnly = (holdReasons.includes("channel_card") || holdReasons.includes("peer_card")) && !holdReasons.includes("unread_messages");
  if (heldForCardOnly) {
    incrementMetaCounter(agentId, "channelCardHold");
  } else if (seenUpToSeq !== undefined) {
    incrementMetaCounter(agentId, "freshnessHold.withEvidence");
  } else if (wasConsumedEvidenceWithheldForContext(agentId, target)) {
    incrementMetaCounter(agentId, "freshnessHold.contextSwitch");
  }
  const contextWasWithheld = reviewerIsolation || data.freshnessContextMode === "withheld";
  return { heldForCardOnly, contextWasWithheld };
}

/** The shown held context's boundary, recorded as consumed (unless the context was withheld). */
function recordHeldShown(agentId: string, target: string, data: AgentApiHeldFreshnessResponse, contextWasWithheld: boolean): void {
  // The held bounded context was just rendered to the agent — that
  // boundary is consumed too; record it so even an abandoned draft
  // leaves an honest per-target cursor behind.
  if (!contextWasWithheld && typeof data.seenUpToSeq === "number" && Number.isFinite(data.seenUpToSeq)) {
    recordConsumedSeqs(agentId, { [target]: data.seenUpToSeq });
  }
}

/** What a send attempt asks the server with: the message and how it relates to a draft that was held. */
interface SendBodyInput {
  target: string;
  /** With a card, "" means none: the Server derives the card's fallback. */
  content: string;
  /** RFC 082: the card, as the sender wrote it. */
  card?: MessageCardInput;
  attachmentIds: string[];
  mentions: AgentApiStructuredMention[];
  idempotencyKey: string;
  /** How often the draft this send sends or replaces was held (`draftReholdCount`). */
  reholdCount: number;
  /** A saved draft's seen frontier: a floor for what this send attests. */
  seenUpToSeq: number | undefined;
  seenExactSeqs: number[];
  reviewerIsolation: boolean;
  /** The same held message again (`--send-draft`), and whether anyway (`--anyway`). */
  sendDraft: boolean;
  anyway: boolean;
}

interface SendBodyPlan {
  body: AgentApiSendV2Body;
  seenUpToSeq: number | undefined;
  seenExactSeqs: number[];
  cardForSend: ReturnType<typeof channelCardForSend> | undefined;
  peerForSend: ReturnType<typeof peerCardForSend> | undefined;
}

/** The send body, with what this agent's ledger attests it has seen of the target. */
function buildSendBody(agentId: string, input: SendBodyInput): SendBodyPlan {
  const { target, reviewerIsolation } = input;
  let { seenUpToSeq, seenExactSeqs } = input;
  // FH-001 full-body advance contract (A), send side: attest only the
  // local per-target cursor recorded by active body-returning operations
  // that safely advance a contiguous boundary (`message read` in this
  // slice). Target keys stay isolated (thread != parent); passive wake/inbox
  // notices and sparse `message check` drains never record this cursor.
  // Absent cursor means omit `seenUpToSeq` so the server freshness gate fails
  // closed.
  // A saved draft's cursor is a floor, not a pin: reads after the hold move
  // the ledger cursor past it and fold exact seqs into it, so pinning the
  // draft value would drop what those reads attested.
  const ledgerSeenUpToSeq = getConsumedSeq(agentId, target);
  if (ledgerSeenUpToSeq !== undefined && (seenUpToSeq === undefined || ledgerSeenUpToSeq > seenUpToSeq)) {
    seenUpToSeq = ledgerSeenUpToSeq;
  }
  seenExactSeqs = [...new Set([
    ...seenExactSeqs,
    ...getConsumedExactSeqs(agentId, target),
  ])]
    .filter((seq) => Number.isInteger(seq) && seq > (seenUpToSeq ?? 0))
    .sort((a, b) => a - b)
    .slice(-2_500);
  const body: AgentApiSendV2Body = {
    target,
    // A card without text: no content, so the Server derives the fallback from the card.
    ...(input.card && input.content.length === 0 ? {} : { content: input.content }),
    ...(input.card ? { card: input.card } : {}),
    idempotencyKey: input.idempotencyKey,
    draftReholdCount: input.reholdCount,
  };
  if (reviewerIsolation) {
    body.freshnessContextMode = "withheld";
  }
  // The channel card version this context has (RFC 072 `channel`; glimpse
  // G1): never seen here holds the send once, an older one comes back with
  // the reply. Reviewer isolation sends no new context, so it says nothing.
  const cardForSend = reviewerIsolation ? undefined : channelCardForSend(agentId, target);
  const peerForSend = reviewerIsolation ? undefined : peerCardForSend(agentId, target);
  if (cardForSend || peerForSend) {
    body.seenCards = {
      ...(cardForSend ? cardForSend.seenCards : {}),
      ...(peerForSend ? { peer: peerForSend.seen } : {}),
    };
  }
  if (seenUpToSeq !== undefined) {
    body.seenUpToSeq = seenUpToSeq;
  }
  if (seenExactSeqs.length > 0) {
    body.seenExactSeqs = seenExactSeqs;
  }
  if (input.sendDraft) {
    body.sendDraft = true;
    if (input.anyway) body.continueAnyway = true;
  } else {
    body.draftReplacedExisting = input.reholdCount > 0;
  }
  if (input.attachmentIds.length > 0) {
    body.attachmentIds = input.attachmentIds;
  }
  if (input.mentions.length > 0) {
    body.mentions = input.mentions;
  }
  return { body, seenUpToSeq, seenExactSeqs, cardForSend, peerForSend };
}

/**
 * A committed send's output: the receipt (text or JSON), the unread messages
 * it brought back, the cards it carried (recorded as seen once printed), the
 * thread attachment, and settling the senders it showed.
 */
async function writeSentOutput(
  ctx: CommandContext,
  agentContext: ReturnType<CommandContext["loadAgentContext"]>,
  agentApi: ReturnType<typeof createAgentApiSurfaceClient>,
  target: string,
  outcome: Exclude<MessageSendOutcome, { kind: "held" }>,
  {
    json,
    reviewerIsolation,
    replacementArchiveAttempted,
    replacementRecoveryFilePath,
    cardForSend,
    peerForSend,
    messageCard = false,
  }: {
    json: boolean;
    reviewerIsolation: boolean;
    /**
     * RFC 082: the message was sent with a card. The receipt says how to
     * update it when the answer says it was stored (`messageCard`), and that
     * it went out as text only when not.
     */
    messageCard?: boolean;
    /** A saved draft was replaced (and archived): the receipt says where its body went. */
    replacementArchiveAttempted: boolean;
    replacementRecoveryFilePath: string | null;
    cardForSend: SendBodyPlan["cardForSend"];
    peerForSend: SendBodyPlan["peerForSend"];
  },
): Promise<void> {
  const cardSection = (messageId: string | undefined, stored: { revision: number } | undefined): string => {
    if (!messageCard || !messageId) return "";
    return `\n${stored ? formatMessageCardSentHint(messageId, stored.revision) : formatMessageCardNotStored()}`;
  };
  if (outcome.kind === "committed") {
    const data = outcome.data;
    if (json) {
      writeJson(ctx.io, replacementArchiveAttempted
        ? {
            ...data,
            replacedDraft: {
              replaced: true,
              recoverySaved: replacementRecoveryFilePath !== null,
              recoveryFile: replacementRecoveryFilePath,
            },
          }
        : data);
      return;
    }
    const replacementSection = replacementArchiveAttempted
      ? `\n${formatDraftReplacedSuccess(replacementRecoveryFilePath)}`
      : "";
    writeText(
      ctx.io,
      adoptCliReplyText(
        `Message commit confirmed for ${target}. Message ID: ${data.messageId}\n`
        + "The original response was lost, so delivery-side receipt details (including mention delivery warnings and recent unread context) are unavailable; no message was replayed."
        + cardSection(data.messageId, data.messageCard)
        + replacementSection,
      ),
      NL,
    );
    return;
  }
  const data = outcome.data;
  const shortId = data.messageId ? data.messageId.slice(0, 8) : null;
  const threadHint = shortId
    ? `. Thread: "${isThreadTargetRef(target) ? target : `${target}:${shortId}`}"`
    : "";

  let unreadSection = "";
  let settleSenders: (io: typeof ctx.io) => Promise<void> = async () => {};
  if (data.recentUnread && data.recentUnread.length > 0) {
    const senders = elideSeenSenders(data.recentUnread, agentContext.agentId);
    settleSenders = senders.settle;
    unreadSection = `\n\n--- New messages you may have missed ---\n${formatMessages(senders.messages)}`;
  }

  const pendingMentionActions = normalizePendingMentionActions(data);
  const unresolvedMentionHandles = normalizeUnresolvedMentionHandles(data);
  const undeliveredMentionCount = pendingMentionActions.length + unresolvedMentionHandles.length;
  const mentionSection = undeliveredMentionCount > 0
    ? formatPendingMentionActions(pendingMentionActions, {
        source: "send",
        unresolvedMentionHandles,
      }).trimEnd()
    : "";
  const sentStatusLine = undeliveredMentionCount > 0
    ? `Message queued to ${target}. Message ID: ${data.messageId}`
    : `Message sent to ${target}. Message ID: ${data.messageId}`;
  const deliveredLine = formatAgentDeliveredToAgentsLine(normalizeAgentDeliveredToAgents(data));
  const deliveredSection = deliveredLine ? `\n${deliveredLine}` : "";
  const cardHintSection = cardSection(data.messageId, data.messageCard);
  const driveByTip = formatDriveByJoinedToPostTip(target, data);
  const driveBySection = driveByTip ? `\n\n${driveByTip}` : "";

  const partialSendPayload = undeliveredMentionCount > 0
    ? {
        ...data,
        state: "partial",
        message: { status: "queued", id: data.messageId },
        pendingMentionActions: pendingMentionActions.map(toSenderPendingMentionAction),
        ...(unresolvedMentionHandles.length > 0
          ? { unresolvedMentionWarnings: unresolvedMentionHandles.map(toSenderUnresolvedMentionWarning) }
          : {}),
      }
    : null;
  // A partial result exits 0: the message is committed, and a nonzero exit
  // reads as "not sent" to callers, who then resend it. The undelivered
  // mentions lead stdout (text) or ride in the payload (JSON) with their
  // per-token recovery commands.
  if (json) {
    const jsonResult = partialSendPayload ?? data;
    writeJson(ctx.io, replacementArchiveAttempted
      ? {
          ...jsonResult,
          replacedDraft: {
            replaced: true,
            recoverySaved: replacementRecoveryFilePath !== null,
            recoveryFile: replacementRecoveryFilePath,
          },
        }
      : jsonResult);
    if (data.channelCard && cardForSend) {
      await recordChannelCardShown(agentContext.agentId, data.channelCard, cardForSend.contextId, target, ctx.io);
    }
    if (data.peerCard && peerForSend) {
      await recordPeerCardShown(agentContext.agentId, data.peerCard, peerForSend.contextId, target, ctx.io);
    }
    return;
  }

  const partialSection = mentionSection ? `${mentionSection}\n\n` : "";
  const replacementSection = replacementArchiveAttempted
    ? `\n${formatDraftReplacedSuccess(replacementRecoveryFilePath)}`
    : "";
  writeText(
    ctx.io,
    adoptCliReplyText(
      `${partialSection}${sentStatusLine}${threadHint}${deliveredSection}${cardHintSection}${replacementSection}${driveBySection}${unreadSection}`,
    ),
    NL,
  );
  if (data.channelCard && cardForSend) {
    const cardText = formatSentChannelCard(data.channelCard, data.channelCardChanged === true);
    writeText(ctx.io, cardText);
    countRendered(agentContext.agentId, "channel_card", cardText);
    await recordChannelCardShown(agentContext.agentId, data.channelCard, cardForSend.contextId, target, ctx.io);
  }
  if (data.peerCard && peerForSend) {
    const cardText = formatSentPeerCard(data.peerCard);
    writeText(ctx.io, cardText);
    countRendered(agentContext.agentId, "peer_card", cardText);
    await recordPeerCardShown(agentContext.agentId, data.peerCard, peerForSend.contextId, target, ctx.io);
  }
  if (!reviewerIsolation && data.messageId && attachOnEverySend(agentContext.agentId, target)) {
    const attachment = await fetchSendAttachment(agentApi, target, data.messageId);
    // The message is committed: rendering trouble must not fail the command.
    let attached: CliReplyText | null = null;
    try {
      attached = attachment ? formatSendAttachment(attachment) : null;
    } catch {
      attached = null;
    }
    if (attached) {
      writeText(ctx.io, attached);
      countRendered(agentContext.agentId, "send_attachment", attached);
    }
  }
  await settleSenders(ctx.io);
}

async function handleMessageSend(
  ctx: CommandContext,
  positionalContent: string[],
  opts: SendOpts,
  setFailureDraftSaved: (draftSaved: boolean) => void,
): Promise<void> {
  const rawTarget = opts.target?.trim() ?? "";
  if (!rawTarget) {
    throw cliError("INVALID_ARG", "--target is required");
  }
  const target = applyDmPeerKind(rawTarget, opts.peerKind);
  const reviewerIsolation = reviewerIsolationEnabled(opts, ctx.env);
  // Task v2: a task ref is never a message target in this CLI — a task is
  // replied to with `raft task reply`. (Servers still accept the ref from
  // older CLIs, which copy it from the delivery.) Refused before stdin is read.
  const taskRef = parseAgentTaskRef(target);
  if (taskRef) {
    throw cliError(TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE, formatTaskTargetUseTaskCommand({ ref: taskRef.ref, action: "send" }));
  }

  try {
    rejectArgContent(positionalContent, opts);
  } catch (err) {
    if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
    throw err;
  }

  try {
    validateDraftSendFlags(opts);
  } catch (err) {
    if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
    throw err;
  }
  if (opts.discardDraft) {
    discardSavedDraft(ctx, target, opts);
    return;
  }
  let explicitMentions: AgentApiStructuredMention[];
  try {
    explicitMentions = parseMentionSelectors(opts.mention);
  } catch (err) {
    if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
    throw err;
  }
  let content: string | undefined;
  let outgoingContent = "";
  let outgoingAttachmentIds: string[] = [];
  let outgoingMentions: AgentApiStructuredMention[] = explicitMentions;
  // RFC 082: `--card <file>` (checked here), or the card a saved draft was sent with.
  let loadedCard: LoadedCard | undefined;
  let outgoingCard: MessageCardInput | undefined;
  let previousDraftReholdCount = 0;
  let seenUpToSeq: number | undefined;
  let seenExactSeqs: number[] = [];
  let idempotencyKey: string = randomUUID();
  let sendDraftStdinDeadlineExpired = false;
  if (opts.sendDraft) {
    content = await resolveOptionalSendContent(ctx.io.stdin ?? process.stdin, {
      onNoBytesWithinWindow: () => {
        sendDraftStdinDeadlineExpired = true;
      },
    });
    try {
      rejectSendDraftStdin(content, target);
    } catch (err) {
      if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
  } else {
    let cardStdinDeadlineExpired = false;
    try {
      // Checked before stdin is consumed, so a bad id or card costs no message body.
      // A card message carries no files (RFC 082 §4.1), whatever the ids are.
      if (opts.card !== undefined && (opts.attachmentId?.length ?? 0) > 0) throw cardWithAttachmentsError();
      outgoingAttachmentIds = normalizeAttachmentIdFlags(opts.attachmentId ?? [], target);
      if (opts.card !== undefined) {
        loadedCard = loadCardFile(opts.card);
        // With a card the text is optional: it is the card's fallback, derived by the Server when absent.
        const text = await resolveOptionalSendContent(ctx.io.stdin ?? process.stdin, {
          onNoBytesWithinWindow: () => {
            cardStdinDeadlineExpired = true;
          },
        });
        content = text !== undefined && text.trim().length > 0 ? text : undefined;
      } else {
        content = await resolveSendContent(ctx.io.stdin ?? process.stdin);
      }
    } catch (err) {
      if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
    outgoingContent = content ?? "";
    if (loadedCard) {
      // Mentions resolve only from text the sender wrote; a derived fallback mentions no one.
      if (explicitMentions.length > 0 && content === undefined) throw cardMentionsWithoutTextError();
      assertCardFallback(loadedCard, content);
      outgoingCard = loadedCard.input;
      if (cardStdinDeadlineExpired) writeDiagnostic(ctx.io, formatCardStdinDeadlineDiagnostic("sent"), NL);
    }
  }

  const agentContext = ctx.loadAgentContext();
  const traceScope = draftTraceScope(ctx, agentContext, target);
  const traceExpired: OnDraftExpired = (expired) => emitDraftResolved(traceScope, expired, "expired");
  // The saved draft this send resolves if it is sent (`--send-draft`) or
  // replaces (a normal send); `cli.draft.resolved` reports how it ended.
  let draftBeingResolved: SavedDraft | null = null;
  let previousDraftToReplace: SavedDraft | null = null;
  let replacementArchiveAttempted = false;
  let replacementRecoveryFilePath: string | null = null;
  const archiveDraftBeingReplaced = (): void => {
    if (!previousDraftToReplace || replacementArchiveAttempted) return;
    replacementArchiveAttempted = true;
    try {
      replacementRecoveryFilePath = archiveReplacedDraft(
        agentContext.agentId,
        target,
        previousDraftToReplace.content,
      );
    } catch {
      // Local recovery is deliberately best-effort. A storage failure must
      // never block the send that replaces the one-slot draft.
      replacementRecoveryFilePath = null;
    }
    writeDiagnostic(
      ctx.io,
      formatDraftReplacedWarning(target, previousDraftToReplace.content, replacementRecoveryFilePath),
      NL,
    );
  };
  if (opts.sendDraft) {
    const draftLookup = lookupSavedDraft(agentContext.agentId, target, traceExpired);
    if (draftLookup.status === "expired") {
      throw cliError(
        "SEND_DRAFT_EXPIRED",
        [
          `The saved draft for this target expired and was discarded: drafts are kept for ${LOCAL_DRAFT_TTL_MINUTES} minutes, `
          + `and this one was saved at ${new Date(draftLookup.savedAt).toISOString()}.`,
          "This command did not send anything.",
          "If this draft came from a failed send whose outcome was never confirmed, the original message may already have been",
          "delivered under its idempotency key: read the target and confirm before resending, or you may post it twice.",
          "To send it, resend the content normally:",
          `  raft message send --target "${target}" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
          "  message body",
          `  ${MESSAGE_HEREDOC_DELIMITER}`,
          "The discarded draft body is no longer stored anywhere; this is its last copy:",
          "---",
          draftLookup.content.replace(/\n$/u, ""),
          "---",
        ].join("\n"),
      );
    }
    const savedDraft = draftLookup.status === "found" ? draftLookup.draft : null;
    if (!savedDraft) {
      throw cliError(
        "SEND_DRAFT_NOT_FOUND",
        [
          "No saved draft exists for this target.",
          "To create or update a draft, send message content normally:",
          `  raft message send --target "${target}" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
          "  message body",
          `  ${MESSAGE_HEREDOC_DELIMITER}`,
        ].join("\n"),
      );
    }
    if (opts.expectedDraftKey !== undefined && savedDraft.idempotencyKey !== opts.expectedDraftKey) {
      throw cliError(
        "SAVED_DRAFT_IDENTITY_CHANGED",
        [
          "The saved draft no longer matches the expected idempotency key.",
          "No request was made and the current draft was left unchanged because it belongs to a different logical send.",
        ].join(" "),
        {
          draftSaved: false,
          retryable: false,
          suggestedNextAction: "Review the current draft before deciding whether to send it; do not treat it as the earlier logical send.",
        },
      );
    }
    outgoingContent = savedDraft.content;
    outgoingCard = savedDraft.card;
    outgoingAttachmentIds = savedDraft.attachmentIds;
    outgoingMentions = explicitMentions.length > 0 ? explicitMentions : (savedDraft.mentions ?? []);
    idempotencyKey = savedDraft.idempotencyKey ?? idempotencyKey;
    previousDraftReholdCount = savedDraft.reholdCount;
    seenUpToSeq = savedDraft.seenUpToSeq;
    seenExactSeqs = savedDraft.seenExactSeqs ?? [];
    if (!savedDraft.idempotencyKey) {
      setSavedDraft(agentContext.agentId, target, {
        ...savedDraft,
        idempotencyKey,
        mentions: outgoingMentions,
      });
    }
    draftBeingResolved = { ...savedDraft, idempotencyKey };
    setFailureDraftSaved(true);
    if (sendDraftStdinDeadlineExpired) {
      writeDiagnostic(ctx.io, formatSendDraftStdinDeadlineDiagnostic(), NL);
    }
  } else {
    const previousDraft = getSavedDraft(agentContext.agentId, target, traceExpired);
    draftBeingResolved = previousDraft;
    previousDraftReholdCount = previousDraft?.reholdCount ?? 0;
    seenUpToSeq = previousDraft?.seenUpToSeq;
    seenExactSeqs = previousDraft?.seenExactSeqs ?? [];
    if (previousDraft && previousDraft.content.trim().length > 0) {
      // Keyed on "a draft with a body exists", NOT on draftReplacedExisting
      // below: that flag is `reholdCount > 0`, so a draft held exactly once
      // reports false while still being replaced here.
      previousDraftToReplace = previousDraft;
    }
  }

  for (const mention of outgoingMentions) {
    if (!structuredRaftMentionStillAppears(outgoingContent, mention.name)) {
      throw cliError(
        "MENTION_NOT_IN_CONTENT",
        `Structured mention @${mention.name} is not present in the message body.`,
      );
    }
  }

  if (!opts.sendDraft && !opts.targetConfirmed) {
    const confirmation = detectThreadContextParentSend(agentContext.agentId, target);
    if (confirmation) {
      archiveDraftBeingReplaced();
      setSavedDraft(agentContext.agentId, target, {
        content: outgoingContent,
        attachmentIds: outgoingAttachmentIds,
        idempotencyKey,
        mentions: outgoingMentions,
        ...(outgoingCard ? { card: outgoingCard } : {}),
        savedAt: currentTimeMs(),
        reholdCount: previousDraftReholdCount,
        seenUpToSeq,
        seenExactSeqs,
        // Inherits the rehold count above without a server hold: say so.
        cause: "thread_confirmation",
      });
      setFailureDraftSaved(true);
      if (draftBeingResolved) emitDraftResolved(traceScope, draftBeingResolved, "superseded");
      throw cliError(
        "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
        formatThreadContextParentSendMessage(target, {
          target: confirmation.threadTarget,
          seq: confirmation.threadSeq,
        }),
        {
          suggestedNextAction:
            `No message was sent. Send to ${confirmation.threadTarget} if this belongs in the thread, or confirm the saved top-level draft with \`raft message send --send-draft --target "${target}"\`.`,
        },
      );
    }
  }

  const plan = buildSendBody(agentContext.agentId, {
    target,
    content: outgoingContent,
    ...(outgoingCard ? { card: outgoingCard } : {}),
    attachmentIds: outgoingAttachmentIds,
    mentions: outgoingMentions,
    idempotencyKey,
    reholdCount: previousDraftReholdCount,
    seenUpToSeq,
    seenExactSeqs,
    reviewerIsolation,
    sendDraft: opts.sendDraft === true,
    anyway: opts.anyway === true,
  });
  const { body, cardForSend, peerForSend } = plan;
  seenUpToSeq = plan.seenUpToSeq;
  seenExactSeqs = plan.seenExactSeqs;
  let preSendCopySaved = false;
  if (!opts.sendDraft) {
    // The pre-send copy only exists to survive a failed send. The ledger is
    // loss-tolerant: if it cannot be written, send anyway and report honestly
    // that no draft was kept, rather than refusing to send at all.
    archiveDraftBeingReplaced();
    try {
      setSavedDraft(agentContext.agentId, target, {
        content: outgoingContent,
        attachmentIds: outgoingAttachmentIds,
        idempotencyKey,
        mentions: outgoingMentions,
        ...(outgoingCard ? { card: outgoingCard } : {}),
        savedAt: currentTimeMs(),
        reholdCount: previousDraftReholdCount,
        seenUpToSeq,
        seenExactSeqs,
        // Like the rehold count, the cause of the draft this copy replaces.
        ...(draftBeingResolved?.cause ? { cause: draftBeingResolved.cause } : {}),
      });
      preSendCopySaved = true;
      setFailureDraftSaved(true);
    } catch {
      setFailureDraftSaved(false);
    }
  }
  const client = ctx.createApiClient(agentContext);
  const agentApi = createAgentApiSurfaceClient(client);
  const outcome = await sendWithReconciliation(agentApi, body, {
    agentId: agentContext.agentId,
    target,
    idempotencyKey,
    reviewerIsolation,
    cardFile: loadedCard?.file ?? null,
  });

  if (outcome.kind === "held") {
    const data = outcome.data;
    // The continuation pilot (continuations_pilot_v0): a plain text send that
    // is held asks the agent instead of saving a draft. Read from the Server
    // only here, where it changes something; off, unknown or unreadable keeps
    // the draft flow below. A card message is not plain text: its draft keeps
    // the card (RFC 082).
    if (!opts.sendDraft && !opts.json && !reviewerIsolation && !outgoingCard && continuationsSupportedRuntime(ctx.env) && await continuationsPilotOn(ctx, agentContext)) {
      await continueHeldSend(ctx, agentContext, {
        target,
        content: outgoingContent,
        attachmentIds: outgoingAttachmentIds,
        mentions: outgoingMentions.map(({ type, id, name }) => ({ type, id, name })),
        reholdCount: previousDraftReholdCount,
        seenUpToSeq: seenUpToSeq ?? null,
        seenExactSeqs,
      }, { data, idempotencyKey, preSendCopySaved, seenUpToSeq, cardForSend, peerForSend });
      return;
    }
    const { heldForCardOnly, contextWasWithheld } = bookHeldContext(agentContext.agentId, target, data, { reviewerIsolation, seenUpToSeq });
    let heldDraftSaved = true;
    try {
      setSavedDraft(agentContext.agentId, target, {
        content: outgoingContent,
        attachmentIds: outgoingAttachmentIds,
        idempotencyKey,
        mentions: outgoingMentions,
        ...(outgoingCard ? { card: outgoingCard } : {}),
        savedAt: currentTimeMs(),
        reholdCount: previousDraftReholdCount + 1,
        // A hold for the card alone showed no messages: keep what was attested.
        seenUpToSeq: contextWasWithheld || heldForCardOnly ? seenUpToSeq : data.seenUpToSeq,
        seenExactSeqs: contextWasWithheld || heldForCardOnly ? seenExactSeqs : [],
        cause: "held",
      });
    } catch {
      heldDraftSaved = false;
    }
    if (heldDraftSaved) {
      emitDraftHeld(traceScope, { idempotencyKey, savedAt: currentTimeMs(), reholdCount: previousDraftReholdCount + 1, cause: "held" });
    }
    setFailureDraftSaved(heldDraftSaved);
    // `--send-draft` held again keeps the same draft (same key), so only a
    // normal send that replaced one ends it here.
    if (heldDraftSaved && !opts.sendDraft && draftBeingResolved) {
      emitDraftResolved(traceScope, draftBeingResolved, "superseded");
    }
    const heldDetails = contextWasWithheld ? redactFreshnessHoldForReviewerIsolation(data) : data;
    if (!opts.json) {
      const heldText = formatHeldSendOutput(
        target,
        data,
        contextWasWithheld,
        heldDraftSaved,
        outgoingCard ? { file: loadedCard?.file ?? null } : undefined,
      );
      writeText(ctx.io, heldText);
      countRendered(agentContext.agentId, heldForCardOnly ? "card_hold" : "freshness_hold", heldText);
    }
    // A card in the JSON error details is shown too: not recording it would
    // hold every JSON-mode send again, `--send-draft` included.
    if (data.channelCard && cardForSend && !contextWasWithheld) {
      await recordChannelCardShown(agentContext.agentId, data.channelCard, cardForSend.contextId, target, ctx.io);
    }
    if (data.peerCard && peerForSend && !contextWasWithheld) {
      await recordPeerCardShown(agentContext.agentId, data.peerCard, peerForSend.contextId, target, ctx.io);
    }
    if (!heldDraftSaved) {
      throw cliError("SEND_HELD", "Message held; no target delivery occurred and no draft was kept.", {
        draftSaved: false,
        effect: "not_executed",
        textDetailMode: "omit_restated_lines",
        retryable: false,
        outputMode: opts.json ? "json" : "text",
        details: { held: heldDetails as unknown as Record<string, unknown> },
        suggestedNextAction: "Review the held context. If it already says what you meant to say, send nothing; otherwise send the full content again.",
      });
    }
    throw cliError(
      "SEND_HELD_AS_DRAFT",
      "Message held as draft; no target delivery occurred.",
      {
        draftSaved: true,
        effect: "draft_saved",
        // The held text above already states the effect and lists both recovery
        // commands verbatim, so the labelled restatements are dropped from TEXT
        // only. Every field is kept, so JSON is unchanged (task #264).
        textDetailMode: "omit_restated_lines",
        retryable: false,
        outputMode: opts.json ? "json" : "text",
        details: { held: heldDetails as unknown as Record<string, unknown> },
        suggestedNextAction: "Review the held context. If it already says what you meant to say, send nothing and delete the draft (--discard-draft); otherwise update the draft or send it unchanged.",
      },
    );
  }

  // The server has committed: the receipt must reach the agent whatever the
  // ledger does. A failed clear leaves a draft carrying this same idempotency
  // key, so a later send only reports it replaced (safe); throwing here would
  // hide the Message ID and invite a duplicate resend.
  try {
    clearSavedDraftIfIdempotencyKeyMatches(agentContext.agentId, target, idempotencyKey);
  } catch {
    // Swallow: see above.
  }
  if (draftBeingResolved) {
    emitDraftResolved(traceScope, draftBeingResolved, opts.sendDraft ? "sent_unchanged" : "replaced_and_sent");
  }
  await writeSentOutput(ctx, agentContext, agentApi, target, outcome, {
    json: opts.json === true,
    reviewerIsolation,
    replacementArchiveAttempted,
    replacementRecoveryFilePath,
    cardForSend,
    peerForSend,
    messageCard: outgoingCard !== undefined,
  });
}

/** `raft message send --help`: card messages (RFC 082), kept short; the Manual topic `message` has every element's props. */
const MESSAGE_CARD_SEND_HELP =
  "\nCard messages (--card <file>):\n" +
  "  A card is a small display-only layout that everyone in the conversation sees the same way: Stack, Text, Badge, RelativeTime, Duration, Button (a button only opens an https link; \"open\": \"beside\" opens it in a panel beside the conversation on the web instead of a new tab), Markdown (bold, lists, quotes, code, http, https and mailto links), Fields (label and value rows) and Divider, under an optional header (a title, a subtitle, up to 3 tags).\n" +
  "  The file is JSON: {\"version\":1,\"header\":{\"title\":\"Build 42\",\"tags\":[{\"text\":\"In review\",\"tone\":\"info\"}]},\"root\":\"root\",\"elements\":{\"root\":{\"type\":\"Stack\",\"props\":{},\"children\":[\"facts\"]},\"facts\":{\"type\":\"Fields\",\"props\":{\"items\":[{\"label\":\"Version\",\"value\":\"1.20.0\",\"mono\":true}]}}}}\n" +
  `  Limits: ${MESSAGE_CARD_LIMITS.maxElements} elements, depth ${MESSAGE_CARD_LIMITS.maxDepth}, 12 children per Stack, ${MESSAGE_CARD_LIMITS.maxButtons} buttons, ${MESSAGE_CARD_LIMITS.maxFields} rows per Fields, 8 KiB of JSON (the header included). Markdown with anything else (a heading, table, image, HTML, a link that is not http, https or mailto, lists or quotes nested deeper than ${MESSAGE_CARD_LIMITS.markdownMaxNesting}) is refused, never cut. A card that breaks a rule is refused before anything is sent, with the element's path and the limit.\n` +
  "  The text on stdin is optional: it is what agents, search and notifications read. Without it, Raft makes it from the card (the header first), and it mentions no one: neither does an @name anywhere on the card, Markdown included.\n" +
  "  A card message carries no files: send files in a separate message.\n" +
  `  Only you can replace the card, for ${MESSAGE_CARD_LIMITS.updateWindowDays} days: raft message update-card. Replacing it notifies no one.\n` +
  "  If card messages are off on this Server (flag message_cards), the send is refused: send text instead.\n" +
  "  A Server older than card messages posts only the text: the receipt then says \"Sent as text only\" (with --json, it has no messageCard).\n" +
  "  Every element and its props: the Manual topic \"message\" (Card messages).\n";

export const messageSendCommand = defineCommand(
  {
    name: "send",
    description: "Send a message to a channel, DM, or thread",
    // Declared only so positional content gets the stdin guidance error
    // (rejectArgContent) instead of a generic parser error; usage hides it.
    arguments: ["[content...]"],
    usage: "--target <target> [options] < message body on stdin",
    helpAfter:
      "\nThe message body is read from stdin, never from arguments. Use a quoted heredoc so the shell leaves quotes, $vars and backticks alone:\n" +
      `  raft message send --target "#channel" <<'${MESSAGE_HEREDOC_DELIMITER}'\n` +
      "  message body\n" +
      `  ${MESSAGE_HEREDOC_DELIMITER}\n` +
      "\nIf the message is sent but an @mention could not be delivered, the command still exits 0 and lists each undelivered mention with its recovery command. Do not resend the message.\n" +
      MESSAGE_CARD_SEND_HELP,
    options: [
      { flags: "--target <target>", description: "Target: '#channel', 'dm:@peer', '#channel:shortid', 'dm:@peer:shortid' (a thread: shortid is its root message's msg=, as in replyTarget)" },
      PEER_KIND_OPTION,
      {
        flags: "--send-draft",
        description:
          `Send the saved draft when no stdin bytes are detected within ${SEND_DRAFT_STDIN_OBSERVATION_MS}ms`,
      },
      {
        flags: "--discard-draft",
        description: "Delete the saved draft for --target without sending it (with --expected-draft-key: only that draft)",
      },
      {
        flags: "--expected-draft-key <key>",
        description: "Fail closed unless the saved draft still has this idempotency key (requires --send-draft or --discard-draft)",
      },
      { flags: "--anyway", description: "Escape hatch: send a saved draft even if freshness re-check is still stale" },
      {
        flags: "--target-confirmed",
        description:
          "Confirm that the top-level --target is intentional even if the latest local read context was a thread",
      },
      reviewerIsolationOption,
      { flags: "--json", description: "Emit the Agent API send response as JSON" },
      { flags: "--content <content>", description: "Unsupported. Pipe message content to stdin instead.", hidden: true },
      {
        flags: "--attachment-id <id>",
        description: "Attachment ID to link (repeatable). Get one from `raft attachment upload`. Several IDs in one value, separated by spaces or commas, are split.",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--mention <actor>",
        description: "Bind an @handle to one actor (repeatable): human:<uuid>:<handle> or agent:<uuid>:<handle>.",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--card <file>",
        description: "Post the message as a card, from this JSON file (see Card messages below). The text on stdin is then optional.",
      },
    ],
  },
  async (ctx, positionalContent: string[], opts: SendOpts) => {
    let failureDraftSaved = false;
    try {
      await handleMessageSend(ctx, positionalContent, opts, (draftSaved) => {
        failureDraftSaved = draftSaved;
      });
    } catch (err) {
      // A pause (exit 10) and a continuation's refusal are not send failures.
      if (err instanceof CliExit || isContinuationRefusal(err)) throw err;
      throw markSendFailureDraftSaved(err, failureDraftSaved);
    }
  },
);

export function registerSendCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, messageSendCommand, runtimeOptions);
}

// ---- the continuation pilot (message/_sendContinuation.ts) ----

/**
 * The draft flow stays for runtimes the pilot fails (codex: it read the
 * pause's exit 10 as a failure and sent again, #wg-ax:#5). The Server already
 * reports the pilot off for them; this covers a server without that check.
 * The runtime is what the daemon passes the CLI; an unknown or missing
 * runtime keeps the pilot's behaviour.
 */
function continuationsSupportedRuntime(env: NodeJS.ProcessEnv): boolean {
  const runtime = cliTraceRuntime(env);
  return runtime === undefined || !CONTINUATIONS_DRAFT_FLOW_RUNTIMES.has(runtime);
}

const pilotReads = new WeakMap<CommandContext, Promise<boolean>>();

/**
 * Whether the continuation pilot (`continuations_pilot_v0`) is on for this
 * agent's server: the agent context's `features.continuationsPilot`, read
 * with the command's own client and credential. Read at most once per
 * command (a CLI process runs one), and only when a send is held. A failed
 * read, or a Server that does not report it, is off.
 */
function continuationsPilotOn(ctx: CommandContext, agentContext: ReturnType<CommandContext["loadAgentContext"]>): Promise<boolean> {
  let read = pilotReads.get(ctx);
  if (!read) {
    read = (async () => {
      try {
        const res = await createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).agent.context();
        return res.ok && res.data?.features?.continuationsPilot === true;
      } catch {
        return false;
      }
    })();
    pilotReads.set(ctx, read);
  }
  return read;
}

/**
 * A send just held, with the pilot on: keep the message in a continuation
 * instead of a draft. The attempt already made (today's send, under today's
 * key) is the continuation's first step, so nothing is sent again; its copy
 * is removed, so `--send-draft` cannot send the message a second time.
 */
async function continueHeldSend(
  ctx: CommandContext,
  agentContext: ReturnType<CommandContext["loadAgentContext"]>,
  args: SendContinuationArgs,
  held: {
    data: AgentApiHeldFreshnessResponse;
    idempotencyKey: string;
    preSendCopySaved: boolean;
    seenUpToSeq: number | undefined;
    cardForSend: SendBodyPlan["cardForSend"];
    peerForSend: SendBodyPlan["peerForSend"];
  },
): Promise<void> {
  if (held.preSendCopySaved) {
    try {
      clearSavedDraftIfIdempotencyKeyMatches(agentContext.agentId, args.target, held.idempotencyKey);
    } catch (err) {
      throw heldCopyNotCleared(err, args.target, null);
    }
  }
  const first = heldStep(ctx, agentContext.agentId, args.target, held.data, held);
  await runContinuable(ctx, ctx.continuations, messageSendContinuation(ctx, { answering: null }, first), args);
}

/**
 * What a held attempt journals (the question's preview), and what it records
 * once the question was printed: the shown messages as read, the render
 * count, the cards.
 */
function heldStep(
  ctx: CommandContext,
  agentId: string,
  target: string,
  data: AgentApiHeldFreshnessResponse,
  plan: { seenUpToSeq: number | undefined; cardForSend: SendBodyPlan["cardForSend"]; peerForSend: SendBodyPlan["peerForSend"] },
): { result: SendStepResult; afterPause: () => Promise<void> } {
  const { heldForCardOnly, contextWasWithheld } = countHold(agentId, target, data, { reviewerIsolation: false, seenUpToSeq: plan.seenUpToSeq });
  const { cardOnlyLead, preview } = renderAgentHoldPreview(target, data);
  return {
    result: { held: true, cardOnlyLead, preview, anywayOffered: data.continueAnywaySuggested === true },
    // What the question shows counts as seen once it was printed: a pause that
    // could not be saved (or a crash before it) showed nothing, so the next
    // send holds for the same messages and shows them.
    afterPause: async () => {
      recordHeldShown(agentId, target, data, contextWasWithheld);
      countRendered(agentId, heldForCardOnly ? "card_hold" : "freshness_hold", preview);
      if (contextWasWithheld) return;
      if (data.channelCard && plan.cardForSend) await recordChannelCardShown(agentId, data.channelCard, plan.cardForSend.contextId, target, ctx.io);
      if (data.peerCard && plan.peerForSend) await recordPeerCardShown(agentId, data.peerCard, plan.peerForSend.contextId, target, ctx.io);
    },
  };
}

/** What one invocation of the continued send keeps between its steps and its output. */
interface ContinuedSendLive {
  /** The continuation this invocation answers (`cont`), or null for the send's first run. */
  answering: ContinuationInvocation["answering"];
  /** The first run's attempt, already made and held (handleMessageSend): its step returns it. */
  first: ReturnType<typeof heldStep> | undefined;
  printedSentOutput: boolean;
  /** Run once the paused text was written (cards the agent has now seen). */
  afterPause: Array<() => Promise<void>>;
}

/**
 * One attempt of a continued send: the same body, request and bookkeeping as
 * a normal send, under the step's idempotency key. Held, it keeps no draft:
 * the message lives in the continuation, so `--send-draft` cannot send it a
 * second time. Sent, it prints the usual output.
 */
async function attemptContinuedSend(
  ctx: CommandContext,
  args: SendContinuationArgs,
  attempt: SendAttempt,
  live: ContinuedSendLive,
): Promise<SendStepResult> {
  if (live.first) {
    // The send itself happened before the continuation existed: journal what it got.
    const first = live.first;
    live.first = undefined;
    live.afterPause.push(first.afterPause);
    return first.result;
  }
  const agentContext = ctx.loadAgentContext();
  const agentId = agentContext.agentId;
  const { target } = args;
  const { idempotencyKey } = attempt;
  const plan = buildSendBody(agentId, {
    target,
    content: attempt.content,
    attachmentIds: args.attachmentIds,
    mentions: attempt.mentions,
    idempotencyKey,
    reholdCount: attempt.reholdCount,
    seenUpToSeq: args.seenUpToSeq ?? undefined,
    seenExactSeqs: args.seenExactSeqs,
    reviewerIsolation: false,
    sendDraft: attempt.mode !== "new",
    anyway: attempt.mode === "anyway",
  });
  // As for a normal send: a copy that survives a failed send, under the same key.
  let copySaved = false;
  try {
    setSavedDraft(agentId, target, {
      content: attempt.content,
      attachmentIds: args.attachmentIds,
      idempotencyKey,
      mentions: attempt.mentions,
      savedAt: currentTimeMs(),
      reholdCount: attempt.reholdCount,
      seenUpToSeq: plan.seenUpToSeq,
      seenExactSeqs: plan.seenExactSeqs,
    });
    copySaved = true;
  } catch {
    // Send anyway; a failure then reports that no draft was kept.
  }
  const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
  let outcome: MessageSendOutcome;
  try {
    outcome = await sendWithReconciliation(agentApi, plan.body, { agentId, target, idempotencyKey, reviewerIsolation: false });
  } catch (err) {
    throw markSendFailureDraftSaved(err, copySaved);
  }

  if (outcome.kind === "held") {
    // No held draft: drop the copy before anything is booked, so a failure
    // here leaves the hold unbooked.
    if (copySaved) {
      try {
        clearSavedDraftIfIdempotencyKeyMatches(agentId, target, idempotencyKey);
      } catch (err) {
        throw heldCopyNotCleared(err, target, live.answering);
      }
    }
    const held = heldStep(ctx, agentId, target, outcome.data, plan);
    live.afterPause.push(held.afterPause);
    return held.result;
  }

  // Committed: as for a normal send, a failed clear only leaves a copy under this same key.
  try {
    clearSavedDraftIfIdempotencyKeyMatches(agentId, target, idempotencyKey);
  } catch {
    // See handleMessageSend.
  }
  await writeSentOutput(ctx, agentContext, agentApi, target, outcome, {
    json: false,
    reviewerIsolation: false,
    replacementArchiveAttempted: false,
    replacementRecoveryFilePath: null,
    cardForSend: plan.cardForSend,
    peerForSend: plan.peerForSend,
  });
  live.printedSentOutput = true;
  return { held: false, status: outcome.kind, messageId: outcome.data.messageId ?? null };
}

/**
 * A held attempt whose local copy could not be removed. In the send's first
 * run nothing was saved for an answer: the copy is a draft like today's. In
 * `cont`, the continuation still holds the message: the run let go of the
 * answer, so the same `cont` takes it over and runs this step again under
 * the same key, as `--send-draft` would send the copy; a new send would be a
 * second message.
 */
function heldCopyNotCleared(cause: unknown, target: string, answering: ContinuedSendLive["answering"]): CliError {
  if (!answering) {
    return cliError("LOCAL_WRITE_FAILED", "Message held: no target delivery occurred, and its local copy could not be removed, so it was not kept for an answer.", {
      cause,
      draftSaved: true,
      retryable: false,
      suggestedNextAction: `Read the new messages (raft message read --target "${target}"), then send what still needs saying.`,
    });
  }
  const command = `cont ${answering.id}${answering.choice === undefined ? "" : ` ${answering.choice}`}`;
  const again = answering.withInput ? `${command} <<'${MESSAGE_HEREDOC_DELIMITER}'\n<the same text>\n${MESSAGE_HEREDOC_DELIMITER}` : command;
  return cliError(
    "LOCAL_WRITE_FAILED",
    `Your message could not be cleared from this computer's saved copy, so it is still kept for this question. Answer again with the same command: ${again}`,
    { cause, draftSaved: true, retryable: true },
  );
}

/**
 * `raft message send` held for unseen messages, as a continuation, built for
 * this invocation (its steps send through this invocation's agent and API
 * client). In the table `cont` resumes from (continuation/_commands.ts).
 */
export function messageSendContinuation(
  ctx: CommandContext,
  invocation: ContinuationInvocation,
  first?: ReturnType<typeof heldStep>,
): CliContinuationCommand<SendContinuationArgs, SendContinuationOutcome> {
  const live: ContinuedSendLive = { answering: invocation.answering, first, printedSentOutput: false, afterPause: [] };
  return createSendContinuation({
    attempt: (args, attempt) => attemptContinuedSend(ctx, args, attempt, live),
    printedSentOutput: () => live.printedSentOutput,
    onPaused: async () => {
      for (const action of live.afterPause.splice(0)) await action();
    },
  });
}
