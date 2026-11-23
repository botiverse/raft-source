// Task #91 route enumeration contract. Every mutating route the app actually registers must appear exactly once in
// ROUTE_AUTHORITY_CLASSIFICATION with a bucket and a one-line reason, and every table row must still be registered.
// The route list comes from runtime registration (see routeRegistrationCapture.ts), cross-checked against Express's
// dispatch stack, so a new router, a chained `.route()`, a subrouter mount or an env-gated mount cannot slip past a
// source-text scan. The adjudicated #91a / #93 lists are pinned by count so moving a route between them is deliberate.
//
// RFC 085 §4.1, the delegable-route registry (Warden reviews every change to it): every human-session route declares
// `delegable`, the `assistant` routes are exactly the owner-action table's writes, the `card` list is pinned by content
// and each entry is complete, and security-sensitive routes stay `never`, by name (the never-delegable list below) and
// by keyword and bucket rules.
import assert from "node:assert/strict";
import express from "express";
import { z } from "zod";
import { PREPARED_REQUEST_OPERATION_PATTERN, SERVER_CAPABILITY_KEYS, type ServerCapability } from "@botiverse/raft-shared";
import { DELEGABLE_CARD_ROUTES, type DelegableCardRoute, type DelegableOperation } from "../services/delegableCardRoutes";
import { DELEGABLE_SUMMARY_TEMPLATES, type DelegableSummaryTemplate } from "../services/delegableSummaryTemplates";
import { delegableBodyBackstopKey, delegableRouteBackstopRule } from "../services/delegableRouteBackstop";
import { preparedRequestParamWords } from "../services/preparedRequestCards";
import { installRouteRegistrationCapture } from "./routeRegistrationCapture";
import {
  DELEGABLE_NEVER_ROWS,
  PINNED_BUCKET_COUNTS,
  ROUTE_AUTHORITY_CLASSIFICATION,
  checkRouteClassification,
  type RouteAuthorityBucket,
  type RouteClassification,
  type RouteDelegable,
} from "./routeAuthorityClassification";

// Mount every env-gated surface so gated routes are enumerated rather than silently absent.
process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;

const capture = installRouteRegistrationCapture();
const noop = (_req: unknown, res: { end: () => void }) => res.end();

test("capture positive controls: chained .route(), nested subrouters, array mounts, app.all, unmounted routers", () => {
  const session = capture.session();
  const app = express();
  const sub = express.Router();
  sub.route("/chained").post(noop).put(noop).get(noop);
  sub.delete("/plain/:id", noop);
  const nested = express.Router();
  nested.patch("/deep", noop);
  sub.use("/nested/:x", nested);
  app.use("/mounted", sub);
  app.use(["/a", "/b"], nested);
  app.all("/any", noop);
  app.post(/^\/regex$/, noop);
  const orphan = express.Router();
  orphan.post("/orphan", noop);

  const { routes, problems } = session.collect((app as unknown as { router: object }).router);
  // Express 5 `app.all` registers every HTTP method on the route individually, so each mutating method is enumerated.
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
    "DELETE /any",
    "DELETE /mounted/plain/:id",
    "PATCH /a/deep",
    "PATCH /any",
    "PATCH /b/deep",
    "PATCH /mounted/nested/:x/deep",
    "POST /^\\/regex$/",
    "POST /any",
    "POST /mounted/chained",
    "PUT /any",
    "PUT /mounted/chained",
  ]);
  assert.deepEqual(problems, ["unmounted router registers POST /orphan"]);
});

let appRouter: object | undefined;
let appSession: ReturnType<typeof capture.session> | undefined;

test("every registered mutating route is classified exactly once and every table row is registered", async () => {
  appSession = capture.session();
  const { createApp } = await import("../app");
  appRouter = (createApp() as unknown as { router: object }).router;
  const { routes, problems } = appSession.collect(appRouter);

  assert.deepEqual(problems, [], "route capture and dispatch stack must agree, with no unmounted mutating routers");
  const result = checkRouteClassification(routes);
  assert.deepEqual(result.unclassified, [], "registered mutating routes missing from ROUTE_AUTHORITY_CLASSIFICATION");
  assert.deepEqual(result.stale, [], "ROUTE_AUTHORITY_CLASSIFICATION rows that are no longer registered");
  assert.deepEqual(result.duplicates, [], "routes classified more than once");
  assert.deepEqual(result.missingReasons, [], "rows without a one-line reason");
  assert.deepEqual(result.pinnedCounts, PINNED_BUCKET_COUNTS, "adjudicated #91a / #93 bucket counts changed");
  assert.equal(routes.length, ROUTE_AUTHORITY_CLASSIFICATION.length);
});

test("reverse controls: an unclassified route on a mounted router, a dropped row and a stale row all turn red", async () => {
  assert.ok(appSession && appRouter, "depends on the enumeration test having built the app");
  const { agentRouter } = await import("../routes/agents");
  agentRouter.post("/:id/unclassified-structural-probe", noop);
  const { routes, problems } = appSession.collect(appRouter);
  assert.deepEqual(problems, []);
  assert.deepEqual(checkRouteClassification(routes).unclassified, ["POST /api/agents/:id/unclassified-structural-probe"]);

  const dropped = ROUTE_AUTHORITY_CLASSIFICATION.filter((row) => row.route !== "PUT /api/agents/:id/scopes");
  assert.ok(checkRouteClassification(routes, dropped).unclassified.includes("PUT /api/agents/:id/scopes"));

  const staleRow: RouteClassification = { route: "POST /api/agents/:id/no-such-route", bucket: "cat1", reason: "control" };
  assert.deepEqual(checkRouteClassification(routes, [...ROUTE_AUTHORITY_CLASSIFICATION, staleRow]).stale, [staleRow.route]);
});

// ---- RFC 085 §4.1: the delegable-route registry ----

/**
 * The `card` list, pinned by content: adding a route to services/delegableCardRoutes.ts or removing one changes this
 * test. RFC 085 §7 Phase 1: agent start and stop, and lowering a channel member's role.
 */
const PINNED_CARD_ROUTES: readonly string[] = [
  "POST /api/agents/:id/start",
  "POST /api/agents/:id/stop",
  "PATCH /api/channels/:id/members/:targetType/:memberId/role",
];

/**
 * Never delegable, by name: RFC 085 §3.1's security-sensitive routes and §5's "not in any batch". Each entry must be a
 * classified route whose `delegable` is `never` (a `nonHuman` route always is). The list lives in this test, so adding
 * or removing an entry changes the test, and an entry whose route is renamed or removed fails it instead of quietly
 * protecting nothing. Sign-in flows before a session exists (login, register, callbacks, password reset) are not named:
 * the sign-in rule below holds everything under /api/auth but the profile.
 */
const NEVER_DELEGABLE: Readonly<Record<string, readonly string[]>> = {
  // Agent credentials, machine and Computer keys (issuing, rotating, revoking), App and webhook secrets, provider and
  // Computer runtime sign-ins, upgrades and installs, signed scope attestations.
  "credentials and keys": [
    "POST /api/agents/:id/credentials",
    "DELETE /api/agents/:id/credentials/:credentialId",
    "POST /api/agents/:id/bootstrap-tokens",
    "POST /api/servers/:id/machines",
    "POST /api/computer/attach",
    "POST /api/computer/adopt-legacy",
    "POST /api/servers/:id/machines/:machineId/rotate-key",
    "POST /api/servers/:id/machines/:machineId/revoke-computer-key",
    "DELETE /api/servers/:id/machines/:machineId",
    "POST /api/servers/:id/setup-reset",
    "POST /api/integrations/clients/:clientId/regenerate-secret",
    "POST /api/integrations/clients/:clientId/app-notifications/webhook/rotate-secret",
    "POST /api/servers/:id/machines/:machineId/runtime-auth/:runtime/login",
    "POST /api/servers/:id/machines/:machineId/runtime-auth/:runtime/login/:loginId/code",
    "POST /api/servers/:id/machines/:machineId/runtime-auth/:runtime/connect-provider",
    "POST /api/servers/:id/machines/:machineId/runtime-auth/:runtime/logout",
    // Runs a runtime's own updater: changes the Computer's software.
    "POST /api/servers/:id/machines/:machineId/runtimes/:runtime/upgrade",
    // Installs software on the Computer, and reads the commands it would run there.
    "POST /api/servers/:id/machines/:machineId/runtimes/:runtime/install-plan",
    "POST /api/servers/:id/machines/:machineId/runtimes/:runtime/install",
    "POST /api/mcp/apps/:appId/connections",
    "PATCH /api/mcp/apps/:appId/connections/:connectionId",
    "POST /api/servers/:id/scope-attestation",
  ],
  // Billing, paid seats, and spending a runtime account's limit reset (RFC 085 §8.3: anything that raises spend).
  "payment and seat charges": [
    "POST /api/billing/cancel",
    "POST /api/billing/checkout",
    "POST /api/billing/pack-quantity",
    "POST /api/billing/pack-quantity/preview",
    "POST /api/billing/portal",
    "POST /api/billing/prepaid/checkout",
    "POST /api/billing/prepaid/seats/checkout",
    "POST /api/billing/seat-pack-quantity",
    "POST /api/billing/seat-pack-quantity/preview",
    "POST /api/appsumo/redemption/bind",
    "POST /api/actions/:messageId/seats-added",
    "POST /api/servers/:id/machines/:machineId/runtime-account-usage/:provider/limit-reset",
    "POST /api/servers/:id/machines/:machineId/runtime-account-usage/:provider/limit-resets/read",
  ],
  // The signed-in person's own security: password (PATCH /api/auth/me also changes it), linked sign-in identities,
  // two-step verification and passkeys, device logins and sessions, and where push notifications are delivered.
  "sign-in, two-step and devices": [
    "PATCH /api/auth/me",
    "DELETE /api/auth/identities/:provider",
    "POST /api/auth/:provider/link/start",
    "POST /api/auth/mobile/oauth/:provider/link/start",
    "POST /api/auth/mobile/oauth/:provider/link/complete",
    "POST /api/auth/second-factor/enable",
    "POST /api/auth/second-factor/disable",
    "POST /api/auth/second-factor/totp/setup",
    "POST /api/auth/second-factor/totp/confirm",
    "POST /api/auth/second-factor/backup-codes/regenerate",
    "POST /api/auth/second-factor/passkeys/registration/options",
    "POST /api/auth/second-factor/passkeys/registration/verify",
    "PATCH /api/auth/second-factor/passkeys/:id",
    "DELETE /api/auth/second-factor/passkeys/:id",
    "POST /api/auth/second-factor/step-up",
    "POST /api/auth/second-factor/reauth/password",
    "DELETE /api/auth/second-factor/recovery",
    "POST /api/auth/device/approve",
    "POST /api/auth/device/authorize",
    "POST /api/auth/device/revoke",
    "POST /api/computer/retire-session",
    "POST /api/push/registrations",
    "PATCH /api/push/registrations/:installationId",
    "POST /api/push/subscribe",
  ],
  "account deletion": [
    "POST /api/me/account/deletion",
    "DELETE /api/me/account/deletion",
    "DELETE /api/me/account/deletion/requests/:requestId",
    "POST /api/me/account/deletion/email-code",
    "POST /api/me/account/deletion/notify-agent-owners",
    "POST /api/auth/account-deletion/cancel",
  ],
  "SSO": [
    "PUT /api/servers/:id/sso/connection",
    "DELETE /api/servers/:id/sso/connection",
    "PATCH /api/servers/:id/sso/rules",
    "POST /api/servers/:id/sso/test",
    "POST /api/servers/:id/sso/domains",
    "POST /api/servers/:id/sso/domains/:domainId/verify",
    "DELETE /api/servers/:id/sso/domains/:domainId",
  ],
  // Login with Raft and OAuth consent, App installs and grants (an install grants the App access), MCP grants,
  // Connections and OAuth, agents' provider connections, and committing an integration card.
  "OAuth and MCP grants": [
    "POST /api/oauth/authorize/human",
    "POST /api/oauth/authorize/account",
    "POST /api/auth/app-login/requests/:id/approve",
    "DELETE /api/me/app-logins/:clientId",
    "POST /api/integrations/agents/:agentId/grants",
    "POST /api/integrations/grants/:grantId/revoke",
    "POST /api/integrations/requests/:requestId/approve",
    "POST /api/integrations/requests/:requestId/deny",
    "POST /api/integrations/marketplace/:clientId/install",
    "DELETE /api/integrations/marketplace/:clientId/install",
    "PUT /api/integrations/marketplace/:clientId/install/app-notifications/grant",
    "POST /api/integrations/clients/:clientId/install/bot",
    // Vouching lets every agent of the Server use the App with no one's approval.
    "PUT /api/integrations/clients/:clientId/server-vouch",
    "POST /api/integration-invites/:token/install",
    "POST /api/integrations/clients/:clientId/link-preview-consent",
    "POST /api/actions/:messageId/execute",
    "PUT /api/mcp/agents/:agentId/assignments",
    "PUT /api/mcp/agents/:agentId/assignments/:mcpServerId",
    "POST /api/mcp/apps/:appId/connections/oauth/start",
    "DELETE /api/mcp/apps/:appId/connections/:connectionId/oauth",
    "POST /api/mcp/servers/:mcpServerId/oauth/start",
    "DELETE /api/mcp/servers/:mcpServerId/oauth",
    "PUT /api/mcp/apps/:appId/default",
    // As the App one above: every agent of the Server may use the MCP App with no one's approval.
    "PUT /api/mcp/apps/:appId/server-vouch",
    // RFC 087: whose account an agent acts as (members' own accounts, shared pins, revoking one).
    "PUT /api/mcp/apps/:appId/members-can-connect",
    "PUT /api/mcp/connections/:connectionId/agents",
    "PUT /api/mcp/connections/:connectionId/agents/:agentId",
    "DELETE /api/mcp/connections/:connectionId",
    "POST /api/agents/:id/connections/:provider",
    "POST /api/agents/:id/connections/:provider/confirm",
    "PUT /api/agents/:id/connections/:provider",
    "DELETE /api/agents/:id/connections/:provider",
    "DELETE /api/agents/:id/connections/:provider/connectors/:connectorId",
    "POST /api/slack-bridge/oauth/start",
  ],
  // A member's server role (PATCH .../members/:memberId), an agent's scopes, and grants that widen what an agent reads.
  "server roles and agent scopes": [
    "PATCH /api/servers/:id/members/:memberId",
    "PUT /api/agents/:id/scopes",
    "POST /api/servers/:id/agent-context-view-grants",
    "DELETE /api/servers/:id/agent-context-view-grants/:grantId",
    "PUT /api/raftbench/readers/:agentId",
  ],
  // A public server and its search listing, a channel visitors can read (PATCH /api/channels/:id's visitorVisible),
  // and an Artifact anyone with the link can open (its home made public).
  "making content public on the internet": [
    "PATCH /api/servers/:id/public-visibility",
    "PATCH /api/servers/:id/public-search",
    "PATCH /api/channels/:id",
    "POST /api/artifacts/:id/home",
  ],
  // RFC 085 §5: sending external or joint invites exposes a channel (and on conversion its history) outside the
  // server, the same class as making it public; so does mirroring channels to a Slack workspace.
  "channel content outside the server": [
    "POST /api/channels/:id/external-invites",
    "POST /api/channels/:id/external-invites/:inviteId/resend",
    "POST /api/channels/:id/external-connect-servers",
    "POST /api/channels/:id/joint-invites",
    "POST /api/channels/:id/joint-invite/resend",
    "POST /api/channels/:id/convert-to-joint",
    "POST /api/channels/:id/connect-my-servers",
    "POST /api/slack-bridge/provisioning/connect",
    "PUT /api/slack-bridge/provisioning/channel-pairs",
    "POST /api/slack-bridge/provisioning/enable",
  ],
  // RFC 085 §5: deleting stays `never` (archiving is the card); a server likewise.
  "deleting a channel or server": [
    "DELETE /api/channels/:id",
    "DELETE /api/servers/:id",
  ],
};
const NEVER_DELEGABLE_ROUTES = Object.values(NEVER_DELEGABLE).flat();

type SensitiveRule = { name: string; method?: string; path?: RegExp; reason?: RegExp };

/** Buckets whose every route is security-sensitive: external auth and App grants. */
const NEVER_BUCKETS: readonly RouteAuthorityBucket[] = ["integrationLane"];

/**
 * Keyword rules (RFC 085 §3.1, §5): a route one catches, by its path or its row's reason, must be `never` whether the
 * list above names it or not, so a new route of one of these kinds is held before anyone has to remember it. Paths are
 * matched with every `:param` blanked to `:` (a param's name, like `:token`, is no keyword). Narrow where the RFC
 * plans a card: a role is a server role (PATCH .../members/:targetType/:memberId/role also demotes a channel member,
 * §7, and PATCH /api/agents/:id carries model and reasoning, §5; their cards' body schemas hold the rest), and joint
 * invites are caught on the sending side only (accepting one is a §5 card). RFC085_FIRST_BATCH keeps them that narrow.
 */
const SECURITY_SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    name: "credentials and keys",
    path: /credential|secret|token|(^|[/-])keys?($|[/-])|\/runtime-auth\/|scope-attestation/i,
    reason: /\b(credentials?|secrets?|issueAgentCredentials|rotateMachineKeys|rotateServerSecrets|(machine|Computer|API) keys?)\b/i,
  },
  { name: "payment and seat charges", path: /^\/api\/billing\/|seat|^\/api\/appsumo\/|limit-reset/i, reason: /\b(billing|seats?|manageBilling)\b/i },
  {
    name: "sign-in, two-step and devices",
    path: /^\/api\/auth\/(?!me(\/|$))|^\/api\/push\/|retire-session|app-logins/i,
    reason: /\b(two-step|second factor|passkeys?|device (registration|session))\b/i,
  },
  { name: "account deletion", path: /account[/-]deletion/i },
  { name: "SSO", path: /\/sso(\/|$)/i, reason: /\b(SSO|SAML|manageSso)\b/ },
  {
    name: "OAuth and MCP grants",
    path: /\/oauth(\/|$)|(^|[/-])grants?($|[/-])|consent|^\/api\/integration|^\/api\/mcp\/agents\/|^\/api\/mcp\/apps\/:\/(connections|default)|^\/api\/agents\/:\/connections/i,
    reason: /\b(OAuth|grants?|consents?|manageExternalAuth)\b/,
  },
  { name: "server roles and agent scopes", path: /(^|[/-])scopes?($|[/-])/i, reason: /\b(role transition|changeMemberRoles|transitionMemberRole|agent scopes?)\b/ },
  {
    name: "making content public on the internet",
    path: /public|visitor/i,
    reason: /\b(visitors?|visitorVisible|manageVisitorAccess|link sharing|signed-out|(made|make it|making) public)\b/i,
  },
  {
    name: "channel content outside the server",
    path: /^\/api\/channels\/:\/(external-|joint-|convert-to-joint|connect-my-servers)|^\/api\/slack-bridge\/(oauth|provisioning\/(connect|enable|channel-pairs))/i,
    reason: /\bfederateChannels\b/,
  },
  { name: "deleting a channel or server", method: "DELETE", path: /^\/api\/(servers|channels)\/:$/, reason: /\bdeleteChannels\b/ },
  // Data export (#triage:#512): copying a person's or a server's data out of Raft; a person's own web sign-in only.
  { name: "data export", path: /(^|\/)data-exports(\/|$)/i, reason: /\bexportServerData\b/ },
];

/**
 * RFC 085 §5 and §7's planned cards: neither the rules nor the list may hold one, or they are broader than the RFC
 * (if the RFC changes, change this in the same review). Open is not delegable: each stays `never` until its card lands.
 */
const RFC085_FIRST_BATCH: readonly string[] = [
  "POST /api/agents/:id/start",
  "POST /api/agents/:id/stop",
  "POST /api/agents/:id/reset",
  "PATCH /api/agents/:id",
  "POST /api/agents/:id/migrate",
  "POST /api/servers/:id/machines/:machineId/computer/:action",
  "POST /api/servers/:id/invites",
  "DELETE /api/servers/:id/members/:memberId",
  "DELETE /api/channels/:id/members/user/:memberId",
  "DELETE /api/channels/:id/members/agent/:memberId",
  "PATCH /api/channels/:id/members/:targetType/:memberId/role",
  "POST /api/channels/:id/archive",
  "POST /api/channels/joint-invites/:inviteId/accept",
  "DELETE /api/channels/threads/:threadChannelId/followers/agents/:agentId",
];

/** The rules (and never-bucket) that catch a row, by name. */
function sensitiveRulesOf(row: RouteClassification): string[] {
  const space = row.route.indexOf(" ");
  const method = row.route.slice(0, space);
  const path = row.route.slice(space + 1).replace(/:[A-Za-z]\w*/g, ":");
  return [
    ...(NEVER_BUCKETS.includes(row.bucket) ? [`bucket ${row.bucket}`] : []),
    ...SECURITY_SENSITIVE_RULES
      .filter((rule) => (!rule.method || rule.method === method) && ((rule.path?.test(path) ?? false) || (rule.reason?.test(row.reason) ?? false)))
      .map((rule) => rule.name),
  ];
}

/**
 * Body keys no card may admit, whatever the route (Warden, #14720): a server
 * role, an agent's environment (it carries secrets), credentials and grants.
 */
const SENSITIVE_CARD_BODY_KEYS = [
  "serverRole", "envVars", "password", "currentPassword", "newPassword", "token", "secret", "apiKey", "credentials", "scopes",
] as const;

/**
 * A path param schema that only takes what preparedRequestParamAllowed lets into a path: a uuid (z.uuid(),
 * z.string().uuid()), or a z.enum of lower-case words (`:action`'s actions). Any other string, even one held
 * to `^[A-Za-z0-9_-]+$`, would let a word such as `me` stand in an id's place (Tenny 296b02bc).
 */
function isIdParamSchema(schema: unknown): boolean {
  if (preparedRequestParamWords(schema)) return true;
  // A string schema (z.string().uuid(), and z.uuid(), whose class is a string format's rather than ZodString), nothing wrapping it.
  if (!(schema instanceof z.ZodType) || (schema.def as { type?: string }).type !== "string") return false;
  const def = schema.def as { format?: string; checks?: Array<{ _zod: { def: { format?: string } } }> };
  if (def.format === "uuid" || def.format === "guid") return true;
  return (def.checks ?? []).some((check) => check._zod.def.format === "uuid" || check._zod.def.format === "guid");
}

/** A zod object that refuses unknown keys (z.strictObject / .strict()): its catchall is `never`. */
function isStrictObject(schema: unknown): schema is z.ZodObject {
  return schema instanceof z.ZodObject && (schema.def.catchall as { def?: { type?: string } } | undefined)?.def?.type === "never";
}

/**
 * What a `card` entry lacks of what RFC 085 §4.1 requires (and Tenny's and Warden's additions on #14720), and of what
 * the request card needs to prepare and show it (§4.2, §4.3): its agent-facing operation, and a template behind its id.
 */
function cardProblems(route: string, card: Partial<DelegableCardRoute>, templates: Readonly<Record<string, DelegableSummaryTemplate>>): string[] {
  const problems: string[] = [];
  if (typeof card.summaryTemplate !== "string" || card.summaryTemplate.trim() === "") problems.push("no summary template");
  else if (!Object.hasOwn(templates, card.summaryTemplate)) problems.push(`summary template ${card.summaryTemplate} has no implementation`);
  const operation: Partial<DelegableOperation> | undefined = card.operation;
  if (!operation || typeof operation.name !== "string" || !PREPARED_REQUEST_OPERATION_PATTERN.test(operation.name)) problems.push("no operation name");
  if (!operation || !isStrictObject(operation.argsSchema)) problems.push("operation args schema not a strict object");
  if (!operation || typeof operation.resolve !== "function") problems.push("operation does not resolve its args");
  // What `raft action prepare --list` tells agents (RFC 085 §4.2 discovery): every arg described, an example that fits.
  const doc = operation?.doc;
  if (!doc || !doc.summary?.trim() || !doc.confirmer?.trim() || !doc.args || !doc.example) problems.push("operation has no agent-facing doc");
  else if (operation && isStrictObject(operation.argsSchema)) {
    const argNames = Object.keys(operation.argsSchema.shape).sort();
    if (JSON.stringify(Object.keys(doc.args).sort()) !== JSON.stringify(argNames)) problems.push(`operation doc describes ${Object.keys(doc.args).sort().join(",") || "nothing"}, args are ${argNames.join(",") || "nothing"}`);
    if (!operation.argsSchema.safeParse(doc.example).success) problems.push("operation doc example does not fit its args");
  }
  if (!isStrictObject(card.paramsSchema)) problems.push("params schema not a strict object");
  else {
    const named = [...route.matchAll(/:([A-Za-z]\w*)/g)].map((match) => match[1]).sort();
    const bound = Object.keys(card.paramsSchema.shape).sort();
    if (JSON.stringify(named) !== JSON.stringify(bound)) problems.push(`params schema binds ${bound.join(",") || "nothing"}, route names ${named.join(",") || "nothing"}`);
    const loose = bound.filter((name) => !isIdParamSchema((card.paramsSchema!.shape as Record<string, unknown>)[name]));
    if (loose.length > 0) problems.push(`params ${loose.join(",")} not held to ids (a uuid, or an enum of lower-case words)`);
  }
  const body = card.bodySchema;
  if (!isStrictObject(body)) problems.push("body schema not a strict object");
  else {
    // The listed keys, and any key the runtime body backstop refuses (visitorVisible, snake_case spellings, ...).
    const sensitive = [...new Set([
      ...SENSITIVE_CARD_BODY_KEYS.filter((key) => Object.hasOwn(body.shape, key)),
      ...Object.keys(body.shape).filter((key) => delegableBodyBackstopKey({ [key]: true }) !== null),
    ])];
    if (sensitive.length > 0) problems.push(`body schema admits ${sensitive.join(",")}`);
  }
  if (!SERVER_CAPABILITY_KEYS.includes(card.permission as ServerCapability)) problems.push("no permission");
  return problems;
}

type DelegabilityInput = {
  table: readonly RouteClassification[];
  ownerActionWrites: readonly string[];
  cardRoutes: Readonly<Record<string, DelegableCardRoute>>;
  /** The summary templates the card entries name (services/delegableSummaryTemplates.ts). */
  templates: Readonly<Record<string, DelegableSummaryTemplate>>;
  neverDelegable: readonly string[];
};

function checkRouteDelegability({ table, ownerActionWrites, cardRoutes, templates, neverDelegable }: DelegabilityInput) {
  const operationNames = Object.values(cardRoutes).map((card) => card.operation?.name).filter((name): name is string => typeof name === "string");
  const rows = new Map(table.map((row) => [row.route, row]));
  const human = table.filter((row) => row.bucket !== "nonHuman");
  const isNever = (row: RouteClassification) => (row.delegable ?? "never") === "never";
  const declaredBuckets = Object.keys(DELEGABLE_NEVER_ROWS);
  const marked = (value: RouteDelegable) => human.filter((row) => row.delegable === value).map((row) => row.route).sort();
  return {
    undeclared: human.filter((row) => row.delegable === undefined && !declaredBuckets.includes(row.bucket)).map((row) => row.route),
    onNonHuman: table.filter((row) => row.bucket === "nonHuman" && row.delegable !== undefined).map((row) => row.route),
    neverRows: Object.fromEntries(declaredBuckets.map((bucket) => [bucket, human.filter((row) => row.bucket === bucket && isNever(row)).length])),
    assistantRows: marked("assistant"),
    ownerActionWrites: [...new Set(ownerActionWrites)].sort(),
    cardRows: marked("card"),
    cardEntries: Object.keys(cardRoutes).sort(),
    incompleteCards: Object.entries(cardRoutes).flatMap(([route, card]) => cardProblems(route, card, templates).map((problem) => `${route}: ${problem}`)),
    duplicateOperations: operationNames.filter((name, index) => operationNames.indexOf(name) !== index),
    neverListDuplicates: neverDelegable.filter((route, index) => neverDelegable.indexOf(route) !== index),
    neverListUnclassified: neverDelegable.filter((route) => !rows.has(route)),
    neverListDelegable: neverDelegable.filter((route) => rows.has(route) && !isNever(rows.get(route)!)),
    sensitiveDelegable: table.filter((row) => !isNever(row)).flatMap((row) => sensitiveRulesOf(row).map((rule) => `${row.route} (${rule})`)),
  };
}

async function currentDelegability(): Promise<DelegabilityInput> {
  // Imported in the test, after the capture is installed (like ../app): its import graph is the server's.
  const { ASSISTANT_OWNER_ACTIONS } = await import("../services/assistantOwnerActions");
  return {
    table: ROUTE_AUTHORITY_CLASSIFICATION,
    // The table's reads (GET) are outside this write classification; its writes are what `assistant` means.
    ownerActionWrites: ASSISTANT_OWNER_ACTIONS.filter((action) => action.method !== "GET").map((action) => `${action.method} ${action.path}`),
    cardRoutes: DELEGABLE_CARD_ROUTES,
    templates: DELEGABLE_SUMMARY_TEMPLATES,
    neverDelegable: NEVER_DELEGABLE_ROUTES,
  };
}

test("RFC 085 delegable: declared for every human-session route; assistant is the owner-action table; card pinned and complete; security-sensitive routes never", async () => {
  const result = checkRouteDelegability(await currentDelegability());
  assert.deepEqual(result.undeclared, [], "human-session routes in a bucket with no DELEGABLE_NEVER_ROWS declaration and no delegable of their own");
  assert.deepEqual(result.onNonHuman, [], "a nonHuman route has no person to act for: no delegable");
  assert.deepEqual(
    result.neverRows,
    DELEGABLE_NEVER_ROWS,
    "a human-session route was added, removed or changed delegable: decide whether it is delegable (RFC 085 §4.1), then update DELEGABLE_NEVER_ROWS",
  );
  assert.deepEqual(result.assistantRows, result.ownerActionWrites, "`assistant` rows must be exactly the writes of the owner-action table (services/assistantOwnerActions.ts)");
  assert.deepEqual(result.cardEntries, [...PINNED_CARD_ROUTES].sort(), "the card list (services/delegableCardRoutes.ts) changed: update PINNED_CARD_ROUTES with Warden's review");
  assert.deepEqual(result.cardRows, result.cardEntries, "`card` rows and card list entries must be the same routes");
  assert.deepEqual(result.incompleteCards, [], "a card route needs a summary template (with its implementation), a body schema, the permission it needs and its operation");
  assert.deepEqual(result.duplicateOperations, [], "two card routes declare the same operation name");
  assert.deepEqual(result.neverListDuplicates, [], "never-delegable routes listed twice");
  assert.deepEqual(result.neverListUnclassified, [], "never-delegable routes that are no longer classified (renamed or removed): update the list");
  assert.deepEqual(result.neverListDelegable, [], "never-delegable routes that are not `never`");
  assert.deepEqual(result.sensitiveDelegable, [], "security-sensitive routes (keyword or bucket rule) that are not `never`");

  const rows = new Map(ROUTE_AUTHORITY_CLASSIFICATION.map((row) => [row.route, row]));
  const held = RFC085_FIRST_BATCH.flatMap((route) => {
    const row = rows.get(route);
    if (!row) return [`${route} (not classified)`];
    return [...(NEVER_DELEGABLE_ROUTES.includes(route) ? ["never-delegable list"] : []), ...sensitiveRulesOf(row)].map((why) => `${route} (${why})`);
  });
  assert.deepEqual(held, [], "RFC 085's planned cards must stay open: a rule or list entry holding one is broader than the RFC");
});

test("RFC 085 Phase 1 entries: lowering a channel role takes role member and nothing else; start and stop take no body; every param an id", () => {
  const role = DELEGABLE_CARD_ROUTES["PATCH /api/channels/:id/members/:targetType/:memberId/role"]!;
  assert.equal(role.operation.name, "channel:remove_admin");
  assert.ok(role.bodySchema.safeParse({ role: "member" }).success);
  // The same route promotes: every other role, a missing one and any other key are refused by the entry itself.
  for (const body of [{ role: "admin" }, { role: "owner" }, { role: "guest" }, { role: "Member" }, {}, { role: "member", serverRole: "member" }, { role: ["member"] }]) {
    assert.equal(role.bodySchema.safeParse(body).success, false, JSON.stringify(body));
  }
  const id = "00000000-0000-4000-8000-000000000001";
  assert.ok(role.paramsSchema.safeParse({ id, targetType: "user", memberId: id }).success);
  for (const params of [{ id: "me", targetType: "user", memberId: id }, { id, targetType: "server", memberId: id }, { id, targetType: "user", memberId: "a" }]) {
    assert.equal(role.paramsSchema.safeParse(params).success, false, JSON.stringify(params));
  }
  for (const route of ["POST /api/agents/:id/start", "POST /api/agents/:id/stop"] as const) {
    const entry = DELEGABLE_CARD_ROUTES[route]!;
    assert.ok(entry.bodySchema.safeParse({}).success, route);
    assert.equal(entry.bodySchema.safeParse({ reason: "x" }).success, false, route);
    assert.equal(entry.paramsSchema.safeParse({ id: "me" }).success, false, route);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(DELEGABLE_CARD_ROUTES).map(([route, entry]) => [route, [entry.operation.name, entry.permission, entry.summaryTemplate]])), {
    "POST /api/agents/:id/start": ["agent:start", "controlAgentRuntime", "agent.start"],
    "POST /api/agents/:id/stop": ["agent:stop", "stopAgents", "agent.stop"],
    "PATCH /api/channels/:id/members/:targetType/:memberId/role": ["channel:remove_admin", "changeChannelMemberRoles", "channel.admin.remove"],
  });
});

test("RFC 085 delegable reverse controls:a listed or rule-caught route made delegable, an undecided route, stray markings, an incomplete card and a stale list entry all turn red", async () => {
  const input = await currentDelegability();
  const check = (overrides: Partial<DelegabilityInput>) => checkRouteDelegability({ ...input, ...overrides });
  const flip = (route: string, delegable: RouteDelegable) => {
    assert.ok(input.table.some((row) => row.route === route), `${route} is classified`);
    return input.table.map((row) => (row.route === route ? { ...row, delegable } : row));
  };

  // A listed route made `card`: refused by name and by its rule, and it has no card entry.
  const checkout = check({ table: flip("POST /api/billing/checkout", "card") });
  assert.deepEqual(checkout.neverListDelegable, ["POST /api/billing/checkout"]);
  assert.deepEqual(checkout.sensitiveDelegable, ["POST /api/billing/checkout (payment and seat charges)"]);
  assert.notDeepEqual(checkout.cardRows, checkout.cardEntries);
  // A route only a rule holds (the list does not name it) made `assistant`: the rule refuses it, and it is not an owner action.
  const seatRequest = check({ table: flip("POST /api/actions/seat-requests", "assistant") });
  assert.deepEqual(seatRequest.neverListDelegable, []);
  assert.deepEqual(seatRequest.sensitiveDelegable, ["POST /api/actions/seat-requests (payment and seat charges)"]);
  assert.notDeepEqual(seatRequest.assistantRows, seatRequest.ownerActionWrites);
  // A never-bucket route (not listed, no keyword) made `card`.
  assert.deepEqual(
    check({ table: flip("POST /api/integrations/clients/:clientId/prompt-text/review", "card") }).sensitiveDelegable,
    ["POST /api/integrations/clients/:clientId/prompt-text/review (bucket integrationLane)", "POST /api/integrations/clients/:clientId/prompt-text/review (OAuth and MCP grants)"],
  );
  // A listed route no rule catches (PATCH /api/channels/:id's visitorVisible) is held by the list alone.
  const channelPatch = check({ table: flip("PATCH /api/channels/:id", "card") });
  assert.deepEqual(channelPatch.neverListDelegable, ["PATCH /api/channels/:id"]);
  assert.deepEqual(channelPatch.sensitiveDelegable, []);

  // A new human-session route nobody decided: its bucket's `never` count moves.
  const undecided = check({ table: [...input.table, { route: "POST /api/agents/:id/undecided-probe", bucket: "cat3", reason: "control" }] });
  assert.notDeepEqual(undecided.neverRows, DELEGABLE_NEVER_ROWS);
  assert.equal(undecided.neverRows.cat3, DELEGABLE_NEVER_ROWS.cat3 + 1);
  // An owner action whose row is no longer `assistant`, and a `delegable` on a nonHuman row.
  const unmarked = check({ table: flip("PUT /api/notification-levels", "never") });
  assert.notDeepEqual(unmarked.assistantRows, unmarked.ownerActionWrites);
  assert.deepEqual(check({ table: flip("POST /internal/agent-api/send", "card") }).onNonHuman, ["POST /internal/agent-api/send"]);

  // A card entry without its template, schema, permission or operation, and with no `card` row; then a complete one.
  const incomplete = check({ cardRoutes: { "POST /api/agents/:id/start": { summaryTemplate: " ", permission: "startAnything" } as unknown as DelegableCardRoute } });
  assert.deepEqual(incomplete.incompleteCards, [
    "POST /api/agents/:id/start: no summary template",
    "POST /api/agents/:id/start: no operation name",
    "POST /api/agents/:id/start: operation args schema not a strict object",
    "POST /api/agents/:id/start: operation does not resolve its args",
    "POST /api/agents/:id/start: operation has no agent-facing doc",
    "POST /api/agents/:id/start: params schema not a strict object",
    "POST /api/agents/:id/start: body schema not a strict object",
    "POST /api/agents/:id/start: no permission",
  ]);
  // The operation an agent names (RFC 085 §4.2), and the template behind the entry's id (§4.3).
  const stubTemplate = { display: { title: "actionCard.field.agent", verb: "actionCard.field.agent", fields: [] }, model: async () => ({ ok: true, model: {} }), names: async () => ({}) } as DelegableSummaryTemplate;
  const doc = { summary: "Start an agent.", args: { agent: "its handle" }, confirmer: "a member", example: { agent: "@builder" } };
  const operation = (name: string): DelegableOperation => ({ name, argsSchema: z.strictObject({ agent: z.string() }), resolve: async () => ({ ok: true, params: {}, body: {} }), doc });
  const templates = { "agent.config": stubTemplate, "agent.start": stubTemplate };
  const noTemplate = check({ cardRoutes: { "POST /api/agents/:id/start": {
    summaryTemplate: "agent.missing", paramsSchema: z.strictObject({ id: z.uuid() }), bodySchema: z.strictObject({}), permission: "controlAgentRuntime",
    operation: { name: "Agent Start", argsSchema: z.object({ agent: z.string() }), resolve: async () => ({ ok: true, params: {}, body: {} }), doc },
  } }, templates });
  assert.deepEqual(noTemplate.incompleteCards, [
    "POST /api/agents/:id/start: summary template agent.missing has no implementation",
    "POST /api/agents/:id/start: no operation name",
    "POST /api/agents/:id/start: operation args schema not a strict object",
  ]);
  // What `raft action prepare --list` says of it (RFC 085 §4.2 discovery): every arg described, and an example that fits.
  const docOf = (next: Partial<DelegableOperation["doc"]> | undefined) => check({ cardRoutes: { "POST /api/agents/:id/start": {
    summaryTemplate: "agent.start", paramsSchema: z.strictObject({ id: z.uuid() }), bodySchema: z.strictObject({}), permission: "controlAgentRuntime",
    operation: { ...operation("agent:start"), doc: next as DelegableOperation["doc"] },
  } }, templates }).incompleteCards;
  assert.deepEqual(docOf(undefined), ["POST /api/agents/:id/start: operation has no agent-facing doc"]);
  assert.deepEqual(docOf({ ...doc, summary: " " }), ["POST /api/agents/:id/start: operation has no agent-facing doc"]);
  assert.deepEqual(docOf({ ...doc, args: { agent: "its handle", why: "a reason" } }), ["POST /api/agents/:id/start: operation doc describes agent,why, args are agent"]);
  assert.deepEqual(docOf({ ...doc, example: { agent: "@builder", extra: "x" } }), ["POST /api/agents/:id/start: operation doc example does not fit its args"]);
  assert.deepEqual(docOf(doc), []);
  const twice = check({ cardRoutes: {
    "POST /api/agents/:id/start": { summaryTemplate: "agent.start", paramsSchema: z.strictObject({ id: z.uuid() }), bodySchema: z.strictObject({}), permission: "controlAgentRuntime", operation: operation("agent:start") },
    "POST /api/agents/:id/stop": { summaryTemplate: "agent.start", paramsSchema: z.strictObject({ id: z.uuid() }), bodySchema: z.strictObject({}), permission: "stopAgents", operation: operation("agent:start") },
  }, templates });
  assert.deepEqual(twice.duplicateOperations, ["agent:start"]);
  // A body that strips unknown keys instead of refusing them, a sensitive key, and params that don't match the route.
  const loose = check({ cardRoutes: { "PATCH /api/agents/:id": {
    summaryTemplate: "agent.config", paramsSchema: z.strictObject({ agentId: z.string() }),
    bodySchema: z.object({ model: z.string() }), permission: "controlAgentRuntime", operation: operation("agent:configure"),
  } }, templates });
  assert.deepEqual(loose.incompleteCards, [
    "PATCH /api/agents/:id: params schema binds agentId, route names id",
    "PATCH /api/agents/:id: params agentId not held to ids (a uuid, or an enum of lower-case words)",
    "PATCH /api/agents/:id: body schema not a strict object",
  ]);
  // Path params are a uuid, or an enum of lower-case words (`:action`); never a bare string, a word pattern (`me` in an
  // id's place), or a looser one (`..`, `.`, `/`).
  const params = (id: z.ZodType) => check({ cardRoutes: { "POST /api/agents/:id/start": {
    summaryTemplate: "agent.start", paramsSchema: z.strictObject({ id }), bodySchema: z.strictObject({}), permission: "controlAgentRuntime", operation: operation("agent:start"),
  } }, templates }).incompleteCards;
  for (const held of [z.uuid(), z.string().uuid(), z.enum(["approve", "deny"])]) assert.deepEqual(params(held), []);
  for (const loose of [
    z.string(), z.string().regex(/^.+$/), z.string().regex(/^[A-Za-z0-9_.-]+$/), z.string().regex(/^[A-Za-z0-9_-]+$/),
    z.uuid().optional(), z.number(), z.enum(["Approve", "../x"]),
  ]) {
    assert.deepEqual(params(loose), ["POST /api/agents/:id/start: params id not held to ids (a uuid, or an enum of lower-case words)"]);
  }
  const sensitive = check({ cardRoutes: { "PATCH /api/agents/:id": {
    summaryTemplate: "agent.config", paramsSchema: z.strictObject({ id: z.uuid() }),
    bodySchema: z.strictObject({ model: z.string(), serverRole: z.literal("member"), envVars: z.record(z.string(), z.string()) }), permission: "controlAgentRuntime",
    operation: operation("agent:configure"),
  } }, templates });
  assert.deepEqual(sensitive.incompleteCards, ["PATCH /api/agents/:id: body schema admits serverRole,envVars"]);
  assert.notDeepEqual(incomplete.cardEntries, [...PINNED_CARD_ROUTES]);
  assert.notDeepEqual(incomplete.cardRows, incomplete.cardEntries);
  // A complete next entry beside the listed ones (a planned card, RFC 085 §5): its row `card`, its entry whole.
  const complete = check({
    table: flip("POST /api/agents/:id/reset", "card"),
    cardRoutes: { ...input.cardRoutes, "POST /api/agents/:id/reset": { summaryTemplate: "agent.start", paramsSchema: z.strictObject({ id: z.uuid() }), bodySchema: z.object({}).strict(), permission: "resetAgentWorkspace", operation: operation("agent:reset") } },
    templates: { ...input.templates, ...templates },
  });
  assert.deepEqual([complete.incompleteCards, complete.sensitiveDelegable, complete.duplicateOperations], [[], [], []]);
  assert.deepEqual(complete.cardRows, complete.cardEntries);
  // A listed entry whose row lost its `card` marking.
  const unmarkedCard = check({ table: flip("POST /api/agents/:id/stop", "never") });
  assert.notDeepEqual(unmarkedCard.cardRows, unmarkedCard.cardEntries);

  // A list entry whose route was renamed away, and one listed twice.
  const stale = check({ neverDelegable: [...input.neverDelegable, "POST /api/billing/no-such-route", "POST /api/billing/checkout"] });
  assert.deepEqual(stale.neverListUnclassified, ["POST /api/billing/no-such-route"]);
  assert.deepEqual(stale.neverListDuplicates, ["POST /api/billing/checkout"]);
});

test("RFC 085 runtime backstop: every route the never-delegable list names, in all its classes, is refused by the product's own check, and no planned card is", () => {
  // The one never-delegable route the backstop can't hold: it sees routes, not bodies, and this one is never
  // delegable for a body field (visitorVisible). The list holds it (services/delegableRouteBackstop.ts says so).
  const LIST_ONLY: Readonly<Record<string, string>> = { "PATCH /api/channels/:id": "never for its visitorVisible field; the backstop sees no body" };
  assert.equal(Object.keys(NEVER_DELEGABLE).length, 10, "the classes this assertion covers: all of them");
  for (const route of Object.keys(LIST_ONLY)) assert.ok(NEVER_DELEGABLE_ROUTES.includes(route), `${route} is still on the list`);
  const missed = Object.entries(NEVER_DELEGABLE).flatMap(([name, routes]) => routes
    .filter((route) => !Object.hasOwn(LIST_ONLY, route) && !delegableRouteBackstopRule(route))
    .map((route) => `${name}: ${route}`));
  assert.deepEqual(missed, [], "never-delegable routes services/delegableRouteBackstop.ts lets through");
  // Every classified route (any bucket, any mount: /oidc/:server/api/oauth/... too) that the sensitive rules catch
  // by its path, or that sits in a never bucket, is caught as well: the same word rules, in product code.
  const pathRulesOf = (row: RouteClassification) => {
    const space = row.route.indexOf(" ");
    const method = row.route.slice(0, space);
    const path = row.route.slice(space + 1).replace(/:[A-Za-z]\w*/g, ":");
    return SECURITY_SENSITIVE_RULES.filter((rule) => (!rule.method || rule.method === method) && (rule.path?.test(path) ?? false)).map((rule) => rule.name);
  };
  const lettedThrough = ROUTE_AUTHORITY_CLASSIFICATION
    .filter((row) => !Object.hasOwn(LIST_ONLY, row.route) && (pathRulesOf(row).length > 0 || NEVER_BUCKETS.includes(row.bucket)))
    .filter((row) => !delegableRouteBackstopRule(row.route))
    .map((row) => `${row.route} (${[...pathRulesOf(row), ...(NEVER_BUCKETS.includes(row.bucket) ? [`bucket ${row.bucket}`] : [])].join(", ")})`);
  assert.deepEqual(lettedThrough, [], "classified routes the sensitive rules or a never bucket hold, which the backstop lets through");
  for (const route of ["POST /oidc/:server/api/oauth/installation-token", "POST /oidc/:server/api/oauth/installations/:installationId/bot-token"]) {
    if (ROUTE_AUTHORITY_CLASSIFICATION.some((row) => row.route === route)) assert.ok(delegableRouteBackstopRule(route), route);
  }
  assert.deepEqual(RFC085_FIRST_BATCH.filter((route) => delegableRouteBackstopRule(route)), [], "RFC 085's planned cards the backstop would refuse");
  // The planned cards that sit next to refused routes stay open: lowering a channel member's role (not a server
  // member's), accepting a joint invite (not sending one), removing a member (not changing their role).
  for (const route of [
    "PATCH /api/channels/:id/members/:targetType/:memberId/role",
    "POST /api/channels/joint-invites/:inviteId/accept",
    "DELETE /api/servers/:id/members/:memberId",
    "POST /api/channels/:id/archive",
  ]) assert.equal(delegableRouteBackstopRule(route), null, route);
  // The rule-caught routes the list doesn't name, too.
  assert.ok(delegableRouteBackstopRule("POST /api/actions/seat-requests"));
  assert.ok(delegableRouteBackstopRule("POST /api/actions/:messageId/execute"));
});
