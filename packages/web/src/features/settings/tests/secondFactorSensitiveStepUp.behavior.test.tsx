// "Verify it's you" before a sensitive action (design v8 §3, dlg-stepup;
// server stepUpGate.ts, PR 5): with two-step verification on, changing the
// password, connecting or disconnecting a sign-in method and creating an
// agent key answer 403 `second_factor_step_up_required` with the methods
// unless this sign-in passed the second step in the last 10 minutes. The one
// dialog (SecondFactorStepUpHost) asks for it, POST /step-up marks it, and
// the refused request goes once more. Closing the dialog does nothing and
// says nothing. Without two-step verification nothing is refused, so nothing
// changes. The API is stubbed at the axios client; the browser's WebAuthn by
// helpers/fakeWebAuthn, Raft Desktop's loopback by helpers/fakeDesktopAuth.
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

import api from "../../../api/client";
import { ExternalAgentConnectionCard } from "../../agent/ExternalAgentConnectionCard";
import SecondFactorStepUpHost from "../../../components/settings/SecondFactorStepUpHost";
import { AccountSection } from "../account/AccountSection";
import { resetSecondFactorStepUpForTests } from "../../../components/settings/secondFactorStepUp";
import { __resetAuthProvidersForTest } from "../../../hooks/useAuthProviders";
import { IntlProviderWrapper } from "../../../i18n/IntlProviderWrapper";
import { LocaleProvider } from "../../../i18n/LocaleProvider";
import { en } from "../../../i18n/messages/en";
import { useAuthStore } from "../../../store/authStore";
import { installFakeDesktopAuth } from "../../../../tests/helpers/fakeDesktopAuth";
import type { FakeDesktopAuth } from "../../../../tests/helpers/fakeDesktopAuth";
import { assertionJSON, credentialFor, installFakeWebAuthn } from "../../../../tests/helpers/fakeWebAuthn";
import type { FakeWebAuthn } from "../../../../tests/helpers/fakeWebAuthn";

const STEP_UP_URL = "/auth/second-factor/step-up";
const ASSERTION_OPTIONS_URL = "/auth/second-factor/passkeys/assertion/options";
const ASSERTION_OPTIONS = { options: { challenge: "a".repeat(43), rpId: "localhost", userVerification: "required", allowCredentials: [{ id: "Y3JlZA", type: "public-key" }] } };
const LAST_METHOD_KEY = "raft.second-factor.last-method";
const SIGN_IN_METHOD_DESCRIPTION = en["settings.twoStep.stepUpDescription"];
const AGENT_KEY_DESCRIPTION = en["settings.twoStep.stepUpAgentKeyDescription"];
const WRONG_CODE = en["settings.twoStep.codeInvalid"];
const API_KEY = "sk_agent_stepped-up-fixture";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiPatch = api.patch;
const originalApiDelete = api.delete;
const originalLogout = useAuthStore.getState().logout;
let webauthn: FakeWebAuthn | null = null;
let desktop: FakeDesktopAuth | null = null;

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  webauthn?.restore();
  webauthn = null;
  desktop?.cleanup();
  desktop = null;
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  api.delete = originalApiDelete;
  __resetAuthProvidersForTest();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  useAuthStore.setState({ user: null, logout: originalLogout } as never);
});

function seedUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
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

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function stepUpRequired(error: string, methods: string[] = ["totp", "backup_code"]) {
  return httpError(403, { error, code: "second_factor_step_up_required", methods });
}

type Identity = { provider: "google" | "github"; providerEmail: string };

/** The Account page's GETs; the identities read from the getter each time. */
function stubGets(identities: () => Identity[]) {
  api.get = (async (url: string) => {
    if (url === "/auth/providers") {
      return { data: { providers: [{ id: "google", label: "Google", enabled: true }, { id: "github", label: "GitHub", enabled: true }] } };
    }
    if (url === "/auth/identities") return { data: { identities: identities(), passwordConfigured: true } };
    if (/^\/agents\/[^/]+\/credentials$/.test(url)) return { data: { agentId: url.split("/")[2], credentials: [] } };
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
}

type Handler = (body: unknown) => unknown;
type Call = { method: string; url: string; body: unknown };

/** POST / PATCH / DELETE by "METHOD url"; each answers with its handlers in turn (the last one repeats). */
function stubWrites(handlers: Record<string, Handler[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const answer = (method: string, url: string, body: unknown) => {
    calls.push({ method, url, body });
    const key = `${method} ${url}`;
    const queue = handlers[key];
    if (!queue) throw new Error(`Unexpected ${key}`);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  };
  api.post = (async (url: string, body?: unknown) => answer("POST", url, body)) as typeof api.post;
  api.patch = (async (url: string, body?: unknown) => answer("PATCH", url, body)) as typeof api.patch;
  api.delete = (async (url: string, config?: { data?: unknown }) => answer("DELETE", url, config?.data)) as typeof api.delete;
  return calls;
}

function fail(err: Error): Handler {
  return () => {
    throw err;
  };
}

function renderWithHost(ui: ReactNode) {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          {ui}
          <SecondFactorStepUpHost />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  fireEvent.click(button);
}

/** The dialog is loaded on first use (lazy), so it may take a moment. */
function findVerifyDialog() {
  return screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
}

async function enterCode(dialog: HTMLElement, label: string, code: string) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value: code } });
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Verify" }));
}

async function closeVerifyDialog(dialog: HTMLElement) {
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null));
}

// ── Password change (Settings › Account) ──

const PASSWORD_BODY = { currentPassword: "old-password-1", newPassword: "a-new-password-123" };
const PASSWORD_REFUSAL = "Confirm it's you with your second step before changing your password.";

async function submitPasswordChange() {
  fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: PASSWORD_BODY.currentPassword } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD_BODY.newPassword } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD_BODY.newPassword } });
  const form = screen.getByLabelText("Current password").closest("form");
  assert.ok(form !== null);
  fireEvent.submit(form);
}

function passwordUpdated() {
  return { ...useAuthStore.getState().user };
}

test("password change: a refusal asks for a code, then the change goes through once more", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL)), passwordUpdated],
    [`POST ${STEP_UP_URL}`]: [() => ({ verified: true })],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();

  const verify = await findVerifyDialog();
  assert.ok(within(verify).getByText(SIGN_IN_METHOD_DESCRIPTION));
  // Only the methods the server listed: no passkey here.
  assert.ok(within(verify).queryByRole("button", { name: "Use a passkey" }) === null);
  await enterCode(verify, "Authenticator code", "123 456");

  assert.ok(await screen.findByText("Password updated!"));
  assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null);
  assert.deepEqual(calls, [
    { method: "PATCH", url: "/auth/me", body: PASSWORD_BODY },
    { method: "POST", url: STEP_UP_URL, body: { code: "123456" } },
    { method: "PATCH", url: "/auth/me", body: PASSWORD_BODY },
  ]);
  assert.equal(localStorage.getItem(LAST_METHOD_KEY), "totp");
});

test("password change: a wrong code stays in the dialog under the field; the right one goes on", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL)), passwordUpdated],
    [`POST ${STEP_UP_URL}`]: [
      fail(httpError(400, { error: "Invalid code", code: "second_factor_code_invalid" })),
      () => ({ verified: true }),
    ],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();

  const verify = await findVerifyDialog();
  await enterCode(verify, "Authenticator code", "000000");
  assert.ok(await within(verify).findByText(WRONG_CODE));
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "not retried after a wrong code");

  await enterCode(verify, "Authenticator code", "123456");
  assert.ok(await screen.findByText("Password updated!"));
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 2);
});

test("password change: a used backup code says so; too many wrong codes says until when", async () => {
  seedUser();
  stubGets(() => []);
  stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL))],
    [`POST ${STEP_UP_URL}`]: [
      fail(httpError(400, { error: "Used", code: "backup_code_used" })),
      fail(httpError(429, { error: "Locked", code: "second_factor_locked", lockedUntil: "2026-10-31T12:30:00.000Z" })),
    ],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();

  const verify = await findVerifyDialog();
  fireEvent.click(within(verify).getByRole("button", { name: "Use a backup code" }));
  await enterCode(verify, "Backup code", "k7p2m-9qztx");
  assert.ok(await within(verify).findByText(en["settings.twoStep.backupCodeUsed"]));
  await enterCode(verify, "Backup code", "a1b2c-3d4e5");
  assert.ok(await within(verify).findByText(/^Too many wrong codes\. Try again after .+\.$/));
});

test("password change: closing the dialog changes nothing and shows no error", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL))],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();
  await closeVerifyDialog(await findVerifyDialog());

  const submit = screen.getAllByRole("button", { name: "Change password" }).find((button) => button.getAttribute("type") === "submit");
  assert.ok(submit !== undefined);
  await waitFor(() => assert.equal(submit.hasAttribute("disabled"), false));
  assert.ok(screen.queryByText(PASSWORD_REFUSAL) === null);
  assert.ok(screen.queryByText(en["settings.account.failedChangePassword"]) === null);
  assert.ok(screen.queryByText("Password updated!") === null);
  assert.equal((screen.getByLabelText("Current password") as HTMLInputElement).value, PASSWORD_BODY.currentPassword, "the form keeps what was typed");
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["PATCH /auth/me"]);
});

test("password change without two-step verification: no dialog, as before", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({ "PATCH /auth/me": [passwordUpdated] });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();

  assert.ok(await screen.findByText("Password updated!"));
  assert.ok(screen.queryByRole("dialog") === null);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["PATCH /auth/me"]);
});

test("turned off meanwhile (409 second_factor_not_enabled): the change just goes once more", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL)), passwordUpdated],
    [`POST ${STEP_UP_URL}`]: [fail(httpError(409, { error: "Not enabled", code: "second_factor_not_enabled" }))],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();
  await enterCode(await findVerifyDialog(), "Authenticator code", "123456");

  assert.ok(await screen.findByText("Password updated!"));
  assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["PATCH /auth/me", `POST ${STEP_UP_URL}`, "PATCH /auth/me"]);
});

test("a sign-in that can't step up (403 session_family_required) offers Sign In Again", async () => {
  seedUser();
  stubGets(() => []);
  let loggedOut = 0;
  useAuthStore.setState({ logout: () => { loggedOut += 1; } } as never);
  const calls = stubWrites({
    "PATCH /auth/me": [fail(stepUpRequired(PASSWORD_REFUSAL))],
    [`POST ${STEP_UP_URL}`]: [fail(httpError(403, { error: "No session family", code: "session_family_required" }))],
  });

  renderWithHost(<AccountSection passwordChangeIntent />);
  await submitPasswordChange();
  const verify = await findVerifyDialog();
  await enterCode(verify, "Authenticator code", "123456");

  const notice = await within(verify).findByTestId("step-up-sign-in-again");
  assert.ok(within(notice).getByText(en["settings.twoStep.stepUpSignInAgain"]));
  assert.equal(loggedOut, 0);
  fireEvent.click(within(notice).getByRole("button", { name: "Sign in again" }));

  assert.equal(loggedOut, 1);
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null));
  assert.ok(screen.queryByText(en["settings.account.failedChangePassword"]) === null);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "not retried");
});

// ── Disconnect a sign-in method ──

const UNLINK_REFUSAL = "Confirm it's you with your second step before disconnecting a sign-in method.";

test("disconnect: confirm, then a passkey, then the identity is gone", async () => {
  seedUser();
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  let identities: Identity[] = [{ provider: "google", providerEmail: "google@example.com" }];
  stubGets(() => identities);
  const calls = stubWrites({
    "DELETE /auth/identities/google": [fail(stepUpRequired(UNLINK_REFUSAL, ["totp", "passkey", "backup_code"])), () => {
      identities = [];
      return { unlinked: true, identities, passwordConfigured: true };
    }],
    [`POST ${ASSERTION_OPTIONS_URL}`]: [() => ASSERTION_OPTIONS],
    [`POST ${STEP_UP_URL}`]: [() => ({ verified: true })],
  });

  renderWithHost(<AccountSection />);
  await screen.findByText("Connected as google@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));

  const verify = await findVerifyDialog();
  // No method used here yet: a passkey first (D4). Its Use passkey button says so; no instruction line (HelperText step 1).
  assert.ok(!verify.textContent?.includes(en["auth.secondFactor.passkeyHint"]), verify.textContent ?? "");
  await clickWhenEnabled(within(verify).getByRole("button", { name: "Use passkey" }));

  // The page behind stays hidden from the accessibility tree until the dialog closes.
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  const googleAccount = screen.getByRole("group", { name: "Google account" });
  await waitFor(() => assert.ok(within(googleAccount).getByText("Not connected")));
  assert.deepEqual(calls, [
    { method: "DELETE", url: "/auth/identities/google", body: undefined },
    { method: "POST", url: ASSERTION_OPTIONS_URL, body: {} },
    { method: "POST", url: STEP_UP_URL, body: { webauthn: assertionJSON() } },
    { method: "DELETE", url: "/auth/identities/google", body: undefined },
  ]);
  assert.equal(localStorage.getItem(LAST_METHOD_KEY), "passkey");
});

test("disconnect: closing the dialog keeps the identity and shows no error", async () => {
  seedUser();
  stubGets(() => [{ provider: "google", providerEmail: "google@example.com" }]);
  const calls = stubWrites({
    "DELETE /auth/identities/google": [fail(stepUpRequired(UNLINK_REFUSAL))],
  });

  renderWithHost(<AccountSection />);
  await screen.findByText("Connected as google@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect", exact: true }));
  await closeVerifyDialog(await findVerifyDialog());

  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  assert.ok(screen.queryByText(UNLINK_REFUSAL) === null);
  assert.ok(screen.getByText("Connected as google@example.com"));
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["DELETE /auth/identities/google"]);
});

// ── Connect a sign-in method ──

const LINK_REFUSAL = "Confirm it's you with your second step before connecting a sign-in method.";

test("connect on the web: the step-up comes before leaving for the provider", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "POST /auth/google/link/start": [fail(stepUpRequired(LINK_REFUSAL)), () => ({ url: "#provider-authorize" })],
    [`POST ${STEP_UP_URL}`]: [() => ({ verified: true })],
  });

  renderWithHost(<AccountSection />);
  const googleAccount = await screen.findByRole("group", { name: "Google account" });
  fireEvent.click(within(googleAccount).getByRole("button", { name: "Connect" }));

  const verify = await findVerifyDialog();
  assert.equal(window.location.hash, "", "still here while the dialog is open");
  fireEvent.click(within(verify).getByRole("button", { name: "Use a backup code" }));
  await enterCode(verify, "Backup code", "k7p2m-9qztx");

  await waitFor(() => assert.equal(window.location.hash, "#provider-authorize"));
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    "POST /auth/google/link/start",
    `POST ${STEP_UP_URL}`,
    "POST /auth/google/link/start",
  ]);
  assert.deepEqual(calls[1]!.body, { backupCode: "k7p2m-9qztx" });
});

test("connect on the web: closing the dialog stays here and shows no error", async () => {
  seedUser();
  stubGets(() => []);
  const calls = stubWrites({
    "POST /auth/google/link/start": [fail(stepUpRequired(LINK_REFUSAL))],
  });

  renderWithHost(<AccountSection />);
  const googleAccount = await screen.findByRole("group", { name: "Google account" });
  fireEvent.click(within(googleAccount).getByRole("button", { name: "Connect" }));
  await closeVerifyDialog(await findVerifyDialog());

  await waitFor(() => assert.equal(within(googleAccount).getByRole("button", { name: "Connect" }).hasAttribute("disabled"), false));
  assert.equal(window.location.hash, "");
  assert.ok(screen.queryByText(LINK_REFUSAL) === null);
  assert.ok(screen.queryByText(en["settings.account.failedConnectProvider"].replace("{label}", "Google")) === null);
  assert.equal(calls.length, 1);
});

test("connect in Raft Desktop: the step-up comes before the browser opens", async () => {
  seedUser();
  let linked = false;
  stubGets(() => (linked ? [{ provider: "google", providerEmail: "google@example.com" }] : []));
  const calls = stubWrites({
    "POST /auth/mobile/oauth/google/link/start": [
      fail(stepUpRequired(LINK_REFUSAL)),
      () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }),
    ],
    [`POST ${STEP_UP_URL}`]: [() => ({ verified: true })],
    "POST /auth/mobile/oauth/google/link/complete": [() => {
      linked = true;
      return { provider: "google", mode: "link", identities: [] };
    }],
  });
  desktop = installFakeDesktopAuth();

  renderWithHost(<AccountSection />);
  const googleAccount = await screen.findByRole("group", { name: "Google account" });
  fireEvent.click(within(googleAccount).getByRole("button", { name: "Connect" }));

  const verify = await findVerifyDialog();
  assert.deepEqual(desktop.opened, [], "the browser waits for the step-up");
  await enterCode(verify, "Authenticator code", "123456");

  await waitFor(() => assert.ok(within(googleAccount).getByText("Connected as google@example.com")));
  assert.deepEqual(calls.map((call) => call.url), [
    "/auth/mobile/oauth/google/link/start",
    STEP_UP_URL,
    "/auth/mobile/oauth/google/link/start",
    "/auth/mobile/oauth/google/link/complete",
  ]);
  assert.deepEqual(desktop.opened, ["https://accounts.google.com/o/oauth2/v2/auth?state=s"]);
});

test("connect in Raft Desktop: closing the dialog ends the attempt without opening the browser or an error", async () => {
  seedUser();
  stubGets(() => []);
  stubWrites({
    "POST /auth/mobile/oauth/google/link/start": [fail(stepUpRequired(LINK_REFUSAL))],
  });
  desktop = installFakeDesktopAuth();

  renderWithHost(<AccountSection />);
  const googleAccount = await screen.findByRole("group", { name: "Google account" });
  fireEvent.click(within(googleAccount).getByRole("button", { name: "Connect" }));
  await closeVerifyDialog(await findVerifyDialog());

  await waitFor(() => assert.ok(desktop!.calls.includes("cancel")));
  assert.deepEqual(desktop.opened, []);
  assert.ok(screen.queryByText(LINK_REFUSAL) === null);
  assert.ok(within(googleAccount).getByText("Not connected"));
});

// ── Agent key (login token) ──

const MINT_REFUSAL = "Confirm it's you with your second step before creating an agent key.";

const EXTERNAL_AGENT = { id: "agent-a", name: "agent-a", displayName: "Agent A", runtime: "external", external: true, status: "idle" } as never;
const WAITING = { setupState: "waiting_for_login", credentialLastUsedAt: null, lastActivityAt: null } as const;

function ExternalAgentCard() {
  return <ExternalAgentConnectionCard agent={EXTERNAL_AGENT} status={WAITING} canIssueCredentials onStatus={() => undefined} />;
}

function minted() {
  return { agentId: "agent-a", credentialId: "new-token", apiKey: API_KEY };
}

test("agent key: a refusal asks for a code, then the key is created once more", async () => {
  stubGets(() => []);
  const calls = stubWrites({
    "POST /agents/agent-a/credentials": [fail(stepUpRequired(MINT_REFUSAL)), minted],
    [`POST ${STEP_UP_URL}`]: [() => ({ verified: true })],
  });

  renderWithHost(<ExternalAgentCard />);
  await clickWhenEnabled(await screen.findByRole("button", { name: en["agent.externalCard.createCredential"] }));

  const verify = await findVerifyDialog();
  assert.ok(within(verify).getByText(AGENT_KEY_DESCRIPTION));
  await enterCode(verify, "Authenticator code", "123456");

  assert.ok(await screen.findByTestId("external-agent-new-credential"));
  assert.ok(screen.queryByText(en["agent.externalCard.createError"]) === null);
  assert.deepEqual(calls.map((call) => call.url), ["/agents/agent-a/credentials", STEP_UP_URL, "/agents/agent-a/credentials"]);
});

test("agent key: closing the dialog creates nothing and shows no error", async () => {
  stubGets(() => []);
  const calls = stubWrites({
    "POST /agents/agent-a/credentials": [fail(stepUpRequired(MINT_REFUSAL))],
  });

  renderWithHost(<ExternalAgentCard />);
  await clickWhenEnabled(await screen.findByRole("button", { name: en["agent.externalCard.createCredential"] }));
  await closeVerifyDialog(await findVerifyDialog());

  await waitFor(() => assert.equal(screen.getByRole("button", { name: en["agent.externalCard.createCredential"] }).hasAttribute("disabled"), false));
  assert.ok(screen.queryByText(en["agent.externalCard.createError"]) === null);
  assert.ok(screen.queryByTestId("external-agent-new-credential") === null);
  assert.equal(calls.length, 1);
});

test("agent key without two-step verification: no dialog, as before", async () => {
  stubGets(() => []);
  const calls = stubWrites({ "POST /agents/agent-a/credentials": [minted] });

  renderWithHost(<ExternalAgentCard />);
  await clickWhenEnabled(await screen.findByRole("button", { name: en["agent.externalCard.createCredential"] }));

  assert.ok(await screen.findByTestId("external-agent-new-credential"));
  assert.ok(screen.queryByRole("dialog") === null);
  assert.equal(calls.length, 1);
});
