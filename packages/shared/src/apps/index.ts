// The first-party apps' parts of shared that core derives things from, one
// line per app, in the server registry's order (packages/server/src/apps/
// firstPartyApps.ts): their agent API fragments, merged into the contract
// after core's routes (agentApiContract.ts).
import { artifactsAgentApi } from "./artifacts/agentApi";

export const firstPartyAppAgentApis = [artifactsAgentApi] as const;
