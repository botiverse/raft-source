import { createEventStore } from "./createEventStore";
import type { EventStore } from "./createEventStore";
import {
  applyAgentActivityEvent,
} from "./events/agentActivityEvents";
import type {
  AgentActivityApplyResult,
  AgentActivityDomainState,
  AgentActivityEvent,
  AgentActivityTransition,
} from "./events/agentActivityEvents";

export interface AgentActivityDomain {
  store: EventStore<AgentActivityDomainState, AgentActivityEvent, AgentActivityTransition>;
}

export function createAgentActivityDomain(options: {
  initialState: AgentActivityDomainState;
  onTransition?: (transition: AgentActivityTransition, event: AgentActivityEvent) => void;
}): AgentActivityDomain {
  const store = createEventStore<AgentActivityDomainState, AgentActivityEvent, AgentActivityTransition>({
    name: "agent-activity",
    initialState: options.initialState,
    reduce: (state, event): AgentActivityApplyResult => applyAgentActivityEvent(state, event),
    onTransition: options.onTransition,
  });
  return { store };
}
