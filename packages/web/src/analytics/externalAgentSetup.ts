// External agent setup (Grace, 2026-11-15): what people do in the Create
// external agent dialog and on the agent page's connection card, up to the
// agent's first sign-in. Counts of people per step, never an agent id; which
// agents connected is a database fact.

import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

type Progress = ProductEventProperties<"external_agent_setup_progress">;
type Action = ProductEventProperties<"external_agent_setup_action">;
type Closed = ProductEventProperties<"external_agent_setup_closed">;
export type ExternalAgentSetupSurface = Progress["surface"];
export type ExternalAgentSetupAction = Action["action"];

/** These are called next to the flow's own work (inside its try blocks): a failure to record must never look like a failure of the flow. */
function quietly(send: () => void): void {
  try {
    send();
  } catch {
    // not recorded
  }
}

export function trackExternalAgentSetupProgress(step: Progress["step"], surface: ExternalAgentSetupSurface, method: Progress["method"]): void {
  quietly(() => trackEvent("external_agent_setup_progress", { step, surface, method }));
}

/** `method`: the one on screen; for `method_switched`, the one switched to. A copy says only that it happened. */
export function trackExternalAgentSetupAction(action: ExternalAgentSetupAction, surface: ExternalAgentSetupSurface, method: Action["method"]): void {
  quietly(() => trackEvent("external_agent_setup_action", { action, surface, method }));
}

export function trackExternalAgentSetupClosed(result: Closed["result"], method: Closed["method"]): void {
  quietly(() => trackEvent("external_agent_setup_closed", { result, method }));
}
