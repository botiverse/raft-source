// `raft message send --target <t> [--attachment-id <id>...]`
// → POST /internal/agent-api/send

import type { Readable } from "node:stream";
import type { Command } from "commander";
import {
  currentTimeMs,
  structuredRaftMentionStillAppears,
  type AgentApiHeldFreshnessResponse,
  type AgentApiSendV2Body,
  type AgentApiSendSentResponse,
  type AgentApiStructuredMention,
} from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import {
  getConsumedReadOrder,
  getConsumedSeq,
  getMostRecentConsumedThreadForParent,
  getParentTargetForThread,
  recordConsumedSeqs,
  type ConsumedThreadTarget,
} from "./_consumedSeqState.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context.js";
import { CliError, cliError } from "../../core/errors.js";
import { adoptCliReplyText, writeDiagnostic, writeJson, writeText, NL, type CliReplyText } from "../../core/renderer.js";
import {
  formatFreshnessHoldOutput,
  redactFreshnessHoldForReviewerIsolation,
  type FreshnessHoldOutputData,
} from "../freshness/_format.js";
import {
  formatPendingMentionActions,
  normalizePendingMentionActions,
  normalizeUnresolvedMentionHandles,
  toSenderPendingMentionAction,
  toSenderUnresolvedMentionWarning,
} from "../mention/_format.js";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation.js";
import { clearSavedDraft, getSavedDraft, setSavedDraft } from "./_continueDraftState.js";
import {
  SEND_DRAFT_STDIN_OBSERVATION_MS,
  formatDraftReplacedWarning,
  formatMessages,
  formatSendDraftStdinDeadlineDiagnostic,
} from "./_format.js";

// Re-exports for existing imports; canonical home is message/_format.ts.
export {
  DRAFT_REPLACED_EXCERPT_LIMIT,
  SEND_DRAFT_STDIN_OBSERVATION_MS,
  formatDraftReplacedWarning,
  formatSendDraftStdinDeadlineDiagnostic,
} from "./_format.js";

interface SendOpts extends ReviewerIsolationOpts {
  target: string;
  content?: string;
  attachmentId?: string[];
  mention?: string[];
  sendDraft?: boolean;
  anyway?: boolean;
  targetConfirmed?: boolean;
  json?: boolean;
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
  | { kind: "sent"; data: AgentApiSendSentResponse };

export class SendContentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SendContentError";
  }
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

export function validateDraftSendFlags(opts: Pick<SendOpts, "sendDraft" | "anyway" | "attachmentId">): void {
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
): CliReplyText {
  if (reviewerIsolation || data.freshnessContextMode === "withheld") {
    return formatFreshnessHoldOutput(target, data, {
      withholdContext: true,
      heldAction: "Your message has been saved as a draft.",
      draftInstructions:
        `To preserve reviewer isolation and send this exact draft despite unseen context:\n` +
        `  raft message send --reviewer-isolation --send-draft --anyway --target "${target}"\n` +
        `To change the draft, send revised content normally with --reviewer-isolation.\n` +
        `Only leave the review seat and use raft message read if the review authority explicitly permits seeing the withheld context.\n`,
    });
  }
  return formatFreshnessHoldOutput(target, data, {
    heldAction: "Your message has been saved as a draft.",
    draftInstructions:
      `To update the draft, send revised content normally:\n` +
      `  raft message send --target "${target}" <<'${MESSAGE_HEREDOC_DELIMITER}'\n` +
      `  revised message\n` +
      `  ${MESSAGE_HEREDOC_DELIMITER}\n` +
      `To send the current draft unchanged:\n` +
      `  raft message send --send-draft --target \"${target}\"\n` +
      `  (this sends the stored copy — do not use it if you meant to change the content)\n` +
      `You can also choose not to send anything.\n`,
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

interface ThreadContextTargetConfirmation {
  parentTarget: string;
  threadTarget: string;
  threadSeq: number;
}

export function detectThreadContextParentSend(
  agentId: string,
  target: string,
): ThreadContextTargetConfirmation | null {
  if (getParentTargetForThread(target) !== null) return null;
  const latestThread = getMostRecentConsumedThreadForParent(agentId, target);
  if (!latestThread) return null;
  const parentReadOrder = getConsumedReadOrder(agentId, target);
  if (parentReadOrder !== undefined && parentReadOrder >= latestThread.readOrder) return null;
  return {
    parentTarget: target,
    threadTarget: latestThread.target,
    threadSeq: latestThread.seq,
  };
}

export function formatThreadContextParentSendMessage(
  target: string,
  latestThread: Pick<ConsumedThreadTarget, "target" | "seq">,
): string {
  return [
    `Possible thread target mismatch: your latest read context under ${target} is ${latestThread.target}, but this send targets ${target} top-level.`,
    "This guard is intentionally narrow: moving a thread conclusion to the parent channel can be correct, but it is uncommon enough to confirm once.",
    "",
    "If this reply belongs in the thread, send the message to the thread target instead:",
    `  raft message send --target "${latestThread.target}" <<'${MESSAGE_HEREDOC_DELIMITER}'`,
    "  message body",
    `  ${MESSAGE_HEREDOC_DELIMITER}`,
    "",
    "If the top-level channel message is intentional, send the saved draft unchanged:",
    `  raft message send --send-draft --target "${target}"`,
  ].join("\n");
}

export function markSendFailureDraftSaved(err: unknown, draftSaved: boolean): Error {
  const transportAmbiguous = err instanceof CliError
    ? err.fault_domain === "agent_api_transport"
    : true;
  const suggestedNextAction = draftSaved && transportAmbiguous
    ? "Delivery state is UNKNOWN: the send failed after the draft was saved, so the message may or may not have been committed. Reading CANNOT settle this. Only an authoritative identity reconciliation can — an idempotency/request/correlation identity bound by the failed request or by a server receipt, confirmed committed by an authoritative record. This CLI does not currently expose such a lookup for message send, so the honest state is CANNOT_CONFIRM. Reading is still worth doing, but it settles nothing on its own: `raft message read --target <target>` can only show that A message matching what you looked for is present, which is not the same as YOUR send having been committed unless you identified it by an authoritative identity — and this CLI does not expose that here. Wait about 90s before looking, because delivery to readable lags; that is a hint against looking too early, not a bound on visibility and not a safety gate. Not seeing it proves nothing: absence is equally consistent with committed-but-not-yet-visible, however many times and however far apart you read, and however wide the window. Matching your own text is not identity either: a hit can be someone else quoting the same string, and a miss can be a committed message you cannot see yet. So the outcome stays unknown and not retryable. Do not resend on this evidence. You may keep waiting, or reconcile out of band. Sending the draft again is a decision by a person to accept a duplicate, not a finding that the original failed, so this guidance does not direct you to it."
    : undefined;
  if (err instanceof CliError) {
    if (err.draftSaved !== undefined) return err;
    return new CliError({
      code: err.code,
      message: err.message,
      exitCode: err.exitCode,
      cause: err.cause,
      suggestedNextAction: err.suggestedNextAction ?? suggestedNextAction,
      textDetailMode: err.textDetailMode,
      draftSaved,
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
      retryable: transportAmbiguous ? false : err.retryable,
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

async function handleMessageSend(
  ctx: CommandContext,
  positionalContent: string[],
  opts: SendOpts,
  setFailureDraftSaved: (draftSaved: boolean) => void,
): Promise<void> {
  const target = opts.target?.trim() ?? "";
  if (!target) {
    throw cliError("INVALID_ARG", "--target is required");
  }
  const reviewerIsolation = reviewerIsolationEnabled(opts, ctx.env);

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
  let previousDraftReholdCount = 0;
  let seenUpToSeq: number | undefined;
  let sendDraftStdinDeadlineExpired = false;
  if (opts.sendDraft) {
    content = await resolveOptionalSendContent(ctx.io.stdin ?? process.stdin, {
      onNoBytesWithinWindow: () => {
        sendDraftStdinDeadlineExpired = true;
      },
    });
    try {
      rejectSendDraftStdin(content, opts.target);
    } catch (err) {
      if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
  } else {
    try {
      content = await resolveSendContent(ctx.io.stdin ?? process.stdin);
    } catch (err) {
      if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
    outgoingContent = content;
    outgoingAttachmentIds = opts.attachmentId && opts.attachmentId.length > 0 ? opts.attachmentId : [];
  }

  const agentContext = ctx.loadAgentContext();
  if (opts.sendDraft) {
    const savedDraft = getSavedDraft(agentContext.agentId, target);
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
    outgoingContent = savedDraft.content;
    outgoingAttachmentIds = savedDraft.attachmentIds;
    outgoingMentions = explicitMentions.length > 0 ? explicitMentions : (savedDraft.mentions ?? []);
    previousDraftReholdCount = savedDraft.reholdCount;
    seenUpToSeq = savedDraft.seenUpToSeq;
    setFailureDraftSaved(true);
    if (sendDraftStdinDeadlineExpired) {
      writeDiagnostic(ctx.io, formatSendDraftStdinDeadlineDiagnostic(), NL);
    }
  } else {
    const previousDraft = getSavedDraft(agentContext.agentId, target);
    previousDraftReholdCount = previousDraft?.reholdCount ?? 0;
    seenUpToSeq = previousDraft?.seenUpToSeq;
    if (previousDraft && previousDraft.content.trim().length > 0) {
      // Keyed on "a draft with a body exists", NOT on draftReplacedExisting
      // below: that flag is `reholdCount > 0`, so a draft held exactly once
      // reports false while still being destroyed here.
      writeDiagnostic(ctx.io, formatDraftReplacedWarning(target, previousDraft.content), NL);
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
      setSavedDraft(agentContext.agentId, target, {
        content: outgoingContent,
        attachmentIds: outgoingAttachmentIds,
        mentions: outgoingMentions,
        savedAt: currentTimeMs(),
        reholdCount: previousDraftReholdCount,
        seenUpToSeq,
      });
      setFailureDraftSaved(true);
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

  if (seenUpToSeq === undefined) {
    // FH-001 full-body advance contract (A), send side: attest only the
    // local per-target cursor recorded by active body-returning operations
    // that safely advance a contiguous boundary (`message read` in this
    // slice). Target keys stay isolated (thread != parent); passive wake/inbox
    // notices and sparse `message check` drains never record this cursor.
    // Absent cursor means omit `seenUpToSeq` so the server freshness gate fails
    // closed.
    seenUpToSeq = getConsumedSeq(agentContext.agentId, target);
  }
  const body: AgentApiSendV2Body = {
    target,
    content: outgoingContent,
    draftReholdCount: previousDraftReholdCount,
  };
  if (reviewerIsolation) {
    body.freshnessContextMode = "withheld";
  }
  if (seenUpToSeq !== undefined) {
    body.seenUpToSeq = seenUpToSeq;
  }
  if (opts.sendDraft) {
    body.sendDraft = true;
    if (opts.anyway) body.continueAnyway = true;
  } else {
    body.draftReplacedExisting = previousDraftReholdCount > 0;
  }
  if (outgoingAttachmentIds.length > 0) {
    body.attachmentIds = outgoingAttachmentIds;
  }
  if (outgoingMentions.length > 0) {
    body.mentions = outgoingMentions;
  }
  if (!opts.sendDraft) {
    setSavedDraft(agentContext.agentId, target, {
      content: outgoingContent,
      attachmentIds: outgoingAttachmentIds,
      mentions: outgoingMentions,
      savedAt: currentTimeMs(),
      reholdCount: previousDraftReholdCount,
      seenUpToSeq,
    });
    setFailureDraftSaved(true);
  }
  const client = ctx.createApiClient(agentContext);
  const agentApi = createAgentApiSurfaceClient(client);
  let res;
  try {
    res = await agentApi.messages.sendV2(body);
  } catch (err) {
    if (reviewerIsolation) {
      throw cliError(
        "SEND_FAILED",
        "Reviewer-isolation send failed; upstream response detail was withheld.",
        { cause: err },
      );
    }
    throw err;
  }
  if (!res.ok) {
    const code = res.status >= 500 ? "SERVER_5XX" : "SEND_FAILED";
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
  const outcome = classifyMessageSendOutcome(rawData);

  if (outcome.kind === "held") {
    const data = outcome.data;
    const contextWasWithheld = reviewerIsolation || data.freshnessContextMode === "withheld";
    // The held bounded context was just rendered to the agent — that
    // boundary is consumed too; record it so even an abandoned draft
    // leaves an honest per-target cursor behind.
    if (!contextWasWithheld && typeof data.seenUpToSeq === "number" && Number.isFinite(data.seenUpToSeq)) {
      recordConsumedSeqs(agentContext.agentId, { [target]: data.seenUpToSeq });
    }
    setSavedDraft(agentContext.agentId, target, {
      content: outgoingContent,
      attachmentIds: outgoingAttachmentIds,
      mentions: outgoingMentions,
      savedAt: currentTimeMs(),
      reholdCount: previousDraftReholdCount + 1,
      seenUpToSeq: contextWasWithheld ? seenUpToSeq : data.seenUpToSeq,
    });
    const heldDetails = contextWasWithheld ? redactFreshnessHoldForReviewerIsolation(data) : data;
    if (!opts.json) {
      writeText(ctx.io, formatHeldSendOutput(target, data, contextWasWithheld));
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
        suggestedNextAction: "Review the held context, then update the draft or send the current draft unchanged.",
      },
    );
  }

  const data = outcome.data;
  clearSavedDraft(agentContext.agentId, target);
  const shortId = data.messageId ? data.messageId.slice(0, 8) : null;
  const replyHint = shortId
    ? ` (to reply in this message's thread, use target "${target.includes(":") ? target : target + ":" + shortId}")`
    : "";

  let unreadSection = "";
  if (data.recentUnread && data.recentUnread.length > 0) {
    unreadSection = `\n\n--- New messages you may have missed ---\n${formatMessages(data.recentUnread)}`;
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
  const driveByTip = formatDriveByJoinedToPostTip(target, data);
  const driveBySection = driveByTip ? `\n\n${driveByTip}` : "";

  const mentionRecoveryCommands = pendingMentionActions
    .map((action) => toSenderPendingMentionAction(action).recoveryCommand)
    .filter((command): command is string => command !== null);
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
  const mentionDeliveryError = undeliveredMentionCount > 0
    ? cliError(
        "MENTION_DELIVERY_FAILED",
        `Partial result for message ${data.messageId}: message status=queued; ${undeliveredMentionCount} @mention${undeliveredMentionCount === 1 ? "" : "s"} status=not_queued.`,
        {
          draftSaved: false,
          effect: "message_queued",
          retryable: false,
          outputMode: opts.json ? "json" : "text",
          details: partialSendPayload ? { result: partialSendPayload } : undefined,
          suggestedNextAction:
            [
              "The message is already queued.",
              ...(mentionRecoveryCommands.length > 0
                ? [
                    `Run only the per-token mention ${mentionRecoveryCommands.length === 1 ? "recovery" : "recoveries"}: `
                      + mentionRecoveryCommands.map((command) => `\`${command}\``).join("; ")
                      + ".",
                  ]
                : []),
              ...(unresolvedMentionHandles.length > 0
                ? ["If an unresolved token was literal prose, wrap it in code; otherwise verify the exact handle and send only a corrected follow-up mention."]
                : []),
              "Do not resend the queued message.",
            ].join(" "),
        },
      )
    : null;
  if (opts.json) {
    if (mentionDeliveryError) throw mentionDeliveryError;
    writeJson(ctx.io, data);
    return;
  }

  const partialSection = mentionSection ? `${mentionSection}\n\n` : "";
  writeText(ctx.io, adoptCliReplyText(`${partialSection}${sentStatusLine}${replyHint}${driveBySection}${unreadSection}`), NL);
  if (mentionDeliveryError) throw mentionDeliveryError;
}

export const messageSendCommand = defineCommand(
  {
    name: "send",
    description: "Send a message to a channel, DM, or thread",
    arguments: ["[content...]"],
    options: [
      { flags: "--target <target>", description: "Target: '#channel', 'dm:@peer', '#channel:threadId', 'dm:@peer:threadId'" },
      {
        flags: "--send-draft",
        description:
          `Send the saved draft when no stdin bytes are detected within ${SEND_DRAFT_STDIN_OBSERVATION_MS}ms`,
      },
      { flags: "--anyway", description: "Escape hatch: send a saved draft even if freshness re-check is still stale" },
      {
        flags: "--target-confirmed",
        description:
          "Confirm that the top-level --target is intentional even if the latest local read context was a thread",
      },
      reviewerIsolationOption,
      { flags: "--json", description: "Emit the Agent API send response as JSON" },
      { flags: "--content <content>", description: "Unsupported. Pipe message content to stdin instead." },
      {
        flags: "--attachment-id <id>",
        description: "Attachment id to link (repeatable). Get one from `raft attachment upload`.",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--mention <actor>",
        description: "Bind an @handle to one actor (repeatable): human:<uuid>:<handle> or agent:<uuid>:<handle>.",
        parse: (value, prev: string[] = []) => prev.concat(value),
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
      throw markSendFailureDraftSaved(err, failureDraftSaved);
    }
  },
);

export function registerSendCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, messageSendCommand, runtimeOptions);
}
