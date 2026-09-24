import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { AccountSection } from "../src/components/settings/SettingsPanel";
import { __resetAuthProvidersForTest } from "../src/hooks/useAuthProviders";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiDelete = api.delete;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.delete = originalApiDelete;
  __resetAuthProvidersForTest();
  useAuthStore.setState({ user: null } as never);
});

function seedUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "off",
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
}

function renderAccount() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <AccountSection />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function stubMethods(params: {
  passwordConfigured: boolean;
  identities: Array<{ provider: "google" | "github"; providerEmail: string }>;
}) {
  api.get = (async (url: string) => {
    if (url === "/auth/providers") {
      return {
        data: {
          providers: [
            { id: "google", label: "Google", enabled: true },
            { id: "github", label: "GitHub", enabled: true },
          ],
        },
      };
    }
    if (url === "/auth/identities") {
      return { data: params };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
}

test("an established password allows confirmed disconnect and refreshes the provider row", async () => {
  seedUser();
  stubMethods({
    passwordConfigured: true,
    identities: [{ provider: "google", providerEmail: "google@example.com" }],
  });
  const deletes: string[] = [];
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: { unlinked: true, identities: [], passwordConfigured: true } };
  }) as typeof api.delete;

  renderAccount();
  assert.ok(await screen.findByText("Connected as google@example.com"));

  fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
  assert.ok(screen.getByRole("dialog", { name: "Disconnect Google" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));

  await waitFor(() => assert.deepEqual(deletes, ["/auth/identities/google"]));
  const googleAccount = screen.getByRole("group", { name: "Google account" });
  await waitFor(() => assert.ok(within(googleAccount).getByText("Not connected")));
  assert.ok(within(googleAccount).getByRole("button", { name: "Connect" }));
});

test("the final social identity routes through verified password setup instead of deleting", async () => {
  seedUser();
  stubMethods({
    passwordConfigured: false,
    identities: [{ provider: "github", providerEmail: "github@example.com" }],
  });
  const posts: Array<{ url: string; body: unknown }> = [];
  let deleteCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;
  api.delete = (async () => {
    deleteCalls += 1;
    return { data: {} };
  }) as typeof api.delete;

  renderAccount();
  assert.ok(await screen.findByText("Connected as github@example.com"));

  fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
  assert.ok(screen.getByRole("dialog", { name: "Set a password first" }));
  assert.ok(screen.getByText("GitHub is your only sign-in account. Set a password before disconnecting it so you do not lose access."));
  fireEvent.click(screen.getByRole("button", { name: "Send setup email" }));

  await waitFor(() => assert.deepEqual(posts, [{
    url: "/auth/forgot-password",
    body: { email: "owner@example.com" },
  }]));
  assert.equal(deleteCalls, 0, "the client must not optimistically delete the final login method");
  assert.ok(await screen.findByText("Password setup email sent. Use the link, then return here to disconnect GitHub."));
  assert.ok(screen.getByText("Connected as github@example.com"), "identity stays connected until setup completes");
});

test("a passwordless account may disconnect one of two social identities", async () => {
  seedUser();
  stubMethods({
    passwordConfigured: false,
    identities: [
      { provider: "google", providerEmail: "google@example.com" },
      { provider: "github", providerEmail: "github@example.com" },
    ],
  });
  const deletes: string[] = [];
  api.delete = (async (url: string) => {
    deletes.push(url);
    return {
      data: {
        unlinked: true,
        identities: [{ provider: "github", providerEmail: "github@example.com" }],
        passwordConfigured: false,
      },
    };
  }) as typeof api.delete;

  renderAccount();
  await screen.findByText("Connected as google@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));

  assert.ok(screen.getByRole("dialog", { name: "Disconnect Google" }), "a non-final identity uses the ordinary disconnect flow");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));
  await waitFor(() => assert.deepEqual(deletes, ["/auth/identities/google"]));
});
