// CI guardrail for the agent permission scope system
// (#proj-permission:1414ca65, agreed 2026-05-12 by stdrc / Stone / Tenny).
//
// Walks every `/agent/:id/*` route registered on `internalRouter` and asserts
// each one is covered:
//
//   • Either by `requireAgentScope` middleware on the route itself (detected
//     via the `__agentScope` tag attached by `getStaticAgentScope`), OR
//   • By an entry in `AGENT_ROUTE_SCOPE_COVERAGE` declaring the route as
//     `intrinsic` / `exempt` with a non-empty reason.
//
// v1 has no `dynamic` kind — granularity is per-CLI-subcommand and every
// message route is statically gated. If a future v2 reintroduces handler-
// decided scopes, restore the `dynamic` kind plus a literal-presence check
// on `assertAgentScope(` in the route's handler body (Stone's original gap-
// closer, msg=b1aa3a13) so an entry can't lie about its handler.
//
// Failure modes the test catches:
//   • New `/agent/:id/*` route added without `requireAgentScope` and not in
//     allowlist → "no scope coverage declared"
//   • Stale allowlist entry (route renamed / removed) → "no matching route"
//   • Static-gated route also in allowlist → "redundant entry"
//   • Allowlist entry with empty reason → "reason must be non-empty"

import assert from "node:assert/strict";
import { test } from "vitest";

import { internalRouter } from "../routes/internal.js";
import { getStaticAgentScope } from "./agentScope.js";
import { AGENT_ROUTE_SCOPE_COVERAGE } from "./agentRouteScopeCoverage.js";

interface RouteEntry {
  method: string;
  path: string;
  staticScope: string | null;
  /** Express layer for this method (filtered to single method per entry). */
  layer: unknown;
}

function enumerateAgentRoutes(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  // Express Router internals: each `stack` layer with a `route` is a registered
  // route. `route.path` is the literal pattern, `route.methods` is the set of
  // HTTP verbs, and `route.stack` is the chain of middleware/handlers.
  const stack = (internalRouter as unknown as { stack: Array<Record<string, unknown>> }).stack;
  for (const layer of stack) {
    const route = layer.route as
      | { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
      | undefined;
    if (!route) continue;
    if (typeof route.path !== "string") continue;
    if (!route.path.startsWith("/agent/:id")) continue;

    let staticScope: string | null = null;
    for (const inner of route.stack) {
      const tagged = getStaticAgentScope(inner.handle);
      if (tagged) {
        staticScope = tagged;
        break;
      }
    }

    for (const [method, enabled] of Object.entries(route.methods)) {
      if (!enabled) continue;
      entries.push({
        method: method.toUpperCase(),
        path: route.path,
        staticScope,
        layer,
      });
    }
  }
  return entries;
}

test("every /agent/:id/* route is either statically gated or in the coverage allowlist", () => {
  const routes = enumerateAgentRoutes();
  assert.ok(routes.length > 0, "expected at least one /agent/:id/* route");

  const violations: string[] = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    const allowlistEntry = AGENT_ROUTE_SCOPE_COVERAGE.get(key);
    if (r.staticScope) {
      if (allowlistEntry) {
        violations.push(
          `${key}: gated by requireAgentScope("${r.staticScope}") AND in allowlist (kind=${allowlistEntry.kind}). Static-gated routes must NOT appear in the allowlist — remove the allowlist entry.`,
        );
      }
      continue;
    }
    if (!allowlistEntry) {
      violations.push(
        `${key}: no scope coverage declared. Either add requireAgentScope(...) middleware, OR add an entry to AGENT_ROUTE_SCOPE_COVERAGE in middleware/agentRouteScopeCoverage.ts with kind=intrinsic|exempt and a non-empty reason.`,
      );
    }
  }
  assert.equal(
    violations.length,
    0,
    `\n  ${violations.join("\n  ")}\n`,
  );
});

test("every allowlist entry corresponds to a registered route (no stale entries)", () => {
  const routes = enumerateAgentRoutes();
  const registeredKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const stale: string[] = [];
  for (const key of AGENT_ROUTE_SCOPE_COVERAGE.keys()) {
    if (!registeredKeys.has(key)) {
      stale.push(`${key}: no matching route registered on internalRouter`);
    }
  }
  assert.equal(
    stale.length,
    0,
    `\n  Stale allowlist entries — remove them from AGENT_ROUTE_SCOPE_COVERAGE:\n  ${stale.join("\n  ")}\n`,
  );
});

test("allowlist entries have non-empty reasons", () => {
  for (const [key, entry] of AGENT_ROUTE_SCOPE_COVERAGE.entries()) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length > 0,
      `${key}: reason must be a non-empty string`,
    );
  }
});

