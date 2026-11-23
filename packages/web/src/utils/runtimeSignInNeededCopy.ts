import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";

// #triage:#494: the words for `runtimeSignInNeededOf` (utils/activity.ts).
// Kept out of utils/activity.ts: that module's English formatters read only
// the app shell's enFallback ids, and these are read through the viewer's
// catalog only.

/**
 * The status words for `runtimeSignInNeededOf`: "Sign-in needed for Kimi Code"
 * where there is room, "Sign-in needed" where there is not (the sidebar).
 */
export function formatRuntimeSignInNeededText(
  formatMessage: IntlShape["formatMessage"],
  runtime: string,
  length: "full" | "short" = "full",
): string {
  return length === "short"
    ? String(formatMessage({ id: "agent.status.runtimeSignIn.short" }))
    : String(formatMessage({ id: "agent.status.runtimeSignIn.full" }, { runtime: getRuntimeDisplayName(runtime) }));
}

/** The sentence that stands in for the daemon's for `runtimeSignInNeededOf` (hover or secondary line). */
export function formatRuntimeSignInNeededDetail(
  formatMessage: IntlShape["formatMessage"],
  input: { name: string; runtime: string; computer: string },
): string {
  return String(formatMessage(
    { id: "agent.status.runtimeSignIn.detail" },
    { name: input.name, runtime: getRuntimeDisplayName(input.runtime), computer: input.computer },
  ));
}
