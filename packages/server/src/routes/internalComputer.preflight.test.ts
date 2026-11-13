import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index";
import { computers, users, agentCredentials } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { routeAuthPolicy } from "../middleware/routeAuthPolicy";
import { internalComputerRouter } from "./internalComputer";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #30 PR-A regression guard — the 3-piece binding gate for the
// synthetic attach/login preflight (RFC v0.8 §9):
//   1. preflight output is DERIVED from the live `routeAuthPolicy` registry
//      (no static/parallel `EXPECTED_PRINCIPALS` list) AND it is
//      side-effect-free (no credential minted / no write);
//   2. a wrong principal fail-closes with the literal `invalid_principal`;
//   3. an unregistered sibling under the claimed `/internal/computer/`
//      prefix fail-closes with the literal `auth_policy_unregistered_path`.

function jsonHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function seedFixture(): Promise<{
  computerApiKey: string;
  agentApiKey: string;
}> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db
    .insert(users)
    .values({
      email: `preflight-${suffix}@slock.test`,
      name: `preflight-${suffix}`,
      displayName: "Preflight Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Preflight Test", `preflight-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "PreflightBot", { runtime: "claude", model: "sonnet" });
  const { machine } = await registerMachine(server.id, owner.id, "preflight-machine");

  const computerMaterial = await generateComputerApiKeyMaterial();
  await db.insert(computers).values({
    serverId: server.id,
    name: "preflight-computer",
    apiKeyHash: computerMaterial.apiKeyHash,
    apiKeyPrefix: computerMaterial.apiKeyPrefix,
    attachedByUserId: owner.id,
    machineId: machine.id,
  });
  const agentMinted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "preflight-agent",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { computerApiKey: computerMaterial.apiKey, agentApiKey: agentMinted.apiKey };
}

test("preflight: derived-from-registry + side-effect-free under Computer principal", async ({ app }) => {
  const { computerApiKey } = await seedFixture();
  const db = getDb();

  const before = await db.select({ id: agentCredentials.id }).from(agentCredentials);

  const res = await fetch(`${app.baseUrl}/internal/computer/preflight`, {
    method: "POST",
    headers: jsonHeaders(computerApiKey),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    surfaceVersion: string;
    claimedPrefixes: string[];
    registeredPrincipals: string[];
    computerSurface: Array<{ method: string; path: string; principal: string }>;
    principal: { kind: string | null };
  };

  assert.equal(body.ok, true);
  assert.equal(typeof body.surfaceVersion, "string");
  assert.ok(body.surfaceVersion.length > 0);
  // Principal split was actually enforced for this request.
  assert.equal(body.principal.kind, "computer");

  // DERIVED, not static: preflight's computerSurface must equal exactly
  // what we independently derive from the imported live registry — so a
  // registry change (or gap) is reflected, never masked by a parallel list.
  const expectedSurface = routeAuthPolicy
    .filter((e) => e.path.startsWith("/internal/computer/"))
    .map((e) => ({ method: e.method, path: e.path, principal: e.principal }));
  assert.deepEqual(body.computerSurface, expectedSurface);
  assert.deepEqual(
    body.registeredPrincipals,
    [...new Set(routeAuthPolicy.map((e) => e.principal))].sort(),
  );
  // The preflight route reflects ITSELF from the registry (proves the
  // derivation walks the real policy, not a hardcoded subset).
  assert.ok(
    body.computerSurface.some(
      (e) => e.path === "/internal/computer/preflight" && e.principal === "sk_computer",
    ),
  );

  // Side-effect-free: no credential minted / nothing written.
  const after = await db.select({ id: agentCredentials.id }).from(agentCredentials);
  assert.equal(after.length, before.length);
});

test("preflight: wrong principal fail-closes with literal invalid_principal", async ({ app }) => {
  const { agentApiKey } = await seedFixture();
  const res = await fetch(`${app.baseUrl}/internal/computer/preflight`, {
    method: "POST",
    headers: jsonHeaders(agentApiKey),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json() as { code?: string }).code, "invalid_principal");
});

test("preflight: unregistered sibling under /internal/computer/ fail-closes (auth_policy_unregistered_path)", async ({ app }) => {
  const { computerApiKey } = await seedFixture();
  const res = await fetch(`${app.baseUrl}/internal/computer/preflight-not-registered`, {
    method: "POST",
    headers: jsonHeaders(computerApiKey),
  });
  assert.equal(res.status, 401);
  assert.equal(
    (await res.json() as { code?: string }).code,
    "auth_policy_unregistered_path",
  );
});

// Express routes case-insensitively, so `/INTERNAL/COMPUTER/...` reaches the
// same router as `/internal/computer/...`. The registry once compared paths
// case-sensitively: such a path was not under a claimed prefix, skipped
// authentication and reached the handler (production probes, 11-03..11-05,
// got the preflight route list with no credential). Every case variant must
// authenticate exactly as the lower-case path does.
test("a case variant of a claimed prefix is authenticated, never passed through", async ({ app }) => {
  const { computerApiKey, agentApiKey } = await seedFixture();
  for (const path of ["/INTERNAL/COMPUTER/preflight", "/Internal/Computer/preflight", "/internal/COMPUTER/PREFLIGHT"]) {
    const anonymous = await fetch(`${app.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(anonymous.status, 401, `${path} without a credential`);
    const wrongPrincipal = await fetch(`${app.baseUrl}${path}`, { method: "POST", headers: jsonHeaders(agentApiKey) });
    assert.equal(wrongPrincipal.status, 401, `${path} with an agent key`);
    assert.equal((await wrongPrincipal.json() as { code?: string }).code, "invalid_principal");
    const unregistered = await fetch(`${app.baseUrl}${path}-NOT-REGISTERED`, { method: "POST", headers: jsonHeaders(computerApiKey) });
    assert.equal(unregistered.status, 401, `${path}-NOT-REGISTERED`);
    assert.equal((await unregistered.json() as { code?: string }).code, "auth_policy_unregistered_path");
  }
  for (const path of ["/INTERNAL/AGENT-API/server", "/Internal/Agent-Api/server"]) {
    const anonymous = await fetch(`${app.baseUrl}${path}`);
    assert.equal(anonymous.status, 401, `${path} without a credential`);
  }
  // The real credential still works on a case variant: it is authenticated, not refused by shape.
  const upper = await fetch(`${app.baseUrl}/INTERNAL/COMPUTER/preflight`, { method: "POST", headers: jsonHeaders(computerApiKey) });
  assert.equal(upper.status, 200);
  assert.equal((await upper.json() as { principal: { kind: string | null } }).principal.kind, "computer");
});

// Archer (#proj-runtime:828ad737): POST /internal/computer/probes/:probeId/materialize
// was served by internalComputerRouter but never registered, so every daemon
// call got 401 auth_policy_unregistered_path. Derive the served routes from the
// router itself so a future sibling cannot ship the same way.
test("every route internalComputerRouter serves is registered in routeAuthPolicy", () => {
  const registered = new Set(
    routeAuthPolicy
      .filter((entry) => entry.path.startsWith("/internal/computer/"))
      .map((entry) => `${entry.method} ${entry.path}`),
  );
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const served = (internalComputerRouter as unknown as { stack: Layer[] }).stack
    .flatMap((layer) => (layer.route
      ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} /internal/computer${layer.route!.path}`)
      : []));
  assert.ok(served.length > 10, "the router's routes were read");
  const missing = served.filter((signature) => !registered.has(signature));
  assert.deepEqual(missing, [], "served under /internal/computer/ but unregistered, so they fail closed for every caller");
});

test("probe materialize reaches its handler under the Computer principal", async ({ app }) => {
  const { computerApiKey } = await seedFixture();
  const res = await fetch(`${app.baseUrl}/internal/computer/probes/not-a-probe-id/materialize`, {
    method: "POST",
    headers: jsonHeaders(computerApiKey),
    body: JSON.stringify({ claimRequestId: "claim-1" }),
  });
  const body = await res.json() as { code?: string };
  assert.notEqual(body.code, "auth_policy_unregistered_path");
  assert.notEqual(res.status, 401);
  assert.ok(["probe_disabled", "probe_invalid"].includes(body.code ?? ""), `the handler answered: ${res.status} ${JSON.stringify(body)}`);
});
