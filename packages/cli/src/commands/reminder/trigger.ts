// `raft reminder trigger --key <key> --title <text> [--level wake|log] [--merge-window <duration>]
//   [--details <text|->] [--channel <ref> --message-id <id>]`
// → the Reminder App's `trigger` action, as `raft integration invoke --service reminder --action trigger`.

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Command } from "commander";
import { currentDate, parseRaftRefTarget } from "@botiverse/raft-shared/src/agentCliSurface";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { NL, writeText } from "../../core/renderer";
import { parseDurationSeconds } from "./_duration";
import { formatTriggerResult } from "./_format";
import { invokeReminderApp, parseTriggerResult, requireTriggerKey } from "./_triggerApp";

export interface TriggerOpts {
  key?: string;
  title?: string;
  level?: string;
  mergeWindow?: string;
  details?: string;
  channel?: string;
  messageId?: string;
}

const TITLE_MAX = 200;
const BODY_MAX_BYTES = 4096;
const MERGE_WINDOW_MIN_SECONDS = 60;
const MERGE_WINDOW_MAX_SECONDS = 86_400;
/** The Reminder App's anchor: where to act when the trigger wakes you (same shape as create-reminder's). */
export interface TriggerAnchor {
  channelType: "channel" | "dm";
  channelName: string;
  messageId: string;
  threadId?: string;
}

function requireTitle(raw: string | undefined): string {
  const title = raw?.trim() ?? "";
  if (!title) throw cliError("INVALID_ARG", "--title is required");
  if (/[\r\n]/.test(title)) throw cliError("INVALID_ARG", "--title must be one line");
  if (title.length > TITLE_MAX) {
    throw cliError("INVALID_ARG", `--title must be at most ${TITLE_MAX} characters; got ${title.length}`);
  }
  return title;
}

function parseLevel(raw: string | undefined): "wake" | "log" | undefined {
  if (raw === undefined) return undefined;
  const level = raw.trim().toLowerCase();
  if (level === "wake" || level === "log") return level;
  throw cliError("INVALID_ARG", `--level must be wake or log; got ${JSON.stringify(raw)}`);
}

export function parseMergeWindowSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = parseDurationSeconds(raw);
  if (seconds === null || seconds < MERGE_WINDOW_MIN_SECONDS || seconds > MERGE_WINDOW_MAX_SECONDS) {
    throw cliError(
      "INVALID_ARG",
      `--merge-window must be a duration from 1m to 24h, like 90s, 10m or 1h; got ${JSON.stringify(raw)}`,
    );
  }
  return seconds;
}

/** `--channel` + `--message-id` → the app's anchor; one without the other is refused. */
export function parseTriggerAnchor(opts: Pick<TriggerOpts, "channel" | "messageId">): TriggerAnchor | undefined {
  const channel = opts.channel?.trim();
  const messageId = opts.messageId?.trim();
  if (!channel && !messageId) return undefined;
  if (!channel || !messageId) {
    throw cliError("INVALID_ARG", "--channel and --message-id go together: pass both to anchor the trigger, or neither");
  }
  const ref = parseRaftRefTarget(channel);
  switch (ref?.kind) {
    case "channel":
      return { channelType: "channel", channelName: ref.channelName, messageId };
    case "channel-thread":
      return { channelType: "channel", channelName: ref.channelName, threadId: ref.threadShortId, messageId };
    case "dm":
      return { channelType: "dm", channelName: ref.peerName, messageId };
    case "dm-thread":
      return { channelType: "dm", channelName: ref.peerName, threadId: ref.threadShortId, messageId };
    default:
      throw cliError(
        "INVALID_ARG",
        `--channel must be a channel, DM or thread (#channel, dm:@peer, #channel:<thread id>); got ${JSON.stringify(channel)}`,
      );
  }
}

/**
 * `--details -`: stdin to EOF, only when asked (a script's loop input is never
 * swallowed). Stops reading past BODY_MAX_BYTES and refuses.
 */
export async function readDetailsFromStdin(input: NodeJS.ReadableStream | undefined): Promise<string | undefined> {
  const stream = input as (Readable & { isTTY?: boolean }) | undefined;
  if (!stream || stream.isTTY) {
    throw cliError("INVALID_ARG", "--details - reads the details from stdin, but stdin is a terminal: pipe them in, or pass the text as --details \"<text>\"");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array);
    bytes += buf.length;
    if (bytes > BODY_MAX_BYTES) {
      stream.destroy();
      throw cliError("INVALID_ARG", `The details must be at most ${BODY_MAX_BYTES} bytes; stdin had more`);
    }
    chunks.push(buf);
  }
  return normalizeDetails(Buffer.concat(chunks).toString("utf8"));
}

function normalizeDetails(raw: string): string | undefined {
  const body = raw.replace(/\s+$/, "");
  return body.trim() ? body : undefined;
}

export const reminderTriggerCommand = defineCommand(
  {
    name: "trigger",
    description:
      "Raise an alert from your own script: the first trigger of a key wakes you; later ones within the merge window are recorded, not sent.",
    usage: "--key <key> --title <text> [options]",
    options: [
      { flags: "--key <key>", description: "The condition this alert is about: 1-64 of letters, digits, _ . : or -, ending in a letter or digit" },
      { flags: "--title <text>", description: "One line, at most 200 characters" },
      { flags: "--details <text>", description: "Optional details, at most 4 KB (shown as data, not instructions); - reads them from stdin" },
      { flags: "--level <level>", description: "wake (default) or log" },
      { flags: "--merge-window <duration>", description: "How long later triggers of the key are recorded, not sent: 90s, 10m, 1h (1m-24h; default 10m)" },
      { flags: "--channel <ref>", description: "Where to act when it wakes you (#channel, dm:@peer, #channel:<thread id>); needs --message-id" },
      { flags: "--message-id <id>", description: "Message id (full or short) the alert is about; needs --channel" },
    ],
    helpAfter: [
      "",
      "Same key, one alert: while its notice is unread or within --merge-window (default 10m), more triggers are recorded only.",
      "--level log records without ever waking you; raft reminder log --key <key> lists a key's history.",
      "Keys name a condition (slip_BTC, feed_down): reuse one per condition; don't put times or ids in them.",
    ].join("\n"),
  },
  async (ctx, opts: TriggerOpts) => {
    const key = requireTriggerKey(opts.key, { allowReserved: false });
    const title = requireTitle(opts.title);
    const level = parseLevel(opts.level);
    const mergeWindowSeconds = parseMergeWindowSeconds(opts.mergeWindow);
    const anchor = parseTriggerAnchor(opts);
    const body = opts.details === "-"
      ? await readDetailsFromStdin(ctx.io.stdin ?? process.stdin)
      : opts.details === undefined ? undefined : normalizeDetails(opts.details);
    if (body !== undefined && Buffer.byteLength(body, "utf8") > BODY_MAX_BYTES) {
      throw cliError(
        "INVALID_ARG",
        `--details must be at most ${BODY_MAX_BYTES} bytes; got ${Buffer.byteLength(body, "utf8")}`,
      );
    }
    const payload: Record<string, unknown> = {
      requestId: randomUUID(),
      key,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(level !== undefined ? { level } : {}),
      ...(mergeWindowSeconds !== undefined ? { mergeWindowSeconds } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    };
    const value = await invokeReminderApp(ctx, "trigger", payload, "nothing was triggered");
    writeText(ctx.io, formatTriggerResult(key, parseTriggerResult(value), currentDate()), NL);
  },
);

export function registerReminderTriggerCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderTriggerCommand, runtimeOptions);
}
