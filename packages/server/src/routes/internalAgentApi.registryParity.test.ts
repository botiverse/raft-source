import { test } from "vitest";
import assert from "node:assert/strict";

import { agentApiContract } from "@botiverse/raft-shared";
import { routeAuthPolicy } from "../middleware/routeAuthPolicy.js";

/**
 * Every contract-declared agent-api route must also be registered in
 * `routeAuthPolicy`. The policy **fails closed**: a path under a claimed prefix
 * that is not registered returns 401 `auth_policy_unregistered_path`.
 *
 * Why this test exists — a real escape, found by driving a browser/CLI against a
 * running server, not by the suite:
 *
 *   `taskAssign` (`POST /internal/agent-api/tasks/assign`) shipped in the task
 *   v1.4 assignee work with a contract entry, a handler, a CLI command, an sp
 *   catalog line, and passing tests — but no `routeAuthPolicy` entry. Every real
 *   caller got 401. `raft task assign` was dead on arrival.
 *
 * Nothing caught it because the only test naming that path was a CLI test with a
 * **mocked transport**: it asserted the client POSTs to `/tasks/assign` against a
 * stub, and never crossed the middleware that rejects it. Adding a sibling route
 * is exactly the case the fail-closed policy is designed for, and exactly the
 * case a per-route test forgets.
 *
 * `internalComputer.preflight.test.ts` already guards the computer surface this
 * way. This is the agent-api counterpart, derived from the contract so it covers
 * every future route rather than the one that happened to break.
 */
test("every contract-declared agent-api route is registered in routeAuthPolicy", () => {
  const registered = new Set(
    routeAuthPolicy
      .filter((e) => e.path.startsWith("/internal/agent-api/"))
      .map((e) => `${e.method} ${e.path}`),
  );

  const missing = Object.values(agentApiContract)
    .map((r) => ({ key: r.key, sig: `${r.method} ${r.fullPath}` }))
    .filter((r) => !registered.has(r.sig));

  assert.deepEqual(
    missing,
    [],
    `these routes are reachable in the contract but unregistered in routeAuthPolicy, so they fail closed with 401 for every caller:\n`
      + missing.map((m) => `  - ${m.key}: ${m.sig}`).join("\n"),
  );
});

/**
 * The inverse direction. A registry entry whose contract route was renamed or
 * removed is dead configuration that quietly grants a path nothing serves —
 * and it makes the set above look complete while describing a route that no
 * longer exists.
 */
test("routeAuthPolicy declares no agent-api route the contract does not serve", () => {
  const declared = new Set(
    Object.values(agentApiContract).map((r) => `${r.method} ${r.fullPath}`),
  );

  // Only task/* is asserted here: the agent-api prefix also carries surfaces
  // (integrations, migrations, credentials) that are registered without going
  // through the shared route contract, and sweeping those in would make this a
  // test about that inventory rather than about contract/registry parity.
  const orphans = routeAuthPolicy
    .filter((e) => e.path.startsWith("/internal/agent-api/tasks"))
    .map((e) => `${e.method} ${e.path}`)
    .filter((sig) => !declared.has(sig));

  assert.deepEqual(orphans, [], `registry entries with no contract route: ${orphans.join(", ")}`);
});
