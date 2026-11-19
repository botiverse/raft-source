import type { CreateAgentLastConfig } from "../../utils/createAgentLastConfig";

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
 */
export function pickCreateAgentRuntime(
  availableRuntimes: readonly string[],
  supportedRuntimes: ReadonlySet<string>,
  onboarding: boolean,
  rememberedConfig: CreateAgentLastConfig | null,
  suggestedRuntime?: string,
): string {
  if (onboarding) {
    return ONBOARDING_RUNTIME_PRIORITY.find((id) => selectable(id, availableRuntimes, supportedRuntimes))
      || availableRuntimes.find((id) => supportedRuntimes.has(id))
      || availableRuntimes[0]
      || "";
  }
  if (suggestedRuntime) {
    return selectable(suggestedRuntime, availableRuntimes, supportedRuntimes) ? suggestedRuntime : "";
  }
  if (rememberedConfig && selectable(rememberedConfig.runtime, availableRuntimes, supportedRuntimes)) {
    return rememberedConfig.runtime;
  }
  return availableRuntimes.find((id) => supportedRuntimes.has(id)) || availableRuntimes[0] || "";
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
