// RFC 075 v4: the assistant allowlist matches exactly the routes it names.
// Walks every route actually registered on the Agent API router (contracted or
// not), so a route added later whose path happens to match an allowlisted
// pattern fails here instead of silently opening to assistants.
import assert from "node:assert/strict";
import { test } from "vitest";
import { agentApiContract } from "@botiverse/raft-shared";
import { internalAgentApiRouter } from "../routes/internalAgentApi";
import { firstPartyApps } from "../apps/firstPartyApps";
import { ASSISTANT_ALLOWED_AGENT_API_ROUTES, ASSISTANT_ROUTE_DECISIONS, ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS, assistantReachesApp, isAssistantAgentApiRequestAllowed } from "./assistantRouteAllowlist";

type RouteLayer = { route?: { path: unknown; methods: Record<string, boolean> } };

function registeredRoutes(): Array<{ method: string; path: string }> {
  const stack = (internalAgentApiRouter as unknown as { stack: RouteLayer[] }).stack;
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (!layer.route || typeof layer.route.path !== "string") continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on && method !== "_all") routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

test("only the allowlisted routes pass, out of every route registered on the Agent API router", () => {
  const expected = new Set<string>([
    ...ASSISTANT_ALLOWED_AGENT_API_ROUTES.map((key) => `${agentApiContract[key].method} ${agentApiContract[key].path}`),
    ...ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS.filter((route) => route.allow).map((route) => `${route.method} ${route.path}`),
  ]);
  const routes = registeredRoutes();
  assert.ok(routes.length > 90, `fixture: found ${routes.length} registered routes`);
  const passing = new Set<string>();
  for (const route of routes) {
    const concrete = route.path.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
    if (isAssistantAgentApiRequestAllowed(route.method, `/internal/agent-api${concrete === "/" ? "" : concrete}`)) {
      passing.add(`${route.method} ${route.path}`);
    }
  }
  assert.deepEqual([...passing].sort(), [...expected].sort());
});

test("every Agent API route is decided once, with a reason: contracted and not, so a new route nobody decided fails here", () => {
  const contractKeys = Object.keys(agentApiContract).sort();
  assert.deepEqual(Object.keys(ASSISTANT_ROUTE_DECISIONS).sort(), contractKeys, "ASSISTANT_ROUTE_DECISIONS covers exactly the contract");
  const contracted = new Set(Object.values(agentApiContract).map((route) => `${route.method} ${route.path}`));
  const uncontracted = registeredRoutes().map((route) => `${route.method} ${route.path}`).filter((route) => !contracted.has(route));
  assert.ok(uncontracted.includes("POST /third-party-events/delivered"), `fixture: ${uncontracted.join(", ")}`);
  const decided = ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS.map((route) => `${route.method} ${route.path}`);
  assert.deepEqual([...decided].sort(), [...new Set(uncontracted)].sort(), "every registered route outside the contract is decided, and no decision is stale");
  assert.equal(new Set(decided).size, decided.length, "decided once");
  const names = new Set([...contractKeys, ...decided]);
  for (const [route, decision] of [...Object.entries(ASSISTANT_ROUTE_DECISIONS), ...ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS.map((d) => [`${d.method} ${d.path}`, d] as const)]) {
    assert.ok(decision.reason.trim().length > 0, `${route}: a reason`);
    for (const pair of "pairsWith" in decision ? decision.pairsWith ?? [] : []) assert.ok(names.has(pair), `${route}: pairsWith names a route (${pair})`);
    for (const pair of "pairsWith" in decision ? decision.pairsWith ?? [] : []) {
      const other = pair in ASSISTANT_ROUTE_DECISIONS ? ASSISTANT_ROUTE_DECISIONS[pair as keyof typeof ASSISTANT_ROUTE_DECISIONS] : ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS.find((d) => `${d.method} ${d.path}` === pair);
      assert.equal(other?.allow, true, `${route} pairs with ${pair}, which must be allowed too`);
    }
  }
});

test("the matcher refuses anything outside the Agent API and other methods", () => {
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/internal/agent-api/context"), true);
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/internal/agent-api/"), true, "whoami with a trailing slash");
  assert.equal(isAssistantAgentApiRequestAllowed("POST", "/internal/agent-api/context"), false);
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/internal/agent-api/Context"), false, "case-sensitive");
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/internal/agent/context"), false);
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/api/agents"), false);
  assert.equal(isAssistantAgentApiRequestAllowed("GET", "/internal/agent-api/attachments/a/b/url"), false, "a :param is one segment");
});

test("an assistant reaches a first-party app exactly when one of the app's routes is allowlisted; none is today", () => {
  const apps = firstPartyApps().map((app) => app.id);
  assert.ok(apps.includes("artifacts"), `fixture: ${apps.join(", ")}`);
  for (const id of apps) {
    const own = (Object.keys(agentApiContract) as Array<keyof typeof agentApiContract>)
      .filter((key) => agentApiContract[key].path === `/${id}` || agentApiContract[key].path.startsWith(`/${id}/`));
    // An app with no Agent API route of its own (reaction-notices: it only sends notices) is reached by no one.
    if (own.length === 0) {
      assert.equal(assistantReachesApp(id), false, `${id}: an app without routes`);
      continue;
    }
    const allowed = own.some((key) => isAssistantAgentApiRequestAllowed(agentApiContract[key].method, `/internal/agent-api${agentApiContract[key].path.replace(/:[A-Za-z]+/g, "x")}`));
    assert.equal(assistantReachesApp(id), allowed, id);
    assert.equal(assistantReachesApp(id), false, `${id}: no assistant route today`);
  }
  assert.equal(assistantReachesApp("art"), false, "a prefix of a path segment is not the app");
});
