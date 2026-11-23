import { z } from "zod";
import { lazySchema } from "./lazySchema";

/**
 * Upgrading a runtime's command-line tool on a Computer from the web
 * (docs/contracts/runtime-auth.md, "Upgrade"). Raft never upgrades a runtime
 * on its own: a person who may manage the Computer presses Upgrade, the
 * Computer runs the runtime's own updater through OAR (`Runtime.upgrade`)
 * and then re-detects its runtimes, so versions, sign-in status and model
 * lists follow. Only the outcome's kind and versions leave the Computer,
 * never the updater's output (it can hold paths and secrets).
 */

/**
 * The `timeoutMs` the Computer passes to OAR's `upgrade`. OAR applies it to
 * its update check AND to the updater run, each up to this bound (downloads
 * can take minutes), so one upgrade takes at most twice this, plus OAR's two
 * version reads (30 s each).
 */
export const RUNTIME_UPGRADE_TIMEOUT_MS = 5 * 60_000;
/**
 * The server's relay budget for an upgrade round trip. Worst case on the
 * Computer: the check and the updater (2 × RUNTIME_UPGRADE_TIMEOUT_MS =
 * 10 min), OAR's version reads before and after (2 × 30 s), and the
 * installation probe (up to 30 s): about 11.5 min, inside a 12 min wait. The
 * rescan after it runs once the answer is sent.
 */
export const RUNTIME_UPGRADE_RELAY_BUDGET_MS = 12 * 60_000;

/**
 * Why the Computer could not try: `in_progress`, an upgrade of this runtime is
 * already running there; `internal`, loading the runtime or running OAR threw.
 */
export const RUNTIME_UPGRADE_ERROR_CODES = ["in_progress", "internal"] as const;
export type RuntimeUpgradeErrorCode = (typeof RUNTIME_UPGRADE_ERROR_CODES)[number];

/**
 * OAR's `unsupported` reasons: `unsupported_installation`, an installation
 * its updater does not manage (a package manager's, an in-process SDK);
 * `requires_terminal`, the updater only runs interactively.
 */
export const RUNTIME_UPGRADE_UNSUPPORTED_REASONS = ["unsupported_installation", "requires_terminal"] as const;

/** A release version as OAR reads it from `--version` (`2.0.14`, `1.0.0-beta.3`). Never a path. Also an install's (runtimeInstall.ts). */
export const runtimeVersionSchema = lazySchema("runtimeVersionSchema", () => z.string().max(64).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u));

/**
 * What an upgrade did, from OAR's `UpgradeResult` without its `output`
 * (and without `current`'s check, `failed`'s message or `unsupported`'s
 * detail, which can name paths). A version OAR could not read is absent.
 */
export const runtimeUpgradeResultSchema = lazySchema("runtimeUpgradeResultSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upgraded"), from: runtimeVersionSchema.optional(), to: runtimeVersionSchema.optional() }),
  /** The update check found nothing newer, so no updater ran. */
  z.strictObject({ kind: z.literal("current"), version: runtimeVersionSchema.optional() }),
  /** The updater ran and exited 0, yet the runtime reports the same version. */
  z.strictObject({ kind: z.literal("unchanged"), version: runtimeVersionSchema.optional() }),
  /** The updater failed (non-zero exit, timeout) and the version did not move. */
  z.strictObject({ kind: z.literal("failed"), exitCode: z.number().int().nullable() }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_UPGRADE_UNSUPPORTED_REASONS) }),
  z.strictObject({ kind: z.literal("not_installed") }),
  z.strictObject({ kind: z.literal("error"), code: z.enum(RUNTIME_UPGRADE_ERROR_CODES) }),
]));
export type RuntimeUpgradeResult = z.infer<typeof runtimeUpgradeResultSchema>;

/**
 * OAR's `UpdateCheckUnavailableReason`: why a check could not name the
 * version the runtime's own updater would install (never a guess that the
 * installation is current). `lookup_failed` also stands for a check that
 * threw or timed out on the Computer, and for a reason this build does not
 * know (a newer Computer's).
 */
export const RUNTIME_UPDATE_CHECK_UNAVAILABLE_REASONS = [
  "unsupported_installation",
  "package_manager",
  "unmanaged_installation",
  "updates_disabled",
  "lookup_failed",
  "version_unreadable",
] as const;
export type RuntimeUpdateCheckUnavailableReason = (typeof RUNTIME_UPDATE_CHECK_UNAVAILABLE_REASONS)[number];

function isRuntimeUpdateCheckUnavailableReason(value: string): value is RuntimeUpdateCheckUnavailableReason {
  return (RUNTIME_UPDATE_CHECK_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

/**
 * One runtime's update check as the Computer reports it (OAR's read-only
 * `checkUpdate`, never an install), from OAR's `UpdateCheck` without its
 * `source`, `channel` or `detail` (they can name paths and URLs). `ok`: the
 * installed version, the one the runtime's own updater would install, and
 * whether that is an update (the runtime's own verdict where it gives one).
 * `checkedAt`: when the Computer ran the check (it keeps an answer for up to
 * a day, see daemon runtimeUpdateCheck.ts). Not strict: a key this build does
 * not know is stripped (never stored or forwarded), and a report's entry
 * that does not parse is dropped on its own (`runtimeUpdatesSchema`).
 */
export const runtimeUpdateCheckSchema = lazySchema("runtimeUpdateCheckSchema", () => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    installed: runtimeVersionSchema,
    latest: runtimeVersionSchema,
    updateAvailable: z.boolean(),
    checkedAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.string().max(64).transform((reason): RuntimeUpdateCheckUnavailableReason => (isRuntimeUpdateCheckUnavailableReason(reason) ? reason : "lookup_failed")),
    checkedAt: z.string().datetime({ offset: true }),
  }),
]));
export type RuntimeUpdateCheck = z.infer<typeof runtimeUpdateCheckSchema>;

/**
 * How old an update check may be and still count: the Computer keeps an
 * answer this long, and the web treats an older one (a stored report the
 * server kept renewing) as no answer, offering Upgrade as before.
 */
export const RUNTIME_UPDATE_CHECK_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * The unavailable reasons that are a deliberate choice rather than a failed
 * lookup: the installation's updates are managed outside Raft (a package
 * manager, updates turned off, an installation the runtime's updater does
 * not manage). The web says so instead of "couldn't check".
 */
export const RUNTIME_UPDATE_CHECK_MANAGED_ELSEWHERE_REASONS = [
  "package_manager",
  "updates_disabled",
  "unmanaged_installation",
  "unsupported_installation",
] as const satisfies readonly RuntimeUpdateCheckUnavailableReason[];

/** A version as the result may carry it, or undefined when OAR's is not one. */
export function runtimeUpgradeVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && runtimeVersionSchema.safeParse(trimmed).success ? trimmed : undefined;
}
