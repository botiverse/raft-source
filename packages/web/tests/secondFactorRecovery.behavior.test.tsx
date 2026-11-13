import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import LoginPage from "../src/components/auth/LoginPage";
import { parseRecoveryLinkToken } from "../src/components/auth/secondFactorRecovery";
import { clearSecondFactorSignIn } from "../src/components/auth/secondFactorSignIn";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import SecondFactorRecoveryLinkPage from "../src/pages/SecondFactorRecoveryLinkPage";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import {
  resetServerFeatureFlagsForTests,
  resolveServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { formatMediumDateTime } from "../src/utils/timeFormatting";
import { TestIntlProvider } from "./helpers/intl";

// Resetting two-step verification by email when every second step is lost
// (#triage:#135, design v2 group d; server contract: routes/secondFactor.ts
// "Email recovery"). The server is stubbed at the axios client; these check
// what the person sees and what is sent.

vi.mock("../src/hooks/useAuthProviders", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuthProviders: () => ({ enabledProviders: [], loading: false, expectedCount: 0 }),
}));

const CHALLENGE = "c".repeat(43);
const LINK_TOKEN = "t".repeat(43);
const RECOVERY_URL = "/auth/second-factor/recovery";
const SERVER_ID = "server-recovery";
const SIGNED_IN = {
  user: { id: "user-1", email: "owner@example.com", name: "owner", preferredMessageBodyFontSize: null },
  accessToken: "access-1",
  refreshToken: "refresh-1",
};
const SENT = "If an account uses this email, we sent it a link to reset two-step verification.";

const originalGet = api.get;
const originalPost = api.post;
const originalDelete = api.delete;

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.delete = originalDelete;
  clearSecondFactorSignIn();
  resetServerFeatureFlagsForTests();
  localStorage.clear();
  window.history.pushState({}, "", "/");
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
  useServerStore.setState({ current: null, servers: [] } as never);
});

function challengeBody(methods: string[]) {
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

function fail(status: number, data: Record<string, unknown>): Handler {
  return () => {
    throw httpError(status, data);
  };
}

function mediumDateTime(iso: string): string {
  const { effectiveTimezone, effectiveTimeFormat } = useTranslationStore.getState().settings;
  return formatMediumDateTime(iso, { locale: DEFAULT_LOCALE, timeZone: effectiveTimezone, timeFormat: effectiveTimeFormat });
}

function recoveryView(status: "waiting" | "ready", firstFactorRequired: "set_password" | null = null) {
  const requested = Date.now() - (status === "ready" ? 73 : 1) * 3_600_000;
  const eligible = requested + 72 * 3_600_000;
  return {
    status,
    requestedAt: new Date(requested).toISOString(),
    eligibleAt: new Date(eligible).toISOString(),
    expiresAt: new Date(eligible + 7 * 24 * 3_600_000).toISOString(),
    firstFactorRequired,
  };
}

async function enabledButton(name: string): Promise<HTMLButtonElement> {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false));
  return button as HTMLButtonElement;
}

async function click(name: string) {
  const button = await enabledButton(name);
  await act(async () => {
    fireEvent.click(button);
  });
}

// ── The second step: "Can't use any of these?" ──

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
  await screen.findByText("Two-step verification");
}

test("Can't Use Any of These? asks for the emailed reset with the typed email, and answers the same for every address", async () => {
  const posts = stubPosts({
    "/auth/login": [() => challengeBody(["totp"])],
    [RECOVERY_URL]: [() => ({ ok: true, message: "If two-step verification on that account can be reset by email, we sent a link to it." })],
  });
  renderLogin();
  await signInWithPassword();

  await click("Can't use any of these?");
  await screen.findByRole("heading", { name: "Can't verify?" });
  // No backup codes on this account: straight to the email reset.
  assert.ok(screen.queryByRole("button", { name: "Use a backup code" }) === null);
  assert.equal((screen.getByLabelText("Email") as HTMLInputElement).value, "owner@example.com");

  await click("Reset by email");
  await screen.findByText(SENT);
  screen.getByText("The link works for 30 minutes. The 72-hour wait starts when you open it.");
  assert.deepEqual(posts.at(-1), { url: RECOVERY_URL, body: { email: "owner@example.com" } });
  // Nothing about the account, and no session.
  assert.equal(useAuthStore.getState().user, null);

  await click("Back to sign in");
  await screen.findByLabelText("Password");
});

test("an account with backup codes is offered them before the email reset", async () => {
  stubPosts({ "/auth/login": [() => challengeBody(["totp", "backup_code"])] });
  renderLogin();
  await signInWithPassword();

  await click("Can't use any of these?");
  await screen.findByText("No backup codes?");
  await click("Use a backup code");
  await screen.findByLabelText("Backup code");
});

test("a rate-limited request says so without saying anything about the account", async () => {
  stubPosts({
    "/auth/login": [() => challengeBody(["totp"])],
    [RECOVERY_URL]: [fail(429, { code: "rate_limited", error: "Too many requests. Please try again later." })],
  });
  renderLogin();
  await signInWithPassword();
  await click("Can't use any of these?");
  await click("Reset by email");
  await screen.findByText("Too many requests. Try again later.");
  assert.ok(screen.queryByText(SENT) === null);
});

// ── The second step once the reset is ready: Finish Reset ──

test("a ready reset is finished only after the screen says what it removes, and signs in", async () => {
  const posts = stubPosts({
    "/auth/login": [() => challengeBody(["totp", "backup_code", "recovery"])],
    "/auth/second-factor/verify": [() => SIGNED_IN],
  });
  renderLogin();
  await signInWithPassword();

  await screen.findByText("Your reset is ready");
  await click("Finish reset");
  await screen.findByText(
    "Finishing removes your authenticator app, passkeys and backup codes, and turns two-step verification off. Every other browser, device and app signed in to your account is signed out, and the agent keys they created stop working.",
  );
  assert.deepEqual(posts.map((post) => post.url), ["/auth/login"], "opening the screen sends nothing");

  await click("Finish reset");
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.equal(localStorage.getItem("slock_access_token"), "access-1");
  assert.deepEqual(posts.at(-1), { url: "/auth/second-factor/verify", body: { challenge: CHALLENGE, recovery: true } });
});

test("a reset that can't be finished any more says so and keeps the sign-in", async () => {
  stubPosts({
    "/auth/login": [() => challengeBody(["totp", "recovery"])],
    "/auth/second-factor/verify": [fail(409, { code: "recovery_not_found" })],
  });
  renderLogin();
  await signInWithPassword();
  await click("Finish reset");
  await screen.findByRole("heading", { name: "Finish the reset" });
  await click("Finish reset");

  await screen.findByText("This reset can't be finished now: it was cancelled, has lapsed, or isn't ready yet. Use your second step, or start a new reset.");
  assert.equal(useAuthStore.getState().user, null);
  await click("Back");
  await screen.findByLabelText("Authenticator code");
});

test("without a ready reset the step offers no Finish Reset", async () => {
  stubPosts({ "/auth/login": [() => challengeBody(["totp"])] });
  renderLogin();
  await signInWithPassword();
  screen.getByLabelText("Authenticator code");
  assert.ok(screen.queryByRole("button", { name: "Finish reset" }) === null);
});

// ── The emailed links ──

function renderLink(mode: "confirm" | "cancel", token: string = LINK_TOKEN) {
  const param = mode === "confirm" ? "second_factor_recovery" : "cancel_second_factor_recovery";
  window.history.pushState({}, "", `/?${param}=${token}`);
  render(
    <TestIntlProvider>
      <SecondFactorRecoveryLinkPage mode={mode} token={parseRecoveryLinkToken(token)} />
    </TestIntlProvider>,
  );
}

test("the confirm link starts nothing until the click, then says from when a sign-in can finish it", async () => {
  const recovery = recoveryView("waiting");
  const posts = stubPosts({ [`${RECOVERY_URL}/confirm`]: [() => ({ recovery })] });
  renderLink("confirm");

  await screen.findByRole("heading", { name: "Reset two-step verification" });
  await waitFor(() => assert.equal(window.location.search, ""));
  assert.deepEqual(posts, [], "a mail scanner opening the link starts nothing");

  await click("Start reset");
  assert.deepEqual(posts, [{ url: `${RECOVERY_URL}/confirm`, body: { token: LINK_TOKEN } }]);
  await screen.findByRole("heading", { name: "Reset started" });
  screen.getByText(
    `From ${mediumDateTime(recovery.eligibleAt)} until ${mediumDateTime(recovery.expiresAt)}, signing in can finish the reset without your second step. Until then, signing in still needs it.`,
  );
  assert.ok(screen.queryByText(/This account has no password/) === null);
});

test("a confirmed reset on an account without a password says to set one first, through forgot password", async () => {
  stubPosts({ [`${RECOVERY_URL}/confirm`]: [() => ({ recovery: recoveryView("waiting", "set_password") })] });
  renderLink("confirm");
  await click("Start reset");

  await screen.findByText(/^This account has no password, and the reset finishes at a sign-in with one\./);
  await click("Set a password");
  await screen.findByRole("heading", { name: "Reset password" });
});

test("a used or expired confirm link says so and offers no second try", async () => {
  stubPosts({ [`${RECOVERY_URL}/confirm`]: [fail(400, { code: "recovery_token_invalid" })] });
  renderLink("confirm");
  await click("Start reset");

  await screen.findByText(/^This link has expired or was already used\./);
  assert.ok(screen.queryByRole("button", { name: "Start reset" }) === null);
  screen.getByRole("button", { name: "Go to Raft" });
});

test("the cancel link cancels only on the click", async () => {
  const posts = stubPosts({ [`${RECOVERY_URL}/cancel`]: [() => ({ cancelled: true })] });
  renderLink("cancel");

  await screen.findByRole("heading", { name: "Cancel the reset" });
  await waitFor(() => assert.equal(window.location.search, ""));
  assert.deepEqual(posts, []);

  await click("Cancel reset");
  assert.deepEqual(posts, [{ url: `${RECOVERY_URL}/cancel`, body: { token: LINK_TOKEN } }]);
  await screen.findByRole("heading", { name: "Reset cancelled" });
  screen.getByText("Two-step verification stays on, and we emailed you.");
});

test("a malformed link asks the server nothing", async () => {
  const posts = stubPosts({});
  renderLink("cancel", "not-a-token");
  await screen.findByText(/^This link doesn't work anymore/);
  assert.ok(screen.queryByRole("button", { name: "Cancel reset" }) === null);
  assert.deepEqual(posts, []);
});

// ── The notification center in every signed-in session ──

function seedSignedIn() {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com", name: "owner" }, loading: false, initialized: true } as never);
  useServerStore.setState({
    servers: [{ id: SERVER_ID, slug: "acme", name: "Acme", role: "owner" }],
    current: { id: SERVER_ID, slug: "acme", name: "Acme", role: "owner" },
    members: [],
    loading: false,
  } as never);
  // The center's other sources, with nothing to say.
  useAgentStore.setState({ agents: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  resolveServerFeatureFlagsForTests(SERVER_ID);
}

/**
 * GET /auth/second-factor/recovery answers `current()`; DELETE clears it (or
 * fails, `failCancel`). The center's other sources read nothing, except
 * `permissionUpdates` Apps waiting for review. Only the recovery calls are kept.
 */
function stubRecovery(
  initial: ReturnType<typeof recoveryView> | null,
  { failCancel = false, permissionUpdates = 0 }: { failCancel?: boolean; permissionUpdates?: number } = {},
) {
  let current = initial;
  const calls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/integrations/permission-updates") return { data: { count: permissionUpdates } };
    if (url !== RECOVERY_URL) return { data: { invites: [], notifications: [] } };
    calls.push(`GET ${url}`);
    return { data: { recovery: current } };
  }) as typeof api.get;
  api.delete = (async (url: string) => {
    calls.push(`DELETE ${url}`);
    if (url !== RECOVERY_URL) throw new Error(`Unexpected DELETE ${url}`);
    if (failCancel) throw httpError(503, { error: "unavailable" });
    const cancelled = current !== null;
    current = null;
    return { data: { cancelled, recovery: null } };
  }) as typeof api.delete;
  return {
    calls,
    set(next: ReturnType<typeof recoveryView> | null) {
      current = next;
    },
  };
}

const BELL = "notification-trigger-top-bar";
const SECURITY_NAME = "Notification center (1 active), security alert";

function renderBell() {
  render(
    <MemoryRouter>
      <TestIntlProvider>
        <NotificationTrigger flavor="top-bar" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  return screen.getByTestId(BELL);
}

function hasSecurityMarker(): boolean {
  return screen.queryByTestId(`${BELL}-security-alert`) !== null;
}

async function openCenter(bell: HTMLElement) {
  await act(async () => {
    fireEvent.click(bell);
  });
  await screen.findByTestId("notification-center");
}

test("a waiting reset is the Bell's security alert and its center's entry; Cancel Reset ends it in one step", async () => {
  seedSignedIn();
  const recovery = recoveryView("waiting");
  const server = stubRecovery(recovery);
  const bell = renderBell();

  // Before opening: the shield marker, not the unread dot, and the name says it.
  await waitFor(() => assert.equal(bell.getAttribute("data-security-alert"), "true"));
  assert.equal(bell.getAttribute("aria-label"), SECURITY_NAME);
  assert.ok(hasSecurityMarker());
  assert.ok(screen.queryByTestId(`${BELL}-unread-dot`) === null);

  await openCenter(bell);
  await screen.findByText("Reset requested");
  const waiting = `Someone asked to reset two-step verification on your account. Signing in can finish it after ${mediumDateTime(recovery.eligibleAt)}. Not you? Cancel the reset.`;
  screen.getByText(waiting);
  // It goes only with the request: nothing dismisses it.
  assert.ok(screen.queryByRole("button", { name: "Dismiss" }) === null);

  await click("Cancel reset");
  await waitFor(() => assert.ok(screen.queryByText("Reset requested") === null));
  assert.ok(screen.queryByText(waiting) === null);
  assert.ok(screen.queryByRole("button", { name: "Cancel reset" }) === null);
  assert.equal(bell.getAttribute("data-security-alert"), "false");
  assert.ok(!hasSecurityMarker());
  assert.equal(bell.getAttribute("aria-label"), "Notification center");
  assert.deepEqual(server.calls, [`GET ${RECOVERY_URL}`, `DELETE ${RECOVERY_URL}`]);
});

test("a ready reset says the next sign-in can finish it, that a password comes first when there is none, and can still be cancelled", async () => {
  seedSignedIn();
  const recovery = recoveryView("ready", "set_password");
  const server = stubRecovery(recovery);
  const bell = renderBell();
  await waitFor(() => assert.equal(bell.getAttribute("aria-label"), SECURITY_NAME));

  await openCenter(bell);
  await screen.findByText("Reset ready");
  screen.getByText(
    `Someone asked to reset two-step verification on your account, and the next sign-in can finish it without the second step, until ${mediumDateTime(recovery.expiresAt)}. Not you? Cancel the reset and change your password. This account has no password yet: set one with Forgot Password on the sign-in page, then sign in to finish it.`,
  );
  assert.ok(screen.queryByRole("button", { name: "Dismiss" }) === null);
  await click("Cancel reset");
  await waitFor(() => assert.ok(screen.queryByText("Reset ready") === null));
  assert.ok(!hasSecurityMarker());
  assert.equal(server.calls.at(-1), `DELETE ${RECOVERY_URL}`);
});

test("a cancel that fails keeps the entry and the security marker", async () => {
  seedSignedIn();
  const server = stubRecovery(recoveryView("waiting"), { failCancel: true });
  const bell = renderBell();
  await waitFor(() => assert.equal(bell.getAttribute("data-security-alert"), "true"));
  await openCenter(bell);
  await screen.findByText("Reset requested");

  await click("Cancel reset");
  await enabledButton("Cancel reset");
  screen.getByText("Reset requested");
  assert.ok(hasSecurityMarker());
  assert.equal(server.calls.at(-1), `DELETE ${RECOVERY_URL}`);
});

test("the reset comes before every other entry", async () => {
  seedSignedIn();
  stubRecovery(recoveryView("waiting"), { permissionUpdates: 2 });
  const bell = renderBell();
  await waitFor(() => assert.equal(bell.getAttribute("aria-label"), "Notification center (2 active), security alert"));
  await openCenter(bell);
  await screen.findByText("App permissions need review");
  const listed = screen.getByTestId("notification-center").textContent ?? "";
  assert.ok(listed.indexOf("Reset requested") >= 0);
  assert.ok(listed.indexOf("Reset requested") < listed.indexOf("App permissions need review"));
});

test("no request, no entry and no marker; one started elsewhere shows when the window comes back", async () => {
  seedSignedIn();
  const server = stubRecovery(null);
  const bell = renderBell();
  await waitFor(() => assert.deepEqual(server.calls, [`GET ${RECOVERY_URL}`]));
  assert.equal(bell.getAttribute("data-security-alert"), "false");
  assert.ok(!hasSecurityMarker());
  assert.equal(bell.getAttribute("aria-label"), "Notification center");

  server.set(recoveryView("waiting"));
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
  });
  await waitFor(() => assert.equal(bell.getAttribute("data-security-alert"), "true"));
  await openCenter(bell);
  await screen.findByText("Reset requested");
});

