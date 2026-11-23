import type { CreateAgentLastConfig } from "../../utils/createAgentLastConfig";
import { pickSignedInRuntime } from "../../utils/runtimeSignInState";
import type { RuntimeSignInState } from "../../utils/runtimeSignInState";

const ONBOARDING_RUNTIME_PRIORITY = ["claude", "codex", "grok", "builtin"];

function selectable(runtime: string, availableRuntimes: readonly string[], supportedRuntimes: ReadonlySet<string>): boolean {
  return availableRuntimes.includes(runtime) && supportedRuntimes.has(runtime);
}

/**
 * The runtime Create Agent starts on for the chosen computer.
 *
 * A Create Agent card's `suggestedRuntime` comes before the remembered last
 * create, for that card only, and never falls back: where this computer cannot
 * run it, nothing is picked ("") and the dialog says so
 * (suggestedRuntimeUnavailable), so the person chooses. Otherwise the
 * remembered runtime when this computer can run it, else the first one it can.
 *
 * Onboarding (Create Cindy) keeps its own priority, then the Computer's sign-in
 * state decides (`signInStateOf`, pickSignedInRuntime): a signed-in runtime
 * before any other, one not known to be signed out next, and never one known to
 * be signed out: with every candidate signed out nothing is picked ("") and the
 * dialog shows the recommended runtime's Sign In (mail #214).
 */
export function pickCreateAgentRuntime(
  availableRuntimes: readonly string[],
  supportedRuntimes: ReadonlySet<string>,
  onboarding: boolean,
  rememberedConfig: CreateAgentLastConfig | null,
  suggestedRuntime?: string,
  signInStateOf: (runtimeId: string) => RuntimeSignInState = () => "unknown",
): string {
  if (onboarding) {
    return pickSignedInRuntime(onboardingRuntimeCandidates(availableRuntimes, supportedRuntimes), signInStateOf) ?? "";
  }
  if (suggestedRuntime) {
    return selectable(suggestedRuntime, availableRuntimes, supportedRuntimes) ? suggestedRuntime : "";
  }
  if (rememberedConfig && selectable(rememberedConfig.runtime, availableRuntimes, supportedRuntimes)) {
    return rememberedConfig.runtime;
  }
  return availableRuntimes.find((id) => supportedRuntimes.has(id)) || availableRuntimes[0] || "";
}

/**
 * The runtime after the server's rows or the Computer's sign-in read change
 * (CreateAgentDialog's reconciliation). Kept while it can still be picked,
 * unless it follows the sign-in read (`followsSignIn`: Create Cindy before the
 * person picks one, again after they switch Computer); then whatever `pick`
 * says now. Nothing to pick from yet: unchanged.
 */
export function reconcileCreateAgentRuntime(
  current: string,
  availableRuntimes: readonly string[],
  followsSignIn: boolean,
  pick: () => string,
): string {
  if (availableRuntimes.length === 0) return current;
  if (!followsSignIn && availableRuntimes.includes(current)) return current;
  return pick();
}

/** Create Cindy's candidates, best first: its priority, then the rest this computer can run. */
export function onboardingRuntimeCandidates(availableRuntimes: readonly string[], supportedRuntimes: ReadonlySet<string>): string[] {
  const prioritized = ONBOARDING_RUNTIME_PRIORITY.filter((id) => selectable(id, availableRuntimes, supportedRuntimes));
  const supported = availableRuntimes.filter((id) => supportedRuntimes.has(id) && !prioritized.includes(id));
  const candidates = [...prioritized, ...supported];
  // No supported one at all: the first the computer lists, as before.
  return candidates.length > 0 ? candidates : availableRuntimes.slice(0, 1);
}

/** Why the card's suggested runtime is not the pick here, or null when there is nothing to say. */
export type SuggestedRuntimeUnavailableCause = "not_on_computer" | "not_admitted";

/**
 * Whether, and why, to say the card's suggested runtime can't be used: a
 * suggestion, the computer's runtime list has arrived, it cannot be picked,
 * and the person has not chosen a runtime yet. `not_admitted` when the
 * computer reports it (`computerRuntimes`) but this server's rows do not
 * offer it for a new agent (`admittedRuntimes`); else `not_on_computer`.
 */
export function suggestedRuntimeUnavailable(input: {
  suggestedRuntime: string | undefined;
  runtime: string;
  catalogReady: boolean;
  availableRuntimes: readonly string[];
  supportedRuntimes: ReadonlySet<string>;
  computerRuntimes: readonly string[];
  admittedRuntimes: ReadonlySet<string>;
}): SuggestedRuntimeUnavailableCause | null {
  const suggested = input.suggestedRuntime;
  if (!suggested || !input.catalogReady || input.runtime) return null;
  if (selectable(suggested, input.availableRuntimes, input.supportedRuntimes)) return null;
  return input.computerRuntimes.includes(suggested) && !input.admittedRuntimes.has(suggested)
    ? "not_admitted"
    : "not_on_computer";
}
