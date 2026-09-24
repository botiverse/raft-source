import { unregisterAgentCredentialProxiesForAgent } from "./agentCredentialProxy.js";
import { unregisterManagedMcpRuntimeProxiesForAgent } from "./managedMcpRuntimeProxy.js";

export function cleanupLaunchProxies(agentId: string): void {
  unregisterAgentCredentialProxiesForAgent(agentId);
  unregisterManagedMcpRuntimeProxiesForAgent(agentId);
}
