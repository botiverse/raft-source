// `integration_service_requested`: an agent named a service this server
// cannot give it (AppFather, 2026-11-15). Recorded next to the answer the
// agent already gets; nothing here may change that answer, delay it, or
// throw. What the agent typed is matched to the fixed list in shared
// (`matchRequestedService`) and never stored, logged, or put in a key.

import {
  matchRequestedService,
  type AgentApiIntegrationMcpApp,
  type REQUESTED_SERVICE_COMMANDS,
  type REQUESTED_SERVICE_OUTCOMES,
  type ServerId,
} from "@botiverse/raft-shared";
import * as oauthService from "./oauthService";
import { resolveAgentLoginClient } from "./oauthClientKeys";
import { findMcpAppForService, listAgentMcpAppsForIntegrationInventory } from "./managedMcpIntegrationInventory";
import type { ProductEventSink } from "./productEventScopeDbWriter";
import { firstSeenToday, recordServerProductEvent, seenToday } from "./serverProductEvents";

export type RequestedServiceOutcome = (typeof REQUESTED_SERVICE_OUTCOMES)[number];
export type RequestedServiceCommand = (typeof REQUESTED_SERVICE_COMMANDS)[number];

/** The once-a-day key: ids, the matched service key and the outcome; never what the agent typed. */
function requestKey(serverId: string, agentId: string, service: string, outcome: RequestedServiceOutcome, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `product-events:service-requested:${day}:${serverId}:${agentId}:${service}:${outcome}`;
}

/**
 * Records the request, at most once a UTC day per server, agent, listed
 * service and outcome: an agent retries, and the question is how many servers
 * asked, not how many times. Every unlisted name is the one key `other`, so
 * two different unlisted services from one agent in a day count once.
 */
export async function recordIntegrationServiceRequested(
  sink: ProductEventSink | null,
  input: {
    serverId: string;
    agentId: string;
    rawService: unknown;
    outcome: RequestedServiceOutcome;
    command: RequestedServiceCommand;
    now?: number;
  },
): Promise<void> {
  try {
    if (sink === null) return;
    const service = matchRequestedService(input.rawService);
    const now = input.now ?? Date.now();
    if (!(await firstSeenToday(requestKey(input.serverId, input.agentId, service, input.outcome, now), now))) return;
    await recordServerProductEvent(sink, {
      event: "integration_service_requested",
      userId: null,
      serverId: input.serverId as ServerId,
      properties: { service, outcome: input.outcome, command: input.command },
      now,
    });
  } catch (err) {
    console.warn("[product-events] integration_service_requested not recorded:", err instanceof Error ? err.name : "unknown");
  }
}

/**
 * For a `--service` lookup that found no usable app: which outcome it is, or
 * null when the name does belong to something on this server (a suspended
 * app, an MCP App) or cannot be told apart (the name is ambiguous, or the MCP
 * App inventory failed to load). Mirrors the order `integration login` checks
 * in, without its side effects. Only called after the lookup answered 404.
 */
export async function classifyUnresolvedServiceLookup(input: {
  serverId: string;
  rawService: string;
  /** The key matched a registered app that this server does not have: never read it as an MCP App's name. */
  clientKeyMatched: boolean;
  /** The agent's MCP Apps; undefined when the inventory could not be loaded. */
  mcpApps: readonly AgentApiIntegrationMcpApp[] | undefined;
}): Promise<RequestedServiceOutcome | null> {
  const suspended = await resolveAgentLoginClient(
    await oauthService.listSuspendedThirdPartyOAuthClients(input.serverId),
    input.rawService,
  );
  if (suspended.ok) return null;
  if (!input.clientKeyMatched) {
    if (input.mcpApps === undefined) return null;
    if (findMcpAppForService(input.mcpApps, input.rawService)) return null;
  }
  const marketplace = await resolveAgentLoginClient(await oauthService.listPublicMarketplaceOAuthClients(), input.rawService);
  if (marketplace.ok) return "not_installed";
  return marketplace.status === 404 ? "not_offered" : null;
}

/**
 * For a route that has already found the name in no OAuth inventory (usable,
 * suspended, Marketplace) but does not look at MCP Apps: records `not_offered`
 * unless the name is one of this agent's MCP Apps. If the MCP App inventory
 * cannot be read, nothing is recorded.
 */
export async function recordServiceNotOfferedUnlessMcpApp(
  sink: ProductEventSink | null,
  input: { serverId: string; agentId: string; rawService: string; clientKeyMatched: boolean; command: RequestedServiceCommand },
): Promise<void> {
  try {
    if (sink === null) return;
    if (!input.clientKeyMatched) {
      const mcpApps = await listAgentMcpAppsForIntegrationInventory(input.serverId, input.agentId);
      if (findMcpAppForService(mcpApps, input.rawService)) return;
    }
    await recordIntegrationServiceRequested(sink, { ...input, outcome: "not_offered" });
  } catch (err) {
    console.warn("[product-events] integration_service_requested not recorded:", err instanceof Error ? err.name : "unknown");
  }
}

/**
 * A `--service` lookup that found no usable app: works out which outcome it
 * is and records it. An agent stuck retrying the same lookup would pay the
 * classifier's reads on every call, so it is skipped when today's row for this
 * server, agent and matched service already exists (either outcome).
 *
 * The cost of that shortcut, for `other` only: every unlisted name shares the
 * one key, so once one unlisted lookup is recorded, a later lookup of a
 * different unlisted name with the other outcome is not recorded that day.
 * A name that turned out to belong to something on the server records
 * nothing and so never blocks a later one.
 */
export async function recordUnresolvedServiceLookup(
  sink: ProductEventSink | null,
  input: {
    serverId: string;
    agentId: string;
    rawService: string;
    clientKeyMatched: boolean;
    mcpApps: readonly AgentApiIntegrationMcpApp[] | undefined;
    now?: number;
  },
): Promise<void> {
  try {
    if (sink === null) return;
    const now = input.now ?? Date.now();
    const service = matchRequestedService(input.rawService);
    for (const outcome of ["not_offered", "not_installed"] as const) {
      if (await seenToday(requestKey(input.serverId, input.agentId, service, outcome, now), now)) return;
    }
    const outcome = await classifyUnresolvedServiceLookup(input);
    if (outcome) await recordIntegrationServiceRequested(sink, { ...input, outcome, command: "lookup", now });
  } catch (err) {
    console.warn("[product-events] integration_service_requested not recorded:", err instanceof Error ? err.name : "unknown");
  }
}
