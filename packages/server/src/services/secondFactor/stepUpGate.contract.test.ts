import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installRouteRegistrationCapture, type RegisteredMutatingRoute } from "../../test/routeRegistrationCapture";
import { STEP_UP_ACTIONS, type StepUpAction } from "./stepUpGate";

// Every route gated by step-up for a sensitive action (design v8 §3, PR 5).
// Forward: the gate calls in the source are exactly GATED_ROUTES (by file and
// action). Reverse: every registered route that looks like it can start a
// sign-in-method link, change a password, or mint an agent, machine or
// Computer credential, or that touches the account's email, approves a sign-in
// or an app's access, installs an app, executes an action card, or issues a
// token or secret (SENSITIVE_ROUTE_PATTERNS) is in GATED_ROUTES, in
// APPROVAL_GATED_ROUTES (the approver's second step, refuseUnverifiedApprover),
// in GATED_BY_CARD_KIND (each card kind's own declaration) or in EXEMPTIONS
// with a reason; an unknown one fails. Each gated route has its behaviour (enforced and not) in
// routes/secondFactorStepUp.api.test.ts.
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Mount every env-gated surface so gated routes are enumerated rather than silently absent
// (as routeAuthorityClassification.structure.test.ts).
process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
const capture = installRouteRegistrationCapture();
afterAll(() => capture.restore());

/** Route ("METHOD /path" as registered) -> where its gate is called and for what. */
const GATED_ROUTES: Record<string, { file: string; action: StepUpAction }> = {
  "PATCH /api/auth/me": { file: "routes/auth.ts", action: "password_change" },
  "DELETE /api/auth/identities/:provider": { file: "routes/auth.ts", action: "identity_unlink" },
  "POST /api/auth/:provider/link/start": { file: "routes/auth.ts", action: "identity_link" },
  "POST /api/auth/mobile/oauth/:provider/link/start": { file: "routes/auth.ts", action: "identity_link" },
  // `mode: "link"` with an optional bearer (startMobileOAuthResponse).
  "POST /api/auth/mobile/oauth/start": { file: "routes/auth.ts", action: "identity_link" },
  // iOS native Apple, `mode: "link"` with an optional bearer.
  "POST /api/auth/mobile/oauth/apple/native/start": { file: "routes/auth.ts", action: "identity_link" },
  // Web sessions; not a device login's.
  "POST /api/agents/:id/credentials": { file: "routes/agentCredentials.ts", action: "agent_credential_mint" },
  "POST /api/agents/:id/bootstrap-tokens": { file: "routes/agents.ts", action: "agent_bootstrap_token" },
  // Web sessions; not a device login's, nor a device-login grant's attach token.
  "POST /api/computer/attach": { file: "routes/computerAttach.ts", action: "computer_attach" },
  "POST /api/computer/adopt-legacy": { file: "routes/computerAdopt.ts", action: "computer_adopt" },
  "POST /api/servers/:id/machines": { file: "routes/servers.ts", action: "machine_key_register" },
  "POST /api/servers/:id/machines/:machineId/rotate-key": { file: "routes/servers.ts", action: "machine_key_rotate" },
  // Answers with the new app's first client secret.
  "POST /api/integrations/clients": { file: "routes/integrations.ts", action: "integration_app_register" },
  "POST /api/integrations/clients/:clientId/regenerate-secret": { file: "routes/integrations.ts", action: "integration_client_secret_regenerate" },
  "POST /api/integrations/clients/:clientId/app-notifications/webhook/rotate-secret": { file: "routes/integrations.ts", action: "integration_webhook_secret_rotate" },
};

/**
 * Approvals of a sign-in elsewhere or of an app's access, gated by the approver's own verified second
 * step (refuseUnverifiedApprover -> approverSecondFactorCheck), not by step-up.
 * `handler` is the registration as written in `file`.
 */
const APPROVAL_GATED_ROUTES: Record<string, { file: string; handler: string }> = {
  "POST /api/auth/app-login/requests/:id/approve": { file: "routes/appLogin.ts", handler: 'appLoginRouter.post("/requests/:id/approve"' },
  // `approve: false` (a refusal) skips the check.
  "POST /api/auth/device/approve": { file: "routes/deviceAuth.ts", handler: 'deviceAuthRouter.post("/approve"' },
  // Login with Raft consent: issues an app a code for this person. One handler for both mounts;
  // the OIDC mount's guard answers 404 before it (oidcScopedMountGuard), still gated if served.
  "POST /api/oauth/authorize/human": { file: "routes/oauth.ts", handler: 'oauthRouter.post("/authorize/human"' },
  "POST /oidc/:server/api/oauth/authorize/human": { file: "routes/oauth.ts", handler: 'oauthRouter.post("/authorize/human"' },
  // RFC 079 phase 3a: the account-mode consent, a code naming no Server. Root only; the OIDC mount's guard answers 404.
  "POST /api/oauth/authorize/account": { file: "routes/oauth.ts", handler: 'oauthRouter.post("/authorize/account"' },
  "POST /oidc/:server/api/oauth/authorize/account": { file: "routes/oauth.ts", handler: 'oauthRouter.post("/authorize/account"' },
  "POST /api/integrations/requests/:requestId/approve": { file: "routes/integrations.ts", handler: 'integrationRouter.post("/requests/:requestId/approve"' },
  // Installing an app grants it access to the server: as the install card
  // (actionCardSecondFactor.ts integration:install_marketplace_app).
  "POST /api/integrations/marketplace/:clientId/install": { file: "routes/integrations.ts", handler: 'integrationRouter.post("/marketplace/:clientId/install"' },
  "POST /api/integration-invites/:token/install": { file: "routes/integrations.ts", handler: 'integrationInviteRouter.post("/:token/install"' },
  // An installed app's new scopes and data groups.
  "PUT /api/integrations/marketplace/:clientId/install/app-notifications/grant": { file: "routes/integrations.ts", handler: 'integrationRouter.put("/marketplace/:clientId/install/app-notifications/grant"' },
  // `action: "grant"` only; removing the bot skips the check.
  "POST /api/integrations/clients/:clientId/install/bot": { file: "routes/integrations.ts", handler: 'integrationRouter.post("/clients/:clientId/install/bot"' },
};

/**
 * Executing an action card: gated by the card's kind, each kind declaring
 * approver, step-up or none (services/actionCardSecondFactor.ts, checked once
 * in actionCardsService.executeActionCard); actionCardSecondFactor.contract.test.ts
 * checks every kind declares one and where the check runs.
 */
const GATED_BY_CARD_KIND: Record<string, string> = {
  "POST /api/actions/:messageId/execute": "services/actionCardSecondFactor.ts (actionCardSecondFactor.contract.test.ts)",
};

/**
 * What can start a sign-in-method link, change a password, or mint an agent,
 * machine or Computer credential, touch the account's email, approve a sign-in
 * or an app's access, or issue a token or secret, by registered path (mutating
 * methods only).
 */
const SENSITIVE_ROUTE_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  // Social sign-in legs (start, callback, complete: any can link), identities, pending links.
  { kind: "sign-in method", pattern: /^\w+ \/api\/auth\/(?:.*\/)?(?:oauth|:provider|identities)(?:\/|$)/ },
  { kind: "sign-in method", pattern: /^\w+ \/api\/auth\/.*link/ },
  { kind: "sign-in method", pattern: /^POST \/api\/auth\/.*passkeys\/registration\// },
  { kind: "password", pattern: /^\w+ \/api\/auth\/.*password/ },
  { kind: "password", pattern: /^PATCH \/api\/auth\/me$/ },
  { kind: "agent credential", pattern: /^\w+ \/(?:api|internal)\/.*\/(?:credentials|bootstrap-tokens)(?:\/|$)/ },
  { kind: "machine or Computer key", pattern: /^\w+ \/api\/servers\/:id\/machines$/ },
  { kind: "machine or Computer key", pattern: /(?:rotate-key|computer-key)$/ },
  { kind: "machine or Computer key", pattern: /^\w+ \/(?:api|internal)\/computer\/(?:attach|adopt)/ },
  // A future change-email, and what sends or redeems an account email today.
  { kind: "email", pattern: /^\w+ \/api\/(?:auth|me)\/.*(?:e-?mail|verification|recovery)/i },
  { kind: "approval", pattern: /^\w+ \/(?:api|internal|oidc)\/.*(?:approve|deny|reject|consent|authorize)/i },
  // Creating an app (an integration client): it comes with a client secret, though no path word says so.
  { kind: "app registration", pattern: /^POST \/(?:api|internal|oidc)\/(?:.*\/)?(?:clients|apps?)(?:\/register)?$/ },
  // Installing an app (or anything under an install), and what an action card does.
  { kind: "app install", pattern: /^\w+ \/(?:api|internal|oidc)\/(?:.*\/)?install(?:\/|$)/i },
  { kind: "action card", pattern: /^\w+ \/api\/actions\/:messageId\/(?:execute|mark-executed|reconfirm)$/ },
  // A path segment naming a token or secret (not a `:token` parameter), and the Login Token exchange.
  { kind: "token or secret", pattern: /^\w+ \/(?:api|internal|oidc)\/(?:.*\/)?[\w-]*(?:token|secret)[\w-]*(?:\/|$)/i },
  { kind: "token or secret", pattern: /^POST \/api\/agent\/login$/ },
];

/** Matching routes that need no step-up, and why. */
const EXEMPTIONS: Record<string, string> = {
  "POST /api/auth/:provider/callback": "provider redirect; a link is bound to its gated /:provider/link/start (signed state)",
  "POST /api/auth/:provider/complete": "link mode is bound to a gated start; login mode is a sign-in (its pending link waits for the second step)",
  "POST /api/auth/mobile/oauth/complete": "link mode is bound to a gated start's transaction and user; login mode is a sign-in",
  "POST /api/auth/mobile/oauth/:provider/link/complete": "bound to its gated link/start's transaction and user",
  "POST /api/auth/mobile/oauth/apple/native/authorize": "bound to the gated native start (signed request token, stored mode and user)",
  "POST /api/auth/second-factor/passkeys/registration/options": "issues a challenge; adds nothing",
  "POST /api/auth/second-factor/passkeys/registration/verify": "adding a passkey is gated inline (passkeyManagement.ts: recent sign-in when off, step-up when on)",
  "POST /api/auth/pending-link/cancel": "cancels a pending link; links nothing",
  "POST /api/auth/forgot-password": "unauthenticated; only emails a reset link",
  "POST /api/auth/reset-password": "unauthenticated reset by the emailed token; signs out every sign-in, the second step is still asked at the next",
  "POST /api/auth/second-factor/reauth/password": "checks the current password; changes nothing",
  "DELETE /api/agents/:id/credentials/:credentialId": "revokes an agent key; mints nothing",
  "POST /internal/computer/runners/:agentId/credentials": "a Computer with its own key, for an agent on it (machine's own key)",
  "POST /internal/computer/runners/:agentId/credentials/renew": "a Computer with its own key renews a runner key it minted (machine's own key)",
  "DELETE /internal/computer/runners/:agentId/credentials/:credentialId": "a Computer with its own key revokes; mints nothing",
  "POST /internal/agent-api/credentials/self/revoke": "an agent key revokes itself (its own key, no person's session); mints nothing",
  "POST /api/provider-connections/:connectionId/credentials/rotate": "a model provider's API key the person supplies; not a Raft credential",
  "POST /api/servers/:id/machines/:machineId/revoke-computer-key": "revokes a Computer key; mints nothing",
  // Email.
  "POST /api/auth/verify-email": "unauthenticated; redeems the emailed verification token for the address already on the account",
  "POST /api/auth/resend-verification": "re-sends the verification email to the address already on the account; changes nothing",
  "POST /api/me/account/deletion/email-code": "emails a deletion code to the account's own address; deletion itself checks the code (accountDeletion.ts)",
  "POST /api/auth/second-factor/recovery": "unauthenticated; only emails a recovery link to the account's address, the same answer for every address",
  "POST /api/auth/second-factor/recovery/confirm": "unauthenticated by the emailed token; starts the 72-hour delayed, notified reset (recovery.ts), the designed path for a lost second step",
  "POST /api/auth/second-factor/recovery/cancel": "cancels a pending reset by the emailed token; weakens nothing",
  "DELETE /api/auth/second-factor/recovery": "a signed-in cancel of a pending reset; weakens nothing",
  // Approvals.
  "POST /api/auth/app-login/requests/:id/deny": "refuses an app login; grants nothing",
  "POST /api/auth/device/authorize": "unauthenticated device-login start; issues only codes, the sign-in waits for the gated /device/approve",
  "POST /api/integrations/requests/:requestId/deny": "refuses an app's agent access request; grants nothing",
  "POST /api/server-connect-requests/:id/reject": "refuses a shared-channel connect request; grants nothing",
  "POST /api/server-connect-requests/:id/approve": "a Server admin connects a shared channel to another Server; no sign-in or credential",
  "POST /internal/artifacts-content/authorize": "the artifacts content service asks whether a viewer may read; grants nothing",
  "POST /api/integrations/clients/:clientId/link-preview-consent": "shares only the person's own Raft profile with an app installed here, for link previews; issues no credential",
  // App registration.
  "POST /api/mcp/apps": "adds an MCP server's definition to the Server's catalog; issues no Raft credential (a Connection's own credential is the person's, added separately)",
  // App installs and action cards.
  "DELETE /api/integrations/marketplace/:clientId/install": "uninstalls an app; revokes its access, grants nothing",
  "POST /api/actions/:messageId/mark-executed": "records a result the dialog's own route already produced (agent:create, channel:add_member, integration:connect_mcp); performs nothing, and refuses every kind that grants access (INLINE_EXECUTE_REQUIRED)",
  "POST /api/actions/:messageId/reconfirm": "re-confirms a card after a channel conversion; runs nothing, the execute after it is gated by kind",
  // Tokens and secrets.
  "POST /api/auth/device/token": "unauthenticated device-code poll; the session it issues was approved at the gated /device/approve",
  "POST /api/agent/login": "unauthenticated; redeems a Login Token minted by the gated /api/agents/:id/bootstrap-tokens",
  "POST /api/oauth/token": "an app's own client credentials exchange a code or grant; the person's consent is at /authorize/human",
  "POST /oidc/:server/api/oauth/token": "the OIDC mount of /api/oauth/token",
  "POST /api/oauth/installation-token": "an app's own client credentials mint its installation token; no person's session",
  "POST /oidc/:server/api/oauth/installation-token": "the OIDC mount of /api/oauth/installation-token",
  "POST /api/oauth/installations/:installationId/bot-token": "an app's own client credentials mint its Bot key under the admin's bot grant; no person's session",
  "POST /oidc/:server/api/oauth/installations/:installationId/bot-token": "the OIDC mount of /api/oauth/installations/:installationId/bot-token",
  "POST /internal/agent-api/integrations/token": "an agent's own key (sk_agent) gets an audience token; no person's session",
  "POST /internal/agent-api/integrations/app/rotate-secret": "an agent's own key (sk_agent) rotates an app secret it maintains; no person's session",
};

function sensitive(route: string): boolean {
  return SENSITIVE_ROUTE_PATTERNS.some(({ pattern }) => pattern.test(route));
}

/** Matching routes neither gated nor exempt, and listed routes that no longer match a registered one. */
function checkSensitiveRoutes(routes: RegisteredMutatingRoute[]): { unknown: string[]; stale: string[] } {
  const registered = new Set(routes.map((route) => `${route.method} ${route.path}`));
  const matching = [...registered].filter(sensitive).sort();
  const listed = [...Object.keys(GATED_ROUTES), ...Object.keys(APPROVAL_GATED_ROUTES), ...Object.keys(GATED_BY_CARD_KIND), ...Object.keys(EXEMPTIONS)];
  return {
    unknown: matching.filter((route) => !(route in GATED_ROUTES) && !(route in APPROVAL_GATED_ROUTES) && !(route in GATED_BY_CARD_KIND) && !(route in EXEMPTIONS)),
    stale: listed.filter((route) => !registered.has(route) || !sensitive(route)).sort(),
  };
}

function productionSources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    const file = entry.split("\\").join("/");
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts") || file.startsWith("test/")) continue;
    files.set(file, readFileSync(resolve(srcDir, file), "utf8"));
  }
  return files;
}

test("the gate calls in the source are exactly GATED_ROUTES, by file and action", () => {
  const found: Record<string, string[]> = {};
  for (const [file, source] of productionSources()) {
    const calls = [...source.matchAll(/(?<!function\s)refuseWithoutRecentSecondFactor\(([^;]*?)\)\)\s*return;/g)];
    const actions = calls.map((match) => /"([a-z_]+)"\s*$/.exec(match[1]!)?.[1] ?? "<not a literal action>");
    const mentions = [...source.matchAll(/(?<![\w$])refuseWithoutRecentSecondFactor\(/g)].length
      - (/function refuseWithoutRecentSecondFactor\(/.test(source) ? 1 : 0);
    assert.equal(actions.length, mentions, `${file}: every call is \`if (... refuseWithoutRecentSecondFactor(..., "action")) return;\``);
    if (actions.length > 0) found[file] = actions.sort();
  }
  const expected: Record<string, string[]> = {};
  for (const { file, action } of Object.values(GATED_ROUTES)) (expected[file] ??= []).push(action);
  for (const actions of Object.values(expected)) actions.sort();
  assert.deepEqual(found, expected);
});

test("each approval in APPROVAL_GATED_ROUTES refuses an unverified approver, and no other handler calls it", () => {
  const sources = productionSources();
  const expected: Record<string, number> = {};
  const handlers = new Set<string>();
  for (const [route, { file, handler }] of Object.entries(APPROVAL_GATED_ROUTES)) {
    const source = sources.get(file) ?? "";
    const start = source.indexOf(handler);
    assert.ok(start >= 0, `${route}: ${handler} in ${file}`);
    const end = source.indexOf("\n});\n", start);
    const body = source.slice(start, end < 0 ? undefined : end);
    assert.match(body, /if \((?:\w+ && )?await refuseUnverifiedApprover\(res, [^;]*\)\) return;/, `${route}: its handler refuses an unverified approver`);
    // One handler serves each of its mounts.
    if (!handlers.has(`${file} ${handler}`)) expected[file] = (expected[file] ?? 0) + 1;
    handlers.add(`${file} ${handler}`);
  }
  const found: Record<string, number> = {};
  for (const [file, source] of sources) {
    const calls = [...source.matchAll(/(?<!function\s)(?<![\w$])refuseUnverifiedApprover\(/g)].length;
    if (calls > 0) found[file] = calls;
  }
  assert.deepEqual(found, expected);
});

let appRouter: object | undefined;
let appSession: ReturnType<typeof capture.session> | undefined;

test("reverse: every registered route that can link a sign-in method, change a password or mint a key is gated or exempt with a reason", async () => {
  appSession = capture.session();
  const { createApp } = await import("../../app");
  appRouter = (createApp() as unknown as { router: object }).router;
  const { routes, problems } = appSession.collect(appRouter);
  assert.deepEqual(problems, [], "route capture and dispatch stack must agree");
  assert.ok(routes.length > 100, "the app's routes were captured");
  const result = checkSensitiveRoutes(routes);
  assert.deepEqual(result.unknown, [], "gate these with refuseWithoutRecentSecondFactor, or add them to EXEMPTIONS with a reason");
  assert.deepEqual(result.stale, [], "GATED_ROUTES / EXEMPTIONS rows no longer registered, or no longer matching a pattern");
  for (const [route, reason] of Object.entries(EXEMPTIONS)) {
    assert.ok(reason.trim().length > 10, `${route}: a written reason`);
    assert.doesNotMatch(reason, /POSSIBLE GAP/, `${route}: decide it (gate it, or a reason it needs none)`);
  }
  for (const route of Object.keys(GATED_ROUTES)) assert.equal(route in EXEMPTIONS || route in APPROVAL_GATED_ROUTES, false, `${route}: listed twice`);
  for (const route of Object.keys(APPROVAL_GATED_ROUTES)) assert.equal(route in EXEMPTIONS, false, `${route}: approval-gated and exempt`);
  for (const route of Object.keys(GATED_BY_CARD_KIND)) {
    assert.equal(route in EXEMPTIONS || route in GATED_ROUTES || route in APPROVAL_GATED_ROUTES, false, `${route}: listed twice`);
  }
});

test("reverse control: a newly registered matching route turns it red", async () => {
  assert.ok(appSession && appRouter, "depends on the enumeration test having built the app");
  const { authRouter } = await import("../../routes/auth");
  const { agentRouter } = await import("../../routes/agents");
  const { accountDeletionRouter } = await import("../../routes/accountDeletion");
  const { integrationRouter } = await import("../../routes/integrations");
  const noop = (_req: unknown, res: { end: () => void }) => res.end();
  authRouter.post("/:provider/link/step-up-probe", noop);
  agentRouter.post("/:id/credentials/step-up-probe", noop);
  authRouter.post("/change-email/step-up-probe", noop);
  accountDeletionRouter.patch("/email/step-up-probe", noop);
  integrationRouter.post("/requests/:requestId/step-up-probe/approve", noop);
  integrationRouter.post("/clients/:clientId/step-up-probe/consent", noop);
  integrationRouter.post("/clients/:clientId/step-up-probe-token", noop);
  integrationRouter.post("/clients/:clientId/step-up-probe/rotate-secret", noop);
  integrationRouter.post("/marketplace/:clientId/install/step-up-probe", noop);
  integrationRouter.post("/step-up-probe/clients", noop);
  // Not a token or secret: a `:token` parameter.
  integrationRouter.post("/invites/:token/step-up-probe", noop);
  const { routes } = appSession.collect(appRouter);
  assert.deepEqual(checkSensitiveRoutes(routes).unknown, [
    "PATCH /api/me/account/deletion/email/step-up-probe",
    "POST /api/agents/:id/credentials/step-up-probe",
    "POST /api/auth/:provider/link/step-up-probe",
    "POST /api/auth/change-email/step-up-probe",
    "POST /api/integrations/clients/:clientId/step-up-probe-token",
    "POST /api/integrations/clients/:clientId/step-up-probe/consent",
    "POST /api/integrations/clients/:clientId/step-up-probe/rotate-secret",
    "POST /api/integrations/marketplace/:clientId/install/step-up-probe",
    "POST /api/integrations/requests/:requestId/step-up-probe/approve",
    "POST /api/integrations/step-up-probe/clients",
  ]);
});

test("every action has a refusal message, and every one is used", async () => {
  // Imported here, after the app's routes were captured: it loads routers the capture must see built.
  const { ACTION_CARD_SECOND_FACTOR } = await import("../actionCardSecondFactor");
  // A route's, or an action card kind's (actionCardSecondFactor.ts).
  const used = new Set<StepUpAction>(Object.values(GATED_ROUTES).map(({ action }) => action));
  for (const rule of Object.values(ACTION_CARD_SECOND_FACTOR)) if (rule.secondFactor === "step_up") used.add(rule.action);
  assert.deepEqual([...used].sort(), Object.keys(STEP_UP_ACTIONS).sort());
  for (const message of Object.values(STEP_UP_ACTIONS)) assert.match(message, /^Confirm it's you with your second step before /);
});
