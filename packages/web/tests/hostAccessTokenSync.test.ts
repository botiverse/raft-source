import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_ACCESS_TOKEN_UPDATED_EVENT,
  accessTokenSubject,
  createHostAccessTokenSync,
  hostAccessTokenSurfaceForPathname,
  parseHostAccessTokenBinding,
  parseHostAccessTokenBindingStorage,
  parseHostAccessTokenEventDetail,
} from "../src/utils/hostAccessTokenSync.js";
import type {
  HostAccessTokenContext,
  HostAccessTokenBinding,
  HostAccessTokenEventDetail,
} from "../src/utils/hostAccessTokenSync.js";

const detail = (overrides: Partial<HostAccessTokenEventDetail> = {}): HostAccessTokenEventDetail => ({
  accountId: "account-1",
  serverId: "server-1",
  sessionGeneration: 4,
  webViewGeneration: 7,
  sequence: 1,
  ...overrides,
});

const event = (value: unknown) => new CustomEvent(HOST_ACCESS_TOKEN_UPDATED_EVENT, { detail: value });

function harness(
  expectedBinding: HostAccessTokenBinding | null = {
    accountId: "account-1",
    serverId: "server-1",
    sessionGeneration: 4,
    webViewGeneration: 7,
  },
) {
  const target = new EventTarget();
  const scheduled: Array<() => void> = [];
  const committed: string[] = [];
  let accessTokenReads = 0;
  let storedAccessToken: string | null = "access-2";
  let context: HostAccessTokenContext = {
    hostShell: true,
    surface: "computers",
    accountId: "account-1",
    serverId: "server-1",
  };
  const sync = createHostAccessTokenSync({
    eventTarget: target,
    expectedBinding,
    readContext: () => context,
    readAccessToken: () => {
      accessTokenReads += 1;
      return storedAccessToken;
    },
    commitAccessOnlyToken: (token) => committed.push(token),
    schedule: (task) => scheduled.push(task),
  });
  const flush = () => scheduled.splice(0).forEach((task) => task());
  return {
    target,
    committed,
    accessTokenReads: () => accessTokenReads,
    flush,
    sync,
    setContext: (next: HostAccessTokenContext) => { context = next; },
    setStoredAccessToken: (token: string | null) => { storedAccessToken = token; },
  };
}

test("all four native settings surfaces share the same path classifier", () => {
  assert.equal(hostAccessTokenSurfaceForPathname("/s/dev/computers"), "computers");
  assert.equal(hostAccessTokenSurfaceForPathname("/s/dev/settings/billing"), "billing");
  assert.equal(hostAccessTokenSurfaceForPathname("/s/dev/settings/applications"), "marketplace");
  assert.equal(hostAccessTokenSurfaceForPathname("/s/dev/settings/integrations"), "marketplace");
  assert.equal(hostAccessTokenSurfaceForPathname("/s/dev/settings/administration"), "administration");
  assert.equal(hostAccessTokenSurfaceForPathname("/computers"), "computers");
  assert.equal(hostAccessTokenSurfaceForPathname("/settings/billing"), "billing");
  assert.equal(hostAccessTokenSurfaceForPathname("/settings/applications"), "marketplace");
  assert.equal(hostAccessTokenSurfaceForPathname("/settings/integrations"), "marketplace");
  assert.equal(hostAccessTokenSurfaceForPathname("/settings/administration"), "administration");
  assert.equal(hostAccessTokenSurfaceForPathname("/settings/profile"), null);
});

test("event detail is access-only fence metadata with strict integer generations", () => {
  assert.deepEqual(parseHostAccessTokenEventDetail(detail()), detail());
  assert.equal(parseHostAccessTokenEventDetail({ ...detail(), sequence: 1.5 }), null);
  assert.equal(parseHostAccessTokenEventDetail({ ...detail(), sessionGeneration: -1 }), null);
  assert.equal(parseHostAccessTokenEventDetail({ ...detail(), accessToken: "must-not-be-consumed" }), null);
  assert.equal(parseHostAccessTokenEventDetail({ ...detail(), futureField: true }), null);
});

test("document-start binding storage is exact, finite, and fail-closed", () => {
  const binding = {
    accountId: "account-1",
    serverId: "server-1",
    sessionGeneration: 4,
    webViewGeneration: 7,
  };
  assert.deepEqual(parseHostAccessTokenBinding(binding), binding);
  assert.deepEqual(parseHostAccessTokenBindingStorage(JSON.stringify(binding)), binding);
  assert.equal(parseHostAccessTokenBindingStorage(null), null);
  assert.equal(parseHostAccessTokenBindingStorage("not-json"), null);
  assert.equal(parseHostAccessTokenBinding({ ...binding, sequence: 1 }), null);
  assert.equal(parseHostAccessTokenBinding({ ...binding, accountId: "" }), null);
  assert.equal(parseHostAccessTokenBinding({ ...binding, webViewGeneration: -1 }), null);
});

test("the expected document binding is latched and cannot be retargeted after install", () => {
  const binding = {
    accountId: "account-1",
    serverId: "server-1",
    sessionGeneration: 4,
    webViewGeneration: 7,
  };
  const h = harness(binding);
  binding.webViewGeneration = 99;
  h.target.dispatchEvent(event(detail({ webViewGeneration: 99, sequence: 1 })));
  assert.equal(h.accessTokenReads(), 0);
  h.target.dispatchEvent(event(detail({ webViewGeneration: 7, sequence: 1 })));
  h.flush();
  assert.deepEqual(h.committed, ["access-2"]);
  h.sync.close();
});

test("host event rereads storage and commits only the latest single-flight token", () => {
  const h = harness();
  h.target.dispatchEvent(event(detail({ sequence: 1 })));
  h.setStoredAccessToken("access-3");
  h.target.dispatchEvent(event(detail({ sequence: 2 })));
  assert.deepEqual(h.committed, []);

  h.flush();
  assert.deepEqual(h.committed, ["access-3"]);
  h.sync.close();
});

test("only sequence advances inside the exact bootstrapped binding", () => {
  const h = harness();
  h.target.dispatchEvent(event(detail({ sequence: 9 })));
  h.setStoredAccessToken("stale-sequence");
  h.target.dispatchEvent(event(detail({ sequence: 8 })));
  h.setStoredAccessToken("wrong-binding");
  h.target.dispatchEvent(event(detail({ webViewGeneration: 8, sequence: 99 })));

  h.flush();
  assert.deepEqual(h.committed, ["access-2"]);
  h.sync.close();
});

test("first wrong generation and same-account ABA old binding never read or commit the token", () => {
  const unbootstrapped = harness(null);
  unbootstrapped.target.dispatchEvent(event(detail()));
  assert.equal(unbootstrapped.accessTokenReads(), 0, "missing bootstrap must fail closed");
  unbootstrapped.sync.close();

  const current = harness({
    accountId: "account-1",
    serverId: "server-1",
    sessionGeneration: 8,
    webViewGeneration: 12,
  });
  current.target.dispatchEvent(
    event(detail({ sessionGeneration: 99, webViewGeneration: 99, sequence: 999 })),
  );
  assert.equal(current.accessTokenReads(), 0, "wrong binding must be rejected before storage read");

  current.target.dispatchEvent(
    event(detail({ sessionGeneration: 7, webViewGeneration: 11, sequence: 9999 })),
  );
  assert.equal(current.accessTokenReads(), 0, "old ABA binding must not self-establish truth");

  current.setStoredAccessToken("fresh-current-token");
  current.target.dispatchEvent(
    event(detail({ sessionGeneration: 8, webViewGeneration: 12, sequence: 1 })),
  );
  current.flush();
  assert.deepEqual(current.committed, ["fresh-current-token"]);
  current.sync.close();
});

test("missing token, logout, cross-server, stale and duplicate events fail closed", () => {
  const h = harness();
  h.setStoredAccessToken(null);
  h.target.dispatchEvent(event(detail({ sequence: 1 })));
  h.flush();

  h.setStoredAccessToken("access-4");
  h.setContext({ hostShell: false, surface: "billing", accountId: "account-1", serverId: "server-1" });
  h.target.dispatchEvent(event(detail({ sequence: 2 })));
  h.setContext({ hostShell: true, surface: "billing", accountId: null, serverId: "server-1" });
  h.target.dispatchEvent(event(detail({ sequence: 3 })));
  h.setContext({ hostShell: true, surface: "billing", accountId: "account-1", serverId: "server-2" });
  h.target.dispatchEvent(event(detail({ sequence: 4 })));
  h.setContext({ hostShell: true, surface: "billing", accountId: "account-1", serverId: "server-1" });
  h.target.dispatchEvent(event(detail({ sessionGeneration: 3, sequence: 99 })));
  h.target.dispatchEvent(event(detail({ sequence: 5 })));
  h.target.dispatchEvent(event(detail({ sequence: 5 })));
  h.flush();

  assert.deepEqual(h.committed, ["access-4"]);
  h.sync.close();
});

test("context changes before the scheduled commit and page disposal both cancel updates", () => {
  const h = harness();
  h.target.dispatchEvent(event(detail()));
  h.setContext({ hostShell: true, surface: "computers", accountId: "account-1", serverId: "server-2" });
  h.flush();
  assert.deepEqual(h.committed, []);

  h.setContext({ hostShell: true, surface: "computers", accountId: "account-1", serverId: "server-1" });
  h.target.dispatchEvent(new Event("pagehide"));
  h.target.dispatchEvent(event(detail({ sequence: 2 })));
  h.flush();
  assert.deepEqual(h.committed, []);
});

test("JWT subject fallback accepts only access-token claims", () => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.equal(accessTokenSubject(`x.${encode({ sub: "account-1", type: "access" })}.x`), "account-1");
  assert.equal(accessTokenSubject(`x.${encode({ sub: "account-1", type: "refresh" })}.x`), null);
  assert.equal(accessTokenSubject("not-a-jwt"), null);
});
