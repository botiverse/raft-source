import type { IntlShape } from "react-intl";
import type { Agent } from "../../store/agentStore";
import { agentModelLabel } from "../../utils/agentModelName";
import { reasoningEffortDisplayLabel } from "../../utils/reasoningEffortOptions";
import { hydrateRuntimeConfigForm } from "../../utils/runtimeConfigForm";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import type { MemberEntry } from "./membersPageModel";

export function memberDescription(entry: MemberEntry): string | null {
  return entry.kind === "human" ? entry.member.description : entry.agent.description;
}

/** What an agent runs on, as the Computer page writes it: the runtime with its
 *  lifecycle word, and the model. An App's identity runs on neither.
 *  `deprecatedHere` is this server's answer (`useRuntimeDeprecatedHere`): a
 *  runtime it offers again is not "(deprecated)" here. */
export function agentRuntimeFacts(
  agent: Agent,
  formatMessage: IntlShape["formatMessage"],
  deprecatedHere: (runtimeId: string) => boolean,
): { runtime: string | null; model: string | null } {
  if (agent.managedByAppInstallId) return { runtime: null, model: null };
  return {
    runtime: agent.runtime ? formatRuntimeLabelWithStatus(agent.runtime, formatMessage, deprecatedHere(agent.runtime)) : null,
    model: agentModelLabel(agent),
  };
}

/** The agent's reasoning effort as its profile's Reasoning row shows it: its
 *  runtime config hydrated as the profile hydrates it (a saved config of
 *  another version is ignored, a missing level or runtime falls back to the
 *  agent's own fields), labelled by reasoningEffortDisplayLabel. Null (a dash)
 *  for a runtime that takes no effort or an App's identity. */
export function agentReasoningEffortFact(
  agent: Agent,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  if (agent.managedByAppInstallId) return null;
  return reasoningEffortDisplayLabel(hydrateRuntimeConfigForm(agent), formatMessage);
}
