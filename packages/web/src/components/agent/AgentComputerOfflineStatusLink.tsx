import { TextLink } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useOpenAgentComputer } from "./useOpenAgentComputer";

/**
 * An agent's written-out status while its Computer is offline (#triage:#206)
 * or needs an update ("Computer update required"): the words open that
 * Computer, where the steps are (raft-design identity-and-presence, An agent
 * on an offline computer). Mounted only in those states, so surfaces rendered
 * outside a router otherwise never reach for navigation.
 */
export function AgentComputerOfflineStatusLink({ agentId, className, testId, children }: {
  agentId: string;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const { open } = useOpenAgentComputer(agentId);
  if (!open) return <span className={className}>{children}</span>;
  return (
    <TextLink type="button" onClick={open} className={className} data-testid={testId}>
      {children}
    </TextLink>
  );
}
