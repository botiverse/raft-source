import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestPath } from "../scripts/testLocations";
import {
  flushProductEvents,
  flushProductEventsBeforeNavigation,
  resetProductEventsForTest,
  setProductEventServerIdGetter,
  trackEvent,
} from "../src/analytics/track";
import { recordPwaInstallEvent } from "../src/utils/pwaInstall";
import { RETIRED_SETTINGS_PAGE_TABS, SETTINGS_PAGE_TABS } from "@botiverse/raft-shared";
import { pageRouteFor } from "../src/analytics/pageViews";
import { SETTINGS_TABS } from "../src/components/settings/settingsNavigation";
import {
  trackActivityOpen,
  trackActivityItemOpen,
  trackActivityMark,
} from "../src/analytics/activity";
import { summarizeBulkModelChangeResults } from "../src/analytics/bulkModelChange";

type Call = { url: string; init?: RequestInit };

function fakeServer(clientEventsAllowed: boolean) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/product-events/config")) {
      return new Response(JSON.stringify({ clientEventsAllowed }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  };
  return { calls, fetchImpl };
}

function withToken<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "token-1" : null) },
  });
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

function trackEverything(): void {
  trackActivityOpen("rail");
  trackActivityItemOpen("thread");
  trackActivityMark("done");
  trackEvent("community_cn_qr_page_view", { from: "direct" });
  recordPwaInstallEvent({
    event: "pwa_install_cta_clicked",
    platform: "ios_safari",
    surface: "settings",
    trigger: "settings",
    displayMode: "browser",
    sessionCountBucket: "1",
    cooldownState: "not_dismissed",
  });
}

test("events go out only after the server says this user may send them", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  setProductEventServerIdGetter(() => "server-1");
  try {
    trackEverything();
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
  }

  assert.deepEqual(server.calls.map((call) => call.url.replace(/^.*\/product-events\//, "")), ["config", "batch"]);
  const batch = server.calls[1]!;
  assert.equal((batch.init?.headers as Record<string, string>)["X-Server-Id"], "server-1");
  const body = JSON.parse(String(batch.init?.body)) as {
    source: string;
    app_version?: string;
    display_mode?: string;
    web_version?: string;
    events: Array<{ uuid: string; event: string; client_session_id: string; properties: Record<string, unknown> }>;
  };
  assert.equal(body.source, "web");
  // Which client (task #13): the server turns it into the platform column.
  assert.ok(body.app_version, "the web build's version");
  assert.equal(body.display_mode, "browser");
  assert.equal(body.web_version, undefined);
  assert.deepEqual(body.events.map((event) => event.event), [
    "activity_open",
    "activity_item_open",
    "activity_mark",
    "community_cn_qr_page_view",
    "pwa_install_cta_clicked",
  ]);
  assert.equal(new Set(body.events.map((event) => event.uuid)).size, body.events.length);
  // A per-page-load product session id (a uuid), not shared with traces.
  assert.equal(new Set(body.events.map((event) => event.client_session_id)).size, 1);
  assert.match(body.events[0]!.client_session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(body.events[4]!.properties, {
    platform: "ios_safari",
    surface: "settings",
    trigger: "settings",
    display_mode: "browser",
    session_count_bucket: "1",
    cooldown_state: "not_dismissed",
  });
}));

test("events never leave the browser when the server says no", () => withToken(async () => {
  const server = fakeServer(false);
  resetProductEventsForTest(server.fetchImpl);
  setProductEventServerIdGetter(() => "server-1");
  try {
    trackEverything();
    await flushProductEvents();
    trackEverything();
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
  }
  assert.deepEqual(server.calls.map((call) => call.url.replace(/^.*\/product-events\//, "")), ["config"]);
}));

test("a terminal navigation resolves consent and issues a keepalive batch before the normal timer", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  try {
    trackEvent("checkout_started", {
      entry: "settings",
      billing_interval: "annual",
      seat_count: 2,
      has_promotion_code: false,
    }, { serverId: "server-a" });
    await flushProductEventsBeforeNavigation({ timeoutMs: 100 });
  } finally {
    resetProductEventsForTest();
  }

  assert.deepEqual(server.calls.map((call) => call.url.replace(/^.*\/product-events\//, "")), ["config", "batch"]);
  assert.equal(server.calls[0]!.init?.keepalive, true, "the consent read may finish while the page is unloading");
  assert.equal(server.calls[1]!.init?.keepalive, true, "the terminal batch must survive navigation");
  assert.equal((server.calls[1]!.init?.headers as Record<string, string>)["X-Server-Id"], "server-a");
}));

test("a stalled consent read cannot hold terminal navigation open", () => withToken(async () => {
  resetProductEventsForTest(() => new Promise<Response>(() => undefined));
  try {
    trackEvent("checkout_started", {
      entry: "settings",
      billing_interval: "monthly",
      seat_count: 1,
      has_promotion_code: false,
    }, { serverId: "server-a" });
    const startedAt = Date.now();
    await flushProductEventsBeforeNavigation({ timeoutMs: 5 });
    assert.ok(Date.now() - startedAt < 100, "analytics timeout must release navigation promptly");
  } finally {
    resetProductEventsForTest();
  }
}));

test("nothing is sent outside a server or without a session", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  try {
    trackEverything(); // no current server
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
  }
  assert.equal(server.calls.length, 0);
}));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("only src/analytics/track.ts defines where product events go", () => {
  const offenders = listSourceFiles(join(__dirname, "../src")).filter((file) => {
    if (file.endsWith(join("analytics", "track.ts"))) return false;
    // Feature tests (src/features/<feature>/tests/) are not app code.
    if (isTestPath(relative(join(__dirname, ".."), file))) return false;
    return /posthog|amplitude|mixpanel|segment\.com/i.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(offenders, []);
});

test("page_viewed carries only a route name for tracked in-server pages", () => {
  assert.deepEqual(pageRouteFor("/s/acme/channel/123e4567-e89b-42d3-a456-426614174000"), { route: "channel" });
  assert.deepEqual(pageRouteFor("/s/acme/machine/abc"), { route: "computer" });
  assert.deepEqual(pageRouteFor("/s/acme/channel/123e4567-e89b-42d3-a456-426614174000/search"), { route: "conversation_search" });
  assert.deepEqual(pageRouteFor("/s/acme/dm/abc/search"), { route: "conversation_search" });
  assert.deepEqual(pageRouteFor("/s/acme/members/graph"), { route: "members" }, "the retired graph path is a redirect to Members, not a graph view");
  assert.deepEqual(pageRouteFor("/s/acme/assistant"), { route: "assistant" });
  assert.deepEqual(pageRouteFor("/s/acme/settings/administration"), { route: "settings", settingsTab: "administration" });
  assert.deepEqual(pageRouteFor("/s/acme/settings"), { route: "settings" });
  assert.deepEqual(pageRouteFor("/s/acme/settings/anything-typed-here"), { route: "settings" }, "unknown tabs are dropped");
  assert.deepEqual(pageRouteFor("/s/acme/settings/mcp"), { route: "settings" }, "a retired tab is a redirect, not a tab view");
  assert.deepEqual(pageRouteFor("/s/acme/settings/applications", true), { route: "settings", settingsTab: "integrations" }, "a guest's Applications is the tab `integrations` under another path");
  assert.deepEqual(pageRouteFor("/s/acme/settings/applications"), { route: "settings" }, "for everyone else Applications redirects to the Apps page");
  for (const redirecting of ["integrations", "mcp", "mcp-servers", "browser", "moderation"]) {
    assert.deepEqual(pageRouteFor(`/s/acme/settings/${redirecting}`, true), { route: "settings" }, `${redirecting} redirects: the target is the one counted`);
  }
  assert.deepEqual(pageRouteFor("/s/acme/settings/server-labs"), { route: "settings", settingsTab: "labs" }, "an alias that shows a tab without redirecting");
  assert.deepEqual(pageRouteFor("/s/acme/settings/account/delete"), { route: "settings", settingsTab: "account" });
  assert.deepEqual(pageRouteFor("/s/acme/artifacts"), { route: "artifacts" });
  assert.equal(pageRouteFor("/s/acme/threads"), null, "legacy redirects are not pages");
  assert.equal(pageRouteFor("/s/acme/"), null);
  assert.equal(pageRouteFor("/login"), null);
  assert.equal(pageRouteFor("/s/acme/constructor"), null, "no prototype keys");
});

test("the registry's settings tabs match the settings navigation, plus retired tabs older bundles may still send", () => {
  assert.deepEqual(
    [...SETTINGS_PAGE_TABS].sort(),
    [...SETTINGS_TABS.map((tab) => tab.id as string), ...RETIRED_SETTINGS_PAGE_TABS].sort(),
  );
  for (const retired of RETIRED_SETTINGS_PAGE_TABS) {
    assert.ok(!SETTINGS_TABS.some((tab) => (tab.id as string) === retired), `${retired} is retired from the navigation`);
  }
});

test("bulk_model_change_finished keeps unconfirmed results apart from failures", () => {
  assert.deepEqual(summarizeBulkModelChangeResults(["succeeded", "succeeded"]), {
    outcome: "all_succeeded",
    succeeded_count: 2,
    restart_pending_count: 0,
    save_failed_count: 0,
    unconfirmed_count: 0,
  });
  assert.deepEqual(summarizeBulkModelChangeResults(["succeeded", "restart_pending", "save_failed", "unconfirmed"]), {
    outcome: "partial",
    succeeded_count: 1,
    restart_pending_count: 1,
    save_failed_count: 1,
    unconfirmed_count: 1,
  });
  assert.equal(summarizeBulkModelChangeResults(["unconfirmed", "save_failed"]).outcome, "none_succeeded");
});

// xxchan, 2026-10-22 (task #13): the desktop app embeds the web build, so it
// says so: source `desktop`, its own version, and the web build in web_version.
// A flush never waits for the desktop bridge (John): a batch sent before it
// answers goes without app_version, and later batches carry it.
test("inside the desktop app, batches say desktop with the embedded web build, and never wait for the app's version", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  setProductEventServerIdGetter(() => "server-1");
  let answer: (version: string) => void = () => undefined;
  const pendingVersion = new Promise<string>((resolve) => { answer = resolve; });
  const hadWindow = "window" in globalThis;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { raftDesktop: { isDesktop: true, getAppVersion: () => pendingVersion } };
  try {
    trackActivityOpen("rail");
    await flushProductEvents();
    // The page closes while the bridge has still not answered: the batch goes anyway.
    trackActivityOpen("rail");
    await flushProductEvents({ onPageHide: true });
    answer("0.1.22");
    await pendingVersion;
    await Promise.resolve();
    trackActivityOpen("rail");
    await flushProductEvents();
  } finally {
    if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else delete (globalThis as { window?: unknown }).window;
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
  }
  const bodies = server.calls
    .filter((call) => call.url.endsWith("/product-events/batch"))
    .map((call) => JSON.parse(String(call.init?.body)) as { source: string; app_version?: string; web_version?: string; display_mode?: string });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]!.source, "desktop");
  assert.equal(bodies[0]!.app_version, undefined, "sent before the bridge answered, without waiting");
  assert.ok(bodies[0]!.web_version, "the embedded web build");
  assert.equal(bodies[0]!.display_mode, undefined);
  assert.equal(bodies[1]!.source, "desktop", "on page hide, still pending: sent, without app_version");
  assert.equal(bodies[1]!.app_version, undefined);
  assert.equal(bodies[2]!.app_version, "0.1.22", "the desktop app's own version, once known");
}));
