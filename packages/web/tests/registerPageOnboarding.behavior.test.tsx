import assert from "node:assert/strict";
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

test("create account is a standalone credential page without identity fields or wizard chrome", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { providers: [] } }));
  const { container } = renderPage();

  assert.ok(screen.getByRole("heading", { name: "Create your account" }));
  assert.ok(container.querySelector("aside") === null);
  assert.equal(container.querySelectorAll("i.bg-palette-pink, i.bg-palette-yellow").length, 0);
  assert.ok(container.querySelector('[class*="radial-gradient"]') === null);
  assert.ok(container.querySelector('[class*="lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]"]') === null);
  assert.ok(container.querySelector(".h-panel-header"));
  assert.ok(container.querySelector(".max-w-md"));
  // No future-step preview copy (Cat's principle: each line serves the current
  // step only; "X comes next" is low-value distraction here).
  assert.ok(screen.queryByText(/come next/i) === null);
  assert.ok(screen.getByLabelText("Email"));
  assert.ok(screen.getByLabelText("Password"));
  // Min-length is carried by the placeholder only; the redundant helper line is gone.
  assert.ok(screen.queryByText("At least 8 characters.") === null);
  assert.ok(screen.queryByLabelText("Display name") === null);
  assert.ok(screen.queryByLabelText("@handle") === null);
  assert.ok(screen.queryByText("Profile picture") === null);
  assert.ok(screen.queryByText(/Step \d/i) === null);
  assert.ok(screen.queryByText(/skips this step/i) === null);
});

test("create account submits email, password, and legal acceptance only", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { providers: [] } }));
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

test("create account exposes configured Google and GitHub entry buttons without explanatory skip copy", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
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
  assert.ok(screen.queryByText(/goes straight to identity setup/i) === null);
});

test("sign-up reads checkbox, Continue, then the usage-data notice, with no disabled-reason line", async () => {
  // cindyz, 2026-11-05: the usage-data notice sits directly under Continue, and
  // the "Agree to the Terms ... to continue." line under it is gone (the
  // checkbox label already says what is required).
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: { providers: [] } }));
  renderPage();

  const checkbox = screen.getByRole("checkbox");
  const submit = screen.getByRole("button", { name: "Continue" });
  const notice = screen.getByTestId("legal-acceptance-usage-data-notice");
  assert.equal(notice.textContent, "Raft collects usage data to improve the product. You can turn it off anytime in Settings.");
  // Booleans only in assertions: a failing assert on a DOM node prints the whole jsdom graph.
  const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  assert.ok(follows(checkbox, submit), "Continue comes after the checkbox");
  assert.ok(follows(submit, notice), "the notice comes after Continue");
  assert.ok(submit.nextElementSibling === notice, "the notice is directly below Continue");
  assert.ok(notice.closest("label") === null, "the notice is not part of the checkbox label");
  assert.ok(notice.id !== "" && submit.getAttribute("aria-describedby") === notice.id, "Continue is described by the notice");

  assert.ok(submit.hasAttribute("disabled"));
  assert.ok(screen.queryByText(/to continue\./) === null, "no disabled-reason line");
  fireEvent.click(notice);
  assert.equal((checkbox as HTMLButtonElement).getAttribute("aria-checked"), "false", "clicking the notice does not accept the terms");

  fireEvent.click(checkbox);
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"), false));
  assert.ok(screen.getByTestId("legal-acceptance-usage-data-notice"), "the notice stays once the box is checked");
});
