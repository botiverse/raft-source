/**
 * A runtime backstop under the RFC 085 delegable list: routes of a class that
 * must never run from a card, whatever the list says. The list is reviewed
 * and the route classification's structure test keeps these classes `never`
 * (src/test/routeAuthorityClassification.structure.test.ts, which product
 * code never imports); this is the product's own check, by path and keyword,
 * so a bad entry is still refused at prepare and at commit.
 *
 * It matches a route's path whatever its case and however it is mounted (no
 * `/api/` anchor: `/oidc/:server/api/oauth/...` is caught too), both as the
 * list writes it (the pattern, `:params` and all: at prepare and in the
 * structure test) and as the request would run (the concrete path with every
 * param filled in: at prepare and again at commit), so a param can't carry a
 * refused word in. Its word rules are the structure test's sensitive rules,
 * plus those of each never-delegable class they don't reach.
 *
 * The structure test checks that it catches every route the never-delegable
 * list names, in all ten classes, and every classified route the sensitive
 * rules or a never bucket hold, and that none of RFC 085's planned cards is
 * caught (lowering a channel member's role and accepting a joint invite stay
 * open).
 *
 * One never-delegable route is held by its body, not its path: `PATCH /api/channels/:id`,
 * never delegable for its `visitorVisible` field (making a channel readable by
 * visitors). Refusing every channel edit to catch one field is not the path
 * rules' to decide; the list and its structure test hold the route, and
 * delegableBodyBackstopKey below refuses that field (and the other
 * never-delegable body keys) in any body a card would send.
 */

export interface DelegableRouteBackstopRule {
  name: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Tested against the normalised path (normaliseDelegablePath): lower case,
   * one slash between segments, none at the end, every `:param` written `:`.
   * A param's place is matched by `[^/]+`, which a concrete id fills too.
   */
  path: RegExp;
}

/** Any segment exactly one of `words` (an alternation, lower case). */
const segment = (words: string) => new RegExp(`(^|/)(${words})(/|$)`);

export const DELEGABLE_ROUTE_BACKSTOP: readonly DelegableRouteBackstopRule[] = [
  // Credentials and keys (the structure test's rule, then the rest of the class): agent credentials and bootstrap
  // tokens, Computer and App keys and secrets, provider and runtime sign-ins, signed scope attestations; adding a
  // Computer mints its key, removing one revokes it.
  // `/runtimes/:runtime/upgrade`: runs a runtime's own updater on the Computer (changes its software, #15117);
  // `/runtimes/:runtime/install` and `install-plan`: its own installer, and the commands it would run there.
  { name: "credentials and keys", path: /credential|secret|token|(^|[/-])keys?($|[/-])|\/runtime-auth\/|scope-attestation|\/runtimes\/[^/]+\/(upgrade|install|install-plan)($|\/)/ },
  { name: "credentials and keys", path: segment("api-keys?|rotate-key|revoke-computer-key|setup-reset|attach|adopt-legacy") },
  { name: "credentials and keys", method: "POST", path: /\/machines$/ },
  { name: "credentials and keys", method: "DELETE", path: /\/machines\/[^/]+$/ },
  // Payment and seat charges.
  { name: "payment and seat charges", path: /(^|\/)billing(\/|$)|seat|(^|\/)appsumo(\/|$)|limit-reset|checkout|prepaid|pack-quantity|subscription|invoice|payment/ },
  // Sign-in, two-step and devices: every auth and OAuth route (the person's own profile and password too), push,
  // devices and sessions, linked identities, the sign-in OIDC mount, App logins.
  { name: "sign-in, two-step and devices", path: segment("auth|oauth|oidc|push|login|logout|password|passkeys?|second-factor|sessions?|retire-session|identities|device|app-logins") },
  { name: "account deletion", path: /account[/-]deletion/ },
  { name: "SSO", path: segment("sso|saml|scim") },
  // OAuth and MCP grants (the structure test's rule, unanchored): grants and consent, the integration lane, App
  // installs and their bots, MCP assignments and connections, an agent's provider connections.
  {
    name: "OAuth and MCP grants",
    path: /(^|[/-])grants?($|[/-])|consent|(^|\/)integrations?($|[/-])|(^|\/)integration-invites(\/|$)|(^|\/)mcp(\/|$)|(^|\/)installations?(\/|$)|(^|\/)install(\/|$)|(^|\/)connections(\/|$)/,
  },
  // Server roles and agent scopes: scopes, a member's server role (PATCH .../members/:memberId; a channel member's
  // role, .../members/:targetType/:memberId/role, is the channel:remove_admin card), and grants that widen what an agent
  // reads (View Context above, RaftBench readers).
  { name: "server roles and agent scopes", path: /(^|[/-])scopes?($|[/-])|(^|\/)raftbench(\/|$)/ },
  { name: "server roles and agent scopes", method: "PATCH", path: /\/servers\/[^/]+\/members\/[^/]+$/ },
  // Making content public on the internet: public servers and their search listing, visitor access, an Artifact's
  // home anyone with the link opens.
  { name: "making content public on the internet", path: /public|visitor/ },
  { name: "making content public on the internet", method: "POST", path: /\/artifacts\/[^/]+\/home$/ },
  // Channel content outside the server: external invites and connections, sending a joint invite from a channel
  // (accepting one, /channels/joint-invites/:inviteId/accept, is a planned card), converting to joint, connecting
  // one's own servers, and the Slack bridge.
  { name: "channel content outside the server", path: /\/channels\/[^/]+\/(external-|joint-|convert-to-joint|connect-my-servers)|(^|\/)external-|(^|\/)slack-bridge(\/|$)/ },
  // Deleting a channel or a server (archiving a channel is the card).
  { name: "deleting a channel or server", method: "DELETE", path: /\/(servers|channels)\/[^/]+$/ },
  // Data export: copying a person's or a server's data out of Raft (#triage:#512).
  { name: "data export", path: segment("data-exports") },
  // A card never runs another card (the dispatcher's own guard refuses it too).
  { name: "action cards", path: segment("actions") },
];

/** A path as the rules read it: lower case, one slash between segments, none at the end, each `:param` as `:`. */
export function normaliseDelegablePath(path: string): string {
  const collapsed = path.trim().toLowerCase().replace(/\/{2,}/g, "/").replace(/:[a-z_][a-z0-9_]*/g, ":");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** The rule a route breaks (`POST /api/...`, as the list keys it or as it would run, concrete), or null. */
export function delegableRouteBackstopRule(route: string): DelegableRouteBackstopRule | null {
  const space = route.trim().indexOf(" ");
  const method = route.trim().slice(0, space).toUpperCase();
  const path = normaliseDelegablePath(route.trim().slice(space + 1));
  return DELEGABLE_ROUTE_BACKSTOP.find((rule) => (!rule.method || rule.method === method) && rule.path.test(path)) ?? null;
}

/**
 * Body keys a card never sends, at any depth and however they are spelled
 * (camelCase, snake_case, kebab-case, any case: compared with everything but
 * letters and digits dropped). The route backstop above sees the route, not
 * its body; these are the fields that would make one of its never-delegable
 * classes through an otherwise allowed route: making content public
 * (`visitorVisible` on PATCH /api/channels/:id, `public`, `isPublic`),
 * credentials and secrets (`api_key`, `token`, `password`, `credentials`), an
 * agent's environment (`env_vars`: it carries secrets), a server role,
 * scopes, and sending a channel outside the server (joint and external
 * invites, a target server, `visibility: "joint"`; Warden on #14852). Checked on the body a card would send, at prepare and again at
 * commit (Tenny 296b02bc, Warden on #14735).
 */
const FORBIDDEN_BODY_KEY = /visitor|public|secret|token|password|passcode|credential|apikey|privatekey|envvar|serverrole|scope|joint|external|targetserver|invitedpeople|sameadmin/;

/**
 * Body values that send content outside the server through a route no path rule refuses: a channel created
 * with `visibility: "joint"` is shared with other servers (POST /api/channels; Warden on #14852). Keys compared
 * as above, values in any case.
 */
const FORBIDDEN_BODY_VALUES: ReadonlyArray<{ key: string; value: RegExp }> = [
  { key: "visibility", value: /^joint$/i },
];

/** The first forbidden key in `body` (its dotted path, as `channel.visitor_visible`), or null. */
export function delegableBodyBackstopKey(body: unknown, at = ""): string | null {
  if (Array.isArray(body)) {
    for (const [index, item] of body.entries()) {
      const found = delegableBodyBackstopKey(item, `${at}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!body || typeof body !== "object") return null;
  for (const [key, value] of Object.entries(body)) {
    const path = at ? `${at}.${key}` : key;
    const folded = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_BODY_KEY.test(folded)) return path;
    if (typeof value === "string" && FORBIDDEN_BODY_VALUES.some((rule) => rule.key === folded && rule.value.test(value.trim()))) return path;
    const found = delegableBodyBackstopKey(value, path);
    if (found) return found;
  }
  return null;
}
