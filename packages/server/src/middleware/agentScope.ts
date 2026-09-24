// Agent scope-check middleware — authoritative enforcement.
//
// Mounts on `/internal/agent/:id/*` routes that require a grantable scope.
// The agent's daemon-side cache is cooperative; this middleware is the
// final word on whether the call is permitted.
//
// On deny, sets `req.scopeDenyReason` and `req.scopeRequired` so:
//   • the OTLP `permission.denied` span (Stone, #proj-permission:10bdc2c9)
//     can read low-cardinality attributes off the request without
//     re-loading the scope set
//   • the prom counter `slock_agent_permission_denied_total` (Noel, same
//     thread) can attach the same labels
//
// Response body shape on 403:
//   { error: "missing required scope", requiredScope, reason }
//
// 200 fast-path overhead is one DB read into `agent_scopes`. Daemon caches
// reduce this to zero in steady state (CLI gates obvious denies before
// they hit the wire), but the server check still runs on every grantable
// MCP / CLI call as defense-in-depth.

import type { RequestHandler } from "express";
import {
  hasScope,
  isAgentScope,
  type AgentScope,
  type AgentScopeDenyReason,
} from "@botiverse/raft-shared";
import { loadAgentScopes, AgentScopesNotFoundError } from "../services/agentScopesService.js";
import * as agentService from "../services/agentService.js";
import { AGENT_CREDENTIAL_BRIDGE_MACHINE_ID } from "./agentCredentialBridge.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAgentScope` when the call is denied; null otherwise.
       *  Read by Stone's OTLP span emit + Noel's prom counter so they
       *  share a single source of truth on why a deny happened. */
      scopeDenyReason?: AgentScopeDenyReason | null;
      /** The scope literal the route required; populated alongside
       *  scopeDenyReason on deny. */
      scopeRequired?: AgentScope | null;
    }
  }
}

/**
 * Returns an Express middleware that asserts the caller agent has the given
 * scope. Use exactly one scope per route — composition (`requireAgentScope("a")`
 * + `requireAgentScope("b")`) is intentionally not supported; if a route
 * needs two scopes, that's a design smell, split the route.
 *
 * Returns `RequestHandler<any>` (rather than `RequestHandler` with a default
 * `ParamsDictionary`) so the route literal's own `RouteParameters<Route>` is
 * what flows into the next handler in the chain. A typed default would lock
 * P to `{ [k]: string | string[] }`, widening `req.params.id` everywhere this
 * middleware sits in front of an existing handler — which is most routes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireAgentScope(scope: AgentScope): RequestHandler<any> {
  // Bake-in sanity check at module-load time: scope literal must be in
  // the shared contract. Catches typos at import rather than at runtime.
  if (!isAgentScope(scope)) {
    throw new Error(`requireAgentScope: unknown scope literal '${scope}'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: RequestHandler<any> = async (req, res, next) => {
    const agentId = (req.params as unknown as { id?: string }).id;
    if (!agentId) {
      // Misconfiguration — the middleware was applied to a route without
      // `:id`. Surface as 500 so the deploy is loud, not silent.
      res.status(500).json({ error: "agent scope middleware applied to a route without :id" });
      return;
    }

    if (!req.machineId || !req.serverId) {
      res.status(401).json({ error: "Machine authentication required" });
      return;
    }

    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const isAgentCredentialBridge = req.machineId === AGENT_CREDENTIAL_BRIDGE_MACHINE_ID &&
      req.principalKind === "agent_credential" &&
      req.actingAgentId === agentId &&
      agent.machineId === null;
    if (!isAgentCredentialBridge && agent.machineId !== req.machineId) {
      res.status(403).json({ error: "This agent is not assigned to your machine" });
      return;
    }

    let denyReason: AgentScopeDenyReason | null = null;
    try {
      const set = await loadAgentScopes(agentId);
      if (hasScope(set, scope)) {
        // Authorized — continue. Leave scopeDenyReason untouched (null /
        // undefined) so downstream observability emits no deny event.
        next();
        return;
      }
      denyReason = "missing_scope";
    } catch (err) {
      if (err instanceof AgentScopesNotFoundError) {
        // Caller agent doesn't exist. Treat as missing_scope — consistent
        // 403 wire shape, no information leak about whether the agent
        // happens to exist on another server.
        denyReason = "missing_scope";
      } else {
        // Unexpected error loading scopes — fail closed. Surface as a
        // distinct deny reason so observability can isolate infra issues
        // from policy issues.
        console.error("agentScope: scope lookup failed", err);
        denyReason = "scope_lookup_failed";
      }
    }

    req.scopeDenyReason = denyReason;
    req.scopeRequired = scope;
    res.status(403).json({
      error: "missing required scope",
      requiredScope: scope,
      reason: denyReason,
    });
  };
  // Tag the middleware so the route-coverage test (see
  // `agentRouteScopeCoverage.test.ts`) can detect "this route has a static
  // middleware-level scope check". Type assertion since RequestHandler has no
  // free-form attribute slot — the property is internal-only.
  (handler as RequestHandler<any> & { __agentScope?: AgentScope }).__agentScope = scope;
  return handler;
}

/**
 * Read the static scope (if any) tagged onto a middleware by `requireAgentScope`.
 * Returns null when the handler is not a `requireAgentScope`-produced
 * middleware. Consumed only by the route-coverage test.
 */
export function getStaticAgentScope(handler: unknown): AgentScope | null {
  if (typeof handler !== "function") return null;
  const tagged = handler as { __agentScope?: AgentScope };
  return tagged.__agentScope ?? null;
}
