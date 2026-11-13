// Shared by `raft reminder trigger` and `raft reminder log --key`: both call the
// Reminder App's agent actions (`trigger`, `list-trigger-log`) through the same
// path as `raft integration invoke --service reminder --action <name>`.

import type { CommandContext } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { invokeAppAction } from "../integration/invoke";

/** The Reminder App's service id on a Raft server. */
export const REMINDER_APP_SERVICE = "reminder";

/** The app's rule for a trigger key (Raft's `object.ref` rule for `trigger/<key>`). */
const TRIGGER_KEY = /^[A-Za-z0-9_.:-]{0,63}[A-Za-z0-9]$/;
const RESERVED_KEY_PREFIX = "raft.";

/**
 * A trigger key checked before any call. `allowReserved`: reading the log may
 * name the app's own `raft.throttled` key; raising a trigger may not.
 */
export function requireTriggerKey(raw: string | undefined, opts: { allowReserved: boolean }): string {
  const key = raw?.trim() ?? "";
  if (!key) throw cliError("INVALID_ARG", "--key is required");
  if (!TRIGGER_KEY.test(key)) {
    throw cliError(
      "INVALID_ARG",
      `--key must be 1-64 characters of letters, digits, _ . : or -, ending in a letter or digit; got ${JSON.stringify(key)}`,
    );
  }
  if (!opts.allowReserved && key.startsWith(RESERVED_KEY_PREFIX)) {
    throw cliError("INVALID_ARG", `--key must not start with "raft." (reserved for Raft's own keys); got ${JSON.stringify(key)}`);
  }
  return key;
}

/** One Reminder App action; a server without the app reads as REMINDER_APP_NOT_INSTALLED. */
export async function invokeReminderApp(
  ctx: CommandContext,
  action: string,
  payload: Record<string, unknown>,
  nothingDone: string,
): Promise<unknown> {
  try {
    const { value } = await invokeAppAction(ctx, { service: REMINDER_APP_SERVICE, action, payload, requireOfficial: true });
    return unwrapAppAnswer(value);
  } catch (error) {
    if (error instanceof CliError && error.code === "INTEGRATION_NOT_FOUND") {
      throw cliError(
        "REMINDER_APP_NOT_INSTALLED",
        `The Reminder app isn't installed on this server, so ${nothingDone}.`,
        { suggestedNextAction: "raft integration list shows what is installed; ask a server admin to install Reminder." },
      );
    }
    throw error;
  }
}

export interface TriggerResult {
  key: string;
  /** woke | merged | recorded (level log) | throttled; anything newer prints as-is. */
  outcome: string;
  triggerCount: number;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  nextWakeAllowedAt?: string;
}

export interface TriggerLogEntry {
  at: string;
  level: string;
  title: string;
  outcome: string;
}

export interface TriggerLog {
  key: string;
  entries: TriggerLogEntry[];
  sinceLastEvent: {
    triggerCount: number;
    firstTriggeredAt: string | null;
    lastTriggeredAt: string | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The app answers `{ ok: true, result, status }` (seen live on reminder.raft.build,
 * 2026-11-10); the action's own answer is `result`. A bare answer passes through.
 */
function unwrapAppAnswer(value: unknown): unknown {
  return isRecord(value) && value.ok === true && "result" in value ? value.result : value;
}

function badAnswer(action: string): CliError {
  return cliError("INVALID_JSON_RESPONSE", `The Reminder app's ${action} answer is not in the expected shape.`);
}

export function parseTriggerResult(value: unknown): TriggerResult {
  if (
    !isRecord(value)
    || typeof value.outcome !== "string"
    || typeof value.triggerCount !== "number"
    || typeof value.firstTriggeredAt !== "string"
    || typeof value.lastTriggeredAt !== "string"
    || (value.nextWakeAllowedAt !== undefined && typeof value.nextWakeAllowedAt !== "string")
  ) {
    throw badAnswer("trigger");
  }
  return {
    key: typeof value.key === "string" ? value.key : "",
    outcome: value.outcome,
    triggerCount: value.triggerCount,
    firstTriggeredAt: value.firstTriggeredAt,
    lastTriggeredAt: value.lastTriggeredAt,
    ...(typeof value.nextWakeAllowedAt === "string" ? { nextWakeAllowedAt: value.nextWakeAllowedAt } : {}),
  };
}

export function parseTriggerLog(value: unknown): TriggerLog {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw badAnswer("list-trigger-log");
  const entries = value.entries.map((entry): TriggerLogEntry => {
    if (
      !isRecord(entry)
      || typeof entry.at !== "string"
      || typeof entry.level !== "string"
      || typeof entry.title !== "string"
      || typeof entry.outcome !== "string"
    ) {
      throw badAnswer("list-trigger-log");
    }
    return { at: entry.at, level: entry.level, title: entry.title, outcome: entry.outcome };
  });
  const since = isRecord(value.sinceLastEvent) ? value.sinceLastEvent : {};
  return {
    key: typeof value.key === "string" ? value.key : "",
    entries,
    sinceLastEvent: {
      triggerCount: typeof since.triggerCount === "number" ? since.triggerCount : 0,
      firstTriggeredAt: typeof since.firstTriggeredAt === "string" ? since.firstTriggeredAt : null,
      lastTriggeredAt: typeof since.lastTriggeredAt === "string" ? since.lastTriggeredAt : null,
    },
  };
}
