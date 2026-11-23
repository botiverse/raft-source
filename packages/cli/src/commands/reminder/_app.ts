// `raft reminder` on a server whose reminders live in the Reminder app: the
// commands call the app's agent actions (create-reminder, list-reminders,
// show-reminder, update-reminder, snooze-reminder, cancel-reminder) and print
// the app's reply text. Everywhere else they keep the legacy reminder API.

import { appReplyText, asMessageId, parseRaftRefTarget } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import type { AgentContext } from "../../auth/env";
import type { CommandContext } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { NL, writeText, type CliReplyText } from "../../core/renderer";
import { AppReplyTextError, appActionFailureStatus } from "../integration/invoke";
import { parseReminderIdInput } from "../../apps/reminder/sealGuard";
import { formatReminderAppAnswer, formatReminderAppReply } from "./_format";
import { callReminderApp } from "./_triggerApp";

/** The legacy write routes' 409 code once the server's reminders moved to the app (nothing was changed). */
export const REMINDERS_MOVED_TO_APP = "reminders_moved_to_app";

/**
 * on / off: what the agent context said. unknown: it could not be read (a
 * 5xx, no answer) twice, so whether the reminders moved is not known.
 */
export type ReminderAppGate = "on" | "off" | "unknown";

const gateReads = new WeakMap<CommandContext, Promise<ReminderAppGate>>();

async function readGateOnce(ctx: CommandContext, agentContext: AgentContext): Promise<ReminderAppGate> {
  try {
    const res = await createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).agent.context();
    if (res.ok) return res.data?.features?.reminderApp === true ? "on" : "off";
    // A 4xx is the Server's answer (an older Server without the field reads as off); a 5xx is not.
    return res.status >= 500 || res.status === 0 ? "unknown" : "off";
  } catch {
    return "unknown";
  }
}

/**
 * Whether this agent's server keeps its reminders in the Reminder app: the
 * agent context's `features.reminderApp` (the Server's full gate), read once
 * per command, and once more if the first read gets no answer. Absent (an
 * older Server) is off. Off and unknown both use the legacy API; the Server
 * refuses a legacy write with `reminders_moved_to_app` when it disagrees
 * (wasMovedToApp), and unknown also asks the app about an id the legacy API
 * does not know (legacyThenApp).
 */
export function reminderAppGate(ctx: CommandContext, agentContext: AgentContext): Promise<ReminderAppGate> {
  let read = gateReads.get(ctx);
  if (!read) {
    read = (async () => {
      const first = await readGateOnce(ctx, agentContext);
      return first === "unknown" ? readGateOnce(ctx, agentContext) : first;
    })();
    gateReads.set(ctx, read);
  }
  return read;
}

/** A legacy write the Server refused because reminders moved to the app: nothing was changed, so it is redone there. */
export function wasMovedToApp(res: { ok: boolean; status: number; errorCode?: string | null }): boolean {
  return !res.ok && res.status === 409 && res.errorCode === REMINDERS_MOVED_TO_APP;
}

/** `--id` as the app takes it: `reminder:<id>[:<rev>]` (as `raft inbox check` prints it) becomes the bare id. */
export function reminderAppId(raw: string | undefined): string {
  const id = parseReminderIdInput(raw).id;
  if (!id) throw cliError("INVALID_ARG", "--id is required");
  return id;
}

const MAYBE_APPLIED =
  "It may or may not have been applied: check with raft reminder list (or raft reminder show --id <id>) before running it again.";

function isServerFailure(status: number | "transport" | null): boolean {
  return status === "transport" || (typeof status === "number" && status >= 500);
}

/**
 * The app's failure as the command's error. With reply text: that text,
 * quoted (free text never starts a line), under a CLI line naming the HTTP
 * status and the app's own code; the code is REMINDER_APP_REFUSED (4xx) or
 * REMINDER_APP_FAILED (anything else), with the app's code in details. A
 * refused write changed nothing and says so. A write that failed on the
 * app's side or got no answer may have run: it says so and is not retryable.
 * Any other error passes.
 */
export function reminderAppFailure(error: unknown, opts: { write: boolean }): unknown {
  const status = appActionFailureStatus(error);
  if (error instanceof AppReplyTextError) {
    const refused = error.httpStatus >= 400 && error.httpStatus < 500;
    const lines = [
      `The Reminder app ${refused ? "refused it" : "failed"} (HTTP ${error.httpStatus}${error.appCode ? ` ${error.appCode}` : ""}):`,
      formatReminderAppReply(error.reply, "error"),
    ];
    if (opts.write) lines.push(refused ? "Nothing was changed." : MAYBE_APPLIED);
    return new CliError({
      code: refused ? "REMINDER_APP_REFUSED" : "REMINDER_APP_FAILED",
      message: lines.join("\n"),
      details: { ...error.details, http_status: error.httpStatus, ...(error.appCode ? { app_code: error.appCode } : {}) },
      retryable: refused ? false : !opts.write,
    });
  }
  if (opts.write && error instanceof CliError && isServerFailure(status)) {
    return new CliError({
      code: "REMINDER_APP_FAILED",
      message: `${error.message}\n${MAYBE_APPLIED}`,
      details: error.details,
      retryable: false,
    });
  }
  return error;
}

/** True when the app answered that the reminder does not exist (or is not this agent's). */
export function isReminderAppNotFound(error: unknown): error is AppReplyTextError {
  return error instanceof AppReplyTextError && (error.appCode === "reminder_not_found" || error.httpStatus === 404);
}

/** No answer, or a gateway error: the request may not have reached the app. */
function isRetryableTransport(error: unknown): boolean {
  const status = appActionFailureStatus(error);
  return status === "transport" || status === 502 || status === 503 || status === 504;
}

/**
 * One app action; its answer, or the app's error as the command's error
 * (reminderAppFailure). `retryOnce`: only for create-reminder, whose
 * requestId makes the app answer a repeat with the same reminder; the same
 * payload (and requestId) goes once more after no answer or a 502-504.
 */
export async function askReminderApp(
  ctx: CommandContext,
  action: string,
  payload: Record<string, unknown>,
  opts: { write: boolean; retryOnce?: boolean },
): Promise<unknown> {
  const nothingDone = opts.write ? "nothing was changed" : "no reminders were read";
  try {
    return await callReminderApp(ctx, action, payload, nothingDone);
  } catch (error) {
    if (!(opts.retryOnce && isRetryableTransport(error))) throw reminderAppFailure(error, opts);
  }
  try {
    return await callReminderApp(ctx, action, payload, nothingDone);
  } catch (error) {
    throw reminderAppFailure(error, opts);
  }
}

/** The app's reply text as the command's answer; without one, a short line made from its JSON. */
export function writeReminderAppAnswer(ctx: CommandContext, value: unknown, after?: CliReplyText): void {
  const reply = appReplyText(value);
  const answer = reply ? formatReminderAppReply(reply) : formatReminderAppAnswer(value);
  if (after) writeText(ctx.io, answer, NL, NL, after, NL);
  else writeText(ctx.io, answer, NL);
}

export async function runReminderAppAction(
  ctx: CommandContext,
  action: string,
  payload: Record<string, unknown>,
  opts: { write: boolean; retryOnce?: boolean },
): Promise<void> {
  writeReminderAppAnswer(ctx, await askReminderApp(ctx, action, payload, opts));
}

/**
 * Gate unknown: the legacy command first; if it does not know the id
 * (`notFoundCodes`), the app with the same id (at least 8 characters, the
 * app's minimum). If the app does not know it either, or is not installed,
 * the legacy answer stands.
 */
export async function legacyThenApp(
  gate: ReminderAppGate,
  id: string,
  legacy: () => Promise<void>,
  viaApp: () => Promise<void>,
  notFoundCodes: readonly string[] = ["NOT_FOUND", "reminder_not_found"],
): Promise<void> {
  if (gate !== "unknown") return legacy();
  try {
    await legacy();
  } catch (legacyError) {
    if (!(legacyError instanceof CliError && notFoundCodes.includes(legacyError.code)) || id.length < 8) throw legacyError;
    try {
      await viaApp();
    } catch (appError) {
      if (isReminderAppNotFound(appError) || isAppNotFoundAnswer(appError)
        || (appError instanceof CliError && appError.code === "REMINDER_APP_NOT_INSTALLED")) {
        throw legacyError;
      }
      throw appError;
    }
  }
}

/** reminderAppFailure's form of the app's not-found answer. */
function isAppNotFoundAnswer(error: unknown): boolean {
  return error instanceof CliError && error.details?.app_code === "reminder_not_found";
}

/** Where a message is, from the exact message resolve route. */
interface MessagePlace {
  kind: "channel" | "dm";
  /** Channel name or DM peer (with ~agent/~human when the Server adds it). */
  name: string;
  /** The thread's 8-character id when the message is a thread reply. */
  thread: string | null;
  /** The message's own 8-character id. */
  id8: string;
}

function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase();
  if (norm(a) === norm(b)) return true;
  // dm:@bob and dm:@bob~agent name the same DM when only one side says the kind.
  const bare = (s: string) => norm(s).replace(/~(agent|human)$/, "");
  return (!a.includes("~") || !b.includes("~")) && bare(a) === bare(b);
}

function placeAddress(place: MessagePlace): string {
  const head = place.kind === "dm" ? `dm:@${place.name}` : `#${place.name}`;
  return `${head}:${place.thread ?? place.id8}`;
}

/**
 * Does `--channel` name the conversation the message is in? A channel or DM
 * matches the message there or in one of its threads; a thread address
 * matches a reply in that thread or the thread's first message.
 */
function channelMatches(channel: string, place: MessagePlace): boolean {
  const ref = parseRaftRefTarget(channel);
  const thread = place.thread ?? place.id8;
  switch (ref?.kind) {
    case "channel":
      return place.kind === "channel" && sameName(ref.channelName, place.name);
    case "dm":
      return place.kind === "dm" && sameName(ref.peerName, place.name);
    case "channel-thread":
      return place.kind === "channel" && sameName(ref.channelName, place.name) && ref.threadShortId.toLowerCase().startsWith(thread.toLowerCase());
    case "dm-thread":
      return place.kind === "dm" && sameName(ref.peerName, place.name) && ref.threadShortId.toLowerCase().startsWith(thread.toLowerCase());
    default:
      throw cliError(
        "INVALID_ARG",
        `--channel must be a channel, DM or thread (#channel, dm:@peer, #channel:<thread id>); got ${JSON.stringify(channel)}`,
      );
  }
}

/**
 * The app's anchor, a Raft address, for `--message-id`: always where the
 * message is, from the exact message resolve route (`#ch:<id8>`,
 * `dm:@peer:<id8>`; a thread reply anchors to its thread). `--channel` is
 * only a check: naming another conversation is refused, saying where the
 * message is.
 */
export async function resolveMessageAnchor(
  ctx: CommandContext,
  agentContext: AgentContext,
  messageId: string,
  channel?: string,
): Promise<string> {
  const res = await createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).messages.resolve({ msgId: asMessageId(messageId) });
  const message = res.ok ? res.data?.message : undefined;
  const fullId = message?.message_id ?? message?.id ?? messageId;
  const name = message?.channel_name;
  if (!res.ok || !message || !name) {
    throw cliError(
      res.status >= 500 ? "SERVER_5XX" : "INVALID_ARG",
      `Could not find message ${messageId} to anchor the reminder to${res.error ? ` (${res.error})` : ""}; nothing was scheduled.`,
      { suggestedNextAction: "Pass a message id from a message header you can see (raft message search finds one)." },
    );
  }
  const place: MessagePlace = message.channel_type === "thread" && message.parent_channel_name
    ? {
        kind: message.parent_channel_type === "dm" ? "dm" : "channel",
        name: message.parent_channel_name,
        thread: (name.startsWith("thread-") ? name.slice("thread-".length) : name).slice(0, 8),
        id8: fullId.slice(0, 8),
      }
    : { kind: message.channel_type === "dm" ? "dm" : "channel", name, thread: null, id8: fullId.slice(0, 8) };
  const address = placeAddress(place);
  if (channel && !channelMatches(channel, place)) {
    throw cliError(
      "INVALID_ARG",
      `Message ${messageId} is in ${address}, not ${channel}; nothing was scheduled.`,
      { suggestedNextAction: `Pass --channel ${address}, or leave --channel out.` },
    );
  }
  return address;
}
