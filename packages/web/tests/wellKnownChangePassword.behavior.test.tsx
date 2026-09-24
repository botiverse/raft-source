import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { AccountSection } from "../src/components/settings/SettingsPanel";
import { __resetAuthProvidersForTest } from "../src/hooks/useAuthProviders";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";

const originalApiGet = api.get;
const originalApiPatch = api.patch;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.patch = originalApiPatch;
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

function renderPasswordIntent() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <AccountSection passwordChangeIntent />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

test("a local-password account opens the form directly with password-manager autocomplete", async () => {
  seedUser();
  api.get = (async (url: string) => {
    if (url === "/auth/providers") return { data: { providers: [] } };
    if (url === "/auth/identities") {
      return { data: { identities: [], passwordConfigured: true } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  renderPasswordIntent();
  assert.ok(screen.getByText("Loading sign-in methods…"));

  const current = await screen.findByLabelText("Current Password");
  const next = screen.getByLabelText("New Password");
  const confirm = screen.getByLabelText("Confirm Password");
  assert.equal(current.getAttribute("autocomplete"), "current-password");
  assert.equal(next.getAttribute("autocomplete"), "new-password");
  assert.equal(confirm.getAttribute("autocomplete"), "new-password");
});

test("an ordinary settings password change keeps the confirmation visible", async () => {
  seedUser();
  api.get = (async (url: string) => {
    if (url === "/auth/providers") return { data: { providers: [] } };
    if (url === "/auth/identities") {
      return { data: { identities: [], passwordConfigured: true } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = (async (url: string, fields: unknown) => {
    assert.equal(url, "/auth/me");
    assert.deepEqual(fields, {
      currentPassword: "old-password",
      newPassword: "new-password",
    });
    return { data: useAuthStore.getState().user };
  }) as typeof api.patch;

  render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <AccountSection />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Change Password" }));

  const current = await screen.findByLabelText("Current Password");
  fireEvent.change(current, { target: { value: "old-password" } });
  fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "new-password" } });
  const changePasswordButtons = screen.getAllByRole("button", { name: "Change Password" });
  fireEvent.click(changePasswordButtons.at(-1)!);

  assert.ok(await screen.findByText("Password updated!"));
  assert.equal(current.isConnected, true);
});

test("a social-only account shows provider-managed guidance and never exposes current-password", async () => {
  seedUser();
  api.get = (async (url: string) => {
    if (url === "/auth/providers") {
      return { data: { providers: [{ id: "github", label: "GitHub", enabled: true }] } };
    }
    if (url === "/auth/identities") {
      return {
        data: {
          identities: [{ provider: "github", providerEmail: "owner@example.com" }],
          passwordConfigured: false,
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  renderPasswordIntent();
  assert.ok(await screen.findByTestId("password-managed-by-provider"));
  assert.ok(screen.getByText("This Raft account does not have a local password. Change your password with GitHub."));
  assert.equal(screen.queryByLabelText("Current Password"), null);
  assert.equal(screen.queryByRole("button", { name: "Set password by email" }), null);
});
