import assert from "node:assert/strict";
import { classifyLinkTarget, isRaftAuthorizeUrl, routeLink } from "./linkRouter";
import type { LinkIntent, LinkOrigin, LinkOutcome, LinkPreference, LinkTarget } from "./linkRouter";

// The routing table (#proj-workspace:#293). Each row: target, origin, intent, preference, browser → outcome. `*`
// stands for every value of that column; a later row overrides an earlier one for the cases it names, and every
// combination must be named by some row.
type Any = "*";
type Row = [LinkTarget | Any, LinkOrigin | Any, LinkIntent | Any, LinkPreference | Any, boolean | Any, string];

const TARGETS: LinkTarget[] = ["web", "web-credentials", "raft", "scheme", "unsafe"];
const ORIGINS: LinkOrigin[] = ["shell", "page"];
const INTENTS: LinkIntent[] = ["plain", "new-tab", "new-window", "beside", "browser"];
const PREFERENCES: LinkPreference[] = ["beside", "browser", null];

const TABLE: Row[] = [
  // Raft's own UI: its own pages, other applications' links, and addresses the browser never shows keep their own way.
  ["raft", "shell", "*", "*", "*", "default"],
  ["scheme", "shell", "*", "*", "*", "default"],
  ["web-credentials", "shell", "*", "*", "*", "default"],
  // Raft's own UI, a web page, no built-in browser here (a web browser, the flag off, no conversation): as before.
  ["web", "shell", "*", "*", false, "default"],
  // Raft's own UI, a web page, the built-in browser available.
  ["web", "shell", "plain", "beside", true, "browser-tab new-foreground"],
  ["web", "shell", "plain", "browser", true, "default"],
  ["web", "shell", "plain", null, true, "ask-first"],
  ["web", "shell", "new-tab", "beside", true, "browser-tab new-background"],
  ["web", "shell", "new-tab", null, true, "browser-tab new-background"],
  ["web", "shell", "new-tab", "browser", true, "default"],
  ["web", "shell", "new-window", "beside", true, "browser-tab new-foreground"],
  ["web", "shell", "new-window", null, true, "browser-tab new-foreground"],
  ["web", "shell", "new-window", "browser", true, "default"],
  // The menu's explicit choices win over the preference.
  ["web", "shell", "beside", "*", true, "browser-tab new-foreground"],
  ["web", "shell", "browser", "*", "*", "system-browser"],
  // A page in a browser tab: the preference is never asked.
  ["web", "page", "plain", "*", true, "browser-tab current"],
  ["web", "page", "new-tab", "*", true, "browser-tab new-background"],
  ["web", "page", "new-window", "*", true, "browser-tab new-foreground"],
  ["web", "page", "beside", "*", true, "browser-tab new-foreground"],
  ["web", "page", "browser", "*", "*", "system-browser"],
  // A shell with one page and no tabs: what the page opens goes to the system browser.
  ["web", "page", "*", "*", false, "system-browser"],
  // A page never navigates a tab to Raft's own pages or to another application: refused, and said so on the tab.
  ["raft", "page", "*", "*", "*", "refuse-visible raft"],
  ["scheme", "page", "*", "*", "*", "refuse-visible scheme"],
  ["web-credentials", "page", "*", "*", "*", "drop"],
  // Nothing opens these.
  ["unsafe", "*", "*", "*", "*", "drop"],
];

const says = (outcome: LinkOutcome): string =>
  outcome.kind === "browser-tab" ? `browser-tab ${outcome.where}` : outcome.kind === "refuse-visible" ? `refuse-visible ${outcome.reason}` : outcome.kind;

function expected(target: LinkTarget, origin: LinkOrigin, intent: LinkIntent, preference: LinkPreference, browser: boolean): string | null {
  let found: string | null = null;
  for (const [t, o, i, p, b, outcome] of TABLE) {
    if ((t === "*" || t === target) && (o === "*" || o === origin) && (i === "*" || i === intent) && (p === "*" || p === preference) && (b === "*" || b === browser)) found = outcome;
  }
  return found;
}

test("routeLink: every combination is the table's", () => {
  let cases = 0;
  for (const target of TARGETS) for (const origin of ORIGINS) for (const intent of INTENTS) for (const preference of PREFERENCES) for (const browser of [true, false]) {
    const want = expected(target, origin, intent, preference, browser);
    assert.notEqual(want, null, `no row for ${target} ${origin} ${intent} ${preference} ${browser}`);
    assert.equal(says(routeLink({ target, origin, intent, preference, browser })), want, `${target} ${origin} ${intent} ${preference} browser=${browser}`);
    cases += 1;
  }
  assert.equal(cases, 300);
});

test("routeLink: a page-initiated action is never left without an outcome of its own", () => {
  for (const target of TARGETS) for (const intent of INTENTS) for (const browser of [true, false]) {
    assert.notEqual(routeLink({ target, origin: "page", intent, preference: null, browser }).kind, "default", `${target} ${intent}`);
    assert.notEqual(routeLink({ target, origin: "page", intent, preference: null, browser }).kind, "ask-first", `${target} ${intent}`);
  }
});

test("classifyLinkTarget: web pages, Raft's hosts, other applications, and what nothing opens", () => {
  const raft = ["raftweb.test", "api.raft.test"];
  assert.equal(classifyLinkTarget("https://example.com/a?b#c", raft), "web");
  assert.equal(classifyLinkTarget("http://127.0.0.1:3000/", raft), "web");
  assert.equal(classifyLinkTarget("https://user:pw@example.com/", raft), "web-credentials");
  assert.equal(classifyLinkTarget("https://raftweb.test/s/x/channel/y", raft), "raft");
  assert.equal(classifyLinkTarget("https://API.raft.test/api/oauth/authorize", raft), "raft");
  assert.equal(classifyLinkTarget("https://app.raft.build/login-with-raft/setup", []), "raft");
  assert.equal(classifyLinkTarget("https://raftweb.test.evil.example/", raft), "web");
  assert.equal(classifyLinkTarget("mailto:a@example.com", raft), "scheme");
  assert.equal(classifyLinkTarget("tel:+15550100", raft), "scheme");
  assert.equal(classifyLinkTarget("obsidian://open?vault=x", raft), "scheme");
  for (const url of ["javascript:alert(1)", "data:text/html,x", "blob:https://example.com/1", "file:///etc/passwd", "about:blank", "app://raft/s/x", "raft://s/x", "view-source:https://example.com", "not a url", "", null, 7]) {
    assert.equal(classifyLinkTarget(url, raft), "unsafe", String(url));
  }
});

test("isRaftAuthorizeUrl: Raft's sign-in for another site, on a Raft host only", () => {
  const raft = ["api.raft.test"];
  assert.equal(isRaftAuthorizeUrl("https://api.raft.test/api/oauth/authorize?client_id=deck", raft), true);
  assert.equal(isRaftAuthorizeUrl("https://app.raft.build/login-with-raft/setup?flow=oidc", raft), true);
  // A Server's own issuer: the same endpoint under `/oidc/<server>`.
  assert.equal(isRaftAuthorizeUrl("https://api.raft.test/oidc/acdb8a20-9399-4f6e-8d1c-758d09f28a11/api/oauth/authorize?client_id=deck", raft), true);
  assert.equal(isRaftAuthorizeUrl("https://api.raft.test/oidc/a/b/api/oauth/authorize", raft), false);
  assert.equal(isRaftAuthorizeUrl("https://api.raft.test/oidc/a/api/oauth/authorize/human", raft), false);
  // As the server's router reads a path: letters in either case, one trailing slash; the Server segment as written.
  for (const path of [
    "/API/OAuth/Authorize", "/api/oauth/authorize/", "/API/OAUTH/AUTHORIZE/",
    "/OIDC/Srv-A/API/OAuth/authorize", "/oidc/Srv-A/api/oauth/authorize/", "/Oidc/Srv-A/Api/Oauth/Authorize/",
    "/Login-With-Raft/setup/",
  ]) {
    assert.equal(isRaftAuthorizeUrl(`https://api.raft.test${path}?client_id=deck`, raft), true, path);
  }
  // What the router does not take as the same route: a repeated slash, a longer path.
  for (const path of ["/api/oauth/authorize//", "/api//oauth/authorize", "//api/oauth/authorize", "/api/oauth//authorize", "/oidc//api/oauth/authorize", "/oidc/a/api/oauth/authorize//", "/api/oauth/authorizes"]) {
    assert.equal(isRaftAuthorizeUrl(`https://api.raft.test${path}`, raft), false, path);
  }
  // The consent page under its two older names (App.tsx routes them to it), in either case, with one trailing slash or none.
  for (const path of [
    "/login-with-slock/setup", "/Login-With-Slock/Setup/", "/login-with-slock-human/setup", "/LOGIN-WITH-SLOCK-HUMAN/SETUP/",
    "/login-with-raft/setup", "/LOGIN-WITH-RAFT/SETUP",
  ]) {
    assert.equal(isRaftAuthorizeUrl(`https://app.raft.build${path}?client_id=deck&return_to=https%3A%2F%2Fdeck.example%2Fcb`, raft), true, path);
  }
  for (const path of ["/login-with-slockx/setup", "/login-with-slock-humans/setup", "/login-with-slack/setup", "/x/login-with-slock/setup"]) {
    assert.equal(isRaftAuthorizeUrl(`https://app.raft.build${path}`, raft), false, path);
  }
  assert.equal(isRaftAuthorizeUrl("https://example.com/login-with-slock/setup?client_id=deck", raft), false, "not a Raft host");
  assert.equal(isRaftAuthorizeUrl("https://app.raft.build/s/x/channel/y", raft), false);
  assert.equal(isRaftAuthorizeUrl("https://example.com/api/oauth/authorize", raft), false);
  assert.equal(isRaftAuthorizeUrl("https://example.com/API/OAuth/Authorize/", raft), false);
  assert.equal(isRaftAuthorizeUrl("nope", raft), false);
});

test("a Raft host written another way is still Raft's: trailing dots, case, a port, an encoded dot", () => {
  const raft = ["raftweb.test", "api.raft.test"];
  for (const url of [
    "https://app.raft.build./x", "https://APP.RAFT.BUILD./", "https://app.raft.build../",
    "https://raftweb.test./s/x/channel/y", "https://API.RAFT.TEST../api/oauth/authorize",
    // What WHATWG URL already takes out of `hostname`: a port, a percent-encoded or full-width dot.
    "https://app.raft.build:443/", "https://app.raft.build:8443/", "https://app.raft%2Ebuild/", "https://app.raft.build%2E/", "https://app\u3002raft\u3002build/",
    // A user name does not make it another host either (the host is asked first).
    "https://user@app.raft.build/", "https://user:pw@app.raft.build./",
  ]) {
    assert.equal(classifyLinkTarget(url, raft), "raft", url);
  }
  assert.equal(classifyLinkTarget("https://example.com./", raft), "web");
  assert.equal(classifyLinkTarget("https://example.com../a", raft), "web");
  assert.equal(classifyLinkTarget("https://app.raft.build.evil.example./", raft), "web");

  assert.equal(isRaftAuthorizeUrl("https://api.raft.test./api/oauth/authorize?client_id=deck", raft), true);
  assert.equal(isRaftAuthorizeUrl("https://APP.RAFT.BUILD../login-with-raft/setup?flow=oidc", raft), true);
  assert.equal(isRaftAuthorizeUrl("https://app.raft.build./s/x/channel/y", raft), false);
  assert.equal(isRaftAuthorizeUrl("https://example.com./api/oauth/authorize", raft), false);

  // From a page in the built-in browser it is refused like any Raft page, never a tab.
  const target = classifyLinkTarget("https://app.raft.build./", raft);
  assert.deepEqual(routeLink({ target, intent: "plain", origin: "page", preference: null, browser: true }), { kind: "refuse-visible", reason: "raft" });
});
