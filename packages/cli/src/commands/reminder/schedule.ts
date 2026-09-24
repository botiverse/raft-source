// `raft reminder schedule --title <t> [--delay-seconds <n> | --fire-at <iso>] [--message-id <id>]`
// → POST /internal/agent-api/reminders

import type { Command } from "commander";
import type { AgentApiRequestBodyByRoute } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { formatReminderScheduled } from "./_format.js";

export interface ScheduleOpts {
  title: string;
  delaySeconds?: string;
  fireAt?: string;
  messageId?: string;
  msgId?: string;
  repeat?: string;
  tz?: string;
  channel?: string;
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
  if (opts.channel !== undefined) body.channel = opts.channel;

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

export const reminderScheduleCommand = defineCommand(
  {
    name: "schedule",
    description: "Schedule a reminder that fires at a future time",
    options: [
      { flags: "--title <t>", description: "Short description of what the reminder is about" },
      { flags: "--delay-seconds <n>", description: "Preferred for relative times. Fires this many seconds from now (server-computed, timezone-safe)" },
      { flags: "--fire-at <iso>", description: "ISO-8601 UTC timestamp, e.g. 2026-04-21T09:00:00Z. Use only for absolute calendar times" },
      { flags: "--repeat <rule>", description: "Recurrence rule: every:15m | every:2h | every:1d | daily@09:00 | weekly:mon,fri@09:00" },
      { flags: "--tz <iana>", description: "IANA timezone for --repeat (e.g. Asia/Shanghai). Overrides this host's timezone." },
      { flags: "--channel <ref>", description: "Optional channel, DM, or thread to anchor this reminder to (e.g. #general, dm:@alice). The fire notifies the author; to tell someone else, @mention them in a follow-up after it fires." },
      { flags: "--message-id <id>", description: "Message id (full or short) this reminder is anchored to. Required for agent-created reminders." },
      { flags: "--msg-id <id>", description: "Deprecated alias for --message-id." },
    ],
  },
  async (ctx, opts: ScheduleOpts) => {
      if (!opts.title?.trim()) {
        throw cliError("INVALID_ARG", "--title is required");
      }
      const built = buildScheduleBody(opts);
      if (built.error) throw cliError(built.error.code, built.error.message);

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.create(
        built.body as AgentApiRequestBodyByRoute["reminderCreate"],
      );
      if (!res.ok || !res.data?.reminder) {
        const code = res.status >= 500 ? "SERVER_5XX" : "SCHEDULE_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      writeText(ctx.io, adoptCliReplyText(
        formatReminderScheduled(res.data.reminder, res.data.warning ?? null) + "\n",
      ));
  },
);

export function registerReminderScheduleCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderScheduleCommand, runtimeOptions);
}
