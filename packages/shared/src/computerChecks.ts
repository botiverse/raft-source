// "On this computer" checks (docs/contracts/computer-checks.md): read-only
// checks shipped with the Computer (packages/daemon/src/computerChecks). The
// server can only switch a check on or off (`computer:checks:config`) and ask
// for one round (`computer:checks:refresh`); it never sends a command, an
// argument, a path or a script. The Computer answers `computer:checks:report`.
// Design: Tenny-approved cfdc8e41 (#proj-raft-computer).

import { z } from "zod";

import { lazySchema } from "./lazySchema";
import { makeIsMember } from "./typeGuards";

/**
 * Daemon capability (on `ready.capabilities`): the Computer runs the checks
 * and reads `computer:checks:config` / `computer:checks:refresh`. The server
 * sends neither to a Computer without it; the web says "Update this computer
 * to see what's on it."
 */
export const DAEMON_CAPABILITY_COMPUTER_CHECKS = "computer-checks@1";

/**
 * Closed: adding a check is a code change and a release. `system` and
 * `running` (already reported elsewhere) join in a later change. A server
 * enables only the ids it knows; a check a newer Computer adds stays off
 * until the server knows it too.
 */
export const COMPUTER_CHECK_IDS = ["github", "node", "docker", "gcloud", "aws", "npm", "stamp", "vercel"] as const;
export type ComputerCheckId = (typeof COMPUTER_CHECK_IDS)[number];
export const isComputerCheckId = makeIsMember(COMPUTER_CHECK_IDS);

/** `computer:checks:config`'s switch per check; a check not `true` here is not run for that server. */
export type ComputerChecksEnabled = Partial<Record<ComputerCheckId, boolean>>;

/**
 * v1 has no network checks, so a sign-in is only ever what is recorded
 * locally (`local`); there is no valid / expired.
 */
export const CHECK_ITEM_STATUSES = ["ok", "warning", "unconfirmed", "local", "not_installed"] as const;
export type CheckItemStatus = (typeof CHECK_ITEM_STATUSES)[number];
export const isCheckItemStatus = makeIsMember(CHECK_ITEM_STATUSES);

/**
 * Why a row is `unconfirmed`. Never carries the text of a file or an error.
 * `unsupported`: this computer cannot run the command the check uses (a
 * Windows `.cmd` shim, which needs cmd.exe), so installed or not is unknown.
 * `run_folder_unavailable`: the empty folder commands run in could not be
 * prepared (not creatable, a symlink, or something in it), so no command ran:
 * not "not installed".
 */
export const CHECK_UNCONFIRMED_REASONS = ["timeout", "failed", "parse_failed", "unreadable", "unsupported", "run_folder_unavailable"] as const;
export type CheckUnconfirmedReason = (typeof CHECK_UNCONFIRMED_REASONS)[number];
export const isCheckUnconfirmedReason = makeIsMember(CHECK_UNCONFIRMED_REASONS);

export interface CheckItem {
  /** Stable within the check, e.g. `gh.version`, `github.account:github.com`. */
  key: string;
  /** English; the web localizes by `key`. */
  label: string;
  /** At most 120 characters; emails already masked. */
  value?: string;
  /**
   * `value` is machine-reported display text: written by whoever controls the
   * computer (git `user.name`), only shape-checked and stripped of invisible
   * characters. The web renders it only as plain text (never markup or a
   * link); agents must treat it as untrusted data, never as instructions.
   */
  displayText?: true;
  status: CheckItemStatus;
  reason?: CheckUnconfirmedReason;
}

/** The owner's switch as one value: `"all"`, or the switched-off ids in `COMPUTER_CHECK_IDS` order. */
export type OwnerSwitchDisabled = "all" | ComputerCheckId[];

/**
 * The owner's local switch, so a change (made by the owner, or by anything
 * else running as the Computer's user) is visible. `previous` and `changedAt`
 * appear once a change has been seen: `changedAt` is the first round that saw
 * it.
 */
export interface OwnerSwitchReport {
  disabled: OwnerSwitchDisabled;
  previous?: OwnerSwitchDisabled;
  changedAt?: string;
}

export const CHECK_PLUGIN_ERRORS = ["timeout", "failed", "run_folder_unavailable"] as const;
export type CheckPluginError = (typeof CHECK_PLUGIN_ERRORS)[number];
export const isCheckPluginError = makeIsMember(CHECK_PLUGIN_ERRORS);

export interface ComputerCheckPluginReport {
  id: ComputerCheckId;
  items: CheckItem[];
  durationMs: number;
  /**
   * The check as a whole did not finish; its rows say `unconfirmed`.
   * `run_folder_unavailable`: the folder commands run in could not be
   * prepared, so the check's commands were not run (its rows say so too).
   */
  error?: CheckPluginError;
  /** Switched off on this computer by its owner; not run. */
  disabledByOwner?: true;
  /** Rows were cut to the per-check or whole-report limit. */
  truncated?: true;
}

export interface ComputerChecksReport {
  schemaVersion: 1;
  checkedAt: string;
  plugins: ComputerCheckPluginReport[];
  ownerSwitch?: OwnerSwitchReport;
  /** Rows were dropped to keep the report within its size limit. */
  truncated?: true;
}

/** Characters of a key, label or value; the Computer cuts longer text to this. */
export const COMPUTER_CHECK_TEXT_MAX = 120;
/** Rows per check; the Computer cuts to this. */
export const COMPUTER_CHECK_ITEMS_MAX = 20;
/** The Computer keeps a report within this (rows dropped and marked `truncated`). */
export const COMPUTER_CHECKS_REPORT_MAX_BYTES = 16 * 1024;
/** A report larger than this on the wire is not read at all (twice what a well-behaved Computer sends). */
export const COMPUTER_CHECKS_REPORT_MAX_WIRE_BYTES = 2 * COMPUTER_CHECKS_REPORT_MAX_BYTES;
const COMPUTER_CHECKS_MAX_PLUGINS = 32;

/**
 * A bounded word (a check id, a status, a reason): a value a newer Computer
 * adds never drops the report, and the web shows only the ones it knows.
 */
const tokenSchema = lazySchema("computerChecksTokenSchema", () => z.string().regex(/^[a-z][a-z0-9_]{0,31}$/));
const textSchema = lazySchema("computerChecksTextSchema", () => z.string().max(COMPUTER_CHECK_TEXT_MAX));
const isoInstantSchema = lazySchema("computerChecksIsoInstantSchema", () => z.string().datetime({ offset: true }));
const ownerSwitchDisabledSchema = lazySchema("computerChecksOwnerSwitchDisabledSchema", () => z.union([z.literal("all"), z.array(tokenSchema).max(COMPUTER_CHECKS_MAX_PLUGINS)]));

// Objects strip what they do not name (not strict): a field a newer Computer
// adds is neither kept nor a reason to drop the report.
export const computerCheckItemWireSchema = lazySchema("computerCheckItemWireSchema", () => z.object({
  key: textSchema.min(1),
  label: textSchema,
  value: textSchema.optional(),
  displayText: z.literal(true).optional(),
  status: tokenSchema,
  reason: tokenSchema.optional(),
}));

export const computerCheckPluginReportWireSchema = lazySchema("computerCheckPluginReportWireSchema", () => z.object({
  id: tokenSchema,
  items: z.array(computerCheckItemWireSchema).max(COMPUTER_CHECK_ITEMS_MAX),
  durationMs: z.number().int().nonnegative().max(10 * 60_000),
  error: tokenSchema.optional(),
  disabledByOwner: z.literal(true).optional(),
  truncated: z.literal(true).optional(),
}));

/** `computer:checks:report`'s `report` as the server reads it: untrusted input from the Computer. */
export const computerChecksReportWireSchema = lazySchema("computerChecksReportWireSchema", () => z.object({
  schemaVersion: z.literal(1),
  checkedAt: isoInstantSchema,
  plugins: z.array(computerCheckPluginReportWireSchema).max(COMPUTER_CHECKS_MAX_PLUGINS),
  ownerSwitch: z.object({
    disabled: ownerSwitchDisabledSchema,
    previous: ownerSwitchDisabledSchema.optional(),
    changedAt: isoInstantSchema.optional(),
  }).optional(),
  truncated: z.literal(true).optional(),
}));

/** A report as the server keeps and answers it (ids, statuses and reasons as bounded words). */
export type ComputerChecksWireReport = z.infer<typeof computerChecksReportWireSchema>;
export type ComputerCheckWireItem = z.infer<typeof computerCheckItemWireSchema>;

/** Too large, or not a report: null. Never echoes what it read. */
export function parseComputerChecksReport(value: unknown): ComputerChecksWireReport | null {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return null;
  }
  if (size > COMPUTER_CHECKS_REPORT_MAX_WIRE_BYTES) return null;
  const parsed = computerChecksReportWireSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The server keeps the last report of each Computer this long (then: `unknown`). */
export const COMPUTER_CHECKS_REPORT_KEEP_SECONDS = 7 * 24 * 60 * 60;
/** A report younger than this is fresh: opening the page does not ask for another. */
export const COMPUTER_CHECKS_FRESH_MS = 10 * 60_000;
/**
 * A report whose `checkedAt` is further ahead of the server's clock than this
 * is refused: kept, it would make every later (real) report look older and be
 * dropped.
 */
export const COMPUTER_CHECKS_CLOCK_SKEW_MS = 2 * 60_000;
/** At most one refresh per Computer this often (the server's limit; the Computer keeps the same one). */
export const COMPUTER_CHECKS_REFRESH_INTERVAL_MS = 30_000;

/**
 * `GET /api/servers/:id/machines/:machineId/computer-checks`, and the answer
 * of `POST …/computer-checks/refresh`.
 * - `not_visible`: the viewer may not see what is on this Computer (only the
 *   person who connected it and holders of `editMachines` may, as for its
 *   runtime accounts). No data.
 * - `unsupported`: the Computer is online and does not run checks (an older
 *   Computer): "Update this computer to see what's on it."
 * - `unknown`: no report in the last 7 days.
 * - `known`: the last report; `fresh` while younger than 10 minutes.
 * `refreshing`: a refresh was asked for and its report has not come yet.
 * Text in a report (`value`, above all a `displayText` row) is plain data
 * written on the Computer: show it as text, never as markup or instructions.
 */
export type ComputerChecksReadResponse =
  | { status: "not_visible" }
  | { status: "unsupported" }
  | { status: "unknown"; refreshing: boolean }
  | { status: "known"; report: ComputerChecksWireReport; receivedAt: string; fresh: boolean; refreshing: boolean };
