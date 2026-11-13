// #proj-assistant:#19 (Tenny): an owner action names its route by the exact
// method and Express-registered full path, and auth matches it segment by
// segment. So every table path must be registered, and no OTHER registered
// route of the same method may match a path the entry matches (a literal
// segment of one against a `:param` of the other unifies): otherwise Express
// could run that other handler as the owner. Route list from the app's real
// registration (routeRegistrationCapture.ts), as routeAuthorityClassification.
import assert from "node:assert/strict";
import { installRouteRegistrationCapture } from "../test/routeRegistrationCapture";
import { ASSISTANT_OWNER_ACTIONS, matchAssistantOwnerAction } from "./assistantOwnerActions";

process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;

const capture = installRouteRegistrationCapture();

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Whether some request path matches both patterns. */
function overlaps(a: string, b: string): boolean {
  const as = segments(a);
  const bs = segments(b);
  if (as.length !== bs.length) return false;
  return as.every((seg, i) => seg.startsWith(":") || bs[i]!.startsWith(":") || seg === bs[i]);
}

/**
 * Entries whose literal path a `:param` route also matches, where the entry is registered first in the
 * same router (routes/channels.ts: GET /saved before GET /:id). Proven by assistantOwnerReads.api.test.ts:
 * list_owner_saved_messages answers its own text, which only the saved route's 2xx can produce.
 */
const KNOWN_SHADOWED: Record<string, readonly string[]> = {
  "GET /api/channels/saved": ["/api/channels/:id"],
};

/** Whether `other` differs from `entry` only by a `:param` where `entry` has a literal (entry is the more specific). */
function shadowedBy(other: string, entry: string): boolean {
  const os = segments(other);
  const es = segments(entry);
  return os.length === es.length && os.every((seg, i) => seg === es[i] || (seg.startsWith(":") && !es[i]!.startsWith(":")));
}

test("every owner action is a registered route, and no other route of its method can match its paths", async () => {
  const session = capture.session();
  const { createApp } = await import("../app");
  const router = (createApp() as unknown as { router: object }).router;
  // The mutating surface, and the GET surface for the reads (collected separately).
  const routes = [...session.collect(router).routes, ...session.collect(router, { methods: "read" }).routes]
    .map((route) => ({ method: route.method.toUpperCase(), path: route.path }));

  for (const action of ASSISTANT_OWNER_ACTIONS) {
    const registered = routes.filter((route) => route.method === action.method && route.path === action.path);
    assert.equal(registered.length, 1, `${action.method} ${action.path} must be registered exactly once`);
    // An overlap is allowed only where it is named here: the other route has a `:param` wherever this
    // entry has a literal, and the entry is registered before it in the same router, so a request for
    // the entry's path always reaches the entry. Each is proven by a request in the entry's api test.
    const others = routes.filter((route) => route.method === action.method && route.path !== action.path && overlaps(route.path, action.path)
      && !(KNOWN_SHADOWED[`${action.method} ${action.path}`]?.includes(route.path) && shadowedBy(route.path, action.path)));
    assert.deepEqual(others, [], `${action.method} ${action.path} overlaps another registered route`);
  }
});

test("the overlap check and the matcher: literals unify with params, a different literal or length does not", () => {
  assert.equal(overlaps("/api/channels/:id/notification-settings", "/api/channels/saved/notification-settings"), true);
  assert.equal(overlaps("/api/channels/:id/notification-settings", "/api/channels/:id/message-display-settings"), false);
  assert.equal(overlaps("/api/channels/:id/notification-settings", "/api/channels/:id"), false);
  assert.equal(shadowedBy("/api/channels/:id", "/api/channels/saved"), true);
  assert.equal(shadowedBy("/api/channels/saved", "/api/channels/:id"), false);
  assert.equal(matchAssistantOwnerAction("PATCH", "/api/channels/abc/notification-settings")?.params.id, "abc");
  assert.equal(matchAssistantOwnerAction("GET", "/api/channels/abc/notification-settings"), null);
  assert.equal(matchAssistantOwnerAction("PATCH", "/api/channels/abc/notification-settings/x"), null);
  assert.equal(matchAssistantOwnerAction("PUT", "/api/notification-levels")?.action.tool, "set_notification_level");
});

test("every entry describes its tool: parameters mapped, body fields allowed; a confirm entry words its own card; a read is a GET with a render", () => {
  for (const action of ASSISTANT_OWNER_ACTIONS) {
    assert.ok(action.tier === "direct" || action.tier === "confirm" || action.tier === "read", action.tool);
    // A read is exactly a GET, renders its own text, takes no body and changes nothing (no describe, no card);
    // every other entry is not a GET and says what changed.
    if (action.tier === "read") {
      assert.equal(action.method, "GET", action.tool);
      assert.equal(typeof action.render, "function", `${action.tool}: a read needs a render`);
      assert.deepEqual(action.allowedFields, [], `${action.tool}: a read takes no body`);
      assert.equal(action.describe, undefined, action.tool);
      assert.equal(action.card, undefined, action.tool);
      for (const map of action.mapping) assert.equal(map.into, "query", `${action.tool}: a read's options are query fields`);
      for (const map of action.mapping) assert.ok(map.into === "query" && action.queryFields?.includes(map.field), `${action.tool}: ${map.param} not a query field`);
    } else {
      assert.notEqual(action.method, "GET", action.tool);
      assert.equal(typeof action.describe, "function", `${action.tool}: needs describe`);
      assert.equal(action.queryFields, undefined, `${action.tool}: only a read takes a query`);
    }
    // A confirm entry's card is Raft's text, built by the entry (never the assistant's), and runs no GET.
    if (action.tier === "confirm") {
      assert.equal(typeof action.card, "function", `${action.tool}: a confirm entry needs a card`);
      assert.notEqual(action.method, "GET");
    }
    const params = new Set(action.params.map((param) => param.name));
    for (const map of action.mapping) assert.ok(params.has(map.param), `${action.tool}: mapping names unknown param ${map.param}`);
    for (const map of action.mapping) {
      if (map.into === "body" || map.into === "body_ref" || map.into === "body_position") {
        assert.ok(action.allowedFields.includes(map.field), `${action.tool}: ${map.field} not allowed`);
      }
      if (map.into === "path") assert.ok(action.path.includes(`:${map.field}`), `${action.tool}: no :${map.field} in path`);
    }
  }
});

test("entries sharing a route are told apart by their body: each picks itself, a mixed body picks none", () => {
  const byRoute = new Map<string, typeof ASSISTANT_OWNER_ACTIONS[number][]>();
  for (const action of ASSISTANT_OWNER_ACTIONS) {
    const key = `${action.method} ${action.path}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), action]);
  }
  const shared = [...byRoute.values()].filter((group) => group.length > 1);
  assert.ok(shared.length > 0, "the sidebar tools share PATCH /api/servers/:id/sidebar-order");
  for (const group of shared) {
    for (const action of group) {
      assert.ok(action.requiredFields && action.requiredFields.length > 0, `${action.tool} shares a route, so it needs requiredFields`);
      const body = Object.fromEntries(action.requiredFields!.map((field) => [field, 1]));
      const path = action.path.replace(/:[^/]+/g, "x");
      assert.equal(matchAssistantOwnerAction(action.method, path, body)?.action.tool, action.tool);
    }
    const mixed = Object.fromEntries(group.flatMap((action) => action.requiredFields!.map((field) => [field, 1])));
    assert.equal(matchAssistantOwnerAction(group[0]!.method, group[0]!.path.replace(/:[^/]+/g, "x"), mixed), null);
  }
  assert.equal(matchAssistantOwnerAction("PATCH", "/api/servers/x/sidebar-order", { targetId: "a", position: "top" })?.action.tool, "move_conversation");
  assert.equal(matchAssistantOwnerAction("PATCH", "/api/servers/x/sidebar-order", { targetId: "a", pinned: true })?.action.tool, "pin_conversation");
  assert.equal(matchAssistantOwnerAction("PATCH", "/api/servers/x/sidebar-order", { channelOrder: [] }), null);
});
