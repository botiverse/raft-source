// Every first-party app's agent API samples, for tests only (never imported
// by runtime code): one line per app, as apps/index.ts. Each app's covers
// every route of its fragment (checked by its own `satisfies`, and here as a
// whole).
import type { FirstPartyAppAgentApiRoutes } from "../agentApiContract";
import type { AgentApiMethod } from "../agentApiRoute";
import { artifactsAgentApiSamples } from "./artifacts/agentApi.samples";

/**
 * One route's test sample: the client call's arguments, a valid response,
 * and the request the raw client sends for those arguments.
 */
export type AgentApiRouteSample = {
  input: unknown[];
  response: unknown;
  sent: { method: AgentApiMethod; path: string; body: unknown };
};

export const firstPartyAppAgentApiSamples: Readonly<Record<keyof FirstPartyAppAgentApiRoutes, AgentApiRouteSample>> = {
  ...artifactsAgentApiSamples,
};
