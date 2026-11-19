// The RFC 085 runtime backstop's own reverse cases (services/delegableRouteBackstop.ts): whatever the case, the
// mount prefix, extra or trailing slashes, and as a concrete path with its ids filled in; and the planned cards that
// sit next to refused routes stay open, as patterns and as concrete paths. The structure test runs it over the
// whole route classification.
import assert from "node:assert/strict";
import { delegableBodyBackstopKey, delegableRouteBackstopRule, normaliseDelegablePath } from "./delegableRouteBackstop";

const ID = "6f1389e2-5b60-4337-8e0d-e801dd9918f9";
const OTHER = "fa876988-bb1a-413f-8048-d618873b8588";

test("paths are read in lower case, one slash between segments, none at the end, each :param as :", () => {
  assert.equal(normaliseDelegablePath("/API//Servers/:id/Members/:memberId/"), "/api/servers/:/members/:");
  assert.equal(normaliseDelegablePath("/"), "/");
});

test("refused whatever the case, the mount prefix or the slashes", () => {
  for (const route of [
    "POST /API/Billing/Checkout",
    "post /api/billing/checkout",
    "POST //api//billing//checkout/",
    "POST /oidc/:server/api/oauth/installation-token",
    "POST /oidc/:server/api/oauth/installations/:installationId/bot-token",
    "POST /internal/mirror/api/agents/:id/credentials",
    "PUT /v2/agents/:id/SCOPES",
    "PATCH /other/api/servers/:id/public-visibility",
    "POST /mirror/channels/:id/Convert-To-Joint",
    "DELETE /x/api/me/account/deletion",
    "PUT /SSO/connection",
    "POST /api/actions/:messageId/execute",
  ]) assert.ok(delegableRouteBackstopRule(route), route);
});

test("refused as concrete paths with their ids filled in, so a param can't carry a refused route in", () => {
  for (const route of [
    `PATCH /api/servers/${ID}/members/${OTHER}`,
    `DELETE /api/channels/${ID}`,
    `DELETE /api/servers/${ID}`,
    `POST /api/channels/${ID}/joint-invites`,
    `POST /api/artifacts/${ID}/home`,
    `DELETE /api/servers/${ID}/machines/${OTHER}`,
    // A pattern whose param is filled with a refused word.
    `POST /api/agents/${ID}/scopes`,
    "POST /api/agents/billing/stop",
  ]) assert.ok(delegableRouteBackstopRule(route), route);
});

test("the planned cards next to refused routes stay open, as patterns and as concrete paths", () => {
  for (const route of [
    "PATCH /api/channels/:id/members/:targetType/:memberId/role",
    `PATCH /api/channels/${ID}/members/user/${OTHER}/role`,
    "POST /api/channels/joint-invites/:inviteId/accept",
    `POST /api/channels/joint-invites/${ID}/accept`,
    "DELETE /api/servers/:id/members/:memberId",
    `DELETE /api/servers/${ID}/members/${OTHER}`,
    "POST /api/servers/:id/machines/:machineId/computer/:action",
    `POST /api/servers/${ID}/machines/${OTHER}/computer/restart`,
    `POST /api/channels/${ID}/archive`,
    `POST /api/agents/${ID}/stop`,
    `PATCH /api/agents/${ID}`,
    `DELETE /api/channels/threads/${ID}/followers/agents/${OTHER}`,
  ]) assert.equal(delegableRouteBackstopRule(route), null, route);
});

test("body fields that make content public, carry a secret, or set a role or scopes are refused at any depth and in any spelling", () => {
  for (const [body, path] of [
    [{ visitorVisible: true }, "visitorVisible"],
    [{ visitor_visible: true }, "visitor_visible"],
    [{ name: "x", settings: { isPublic: true } }, "settings.isPublic"],
    [{ env_vars: { A: "1" } }, "env_vars"],
    [{ config: [{ ok: 1 }, { api_key: "k" }] }, "config[1].api_key"],
    [{ "Server-Role": "admin" }, "Server-Role"],
    [{ scopes: [] }, "scopes"],
    [{ nested: { deeper: { refresh_token: "t" } } }, "nested.deeper.refresh_token"],
    // Sending a channel outside the server (POST /api/channels takes these; no path rule refuses it).
    [{ name: "ops", visibility: "joint" }, "visibility"],
    [{ channel: { Visibility: " JOINT " } }, "channel.Visibility"],
    [{ jointInvites: [] }, "jointInvites"],
    [{ external_invites: [] }, "external_invites"],
    [{ target_server_slug: "other" }, "target_server_slug"],
    [{ invitedPeople: [] }, "invitedPeople"],
    [{ "same-admin": true }, "same-admin"],
  ] as const) assert.equal(delegableBodyBackstopKey(body), path, path);
  for (const body of [
    {}, { role: "member" }, { name: "ops", description: "public notes" }, { reason: "stop" }, null, "visitorVisible", [1, 2],
    { name: "ops", visibility: "private" }, { visibility: "channel" }, { note: "joint" },
  ]) {
    assert.equal(delegableBodyBackstopKey(body), null, JSON.stringify(body));
  }
});
