import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import api from "../src/api/client";
import RegisterPage from "../src/components/auth/RegisterPage";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { __resetAuthProvidersForTest } from "../src/hooks/useAuthProviders";
import { useAuthStore } from "../src/store/authStore";

const initialAuthState = useAuthStore.getInitialState();

function renderPage() {
  const switched: string[] = [];
  // RegisterPage and the shared LegalAcceptanceCheckbox read copy through
  // react-intl now. Real providers, not a stub catalog, so the getByLabelText /
  // getByRole queries below still assert the English users actually see.
  const view = render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <RegisterPage onSwitchToLogin={() => switched.push("login")} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
  return { ...view, switched };
}

beforeEach(() => {
  __resetAuthProvidersForTest();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  __resetAuthProvidersForTest();
  useAuthStore.setState(initialAuthState, true);
});

test("create account is a standalone credential page without identity fields or wizard chrome", async (t) => {
  t.mock.method(api, "get", async () => ({ data: { providers: [] } }));
  const { container } = renderPage();

  assert.ok(screen.getByRole("heading", { name: "Create your account" }));
  assert.equal(container.querySelector("aside"), null);
  assert.equal(container.querySelectorAll("i.bg-brutal-pink, i.bg-soft-signal").length, 0);
  assert.equal(container.querySelector('[class*="radial-gradient"]'), null);
  assert.equal(container.querySelector('[class*="lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]"]'), null);
  assert.ok(container.querySelector(".h-panel-header"));
  assert.ok(container.querySelector(".max-w-md"));
  // No future-step preview copy (Cat's principle: each line serves the current
  // step only; "X comes next" is low-value distraction here).
  assert.equal(screen.queryByText(/come next/i), null);
  assert.ok(screen.getByLabelText("Email"));
  assert.ok(screen.getByLabelText("Password"));
  // Min-length is carried by the placeholder only; the redundant helper line is gone.
  assert.equal(screen.queryByText("At least 8 characters."), null);
  assert.equal(screen.queryByLabelText("Display name"), null);
  assert.equal(screen.queryByLabelText("@handle"), null);
  assert.equal(screen.queryByText("Profile picture"), null);
  assert.equal(screen.queryByText(/Step \d/i), null);
  assert.equal(screen.queryByText(/skips this step/i), null);
});

test("create account submits email, password, and legal acceptance only", async (t) => {
  t.mock.method(api, "get", async () => ({ data: { providers: [] } }));
  const calls: unknown[][] = [];
  useAuthStore.setState({
    loading: false,
    register: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as never);
  renderPage();

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "cindy@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0][0], "cindy@example.com");
  assert.equal(calls[0][1], "password123");
  assert.deepEqual(calls[0][2], {
    acceptTerms: true,
    termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
    privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    legalAcceptanceSource: "signup",
  });
});

test("create account exposes configured Google and GitHub entry buttons without explanatory skip copy", async (t) => {
  t.mock.method(api, "get", async () => ({
    data: {
      providers: [
        { id: "google", label: "Google", enabled: true },
        { id: "github", label: "GitHub", enabled: true },
      ],
    },
  }));
  renderPage();

  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Continue with Google" }));
    assert.ok(screen.getByRole("button", { name: "Continue with GitHub" }));
  });
  assert.equal(screen.queryByText(/goes straight to identity setup/i), null);
});
