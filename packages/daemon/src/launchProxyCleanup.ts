import { unregisterAgentCredentialProxiesForAgent, unregisterAgentCredentialProxyForLaunch } from "./agentCredentialProxy";
import { unregisterManagedMcpRuntimeProxiesForAgent, unregisterManagedMcpRuntimeProxyForLaunch } from "./managedMcpRuntimeProxy";

export function cleanupLaunchProxies(agentId: string): void {
  unregisterAgentCredentialProxiesForAgent(agentId);
  unregisterManagedMcpRuntimeProxiesForAgent(agentId);
}

/** One launch's proxies only, when another launch of the agent may already hold its own. */
export function cleanupLaunchProxiesForLaunch(agentId: string, launchId: string | null): void {
  unregisterAgentCredentialProxyForLaunch({ agentId, launchId });
  unregisterManagedMcpRuntimeProxyForLaunch({ agentId, launchId });
}
