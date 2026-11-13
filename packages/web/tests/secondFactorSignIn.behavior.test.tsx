import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import LoginPage from "../src/components/auth/LoginPage";
import { clearSecondFactorSignIn } from "../src/components/auth/secondFactorSignIn";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import AppLoginPage, { appLoginRedirect } from "../src/pages/AppLoginPage";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import { useAuthStore } from "../src/store/authStore";
import { useTranslationStore } from "../src/store/translationStore";
import { formatClock } from "../src/utils/timeFormatting";
import { assertionJSON, closedPrompt, credentialFor, installFakeWebAuthn } from "./helpers/fakeWebAuthn";
import type { FakeWebAuthn } from "./helpers/fakeWebAuthn";
import { TestIntlProvider } from "./helpers/intl";

// The second step at sign-in and before approving a device or app login
// (#triage:#135, design v2 groups b/c/f). The server decides who needs it:
// these tests stub its answers at the axios client and check what the
// person sees and what is sent.

vi.mock("../src/hooks/useAuthProviders", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuthProviders: () => ({ enabledProviders: [], loading: false, expectedCount: 0 }),
}));

const CHALLENGE = "c".repeat(43);
const LAST_METHOD_KEY = "raft.second-factor.last-method";
const STATUS_URL = "/auth/second-factor/status";
const ASSERTION_OPTIONS_URL = "/auth/second-factor/passkeys/assertion/options";
const ASSERTION_OPTIONS = { options: { challenge: "a".repeat(43), rpId: "localhost", userVerification: "required", allowCredentials: [{ id: "Y3JlZA", type: "public-key" }] } };
const SIGNED_IN = {
  user: { id: "user-1", email: "owner@example.com", name: "owner", preferredMessageBodyFontSize: null },
  accessToken: "access-1",
  refreshToken: "refresh-1",
};
const PERSON = {
  id: "user-1",
  email: "owner@example.com",
  name: "owner",
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
};

const originalGet = api.get;
const originalPost = api.post;
const originalAssign = appLoginRedirect.assign;
let webauthn: FakeWebAuthn | null = null;

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

afterEach(() => {
  cleanup();
  webauthn?.restore();
  webauthn = null;
  api.get = originalGet;
  api.post = originalPost;
  appLoginRedirect.assign = originalAssign;
  clearSecondFactorSignIn();
  localStorage.clear();
  window.history.pushState({}, "", "/");
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

function challengeBody(methods: string[] = ["totp", "backup_code"]) {
  return {
    secondFactorRequired: true,
    challenge: CHALLENGE,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    methods,
    maskedEmail: "o***@example.com",
  };
}

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

type Handler = (body: unknown) => unknown;

/** Each URL answers with its handlers in turn (the last one repeats); a thrown value is the failure. */
function stubPosts(handlers: Record<string, Handler[]>) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const calls = new Map<string, number>();
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = calls.get(url) ?? 0;
    calls.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
  return posts;
}

/** GETs answered by URL; anything else is unexpected. */
function stubGets(handlers: Record<string, () => unknown>) {
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    const handler = handlers[url];
    if (!handler) throw new Error(`Unexpected GET ${url}`);
    return { data: handler() };
  }) as typeof api.get;
  return gets;
}

function status(sessionVerified: boolean, methods = { totp: true, passkeys: 0, backupCodesRemaining: 8 }) {
  return { enabled: true, methods, sessionVerified };
}

function fail(status: number, data: Record<string, unknown>): Handler {
  return () => {
    throw httpError(status, data);
  };
}

function renderLogin() {
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <LoginPage onForgotPassword={vi.fn()} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

async function signInWithPassword() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  });
}

async function enterCode(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  });
}

test("a sign-in that doesn't need the second step signs in as before", async () => {
  const posts = stubPosts({ "/auth/login": [() => SIGNED_IN] });
  renderLogin();
  await signInWithPassword();

  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.equal(localStorage.getItem("slock_access_token"), "access-1");
  assert.ok(screen.queryByText("Two-step verification") === null);
  assert.deepEqual(posts.map((post) => post.url), ["/auth/login"]);
});

test("with two-step verification on, the password leads to the code step and no session yet", async () => {
  stubPosts({ "/auth/login": [() => challengeBody()] });
  renderLogin();
  await signInWithPassword();

  await screen.findByText("Two-step verification");
  await screen.findByText("o***@example.com");
  screen.getByLabelText("Authenticator code");
  screen.getByRole("button", { name: "Use a backup code" });
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(localStorage.getItem("slock_access_token"), null);
});

test("a wrong code says so under the field; the right one signs in", async () => {
  const posts = stubPosts({
    "/auth/login": [() => challengeBody()],
    "/auth/second-factor/verify": [fail(400, { code: "second_factor_code_invalid" }), () => SIGNED_IN],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  await enterCode("Authenticator code", "000000");
  await screen.findByText("That code didn't work. Check your authenticator app and try again.");
  assert.equal(useAuthStore.getState().user, null);

  await enterCode("Authenticator code", "123 456");
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.equal(localStorage.getItem("slock_access_token"), "access-1");
  assert.deepEqual(posts.at(-1), { url: "/auth/second-factor/verify", body: { challenge: CHALLENGE, code: "123456" } });
  assert.equal(localStorage.getItem(LAST_METHOD_KEY), "totp");
});

test("a backup code signs in; a used one says so", async () => {
  const posts = stubPosts({
    "/auth/login": [() => challengeBody()],
    "/auth/second-factor/verify": [fail(400, { code: "backup_code_used" }), () => ({ ...SIGNED_IN, backupCodesRemaining: 7 })],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));
  screen.getByLabelText("Backup code");
  screen.getByRole("button", { name: "Use authenticator code" });

  await enterCode("Backup code", "4mxae-n83vb");
  await screen.findByText("That backup code was already used. Each code works once, so try another one.");

  await enterCode("Backup code", "k7p2m-9qztx");
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.deepEqual(posts.at(-1), { url: "/auth/second-factor/verify", body: { challenge: CHALLENGE, backupCode: "k7p2m-9qztx" } });
  assert.equal(localStorage.getItem(LAST_METHOD_KEY), "backup_code");
});

test("the step starts with the method this device used last, if the account has it (D4)", async () => {
  localStorage.setItem(LAST_METHOD_KEY, "backup_code");
  stubPosts({ "/auth/login": [() => challengeBody()] });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");
  screen.getByLabelText("Backup code");
  assert.ok(screen.queryByLabelText("Authenticator code") === null);
});

test("with only an authenticator app there is nothing to switch to", async () => {
  localStorage.setItem(LAST_METHOD_KEY, "backup_code");
  stubPosts({ "/auth/login": [() => challengeBody(["totp"])] });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");
  screen.getByLabelText("Authenticator code");
  assert.ok(screen.queryByRole("button", { name: "Use a backup code" }) === null);
});

test("a lock ends this sign-in with the time it lifts; Back to Sign In returns to the form", async () => {
  const lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
  stubPosts({
    "/auth/login": [() => challengeBody()],
    "/auth/second-factor/verify": [fail(429, { code: "second_factor_locked", lockedUntil, methods: ["totp"] })],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  await enterCode("Authenticator code", "000000");
  const { effectiveTimezone, effectiveTimeFormat } = useTranslationStore.getState().settings;
  const time = formatClock(lockedUntil, { locale: DEFAULT_LOCALE, timeZone: effectiveTimezone, timeFormat: effectiveTimeFormat });
  await screen.findByText(`Too many wrong tries. The second step is paused until ${time}, and we've emailed you.`);
  assert.ok(screen.queryByLabelText("Authenticator code") === null);

  fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  await screen.findByLabelText("Password");
  assert.ok(screen.queryByText("Two-step verification") === null);
});

test("an expired sign-in can only go back", async () => {
  stubPosts({
    "/auth/login": [() => challengeBody()],
    "/auth/second-factor/verify": [fail(410, { code: "challenge_expired" })],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  await enterCode("Authenticator code", "123456");
  await screen.findByText("This sign-in has expired. Sign in again.");
  screen.getByRole("button", { name: "Back to sign in" });
  assert.ok(screen.queryByLabelText("Authenticator code") === null);
});

test("approving a device login asks for the second step first, then approves", async () => {
  useAuthStore.setState({ user: PERSON, loading: false, initialized: true } as never);
  // A status that can't be read (here the flag-off 404) leaves the page as before; the approval's 403 asks.
  stubGets({ [STATUS_URL]: () => { throw httpError(404, { code: "not_found" }); } });
  const posts = stubPosts({
    "/auth/device/describe": [() => ({
      userCode: "VSWA-7M58",
      clientName: "raft-computer",
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      requester: { ip: null, location: null },
      approvalTicket: "ticket-1",
    })],
    "/auth/device/approve": [fail(403, { code: "second_factor_step_up_required", methods: ["totp", "backup_code"] }), () => ({})],
    "/auth/second-factor/step-up": [() => ({ verified: true })],
  });
  window.history.pushState({}, "", "/login/device");
  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);

  fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), { target: { value: "vswa-7m58" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Approve device login" }));
  });

  await screen.findByText("Two-step verification is on for this account. Verify it's you before approving a device login.");
  await enterCode("Authenticator code", "123456");
  await screen.findByText("Device login approved");

  assert.deepEqual(posts.map((post) => post.url), [
    "/auth/device/describe",
    "/auth/device/approve",
    "/auth/second-factor/step-up",
    "/auth/device/approve",
  ]);
  assert.deepEqual(posts[2]!.body, { code: "123456" });
  assert.deepEqual(posts[3]!.body, { userCode: "VSWA-7M58", approve: true, approvalTicket: "ticket-1" });
});

test("confirming an app sign-in asks for the second step first; a wrong code stays on it", async () => {
  useAuthStore.setState({ user: PERSON, loading: false, initialized: true } as never);
  const assigned: string[] = [];
  appLoginRedirect.assign = (url: string) => {
    assigned.push(url);
  };
  api.get = (async () => ({ data: {} })) as typeof api.get;
  const posts = stubPosts({
    "/auth/app-login/requests/req-1/approve": [
      fail(403, { code: "second_factor_step_up_required", methods: ["totp", "backup_code"] }),
      () => ({ redirectUrl: "raft://login?code=one-time" }),
    ],
    "/auth/second-factor/step-up": [fail(400, { code: "second_factor_code_invalid" }), () => ({ verified: true })],
  });
  window.history.pushState({}, "", "/login/app?request=req-1");
  render(<TestIntlProvider><AppLoginPage /></TestIntlProvider>);

  // The button stays disabled until the request has loaded.
  const confirm = await screen.findByRole("button", { name: "Confirm sign-in" });
  await waitFor(() => assert.equal(confirm.hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(confirm);
  });
  await screen.findByText("Two-step verification is on for this account. Verify it's you before signing in to the app.");

  fireEvent.click(screen.getByRole("button", { name: "Use a backup code" }));
  await enterCode("Backup code", "wrong-code1");
  await screen.findByText("That backup code didn't work. Check it and try again.");
  assert.deepEqual(assigned, []);

  await enterCode("Backup code", "k7p2m-9qztx");
  await screen.findByTestId("app-login-returned");
  assert.deepEqual(assigned, ["raft://login?code=one-time"]);
  assert.deepEqual(posts.filter((post) => post.url === "/auth/second-factor/step-up").map((post) => post.body), [
    { backupCode: "wrong-code1" },
    { backupCode: "k7p2m-9qztx" },
  ]);
});

// ── Passkey as the second step (design step-passkey*) ──

async function clickUsePasskey() {
  const button = await screen.findByRole("button", { name: "Use passkey" });
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(button);
  });
}

test("a passkey as the second step: options for this sign-in, then verify with it", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  const posts = stubPosts({
    "/auth/login": [() => challengeBody(["totp", "passkey", "backup_code"])],
    [ASSERTION_OPTIONS_URL]: [() => ASSERTION_OPTIONS],
    "/auth/second-factor/verify": [() => SIGNED_IN],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  // No method used here yet: passkey first (D4), the others under "or".
  screen.getByText("Use the passkey you saved for Raft on this device or your phone.");
  screen.getByRole("button", { name: "Use authenticator code" });
  screen.getByRole("button", { name: "Use a backup code" });
  assert.ok(screen.queryByLabelText("Authenticator code") === null);

  await clickUsePasskey();
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.deepEqual(posts.map((post) => post.url), ["/auth/login", ASSERTION_OPTIONS_URL, "/auth/second-factor/verify"]);
  assert.deepEqual(posts[1]!.body, { challenge: CHALLENGE });
  assert.deepEqual(posts[2]!.body, { challenge: CHALLENGE, webauthn: assertionJSON() });
  assert.equal(localStorage.getItem(LAST_METHOD_KEY), "passkey");
});

test("closing the passkey prompt at the second step says so; another method still works", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  const posts = stubPosts({
    "/auth/login": [() => challengeBody(["totp", "passkey"])],
    [ASSERTION_OPTIONS_URL]: [() => ASSERTION_OPTIONS],
    "/auth/second-factor/verify": [() => SIGNED_IN],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  await clickUsePasskey();
  await screen.findByText("The passkey prompt was closed. Try again, or use another way.");
  assert.ok(screen.queryByText("Sign-in failed") === null);
  assert.ok(!posts.some((post) => post.url === "/auth/second-factor/verify"), "nothing is verified for a closed prompt");

  fireEvent.click(screen.getByRole("button", { name: "Use authenticator code" }));
  await enterCode("Authenticator code", "123456");
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.deepEqual(posts.at(-1), { url: "/auth/second-factor/verify", body: { challenge: CHALLENGE, code: "123456" } });
});

test("a passkey that doesn't verify says so above the button", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  stubPosts({
    "/auth/login": [() => challengeBody(["passkey"])],
    [ASSERTION_OPTIONS_URL]: [() => ASSERTION_OPTIONS],
    "/auth/second-factor/verify": [fail(400, { code: "second_factor_code_invalid" })],
  });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  await clickUsePasskey();
  await screen.findByText("That passkey didn't work. Try again, or use another way.");
  assert.equal(useAuthStore.getState().user, null);
  screen.getByRole("button", { name: "Use passkey" });
});

test("a browser that can't use passkeys leaves the passkey out and says why", async () => {
  stubPosts({ "/auth/login": [() => challengeBody(["passkey", "totp"])] });
  renderLogin();
  await signInWithPassword();
  await screen.findByText("Two-step verification");

  screen.getByText("This browser can't use passkeys. Use another way, or open Raft in a browser that has your passkey.");
  screen.getByLabelText("Authenticator code");
  assert.ok(screen.queryByRole("button", { name: "Use passkey" }) === null);
  assert.ok(screen.queryByRole("button", { name: "Use a passkey" }) === null);
});

// ── Approval pages: the status says up front whether this sign-in is verified ──

const DESCRIBED = {
  userCode: "VSWA-7M58",
  clientName: "raft-computer",
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  requester: { ip: null, location: null },
  approvalTicket: "ticket-1",
};

async function describeAndApproveDevice() {
  const codeField = await screen.findByPlaceholderText("XXXX-XXXX");
  fireEvent.change(codeField, { target: { value: "vswa-7m58" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Approve device login" }));
  });
}

test("a verified sign-in approves a device login without being asked for a code", async () => {
  useAuthStore.setState({ user: PERSON, loading: false, initialized: true } as never);
  const gets = stubGets({ [STATUS_URL]: () => status(true) });
  const posts = stubPosts({
    "/auth/device/describe": [() => DESCRIBED],
    "/auth/device/approve": [() => ({})],
  });
  window.history.pushState({}, "", "/login/device");
  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);

  await waitFor(() => assert.ok(gets.includes(STATUS_URL)));
  await describeAndApproveDevice();
  await screen.findByText("Device login approved");
  assert.ok(screen.queryByText("Two-step verification is on for this account. Verify it's you before approving a device login.") === null);
  assert.deepEqual(posts.map((post) => post.url), ["/auth/device/describe", "/auth/device/approve"]);
});

test("an unverified sign-in is asked for the second step up front, before the device code", async () => {
  useAuthStore.setState({ user: PERSON, loading: false, initialized: true } as never);
  stubGets({ [STATUS_URL]: () => status(false) });
  const posts = stubPosts({
    "/auth/second-factor/step-up": [() => ({ verified: true })],
    "/auth/device/describe": [() => DESCRIBED],
    "/auth/device/approve": [() => ({})],
  });
  window.history.pushState({}, "", "/login/device");
  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);

  await screen.findByText("Two-step verification is on for this account. Verify it's you before approving a device login.");
  assert.ok(screen.queryByPlaceholderText("XXXX-XXXX") === null);
  await enterCode("Authenticator code", "123456");

  await describeAndApproveDevice();
  await screen.findByText("Device login approved");
  assert.deepEqual(posts.map((post) => post.url), [
    "/auth/second-factor/step-up",
    "/auth/device/describe",
    "/auth/device/approve",
  ]);
  assert.deepEqual(posts[0]!.body, { code: "123456" });
});

test("an unverified sign-in confirms an app sign-in after a passkey step-up up front", async () => {
  useAuthStore.setState({ user: PERSON, loading: false, initialized: true } as never);
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  const assigned: string[] = [];
  appLoginRedirect.assign = (url: string) => {
    assigned.push(url);
  };
  stubGets({
    [STATUS_URL]: () => status(false, { totp: true, passkeys: 1, backupCodesRemaining: 8 }),
    "/auth/app-login/requests/req-1": () => ({}),
  });
  const posts = stubPosts({
    [ASSERTION_OPTIONS_URL]: [() => ASSERTION_OPTIONS],
    "/auth/second-factor/step-up": [() => ({ verified: true })],
    "/auth/app-login/requests/req-1/approve": [() => ({ redirectUrl: "raft://login?code=one-time" })],
  });
  window.history.pushState({}, "", "/login/app?request=req-1");
  render(<TestIntlProvider><AppLoginPage /></TestIntlProvider>);

  await screen.findByText("Two-step verification is on for this account. Verify it's you before signing in to the app.");
  await clickUsePasskey();

  // Verified: the person still confirms the sign-in themselves.
  const confirm = await screen.findByRole("button", { name: "Confirm sign-in" });
  await waitFor(() => assert.equal(confirm.hasAttribute("disabled"), false));
  assert.deepEqual(assigned, []);
  await act(async () => {
    fireEvent.click(confirm);
  });
  await screen.findByTestId("app-login-returned");
  assert.deepEqual(assigned, ["raft://login?code=one-time"]);
  assert.deepEqual(posts.map((post) => post.url), [
    ASSERTION_OPTIONS_URL,
    "/auth/second-factor/step-up",
    "/auth/app-login/requests/req-1/approve",
  ]);
  assert.deepEqual(posts[0]!.body, {});
  assert.deepEqual(posts[1]!.body, { webauthn: assertionJSON() });
});
