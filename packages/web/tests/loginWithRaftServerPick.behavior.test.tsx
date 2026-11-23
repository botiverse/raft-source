/**
 * Login with Raft's Server picker: which Server the page picks by itself.
 * With more than one Server where the App can be used (suspended
 * installations not counted) and no `server` hint, none is picked and Login
 * with Raft stays off until the person picks: an App adding another Server
 * (Stamp's "add a server") would otherwise land on the one already signed in.
 * One Server to choose from, or a hint, picks it as before. The API is
 * stubbed at the axios client.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { initialServerPick } from "../src/features/login-with-raft/loginClientSummary";
import type { AvailableServerClient } from "../src/features/login-with-raft/loginClientSummary";
import HumanLoginSetupPage from "../src/pages/HumanLoginSetupPage";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalApiGet = api.get;

function server(id: string, name: string, slug: string): Server {
  return {
    id,
    name,
    avatarUrl: null,
    slug,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "pro",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-06-25T00:00:00.000Z",
  };
}

const alpha = server("server-a", "Alpha Server", "alpha");
const beta = server("server-b", "Beta Server", "beta");

function seedStores(servers: Server[]) {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      name: "Owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({ servers, current: servers[0], members: [], loading: false } as never);
}

function openLoginPage(search: string, availability: (serverId: string) => string = () => "ready") {
  window.history.pushState({}, "", `/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn${search}`);
  const lookups: string[] = [];
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    lookups.push(config?.params?.server_id ?? "");
    return {
      data: {
        id: "app-1",
        clientId: "orbital-notes",
        appType: "third_party_global",
        name: "Orbital Notes",
        description: "Review launch notes from Raft.",
        homepageUrl: null,
        returnUrl: "https://orbital.example.com/return",
        logoUrl: null,
        availability: availability(config?.params?.server_id ?? ""),
      },
    };
  }) as typeof api.get;
  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);
  return lookups;
}

/** The picker's shown value: null while it shows its placeholder (nothing picked). */
function pickedServerText(): string | null {
  const value = document.querySelector('[data-slot="select-value"]');
  if (!value) return "(no picker)";
  return value.hasAttribute("data-placeholder") ? null : value.textContent ?? "";
}

async function loginButton() {
  return screen.findByRole("button", { name: "Login with Raft" });
}

beforeEach(() => {
  resetServerFeatureFlagsForTests();
});

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  localStorage.clear();
  window.history.pushState({}, "", "/");
});

test("several Servers and no server hint: none is picked and Login with Raft stays off", async () => {
  seedStores([alpha, beta]);
  const lookups = openLoginPage("");
  const button = await loginButton();

  await waitFor(() => assert.deepEqual([...lookups].sort(), ["server-a", "server-b"]));
  // The pick is set with the lookup answers that show the picker: once it shows, the pick is final.
  await waitFor(() => assert.ok(document.querySelector('[data-slot="select-value"]'), "the picker is shown"));
  assert.equal(pickedServerText(), null, "nothing picked");
  assert.equal(button.hasAttribute("disabled"), true, "nothing picked, so nothing to log in to");
  assert.ok((document.querySelector("h1")?.textContent ?? "").includes("Orbital Notes"), "the App's name still heads the page");
});

test("several Servers with a server hint: the hinted one is picked as before", async () => {
  seedStores([alpha, beta]);
  const lookups = openLoginPage("&server=beta");
  const button = await loginButton();

  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false), { timeout: 5000 });
  assert.deepEqual(lookups, ["server-b"]);
  assert.match(pickedServerText() ?? "", /Beta Server/);
});

test("one Server and no server hint: it is picked as before", async () => {
  seedStores([alpha]);
  openLoginPage("");
  const button = await loginButton();

  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false), { timeout: 5000 });
  assert.match(pickedServerText() ?? "", /Alpha Server/);
});

test("one ready Server and one suspended, no server hint: the ready one is picked", async () => {
  seedStores([alpha, beta]);
  openLoginPage("", (serverId) => (serverId === beta.id ? "suspended" : "ready"));
  const button = await loginButton();

  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false), { timeout: 5000 });
  assert.match(pickedServerText() ?? "", /Alpha Server/);
});

test("initialServerPick: none for several choices, suspended ones not counted; the first by rank otherwise", () => {
  const entry = (s: Server, availability = "ready"): AvailableServerClient => ({ server: s, client: { availability } } as never);
  assert.equal(initialServerPick([entry(beta), entry(alpha)]), "");
  assert.equal(initialServerPick([entry(beta)]), "server-b");
  assert.equal(initialServerPick([entry(beta, "suspended"), entry(alpha)]), "server-a");
  assert.equal(initialServerPick([]), "");
});
