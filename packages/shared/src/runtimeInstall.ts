import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { runtimeVersionSchema } from "./runtimeUpgrade";

/**
 * Installing a runtime that is not on a Computer from the web
 * (docs/contracts/runtime-auth.md, "Install"). Raft never installs a runtime
 * on its own: a person who may sign the Computer's runtimes in presses
 * Install, sees the exact commands first (the plan), confirms, and the
 * Computer runs the runtime's own official installer through OAR
 * (`Runtime.installPlan` / `Runtime.install`), then re-detects its runtimes.
 * The web names only the runtime: what runs comes from OAR on the Computer,
 * never from the web. Only the outcome's kind and version leave the Computer
 * after a run, never the installer's output. A version is kept by the
 * upgrade's rule (`runtimeUpgradeVersion`).
 */

/** The `timeoutMs` the Computer passes to OAR's `install`: the bound for the installer run (installers download). */
export const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000;
/**
 * The server's relay budget for an install round trip. Worst case on the
 * Computer: the installer (RUNTIME_INSTALL_TIMEOUT_MS = 10 min), OAR's
 * installation probe before and after it and its own planning (bounded local
 * read-only queries): inside a 12 min wait. The rescan after it runs once
 * the answer is sent.
 */
export const RUNTIME_INSTALL_RELAY_BUDGET_MS = 12 * 60_000;
/** The server's relay budget for reading the plan: OAR runs no installer for it, only bounded local read-only queries. */
export const RUNTIME_INSTALL_PLAN_RELAY_BUDGET_MS = 60_000;

/**
 * Why the Computer could not try: `in_progress`, an install of this runtime
 * is already running there; `internal`, loading the runtime or running OAR threw.
 */
export const RUNTIME_INSTALL_ERROR_CODES = ["in_progress", "internal"] as const;
export type RuntimeInstallErrorCode = (typeof RUNTIME_INSTALL_ERROR_CODES)[number];

/**
 * OAR's `InstallUnsupportedReason`: why it will not run the installer on this
 * Computer. `bundled` also stands for a runtime with nothing to install here
 * (Kimi Code, Pi, an OAR runtime without `install`); `line_required` for a
 * runtime whose vendor ships parallel release lines none of which Raft
 * installs (OpenCode is installed on its 2.x line, the daemon's INSTALL_LINES).
 */
export const RUNTIME_INSTALL_UNSUPPORTED_REASONS = [
  "platform",
  "requires_privileges",
  "requires_gui",
  "missing_tool",
  "location_unknown",
  "configuration",
  "bundled",
  "line_required",
  "unknown_line",
] as const;
export type RuntimeInstallUnsupportedReason = (typeof RUNTIME_INSTALL_UNSUPPORTED_REASONS)[number];

/**
 * The reasons whose plan still carries the vendor's steps for the person to
 * run themselves (OAR: `requires_privileges`, `missing_tool`,
 * `location_unknown`); the web shows them with no Install action.
 */
export const RUNTIME_INSTALL_MANUAL_REASONS = ["requires_privileges", "missing_tool", "location_unknown"] as const satisfies readonly RuntimeInstallUnsupportedReason[];

/**
 * One step as the person reads it before confirming (OAR's `InstallStep.display`:
 * the vendor's documented command). It can name a path in the person's home,
 * so it goes only to the person who asked, and is never logged or traced.
 */
const installStepSchema = lazySchema("installStepSchema", () => z.string().min(1).max(2_000));
/** The vendor's page that documents the steps: an https URL only (the web draws it as a link). */
const installSourceSchema = lazySchema("installSourceSchema", () => z.string().max(500).url().refine((value) => value.startsWith("https://")));
/** OAR's plain words for a person about why it will not run the installer. */
const installDetailSchema = lazySchema("installDetailSchema", () => z.string().min(1).max(1_000));

/**
 * What Install would run on the Computer, read there without running
 * anything (OAR's `InstallPlan`, its steps as display strings). `unsupported`
 * may carry the steps for the person to run themselves (the manual reasons).
 */
export const runtimeInstallPlanSchema = lazySchema("runtimeInstallPlanSchema", () => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), steps: z.array(installStepSchema).min(1).max(10), source: installSourceSchema }),
  z.strictObject({
    kind: z.literal("unsupported"),
    reason: z.enum(RUNTIME_INSTALL_UNSUPPORTED_REASONS),
    detail: installDetailSchema.optional(),
    steps: z.array(installStepSchema).min(1).max(10).optional(),
    source: installSourceSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("error"), code: z.literal("internal") }),
]));
export type RuntimeInstallPlan = z.infer<typeof runtimeInstallPlanSchema>;

/**
 * What an install did, from OAR's `InstallResult` without its `output`, its
 * installation (a command path) or `unsupported`'s detail and steps. A
 * version OAR could not read is absent.
 */
export const runtimeInstallResultSchema = lazySchema("runtimeInstallResultSchema", () => z.discriminatedUnion("kind", [
  /** The installer ran and the runtime's installation probe now finds it. */
  z.strictObject({ kind: z.literal("installed"), version: runtimeVersionSchema.optional() }),
  /** The probe found it before any installer ran. */
  z.strictObject({ kind: z.literal("already_installed"), version: runtimeVersionSchema.optional() }),
  /** The probe after the installer still finds nothing; the installer's exit code, null when the timeout stopped it. */
  z.strictObject({ kind: z.literal("failed"), exitCode: z.number().int().nullable() }),
  z.strictObject({ kind: z.literal("unsupported"), reason: z.enum(RUNTIME_INSTALL_UNSUPPORTED_REASONS) }),
  z.strictObject({ kind: z.literal("error"), code: z.enum(RUNTIME_INSTALL_ERROR_CODES) }),
]));
export type RuntimeInstallResult = z.infer<typeof runtimeInstallResultSchema>;
