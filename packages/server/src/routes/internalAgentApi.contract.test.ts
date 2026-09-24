import assert from "node:assert/strict";
import { test } from "vitest";

import { agentApiContract } from "@botiverse/raft-shared";
import { internalAgentApiRouter } from "./internalAgentApi.js";

function registeredRouteCounts(): Map<string, number> {
  const stack = (internalAgentApiRouter as unknown as { stack?: unknown[] }).stack ?? [];
  const counts = new Map<string, number>();
  for (const layer of stack) {
    const route = (layer as { route?: { path?: unknown; methods?: Record<string, boolean> } }).route;
    if (!route || typeof route.path !== "string") continue;
    for (const method of Object.keys(route.methods ?? {})) {
      const key = `${method.toUpperCase()} ${route.path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function routerStackLayers(): Array<{ route?: { path?: unknown; methods?: Record<string, boolean> } }> {
  return ((internalAgentApiRouter as unknown as { stack?: unknown[] }).stack ?? []) as Array<{
    route?: { path?: unknown; methods?: Record<string, boolean> };
  }>;
}

test("agent-api contract routes are registered once on the Express router", () => {
  const registered = registeredRouteCounts();
  for (const route of Object.values(agentApiContract)) {
    assert.equal(
      registered.get(`${route.method} ${route.path}`) ?? 0,
      1,
      `expected exactly one registered route for ${route.method} ${route.path}`,
    );
  }
});

test("agent-api router has no legacy catch-all fallback", () => {
  const catchAllLayers = routerStackLayers().filter((layer) => !layer.route);
  assert.equal(
    catchAllLayers.length,
    0,
    "agent-api routes must be native/id-less; do not fall through to legacy /internal/agent/:id handlers",
  );
});

test("agent-api exposes no agent runtime-control route", () => {
  const runtimeControlRoute = /(?:^|\/)(?:agents?\/[^/]+\/)?(?:start|stop|reset|restart)(?:\/|$)/i;
  for (const key of registeredRouteCounts().keys()) {
    const path = key.slice(key.indexOf(" ") + 1);
    assert.doesNotMatch(path, runtimeControlRoute, `${key} must remain unavailable to agent principals`);
  }
});

test("agent-api Manual transport schema keeps legacy context optional during staged rollout", () => {
  for (const route of [agentApiContract.knowledgeGet, agentApiContract.knowledgeSearch]) {
    const base = route.key === "knowledgeGet" ? { topic: "server" } : { query: "preview", scope: "recipes" };
    assert.equal(route.request.query.safeParse(base).success, true);
    assert.equal(route.request.query.safeParse({ ...base, intent: "Help the user complete their Raft workflow" }).success, true);
    assert.equal(route.request.query.safeParse({
      ...base,
      intent: "Help the user complete their Raft workflow",
      reason: "Need the relevant Manual guidance right now",
    }).success, true);
    assert.equal(route.request.query.safeParse({ ...base, intent: "too short" }).success, false);
  }
});
