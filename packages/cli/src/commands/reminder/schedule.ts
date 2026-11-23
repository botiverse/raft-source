// `raft reminder schedule --title <t> [--delay-seconds <n> | --fire-at <iso>] [--message-id <id>]`
// → POST /internal/agent-api/reminders, or the Reminder app's create-reminder
//   on a server whose reminders live in the app (_app.ts).

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { AgentApiRequestBodyByRoute } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { apiFailureError } from "../../core/apiFailure";
import { CliError, cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";
import { formatReminderScheduled } from "./_format";
import { reminderAppGate, resolveMessageAnchor, runReminderAppAction, wasMovedToApp } from "./_app";

export interface ScheduleOpts {
  title: string;
  delaySeconds?: string;
  fireAt?: string;
  messageId?: string;
  msgId?: string;
  repeat?: string;
  tz?: string;
  channel?: string;
  peerKind?: string;
}

export interface ScheduleBodyResult {
  body: Record<string, unknown>;
  error?: { code: string; message: string };
}

// Pure body builder so tests can assert the agent-side reminder contract
// without spinning up an HTTP client. Agent-created reminders must carry an
// explicit anchor msgId; resolve failure should fail closed instead of
// silently creating an unanchored row.
export function buildScheduleBody(
  opts: ScheduleOpts,
  now: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): ScheduleBodyResult {
  const canonicalMessageId = opts.messageId?.trim();
  const legacyMsgId = opts.msgId?.trim();
  if (canonicalMessageId && legacyMsgId && canonicalMessageId !== legacyMsgId) {
    return {
      body: {},
      error: {
        code: "INVALID_ARG",
        message: "Pass only one message anchor; --msg-id is a deprecated alias for --message-id",
      },
    };
  }
  const msgId = canonicalMessageId || legacyMsgId || undefined;

  if (!opts.delaySeconds && !opts.fireAt && !opts.repeat) {
    return {
      body: {},
      error: { code: "INVALID_ARG", message: "Provide --delay-seconds, --fire-at, or --repeat" },
    };
  }
  if (opts.delaySeconds && opts.fireAt) {
    return {
      body: {},
      error: {
        code: "INVALID_ARG",
        message: "Pass either --delay-seconds or --fire-at, not both",
      },
    };
  }
  if (opts.tz !== undefined && opts.repeat === undefined) {
    return {
      body: {},
      error: { code: "INVALID_ARG", message: "--tz requires --repeat" },
    };
  }

  const body: Record<string, unknown> = { title: opts.title, msgId: msgId ?? null };

  if (opts.delaySeconds !== undefined) {
    const n = Number(opts.delaySeconds);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return {
        body: {},
        error: {
          code: "INVALID_ARG",
          message: `--delay-seconds must be a positive integer; got ${opts.delaySeconds}`,
        },
      };
    }
    body.delaySeconds = n;
  }
  if (opts.fireAt !== undefined) body.fireAt = opts.fireAt;
  if (opts.repeat !== undefined) {
    body.repeat = opts.repeat;
    // Snapshot caller's IANA tz into daily/weekly rules so later fires
    // don't drift if the caller's host tz changes. Interval rules ignore
    // tz but passing it is harmless.
    const timezone = opts.tz?.trim() || now();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      return {
        body: {},
        error: { code: "INVALID_ARG", message: `--tz must be a valid IANA timezone; got ${timezone}` },
      };
    }
    body.tz = timezone;
  }
  if (opts.channel !== undefined || opts.peerKind !== undefined) {
    try {
      body.channel = opts.peerKind === undefined ? opts.channel : applyDmPeerKind((opts.channel ?? "").trim(), opts.peerKind);
    } catch (err) {
      if (err instanceof CliError) return { body: {}, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  // Agent-created reminders must stay anchored. If we still failed to carry
  // a message anchor, fail closed instead of silently creating a
  // half-correct reminder row with msgRef = null.
  if (body.msgId == null) {
    return {
      body: {},
      error: {
        code: "INVALID_ARG",
        message:
          "Reminder create requires an anchor msgId; resolve a message first and pass --message-id",
      },
    };
  }

  return { body };
}

export interface AppCreateResult {
  /** create-reminder's flat parameters, without `anchor` and `requestId`. */
  payload: Record<string, unknown>;
  /** `--channel` with `--peer-kind` applied, when given. */
  channel?: string;
  messageId: string;
  error?: undefined;
}

/**
 * The Reminder app's create-reminder parameters from the same flags, checked
 * like buildScheduleBody (one of --delay-seconds/--fire-at/--repeat, not
 * both times, a message anchor), except that --tz may also set a one-shot's
 * zone. --repeat without --tz takes this host's zone, as the legacy builder.
 */
export function buildAppCreatePayload(
  opts: ScheduleOpts,
  hostTimezone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): AppCreateResult | { error: { code: string; message: string } } {
  // The shared checks (and their messages) are the legacy builder's; --tz is
  // checked here, as the app also takes it for a one-shot.
  const shared = buildScheduleBody({ ...opts, tz: undefined }, hostTimezone);
  if (shared.error) return { error: shared.error };
  const payload: Record<string, unknown> = { title: opts.title };
  if (opts.delaySeconds !== undefined) payload.in = `${shared.body.delaySeconds as number}s`;
  if (opts.fireAt !== undefined) payload.at = opts.fireAt;
  if (opts.repeat !== undefined) payload.repeat = opts.repeat;
  const timezone = opts.tz?.trim() || (opts.repeat !== undefined ? hostTimezone() : undefined);
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      return { error: { code: "INVALID_ARG", message: `--tz must be a valid IANA timezone; got ${timezone}` } };
    }
    payload.timezone = timezone;
  }
  const channel = typeof shared.body.channel === "string" && shared.body.channel.trim() ? shared.body.channel.trim() : undefined;
  return { payload, ...(channel ? { channel } : {}), messageId: String(shared.body.msgId) };
}

export const reminderScheduleCommand = defineCommand(
  {
    name: "schedule",
    description: "Schedule a reminder that fires at a future time",
    options: [
      { flags: "--title <t>", description: "Short description of what the reminder is about" },
      { flags: "--delay-seconds <n>", description: "Preferred for relative times. Fires this many seconds from now (server-computed, timezone-safe)" },
      { flags: "--fire-at <iso>", description: "ISO-8601 UTC timestamp, e.g. 2026-04-21T09:00:00Z. Use only for absolute calendar times" },
      { flags: "--repeat <rule>", description: "Recurrence rule: every:15m | every:2h | every:1d | daily@09:00 | weekly:mon,fri@09:00" },
      { flags: "--tz <iana>", description: "IANA timezone for --repeat (e.g. Asia/Shanghai). Overrides this host's timezone. In the Reminder app it also sets a one-time reminder's zone." },
      { flags: "--channel <ref>", description: "Where the --message-id message is: channel, DM, or thread (e.g. #general, dm:@alice, #general:<thread id>). Optional; in the Reminder app it is checked against the message. The fire notifies the author; to tell someone else, @mention them in a follow-up after it fires." },
      PEER_KIND_OPTION,
      { flags: "--message-id <id>", description: "Message id (full or short) this reminder is anchored to. Required for agent-created reminders." },
      { flags: "--msg-id <id>", description: "Deprecated alias for --message-id." },
    ],
  },
  async (ctx, opts: ScheduleOpts) => {
      if (!opts.title?.trim()) {
        throw cliError("INVALID_ARG", "--title is required");
      }
      const app = buildAppCreatePayload(opts);
      if (app.error) throw cliError(app.error.code, app.error.message);

      const agentContext = ctx.loadAgentContext();
      const viaApp = async () => {
        const anchor = await resolveMessageAnchor(ctx, agentContext, app.messageId, app.channel);
        // A fresh id per command; the app answers a repeat of it with the same
        // reminder, so the one retry after no answer or a 502-504 creates nothing twice.
        const requestId = randomUUID();
        await runReminderAppAction(ctx, "create-reminder", { ...app.payload, anchor, requestId }, { write: true, retryOnce: true });
      };
      if (await reminderAppGate(ctx, agentContext) === "on") return viaApp();

      const built = buildScheduleBody(opts);
      if (built.error) throw cliError(built.error.code, built.error.message);
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.create(
        built.body as AgentApiRequestBodyByRoute["reminderCreate"],
      );
      if (wasMovedToApp(res)) return viaApp();
      if (!res.ok || !res.data?.reminder) {
        // Carries the server's code, e.g. reminders_unsupported_for_external_agents.
        throw apiFailureError(res, "SCHEDULE_FAILED");
      }
      writeText(ctx.io, adoptCliReplyText(
        formatReminderScheduled(res.data.reminder, res.data.warning ?? null) + "\n",
      ));
  },
);

export function registerReminderScheduleCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderScheduleCommand, runtimeOptions);
}
