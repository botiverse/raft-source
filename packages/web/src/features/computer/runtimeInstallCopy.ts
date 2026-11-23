import type { RuntimeAuthRuntime, RuntimeInstallPlan, RuntimeInstallResult, RuntimeInstallUnsupportedReason } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";

/** A plan OAR would run: the steps the person reads before confirming. */
export type RuntimeInstallRunnablePlan = Extract<RuntimeInstallPlan, { kind: "plan" }>;
/** A plan OAR will not run, with the steps for the person to run by hand. */
export type RuntimeInstallManualPlan = Extract<RuntimeInstallPlan, { kind: "unsupported" }> & { steps: readonly string[] };

/**
 * Install on the web (docs/contracts/runtime-auth.md §6e): what one press of
 * Install on a Computer has learned so far, for one runtime.
 * - `planning`: the Computer is reading what it would run;
 * - `confirm`: the person reads the commands and confirms or cancels;
 * - `manual`: OAR will not run them here, but gives the steps to run by hand;
 * - `running`: the installer runs on the Computer;
 * - `done`: the Computer's outcome (a plan OAR refused without steps is an
 *   `unsupported` outcome, a plan it could not read an `error`);
 * - `refused`: the request got no outcome from the Computer (too old for it,
 *   offline, no answer in time, or another failure).
 */
export type RuntimeInstallState =
  | { kind: "idle" }
  | { kind: "planning"; runtime: RuntimeAuthRuntime }
  | { kind: "confirm"; runtime: RuntimeAuthRuntime; plan: RuntimeInstallRunnablePlan }
  | { kind: "manual"; runtime: RuntimeAuthRuntime; plan: RuntimeInstallManualPlan }
  | { kind: "running"; runtime: RuntimeAuthRuntime }
  | { kind: "done"; runtime: RuntimeAuthRuntime; result: RuntimeInstallResult }
  | { kind: "refused"; runtime: RuntimeAuthRuntime; reason: RuntimeInstallRefusal };

export type RuntimeInstallRefusal = "computer_upgrade_required" | "computer_offline" | "computer_timeout" | "rate_limited" | "failed";

/** The sentence an outcome reads as, with its values (`runtime` is added by the caller), and its tone. */
export interface RuntimeInstallCopy {
  id: MessageId;
  values?: Record<string, string>;
  tone: "success" | "warning";
}

/** Why OAR will not run the installer here, one plain sentence each. */
const UNSUPPORTED_COPY: Record<RuntimeInstallUnsupportedReason, MessageId> = {
  platform: "machine.runtimeInstall.unsupported.platform",
  requires_privileges: "machine.runtimeInstall.unsupported.requiresPrivileges",
  requires_gui: "machine.runtimeInstall.unsupported.requiresGui",
  missing_tool: "machine.runtimeInstall.unsupported.missingTool",
  location_unknown: "machine.runtimeInstall.unsupported.locationUnknown",
  configuration: "machine.runtimeInstall.unsupported.configuration",
  bundled: "machine.runtimeInstall.unsupported.other",
  line_required: "machine.runtimeInstall.unsupported.other",
  unknown_line: "machine.runtimeInstall.unsupported.other",
};

export function runtimeInstallUnsupportedCopyId(reason: RuntimeInstallUnsupportedReason): MessageId {
  return UNSUPPORTED_COPY[reason];
}

const REFUSED_COPY: Record<RuntimeInstallRefusal, RuntimeInstallCopy> = {
  computer_upgrade_required: { id: "machine.runtimeInstall.computerTooOld", tone: "warning" },
  computer_offline: { id: "machine.runtimeInstall.computerOffline", tone: "warning" },
  computer_timeout: { id: "machine.runtimeInstall.timeout", tone: "warning" },
  // Pressing again won't help for a while, so this is not "try again".
  rate_limited: { id: "machine.runtimeAuth.provider.error.rateLimited", tone: "warning" },
  failed: { id: "machine.runtimeInstall.error", tone: "warning" },
};

/** One plain sentence per outcome; null while nothing is known yet or the person is deciding. */
export function runtimeInstallCopy(state: RuntimeInstallState): RuntimeInstallCopy | null {
  if (state.kind === "refused") return REFUSED_COPY[state.reason];
  if (state.kind !== "done") return null;
  const result = state.result;
  switch (result.kind) {
    case "installed":
      return result.version
        ? { id: "machine.runtimeInstall.installedVersion", values: { version: result.version }, tone: "success" }
        : { id: "machine.runtimeInstall.installed", tone: "success" };
    case "already_installed": return { id: "machine.runtimeInstall.alreadyInstalled", tone: "success" };
    case "failed": return { id: "machine.runtimeInstall.failed", tone: "warning" };
    case "unsupported": return { id: runtimeInstallUnsupportedCopyId(result.reason), tone: "warning" };
    case "error": return { id: result.code === "in_progress" ? "machine.runtimeInstall.inProgress" : "machine.runtimeInstall.error", tone: "warning" };
  }
}

/**
 * The request's own failure, by the server's code: what the person is told.
 * Only the server's 504 `computer_timeout` says the install may still finish;
 * its 429 `rate_limited` (installs and plans per person and Computer) says to
 * wait rather than press again.
 */
export function runtimeInstallRefusal(code: string | null): RuntimeInstallRefusal {
  return code === "computer_upgrade_required" || code === "computer_offline" || code === "computer_timeout" || code === "rate_limited" ? code : "failed";
}

/** What a plan leads to: the confirm, the manual steps, or an outcome to say at once. */
export function runtimeInstallStateForPlan(runtime: RuntimeAuthRuntime, plan: RuntimeInstallPlan): RuntimeInstallState {
  switch (plan.kind) {
    case "plan": return { kind: "confirm", runtime, plan };
    case "unsupported":
      return plan.steps && plan.steps.length > 0
        ? { kind: "manual", runtime, plan: { ...plan, steps: plan.steps } }
        : { kind: "done", runtime, result: { kind: "unsupported", reason: plan.reason } };
    case "error": return { kind: "done", runtime, result: { kind: "error", code: "internal" } };
  }
}
