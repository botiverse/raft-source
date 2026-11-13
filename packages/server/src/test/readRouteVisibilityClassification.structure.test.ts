// Read-route visibility contract. Every GET route the app actually registers must appear exactly once in
// READ_ROUTE_VISIBILITY_CLASSIFICATION with an entry (unified / legacy:<check> / none) and a one-line reason, and
// every table row must still be registered. The route list comes from runtime registration (routeRegistrationCapture.ts,
// `methods: "read"`), cross-checked against Express's dispatch stack, as for the mutating-route contract. The legacy
// rows are the migration backlog to the visibility entry: their count may only go down.
import assert from "node:assert/strict";
import express from "express";
import { AGENT_API_ROUTE_MANIFEST } from "@botiverse/raft-shared/src/generated/agentApiRoutes";
import { installRouteRegistrationCapture } from "./routeRegistrationCapture";
import {
  EXPECTED_NONE_READ_ROUTES,
  MAX_LEGACY_READ_ROUTES,
  READ_ROUTE_VISIBILITY_CLASSIFICATION,
  checkReadRouteClassification,
  type ReadRouteClassification,
} from "./readRouteVisibilityClassification";

// Mount every env-gated surface so gated routes are enumerated rather than silently absent.
process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;

const capture = installRouteRegistrationCapture();
const noop = (_req: unknown, res: { end: () => void }) => res.end();

test("read capture positive controls: GET only, chained .route(), nested subrouters, array mounts, unmounted routers", () => {
  const session = capture.session();
  const app = express();
  const sub = express.Router();
  sub.route("/chained").get(noop).post(noop);
  sub.get("/plain/:id", noop);
  sub.delete("/plain/:id", noop);
  const nested = express.Router();
  nested.get("/deep", noop);
  sub.use("/nested/:x", nested);
  app.use("/mounted", sub);
  app.use(["/a", "/b"], nested);
  const orphan = express.Router();
  orphan.get("/orphan", noop);

  const { routes, problems } = session.collect((app as unknown as { router: object }).router, { methods: "read" });
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
    "GET /a/deep",
    "GET /b/deep",
    "GET /mounted/chained",
    "GET /mounted/nested/:x/deep",
    "GET /mounted/plain/:id",
  ]);
  assert.deepEqual(problems, ["unmounted router registers GET /orphan"]);
  // The default stays the mutating surface.
  assert.deepEqual(session.collect((app as unknown as { router: object }).router).routes.map((route) => `${route.method} ${route.path}`), [
    "DELETE /mounted/plain/:id",
    "POST /mounted/chained",
  ]);
});

let appRouter: object | undefined;
let appSession: ReturnType<typeof capture.session> | undefined;

test("every registered GET route is classified exactly once, every row is registered, and the legacy and none counts are pinned", async () => {
  appSession = capture.session();
  const { createApp } = await import("../app");
  appRouter = (createApp() as unknown as { router: object }).router;
  const { routes, problems } = appSession.collect(appRouter, { methods: "read" });

  assert.deepEqual(problems, [], "route capture and dispatch stack must agree, with no unmounted read routers");
  const result = checkReadRouteClassification(routes);
  assert.deepEqual(result.unclassified, [], "registered GET routes missing from READ_ROUTE_VISIBILITY_CLASSIFICATION");
  assert.deepEqual(result.stale, [], "READ_ROUTE_VISIBILITY_CLASSIFICATION rows that are no longer registered");
  assert.deepEqual(result.duplicates, [], "routes classified more than once");
  assert.deepEqual(result.missingReasons, [], "rows without a one-line reason");
  assert.deepEqual(result.malformedEntries, [], "entries must be unified, none, or legacy:<check>");
  // A ratchet, not a bound: lower MAX_LEGACY_READ_ROUTES in the same change that migrates a route.
  assert.equal(
    result.legacyCount,
    MAX_LEGACY_READ_ROUTES,
    `${result.legacyCount} legacy read routes, pinned ${MAX_LEGACY_READ_ROUTES}: a new read route must use the visibility entry; a migration lowers the pin`,
  );
  // Pinned so every new `none` label is a reviewed diff of this number.
  assert.equal(result.noneCount, EXPECTED_NONE_READ_ROUTES, "`none` read routes changed: update EXPECTED_NONE_READ_ROUTES deliberately");
  assert.equal(routes.length, READ_ROUTE_VISIBILITY_CLASSIFICATION.length);
});

test("every agent API read in AGENT_API_ROUTE_MANIFEST is classified", () => {
  const classified = new Set(READ_ROUTE_VISIBILITY_CLASSIFICATION.map((row) => row.route));
  const reads = AGENT_API_ROUTE_MANIFEST.filter((route) => route.method === "GET" && route.sideEffect === "read");
  assert.ok(reads.length > 0, "the manifest lists agent API reads");
  assert.deepEqual(reads.map((route) => `GET ${route.fullPath}`).filter((key) => !classified.has(key)), []);
  assert.ok(classified.has("GET /internal/agent-api/search"));
});

test("reverse controls: an unclassified GET on a mounted router, a dropped row, a stale row and a new legacy row all turn red", async () => {
  assert.ok(appSession && appRouter, "depends on the enumeration test having built the app");
  const { agentRouter } = await import("../routes/agents");
  agentRouter.get("/:id/unclassified-read-structural-probe", noop);
  const { routes, problems } = appSession.collect(appRouter, { methods: "read" });
  assert.deepEqual(problems, []);
  assert.deepEqual(checkReadRouteClassification(routes).unclassified, ["GET /api/agents/:id/unclassified-read-structural-probe"]);

  const dropped = READ_ROUTE_VISIBILITY_CLASSIFICATION.filter((row) => row.route !== "GET /api/messages/search");
  assert.ok(checkReadRouteClassification(routes, dropped).unclassified.includes("GET /api/messages/search"));

  const staleRow: ReadRouteClassification = { route: "GET /api/agents/:id/no-such-read", entry: "none", reason: "control" };
  assert.deepEqual(checkReadRouteClassification(routes, [...READ_ROUTE_VISIBILITY_CLASSIFICATION, staleRow]).stale, [staleRow.route]);

  const legacyRow: ReadRouteClassification = { route: "GET /api/agents/:id/unclassified-read-structural-probe", entry: "legacy:canUserAccessChannel", reason: "control" };
  assert.notEqual(checkReadRouteClassification(routes, [...READ_ROUTE_VISIBILITY_CLASSIFICATION, legacyRow]).legacyCount, MAX_LEGACY_READ_ROUTES);
  const migrated = READ_ROUTE_VISIBILITY_CLASSIFICATION.map((row) => row.route === "GET /api/channels" ? { ...row, entry: "unified" as const } : row);
  assert.notEqual(checkReadRouteClassification(routes, migrated).legacyCount, MAX_LEGACY_READ_ROUTES, "a migration without lowering the pin turns red too");
  const noneRow: ReadRouteClassification = { route: "GET /api/agents/:id/unclassified-read-structural-probe", entry: "none", reason: "control" };
  assert.notEqual(checkReadRouteClassification(routes, [...READ_ROUTE_VISIBILITY_CLASSIFICATION, noneRow]).noneCount, EXPECTED_NONE_READ_ROUTES);
  const malformed: ReadRouteClassification = { route: "GET /api/agents/:id/unclassified-read-structural-probe", entry: "legacy:" as `legacy:${string}`, reason: "control" };
  assert.deepEqual(checkReadRouteClassification(routes, [...READ_ROUTE_VISIBILITY_CLASSIFICATION, malformed]).malformedEntries, [malformed.route]);
});
