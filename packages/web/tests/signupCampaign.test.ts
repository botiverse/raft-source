import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";

import { clearSignupCampaign, rememberSignupCampaign, signupCampaignBody } from "../src/analytics/signupCampaign";
import { resetPrivacyModeForTests, setPrivacyMode } from "../src/store/privacyMode";

// The campaign link that brought a sign-up (artin / Edgar, 2026-11-13,
// #triage:#363): kept across the social round trip, valid values only.

const KEY = "raft.signup-campaign";
const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stored: Map<string, string>;

function installStorage(value: unknown): void {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value });
}

beforeEach(() => {
  resetPrivacyModeForTests();
  stored = new Map();
  installStorage({
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});

afterEach(() => {
  resetPrivacyModeForTests();
  if (original) Object.defineProperty(globalThis, "sessionStorage", original);
  else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  if (originalLocal) Object.defineProperty(globalThis, "localStorage", originalLocal);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function installSession(getItem: (key: string) => string | null): void {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem } });
}

test("a tab that is already signed in stores nothing, and keeps what a signed-out landing stored", () => {
  installSession((key) => (key === "slock_access_token" ? "token-1" : null));
  rememberSignupCampaign("?utm_source=stamp&utm_campaign=acme/widgets");
  assert.equal(stored.has(KEY), false, "a signed-in person following a campaign link is not a sign-up source");
  assert.deepEqual(signupCampaignBody(), {});

  installSession(() => null);
  rememberSignupCampaign("?utm_source=stamp");
  installSession((key) => (key === "slock_access_token" ? "token-1" : null));
  rememberSignupCampaign("?utm_source=newsletter");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp" }, "not replaced by a signed-in load");

  installSession(() => {
    throw new Error("SecurityError");
  });
  rememberSignupCampaign("?utm_source=partner");
  assert.deepEqual(signupCampaignBody(), { utm_source: "partner" }, "unreadable local storage counts as signed out");
});

test("a landing with campaign values is remembered, lowercased, for the sign-up body", () => {
  assert.deepEqual(signupCampaignBody(), {});
  rememberSignupCampaign("?utm_source=Stamp&utm_medium=public_repo&utm_campaign=Acme%2FWidgets.js&next=%2Fs%2Fx");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp", utm_medium: "public_repo", utm_campaign: "acme/widgets.js" });
  assert.deepEqual(JSON.parse(stored.get(KEY) ?? "null"), { utm_source: "stamp", utm_medium: "public_repo", utm_campaign: "acme/widgets.js" });
});

test("a later load without campaign values (the social callback) keeps what the tab held; a new campaign replaces it", () => {
  rememberSignupCampaign("?utm_source=stamp&utm_campaign=acme/widgets");
  rememberSignupCampaign("?code=abc&provider=google");
  rememberSignupCampaign("");
  rememberSignupCampaign("?utm_campaign=someone@example.com");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp", utm_campaign: "acme/widgets" });

  rememberSignupCampaign("?utm_source=newsletter");
  assert.deepEqual(signupCampaignBody(), { utm_source: "newsletter" }, "replaced whole, not merged");
});

test("cleared after a sign-up or sign-in, so a later account is not attributed", () => {
  rememberSignupCampaign("?utm_source=stamp");
  clearSignupCampaign();
  assert.deepEqual(signupCampaignBody(), {});
  assert.equal(stored.has(KEY), false);
});

test("values that are not campaign values are dropped, on the way in and on the way out", () => {
  rememberSignupCampaign("?utm_source=someone@example.com&utm_medium=public%20repo&utm_campaign=acme/widgets/issues");
  assert.equal(stored.has(KEY), false, "nothing valid: nothing stored");

  rememberSignupCampaign("?utm_source=stamp&utm_medium=a/b&utm_campaign=..");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp" });

  // Whatever else wrote the key, only valid values leave it.
  stored.set(KEY, JSON.stringify({ utm_source: "someone@example.com", utm_medium: 7, utm_campaign: "acme/widgets", email: "someone@example.com" }));
  assert.deepEqual(signupCampaignBody(), { utm_campaign: "acme/widgets" });
  for (const raw of ["not json", "null", "[]", "\"stamp\"", "42"]) {
    stored.set(KEY, raw);
    assert.deepEqual(signupCampaignBody(), {}, raw);
  }
});

test("session storage that throws, or is missing, never breaks startup or a sign-up", () => {
  const refuse = () => {
    throw new Error("SecurityError");
  };
  installStorage({ getItem: refuse, setItem: refuse, removeItem: refuse });
  rememberSignupCampaign("?utm_source=stamp");
  assert.deepEqual(signupCampaignBody(), {});
  clearSignupCampaign();

  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  rememberSignupCampaign("?utm_source=stamp");
  assert.deepEqual(signupCampaignBody(), {});
  clearSignupCampaign();
});

test("RAFT_PRIVACY_MODE: nothing is sent, and what the tab stored before the answer is removed", () => {
  rememberSignupCampaign("?utm_source=stamp&utm_campaign=acme/widgets");
  assert.equal(stored.has(KEY), true, "stored while the answer is unknown");
  setPrivacyMode(true);
  assert.equal(stored.has(KEY), false, "removed once privacy mode is known on");
  assert.deepEqual(signupCampaignBody(), {});
  rememberSignupCampaign("?utm_source=stamp");
  assert.equal(stored.has(KEY), false, "and never stored again");

  resetPrivacyModeForTests();
  setPrivacyMode(false);
  rememberSignupCampaign("?utm_source=stamp");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp" });
});

// cindyz, 2026-11-13 (#proj-analytics:72b5e0e2): the landing site's
// `ref_domain` link parameter travels with the campaign values, as `referrer_domain`.
test("the link's ref_domain is remembered as referrer_domain, a bare host name only, with or without campaign values", () => {
  rememberSignupCampaign("?ref_domain=news.ycombinator.com");
  assert.deepEqual(signupCampaignBody(), { referrer_domain: "news.ycombinator.com" });
  assert.deepEqual(JSON.parse(stored.get(KEY) ?? "null"), { referrer_domain: "news.ycombinator.com" });

  rememberSignupCampaign("?utm_source=stamp&ref_domain=WWW.Example.COM");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp", referrer_domain: "example.com" }, "lowercased, without www.");

  rememberSignupCampaign("?code=abc&provider=google");
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp", referrer_domain: "example.com" }, "kept across the social callback");

  rememberSignupCampaign("?utm_source=newsletter");
  assert.deepEqual(signupCampaignBody(), { utm_source: "newsletter" }, "replaced whole: a link without ref_domain has none");

  clearSignupCampaign();
  for (const value of ["https%3A%2F%2Fx.com", "x.com%2Fsomeone", "x.com%3A8080", "someone%40example.com", "192.168.1.10", "localhost", ""]) {
    rememberSignupCampaign(`?ref_domain=${value}`);
    assert.equal(stored.has(KEY), false, value);
  }
  rememberSignupCampaign("?referrer_domain=x.com");
  assert.equal(stored.has(KEY), false, "only the ref_domain parameter is read");

  // Whatever else wrote the key, only a host name leaves it.
  stored.set(KEY, JSON.stringify({ utm_source: "stamp", referrer_domain: "https://x.com/someone", ref_domain: "x.com" }));
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp" });
});

test("a ref_domain that is Raft's own site is not a value: alone it leaves the tab's record untouched", () => {
  rememberSignupCampaign("?utm_source=stamp&utm_campaign=acme/widgets&ref_domain=x.com");
  const held = { utm_source: "stamp", utm_campaign: "acme/widgets", referrer_domain: "x.com" };
  for (const own of ["raft.build", "www.raft.build", "RAFT.BUILD", "docs.raft.build", "app.raft.build"]) {
    rememberSignupCampaign(`?ref_domain=${own}`);
    assert.deepEqual(signupCampaignBody(), held, own);
  }

  clearSignupCampaign();
  rememberSignupCampaign("?ref_domain=raft.build");
  assert.equal(stored.has(KEY), false, "nothing valid: nothing stored");

  // With campaign values it is a campaign link like any other, without a referrer.
  rememberSignupCampaign("?utm_source=newsletter&ref_domain=docs.raft.build");
  assert.deepEqual(signupCampaignBody(), { utm_source: "newsletter" });

  // A host that only looks like it is somebody else's.
  rememberSignupCampaign("?ref_domain=raft.build.evil.com");
  assert.deepEqual(signupCampaignBody(), { referrer_domain: "raft.build.evil.com" });
  rememberSignupCampaign("?ref_domain=notraft.build");
  assert.deepEqual(signupCampaignBody(), { referrer_domain: "notraft.build" });

  // Whatever else wrote the key, it does not leave it.
  stored.set(KEY, JSON.stringify({ utm_source: "stamp", referrer_domain: "docs.raft.build" }));
  assert.deepEqual(signupCampaignBody(), { utm_source: "stamp" });
});

test("ref_domain follows the campaign's rules: nothing stored when signed in, removed under privacy mode", () => {
  installSession((key) => (key === "slock_access_token" ? "token-1" : null));
  rememberSignupCampaign("?ref_domain=x.com");
  assert.equal(stored.has(KEY), false);

  installSession(() => null);
  rememberSignupCampaign("?ref_domain=x.com");
  assert.deepEqual(signupCampaignBody(), { referrer_domain: "x.com" });
  setPrivacyMode(true);
  assert.equal(stored.has(KEY), false);
  assert.deepEqual(signupCampaignBody(), {});
});
