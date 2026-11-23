/**
 * Raft Desktop: "Sign in with Raft" from a page of the built-in browser, shown
 * as a sheet in the app's own window (desktop_browser_raft_sign_in_v0;
 * features/desktopBrowserSignIn). The screen is the safeguard here: it is what
 * the person sees before a code is issued for them. The shell (main process)
 * is faked at the bridge, the API at the axios client.
 *
 * - Nothing is armed, shown or reported with the flag off, in a browser, or
 *   signed out; sign-out is reported whatever the flag says.
 * - The sheet shows the App as Raft's lookup names it, the account, the
 *   Server of the conversation (picked first, changeable) and the host the
 *   answer goes to; nothing is authorized until Login with Raft is pressed.
 * - The answer goes to the shell (`complete`), never to this window's
 *   address; closing cancels; "Verify it's you" works over the sheet.
 * - The sheet is a dialog's parts: the App's name once, as its title; Cancel
 *   and the approving button in the footer, outside the body that scrolls;
 *   the focus starts on ×; none of the setup page's standing explanations
 *   (the page itself keeps them); one available Server is a line, not a
 *   picker.
 * - A request whose scopes Raft has no words for is not shown.
 * - A request whose return address is not the one the App is registered with
 *   is never shown (no name, no sheet) and is refused to the shell (`refuse`:
 *   its tab then says so), where a person closing the sheet is `cancel`.
 * - The approving button takes no press (click, Enter, Space) for
 *   APPROVE_AFTER_MS after it can first be pressed, however long the lookups
 *   before it took, and again after the window regains the focus.
 * - An App that would first be installed is held to the same return address.
 * - Whoever is signed in is named to the shell, flag on or off: an account
 *   that follows another without a sign-out is told apart there.
 * - The App's card shows its registered logo in every layout: ready on a
 *   Server, installed first from the Marketplace, signed in with the account.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesktopWebPreviewRaftSignInBridge, DesktopWebPreviewRaftSignInRequest } from "@botiverse/raft-shared";
import { vi } from "vitest";

import api from "../src/api/client";
import SecondFactorStepUpHost from "../src/components/settings/SecondFactorStepUpHost";
import { resetSecondFactorStepUpForTests } from "../src/components/settings/secondFactorStepUp";
import HumanLoginSetupPage from "../src/pages/HumanLoginSetupPage";
import { DesktopBrowserSignInHost } from "../src/features/desktopBrowserSignIn/DesktopBrowserSignInHost";
// Loaded here so the host's lazy import of it settles without a wait: the tests on the lock run on fake time.
import "../src/features/desktopBrowserSignIn/DesktopBrowserSignInSheet";
import { APPROVE_AFTER_MS, desktopBrowserSignInRequest, isRegisteredReturnAddress } from "../src/features/desktopBrowserSignIn/desktopBrowserSignInRequest";
import { en } from "../src/i18n/messages/en";
import { useAuthStore } from "../src/store/authStore";
import {
  DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const AUTHORIZE_URL = "/oauth/authorize/human";
const STEP_UP_URL = "/auth/second-factor/step-up";
const FEATURE_FLAGS_URL = "/feature-flags/evaluate";
const RETURN_URL = "https://orbital.example.com/return";
// What Raft's server answers the authorize request with (the setup address's query).
const SETUP_SEARCH = `?flow=oidc&client_id=orbital-notes&return_to=${encodeURIComponent(RETURN_URL)}&scope=openid+profile&state=state-1&nonce=nonce-1`;
const REQUEST: DesktopWebPreviewRaftSignInRequest = { requestId: "req-1", setupSearch: SETUP_SEARCH };

const originalApiGet = api.get;
const originalApiPost = api.post;

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
const launch = server("server-1", "Launch Server", "launch");

function user(id: string, email: string) {
  return {
    id,
    email,
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
  };
}

function signIn(id = "user-1", email = "owner@example.com") {
  useAuthStore.setState({ user: user(id, email), accessToken: "access", refreshToken: "refresh", loading: false, initialized: true } as never);
}

function signOut() {
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false, initialized: true } as never);
}

/** The shell, as the web sees it: every call recorded, and the two events the shell can send. */
function fakeShell(options: { /** False: a shell that predates `refuse`. */ refuse?: boolean } = {}) {
  const calls: unknown[][] = [];
  /** Who the web named as signed in (`account`), apart from `calls`: said with the flag on or off. */
  const accounts: string[] = [];
  /** Every call in the order it was made, `account` included. */
  const order: unknown[][] = [];
  let request: ((value: DesktopWebPreviewRaftSignInRequest) => void) | null = null;
  let closed: ((requestId: string) => void) | null = null;
  const bridge: DesktopWebPreviewRaftSignInBridge = {
    arm: (accountKey) => { calls.push(["arm", accountKey]); order.push(["arm", accountKey]); },
    account: (accountKey) => { accounts.push(accountKey); order.push(["account", accountKey]); },
    disarm: () => { calls.push(["disarm"]); order.push(["disarm"]); },
    signedOut: () => { calls.push(["signedOut"]); },
    onRequest: (handler) => { request = handler; return () => { request = null; }; },
    onClosed: (handler) => { closed = handler; return () => { closed = null; }; },
    complete: (requestId, url) => { calls.push(["complete", requestId, url]); },
    cancel: (requestId) => { calls.push(["cancel", requestId]); },
    ...(options.refuse === false ? {} : { refuse: (requestId: string) => { calls.push(["refuse", requestId]); } }),
  };
  (window as unknown as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true, webPreview: { raftSignIn: bridge } };
  return {
    calls,
    accounts,
    order,
    raise: (value: DesktopWebPreviewRaftSignInRequest) => act(() => { assert.ok(request, "the web listens for requests"); request(value); }),
    close: (requestId: string) => act(() => { closed?.(requestId); }),
    listening: () => request !== null,
  };
}

type Call = { url: string; body: unknown };

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

/**
 * The App is ready on both Servers, registered with RETURN_URL (or, per Server, with `registered`; null: the lookup
 * refuses there); each POST answers with its handlers in turn.
 */
function stubApi(handlers: Record<string, ((body: unknown) => unknown)[]> = {}, registered: Record<string, string | null> = {}) {
  const posts: Call[] = [];
  const lookups: string[] = [];
  const counts = new Map<string, number>();
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    const serverId = config?.params?.server_id ?? "";
    lookups.push(serverId);
    if (registered[serverId] === null) throw httpError(403, { error: "app_not_available" });
    return {
      data: {
        id: "app-1",
        clientId: "orbital-notes",
        appType: "third_party_global",
        name: "Orbital Notes",
        description: "Review launch notes from Raft.",
        homepageUrl: null,
        returnUrl: registered[serverId] ?? RETURN_URL,
        logoUrl: null,
        availability: "ready",
      },
    };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === FEATURE_FLAGS_URL) return { data: { evaluations: [] } };
    posts.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
  return { posts, lookups };
}

function renderHost() {
  return render(
    <TestIntlProvider>
      <DesktopBrowserSignInHost />
      <SecondFactorStepUpHost />
    </TestIntlProvider>,
  );
}

function flagOn(serverId = launch.id) {
  act(() => setServerFeatureFlagForTests(serverId, DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY, true));
}

/** The sheet is loaded on first use (lazy). */
function findSheet() {
  return screen.findByTestId("desktop-browser-sign-in", {}, { timeout: 5000 });
}

/** The sheet's approving button takes no press for APPROVE_AFTER_MS after it can first be pressed. */
async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false), { timeout: APPROVE_AFTER_MS + 3000 });
  fireEvent.click(button);
}

/** Only the clock the lock runs on is faked (setTimeout); promises and React's own work run as usual. */
function fakeTime() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function pass(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

/** Let pending promises and the renders they cause run (no fake time passes). */
async function turn() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

/** The sheet, on fake time (findBy waits on the faked clock). */
async function sheetOnFakeTime() {
  for (let i = 0; i < 100 && screen.queryByTestId("desktop-browser-sign-in") === null; i += 1) await turn();
  return screen.getByTestId("desktop-browser-sign-in");
}

/**
 * Every way a button is activated: a click, the element's own activation (what a browser runs for Enter and Space on
 * a focused button; jsdom does not turn a key into a click itself), and the keys as events.
 */
function pressEveryWay(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
  button.click();
  for (const key of ["Enter", " "]) {
    fireEvent.keyDown(button, { key });
    fireEvent.keyUp(button, { key });
  }
}

/** Locked as a browser needs it to ignore Enter and Space: natively `disabled`, not only `aria-disabled`. */
function assertLocked(button: HTMLElement, message: string) {
  assert.equal((button as HTMLButtonElement).disabled, true, message);
  assert.equal(button.tagName, "BUTTON");
}

beforeEach(() => {
  resetServerFeatureFlagsForTests();
  // Both Servers' flags are answered (off), so no evaluation lands later over a value a test sets.
  setServerFeatureFlagForTests(launch.id, DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY, false);
  setServerFeatureFlagForTests(alpha.id, DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY, false);
  signIn();
  useServerStore.setState({ servers: [alpha, launch], current: launch, members: [], loading: false } as never);
  window.history.pushState({}, "", "/s/launch/channel/general");
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetSecondFactorStepUpForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  delete (window as unknown as { raftDesktop?: unknown }).raftDesktop;
  localStorage.clear();
});

test("flag off: the shell is never armed; in a browser the host is nothing", () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  assert.deepEqual(shell.calls, [], "signed in with the flag off: nothing is armed, nothing reported");
  assert.deepEqual(shell.accounts, ["user-1"], "only who is signed in is named");
  cleanup();
  delete (window as unknown as { raftDesktop?: unknown }).raftDesktop;
  const { container } = renderHost();
  assert.equal(container.textContent, "");
});

test("flag on: armed for the signed-in account; off again, another Server without it, or another account disarm it", () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  assert.deepEqual(shell.calls, [["arm", "user-1"]]);
  assert.equal(shell.listening(), true);
  // Turned off while the app is open: it reaches the shell at once.
  act(() => setServerFeatureFlagForTests(launch.id, DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY, false));
  assert.deepEqual(shell.calls.slice(1), [["disarm"]]);
  flagOn();
  // Another Server, where the flag is off.
  act(() => useServerStore.setState({ current: alpha } as never));
  assert.deepEqual(shell.calls.slice(2), [["arm", "user-1"], ["disarm"]]);
  act(() => useServerStore.setState({ current: launch } as never));
  // Another account in the same window.
  act(() => signIn("user-2", "other@example.com"));
  assert.deepEqual(shell.calls.slice(4), [["arm", "user-1"], ["disarm"], ["arm", "user-2"]]);
});

test("sign-out is reported to the shell, with the flag on or off; a session still loading is not a sign-out", () => {
  stubApi();
  const shell = fakeShell();
  // Still restoring the session: tokens, no user yet.
  useAuthStore.setState({ user: null, accessToken: "access", refreshToken: "refresh", initialized: false } as never);
  renderHost();
  assert.deepEqual(shell.calls, []);
  act(() => useAuthStore.setState({ initialized: true } as never));
  assert.deepEqual(shell.calls, [], "the server could not be reached: the session is not gone");
  act(() => signIn());
  assert.deepEqual(shell.calls, [], "flag off");
  act(() => signOut());
  assert.deepEqual(shell.calls, [["signedOut"]]);
  act(() => signIn());
  flagOn();
  act(() => signOut());
  assert.deepEqual(shell.calls.slice(1), [["arm", "user-1"], ["disarm"], ["signedOut"]]);
});

test("the sheet shows Raft's own facts, picks the conversation's Server, and authorizes nothing until the press", async () => {
  const { posts, lookups } = stubApi({ [AUTHORIZE_URL]: [() => ({ returnUrl: RETURN_URL, code: "code-1" })] });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);

  const sheet = await findSheet();
  assert.equal(sheet.getAttribute("role"), "dialog");
  const text = () => sheet.textContent ?? "";
  // The host the answer goes to.
  assert.ok(within(sheet).getByTestId("desktop-browser-sign-in-notice").textContent?.includes("orbital.example.com"));
  // The App as the lookup names it (the request carries no name), the account, the Server.
  await within(sheet).findAllByText("Orbital Notes");
  assert.ok(text().includes("owner@example.com") || text().includes("Owner"), "the account");
  await waitFor(() => assert.ok(text().includes("Launch Server (launch)"), "the conversation's Server is picked, not the first by name"));
  assert.deepEqual([...new Set(lookups)].sort(), ["server-1", "server-a"], "the App is looked up on Raft's server");
  // Only the setup's card: no page header, no side card.
  assert.ok(within(sheet).queryByTestId("human-login-setup-scroller") === null);
  assert.ok(within(sheet).queryByRole("button", { name: en["pages.humanLogin.logOut"] }) === null);
  // Nothing from the request's own text: no state, no nonce.
  assert.equal(text().includes("state-1"), false);
  assert.equal(text().includes("nonce-1"), false);
  // No press yet: nothing was authorized and the shell was told nothing.
  assert.deepEqual(posts, []);
  assert.deepEqual(shell.calls, [["arm", "user-1"]]);

  // The sheet has only just appeared: a press that was on its way to the page approves nothing.
  const approve = within(sheet).getByRole("button", { name: "Login with Raft" });
  assert.equal(approve.hasAttribute("disabled"), true, "disabled at first");
  fireEvent.click(approve);
  assert.deepEqual(posts, []);

  const before = window.location.href;
  await clickWhenEnabled(approve);
  await waitFor(() => assert.equal(shell.calls.length, 2));
  assert.deepEqual(shell.calls[1], ["complete", "req-1", `${RETURN_URL}?code=code-1&state=state-1`]);
  assert.equal(window.location.href, before, "this window goes nowhere");
  assert.deepEqual(posts, [{
    url: AUTHORIZE_URL,
    body: {
      clientId: "orbital-notes",
      serverId: "server-1",
      returnUrl: RETURN_URL,
      scopes: ["openid", "profile"],
      oidc: true,
      nonce: "nonce-1",
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
      server: undefined,
      source: "desktop_browser",
    },
  }]);
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null, "the sheet closes"));
});

/** The sentences of the setup page that say nothing the person can act on: the page's, never the sheet's. */
const PAGE_ONLY_SENTENCES = [
  en["pages.humanLogin.appDetailsHelp"],
  en["pages.humanLogin.serverHelp"],
  en["oauth.consent.introIdentityOnly"],
  "wants to connect to",
  "on an available Raft Server",
];

test("the sheet is a dialog's parts: the App's name as its title, Cancel and the approving button in the footer and not in the scrolling body, the focus on ×", async () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  const sheet = await findSheet();
  const approve = await within(sheet).findByRole("button", { name: "Login with Raft" });
  const cancel = within(sheet).getByRole("button", { name: en["common.confirm.cancel"] });
  const body = within(sheet).getByTestId("login-setup-sheet-body");
  const footer = within(sheet).getByTestId("login-setup-sheet-footer");
  // raft-ui's own parts, each straight in the dialog: the body is the one that scrolls, the footer stays.
  assert.equal(body.getAttribute("data-slot"), "dialog-body");
  assert.equal(footer.getAttribute("data-slot"), "dialog-footer");
  assert.ok(body.parentElement === sheet, "the body is straight in the dialog");
  assert.ok(footer.parentElement === sheet, "the footer is straight in the dialog");
  assert.ok(footer.contains(approve), "the approving button is in the footer");
  assert.ok(footer.contains(cancel), "and so is Cancel");
  assert.equal(body.contains(approve), false, "not in what scrolls");
  assert.equal(body.contains(cancel), false);
  assert.equal(within(body).queryAllByRole("button", { name: "Login with Raft" }).length, 0);
  assert.equal(cancel.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING, "Cancel first, the approving button last");

  // The App's name: the dialog's title and the App's card, nothing else.
  assert.equal(within(sheet).getByRole("heading", { name: "Sign in to Orbital Notes" }).getAttribute("data-slot"), "dialog-title");
  assert.equal(within(sheet).getAllByRole("heading").length, 1, "one heading: the title");
  assert.equal((sheet.textContent ?? "").split("Orbital Notes").length - 1, 2);
  // What stays: where the answer goes, the account, what is asked for.
  assert.ok(within(body).getByTestId("desktop-browser-sign-in-notice").querySelector("strong")?.textContent === "orbital.example.com");
  assert.ok((body.textContent ?? "").includes(en["pages.humanLogin.signedInAsPrefix"]));
  assert.ok(within(body).getByTestId("login-with-raft-requested-scopes").textContent?.includes(en["oauth.consent.requestedAccess"]));
  for (const sentence of PAGE_ONLY_SENTENCES) assert.equal((sheet.textContent ?? "").includes(sentence), false, sentence);

  // The focus starts on ×: Enter or Space on a sheet that has only just appeared cancels.
  const close = within(sheet).getByRole("button", { name: en["common.confirm.closeDialog"] });
  await waitFor(() => assert.ok(document.activeElement === close, "the focus is on ×"));

  // Cancel is a way out like ×.
  fireEvent.click(cancel);
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  assert.deepEqual(shell.calls.slice(1), [["cancel", "req-1"]]);
});

test("one available Server is said in a line; more than one is a picker", async () => {
  stubApi({}, { "server-a": null });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  let sheet = await findSheet();
  assert.equal((await within(sheet).findByTestId("login-setup-only-server")).textContent, "Launch Server (launch)");
  assert.ok(within(sheet).queryByRole("combobox") === null, "no picker");
  fireEvent.click(within(sheet).getByRole("button", { name: en["common.confirm.cancel"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));

  stubApi();
  await shell.raise({ ...REQUEST, requestId: "req-2" });
  sheet = await findSheet();
  await within(sheet).findByRole("combobox");
  assert.ok(within(sheet).queryByTestId("login-setup-only-server") === null, "no line");
});

test("the setup page itself is unchanged: its heading, its explanations and its button in the card", async () => {
  stubApi();
  window.history.pushState({}, "", `/login-with-raft/setup${SETUP_SEARCH}`);
  render(<TestIntlProvider><HumanLoginSetupPage /></TestIntlProvider>);
  const page = screen.getByTestId("human-login-setup-scroller");
  await within(page).findByRole("button", { name: "Login with Raft" });
  for (const sentence of PAGE_ONLY_SENTENCES) assert.ok((page.textContent ?? "").includes(sentence), sentence);
  assert.ok(within(page).getByRole("heading", { level: 1 }).textContent?.includes("Orbital Notes"));
  assert.ok(within(page).queryByTestId("login-setup-sheet-footer") === null, "no dialog footer");
  assert.ok(within(page).queryByRole("button", { name: en["common.confirm.cancel"] }) === null, "no Cancel");
  assert.equal((page.textContent ?? "").includes("Sign in to Orbital Notes"), false);
});

test("closing the sheet cancels the request; the shell dropping it closes the sheet; neither authorizes", async () => {
  const { posts } = stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  let sheet = await findSheet();
  fireEvent.click(within(sheet).getByRole("button", { name: en["common.confirm.closeDialog"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  assert.deepEqual(shell.calls.slice(1), [["cancel", "req-1"]]);

  await shell.raise({ ...REQUEST, requestId: "req-2" });
  sheet = await findSheet();
  // Another request's end is not this one's.
  await shell.close("req-1");
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") !== null);
  // The tab navigated away, or the request expired.
  await shell.close("req-2");
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  assert.deepEqual(shell.calls.slice(2), [], "nothing more is said to the shell");
  assert.deepEqual(posts, []);
});

test("\"Verify it's you\" works over the sheet: the press is asked again after it, and cancelling it keeps the sheet", async () => {
  const stepUp = () => { throw httpError(403, { error: "Verify it's you first.", code: "second_factor_step_up_required", methods: ["totp", "backup_code"] }); };
  const { posts } = stubApi({
    [AUTHORIZE_URL]: [stepUp, stepUp, () => ({ returnUrl: RETURN_URL, code: "code-after-step-up" })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  const sheet = await findSheet();
  await waitFor(() => assert.ok((sheet.textContent ?? "").includes("Launch Server (launch)")));

  // Cancelled: the sheet stays, nothing is reported, the request lives.
  await clickWhenEnabled(within(sheet).getByRole("button", { name: "Login with Raft" }));
  let verify = await screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
  await clickWhenEnabled(within(verify).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null));
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") !== null, "the sheet is still open");
  assert.deepEqual(shell.calls, [["arm", "user-1"]]);

  // Verified: the same request goes once more and its answer goes to the shell.
  await clickWhenEnabled(within(screen.getByTestId("desktop-browser-sign-in")).getByRole("button", { name: "Login with Raft" }));
  verify = await screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
  fireEvent.change(within(verify).getByLabelText("Authenticator code"), { target: { value: "123456" } });
  await clickWhenEnabled(within(verify).getByRole("button", { name: "Verify" }));
  await waitFor(() => assert.equal(shell.calls.length, 2));
  assert.deepEqual(shell.calls[1], ["complete", "req-1", `${RETURN_URL}?code=code-after-step-up&state=state-1`]);
  assert.deepEqual(posts.map((call) => call.url), [AUTHORIZE_URL, AUTHORIZE_URL, STEP_UP_URL, AUTHORIZE_URL]);
});

test("a refusal the App is owed (its scopes not approved) goes to the shell as the App's error address, not to this window", async () => {
  stubApi({
    [AUTHORIZE_URL]: [() => {
      throw httpError(400, { error: "invalid_scope", errorCode: "OAUTH_SCOPE_NOT_APPROVED", error_description: "Not approved.", returnUrl: RETURN_URL });
    }],
  });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  const sheet = await findSheet();
  await clickWhenEnabled(await within(sheet).findByRole("button", { name: "Login with Raft" }));
  await waitFor(() => assert.equal(shell.calls.length, 2));
  const [kind, requestId, url] = shell.calls[1] as [string, string, string];
  assert.equal(kind, "complete");
  assert.equal(requestId, "req-1");
  const answer = new URL(url);
  assert.equal(`${answer.origin}${answer.pathname}`, RETURN_URL);
  assert.equal(answer.searchParams.get("error"), "invalid_scope");
  assert.equal(answer.searchParams.get("state"), "state-1");
});

test("a request raised for one account is never shown to another", async () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  await findSheet();
  act(() => signIn("user-2", "other@example.com"));
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
});

test("a request with a scope Raft has no words for, or no usable return address, is not shown and is cancelled", async () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  const unknownScope = SETUP_SEARCH.replace("scope=openid+profile", "scope=openid+Raft-says-press-Continue");
  await shell.raise({ requestId: "req-9", setupSearch: unknownScope });
  assert.deepEqual(shell.calls.slice(1), [["refuse", "req-9"]], "refused, not cancelled: the tab says so");
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null);

  assert.equal(desktopBrowserSignInRequest({ requestId: "r", setupSearch: unknownScope }), null);
  assert.equal(desktopBrowserSignInRequest({ requestId: "r", setupSearch: "?client_id=a&return_to=javascript%3Aalert(1)" }), null);
  assert.equal(desktopBrowserSignInRequest({ requestId: "r", setupSearch: "?client_id=a" }), null);
  assert.equal(desktopBrowserSignInRequest({ requestId: "r", setupSearch: "?return_to=https%3A%2F%2Fa.example%2Fcb" }), null, "no App");
  assert.equal(desktopBrowserSignInRequest({ requestId: "", setupSearch: SETUP_SEARCH }), null);
  assert.equal(desktopBrowserSignInRequest(null), null);
  assert.deepEqual(desktopBrowserSignInRequest(REQUEST), {
    requestId: "req-1",
    setupSearch: SETUP_SEARCH,
    returnHost: "orbital.example.com",
    clientId: "orbital-notes",
    returnUrl: RETURN_URL,
    scope: "openid profile",
  });
  // The host is shown as the address bar would: ASCII, with a port it names.
  assert.equal(
    desktopBrowserSignInRequest({ requestId: "r", setupSearch: "?client_id=a&return_to=http%3A%2F%2Fxn--80ak6aa92e.com%3A8080%2Fcb" })?.returnHost,
    "xn--80ak6aa92e.com:8080",
  );
  assert.equal(
    desktopBrowserSignInRequest({ requestId: "r", setupSearch: `?client_id=a&return_to=${encodeURIComponent("https://аррӏе.com/cb")}` })?.returnHost,
    "xn--80ak6aa92e.com",
    "a lookalike name is shown in its ASCII form",
  );
});

test("a request with another return address than the App is registered with is never shown: no name, no sheet, cancelled", async () => {
  // A page on evil.example asks with Orbital Notes' client_id and a return address of its own (the shell saw the
  // page on that address's site, and the server's authorize answer repeats what it was sent).
  const { posts, lookups } = stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  const evil = SETUP_SEARCH.replace(encodeURIComponent(RETURN_URL), encodeURIComponent("https://evil.example/return"));
  await shell.raise({ requestId: "req-evil", setupSearch: evil });
  // Refused, not cancelled: nobody dismissed anything, so the shell has the tab say Raft's sign-in did not go ahead.
  await waitFor(() => assert.deepEqual(shell.calls.slice(1), [["refuse", "req-evil"]]));
  assert.deepEqual([...lookups].sort(), ["server-1", "server-a"], "the App was looked up, once per Server");
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null, "no sheet");
  assert.ok(screen.queryByText("Orbital Notes") === null, "the App's name is never on screen");
  assert.deepEqual(posts, []);

  // An App nobody's lookup answers for (unknown, or not open to this person) is not shown either.
  cleanup();
  stubApi({}, { "server-1": null, "server-a": null });
  const unknown = fakeShell();
  renderHost();
  await unknown.raise({ ...REQUEST, requestId: "req-unknown" });
  await waitFor(() => assert.deepEqual(unknown.calls.filter((call) => call[0] === "refuse" || call[0] === "cancel"), [["refuse", "req-unknown"]]));
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null);

  // A shell that predates `refuse` is told to forget it, as before.
  cleanup();
  stubApi({}, { "server-1": null, "server-a": null });
  const older = fakeShell({ refuse: false });
  renderHost();
  await older.raise({ ...REQUEST, requestId: "req-older" });
  await waitFor(() => assert.deepEqual(older.calls.filter((call) => call[0] === "refuse" || call[0] === "cancel"), [["cancel", "req-older"]]));

  // The rule itself: the registered address, character for character.
  assert.equal(isRegisteredReturnAddress(RETURN_URL, [RETURN_URL]), true);
  assert.equal(isRegisteredReturnAddress(RETURN_URL, ["https://other.example/return", RETURN_URL]), true, "registered so on one Server");
  assert.equal(isRegisteredReturnAddress("https://evil.example/return", [RETURN_URL]), false);
  assert.equal(isRegisteredReturnAddress(`${RETURN_URL}/`, [RETURN_URL]), false);
  assert.equal(isRegisteredReturnAddress(`${RETURN_URL}?next=https://evil.example`, [RETURN_URL]), false);
  assert.equal(isRegisteredReturnAddress(RETURN_URL.replace("https://", "http://"), [RETURN_URL]), false);
  assert.equal(isRegisteredReturnAddress(RETURN_URL, []), false, "no lookup answered");
  assert.equal(isRegisteredReturnAddress(RETURN_URL, [null, undefined, 7]), false);
  assert.equal(isRegisteredReturnAddress("", [""]), false);
});

test("the App is listed only on Servers where it is registered with the request's return address", async () => {
  // On Launch (the conversation's Server) a Server-local App of the same id is registered with another address: the
  // sheet does not offer it there, and picks the Server where the App is the one asked for.
  stubApi({}, { "server-1": "https://other.example/return" });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  const sheet = await findSheet();
  await waitFor(() => assert.ok((sheet.textContent ?? "").includes("Alpha Server (alpha)")));
  assert.equal((sheet.textContent ?? "").includes("Launch Server"), false);
});

test("a request the shell ends while its App is looked up is never shown; the next request is shown in its turn", async () => {
  const stub = stubApi({ [AUTHORIZE_URL]: [() => ({ returnUrl: RETURN_URL, code: "code-3" })] });
  const shell = fakeShell();
  renderHost();
  flagOn();
  // The lookups wait.
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stubbedGet = api.get;
  api.get = (async (...args: Parameters<typeof api.get>) => { await gate; return stubbedGet(...args); }) as typeof api.get;
  await shell.raise(REQUEST);
  await shell.close("req-1");
  await act(async () => { release(); await gate; await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null);
  assert.deepEqual(shell.calls, [["arm", "user-1"]], "nothing is said to the shell: it ended the request itself");
  assert.equal(stub.lookups.length, 2);

  await shell.raise({ ...REQUEST, requestId: "req-2" });
  await findSheet();
  // A second request: the shell ends the first (its sheet closes), and the second's opens when its check is done.
  await shell.close("req-2");
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  await shell.raise({ ...REQUEST, requestId: "req-3" });
  const sheet = await findSheet();
  await clickWhenEnabled(await within(sheet).findByRole("button", { name: "Login with Raft" }));
  await waitFor(() => assert.deepEqual(shell.calls.slice(1), [["complete", "req-3", `${RETURN_URL}?code=code-3&state=state-1`]]));
});

test("the lock starts when the approving button can first be pressed, not when the sheet mounts: after a slow lookup it is locked for its whole interval", async () => {
  const { posts } = stubApi({ [AUTHORIZE_URL]: [() => ({ returnUrl: RETURN_URL, code: "code-slow" })] });
  const shell = fakeShell();
  renderHost();
  flagOn();
  // The host's lookups (before the sheet) answer; the setup's own, inside the sheet, wait.
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stubbedGet = api.get;
  let lookups = 0;
  api.get = (async (...args: Parameters<typeof api.get>) => {
    lookups += 1;
    if (lookups > 2) await gate;
    return stubbedGet(...args);
  }) as typeof api.get;
  fakeTime();
  await shell.raise(REQUEST);
  const sheet = await sheetOnFakeTime();
  assert.ok(within(sheet).queryByRole("button", { name: "Login with Raft" }) === null, "still looking the App up: no button yet");
  // Longer than the lock passes before there is a button.
  pass(APPROVE_AFTER_MS * 3);
  await act(async () => { release(); await gate; });
  await turn();
  const approve = within(sheet).getByRole("button", { name: "Login with Raft" });
  assertLocked(approve, "the button has only just appeared: locked, however long the sheet has been open");
  pressEveryWay(approve);
  pass(APPROVE_AFTER_MS - 1);
  assertLocked(approve, "locked to the end of its interval");
  pressEveryWay(approve);
  await turn();
  assert.deepEqual(posts, []);
  pass(1);
  assert.equal((approve as HTMLButtonElement).disabled, false);
  fireEvent.click(approve);
  await turn();
  assert.deepEqual(shell.calls.slice(1), [["complete", "req-1", `${RETURN_URL}?code=code-slow&state=state-1`]]);
});

test("while locked no click, Enter or Space approves, through the whole interval; the window regaining the focus locks it again", async () => {
  const { posts } = stubApi({ [AUTHORIZE_URL]: [() => ({ returnUrl: RETURN_URL, code: "code-key" })] });
  const shell = fakeShell();
  renderHost();
  flagOn();
  fakeTime();
  await shell.raise(REQUEST);
  const sheet = await sheetOnFakeTime();
  await turn();
  const approve = within(sheet).getByRole("button", { name: "Login with Raft" });
  // At its first instant, 1 ms in, half way, and 1 ms short of the end.
  for (const step of [0, 1, APPROVE_AFTER_MS / 2 - 1, APPROVE_AFTER_MS / 2 - 1]) {
    pass(step);
    assertLocked(approve, "locked through its whole interval");
    pressEveryWay(approve);
  }
  await turn();
  assert.deepEqual(posts, [], "nothing was approved");
  pass(1);
  assert.equal((approve as HTMLButtonElement).disabled, false, "pressable once the interval is over");

  // Another window was in front; the person comes back (or a page brought the window forward): the interval starts over.
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  assertLocked(approve, "locked again when the window regains the focus");
  pressEveryWay(approve);
  pass(APPROVE_AFTER_MS - 1);
  assertLocked(approve, "for the whole interval");
  pressEveryWay(approve);
  await turn();
  assert.deepEqual(posts, []);
  pass(1);
  assert.equal((approve as HTMLButtonElement).disabled, false);
  // And the keyboard's activation now approves.
  approve.click();
  await turn();
  assert.equal(posts.length, 1);
  assert.deepEqual(shell.calls.slice(1), [["complete", "req-1", `${RETURN_URL}?code=code-key&state=state-1`]]);
});

test("an App that would first be installed is held to the same return address: a mismatching Marketplace entry is refused", async () => {
  // The lookup offers the App for install, registered with another return address than the request names.
  const installable = (returnUrl: string) => ({
    id: "app-1",
    clientId: "orbital-notes",
    appType: "third_party_global",
    name: "Orbital Notes",
    description: "Review launch notes from Raft.",
    homepageUrl: null,
    returnUrl,
    logoUrl: null,
    marketplace: true,
    availability: "install_required",
    installation: { serverId: "server-1", canInstall: true },
  });
  const { posts } = stubApi();
  const ready = api.get;
  const lookupWith = (answers: Record<string, string | undefined>) => {
    api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
      const other = answers[config?.params?.server_id ?? ""];
      return other ? { data: installable(other) } : ready(url, config as never);
    }) as typeof api.get;
  };

  // Installable everywhere, nowhere with the request's address: no sheet, no name, cancelled.
  lookupWith({ "server-1": "https://evil.example/return", "server-a": "https://evil.example/return" });
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  await waitFor(() => assert.deepEqual(shell.calls.slice(1), [["refuse", "req-1"]]));
  assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null, "no sheet");
  assert.ok(screen.queryByText("Orbital Notes") === null);

  // Ready on Alpha with the request's address, installable on Launch (the conversation's Server) with another: the
  // sheet offers Alpha only, and nothing to install.
  lookupWith({ "server-1": "https://evil.example/return" });
  await shell.raise({ ...REQUEST, requestId: "req-2" });
  const sheet = await findSheet();
  await waitFor(() => assert.ok((sheet.textContent ?? "").includes("Alpha Server (alpha)")));
  assert.equal((sheet.textContent ?? "").includes("Launch Server"), false, "the mismatching Server is not offered");
  assert.ok(within(sheet).queryByRole("button", { name: en["pages.humanLogin.installAndContinue"] }) === null);
  assert.ok(within(sheet).queryByTestId("marketplace-login-commit") === null);

  // The same entry with the request's own address is offered for install: the refusal above is the address's.
  lookupWith({ "server-1": RETURN_URL });
  await shell.close("req-2");
  await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  await shell.raise({ ...REQUEST, requestId: "req-3" });
  const offered = await findSheet();
  await within(offered).findByRole("button", { name: en["pages.humanLogin.installAndContinue"] }, { timeout: 5000 });
  assert.deepEqual(posts, []);
});

// The setup page opened directly in a tab (no authorize request): the query Raft Desktop's main builds from its
// allow-list (apps/desktop webPreviewRaftSignInRules.ts raftSetupEntryRequest): no `flow`, no nonce, no challenge.
const DIRECT_SETUP_SEARCH = `?client_id=orbital-notes&return_to=${encodeURIComponent(RETURN_URL)}&scope=openid+profile&state=state-1`;

/** The lookup answers `answer(serverId)` for the App on each Server (null: the API's ready answer). */
function lookupAnswers(answer: (serverId: string) => Record<string, unknown> | null) {
  const ready = api.get;
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    const data = url === "/oauth/clients/lookup" ? answer(config?.params?.server_id ?? "") : null;
    return data ? { data } : ready(url, config as never);
  }) as typeof api.get;
}

const ORBITAL = {
  id: "app-1",
  clientId: "orbital-notes",
  appType: "third_party_global",
  name: "Orbital Notes",
  description: "Review launch notes from Raft.",
  homepageUrl: null,
  returnUrl: RETURN_URL,
  logoUrl: null,
};

test("the setup page opened directly (no authorize request): an account-mode App shows what it shows after an authorize, and signs in without OIDC", async () => {
  const { posts } = stubApi({ "/oauth/authorize/account": [() => ({ returnUrl: RETURN_URL, code: "code-1" })] });
  lookupAnswers(() => ({ ...ORBITAL, loginMode: "account", availability: "ready" }));
  const shell = fakeShell();
  renderHost();
  flagOn();
  const seen: string[] = [];
  for (const [requestId, setupSearch] of [["req-authorize", SETUP_SEARCH], ["req-direct", DIRECT_SETUP_SEARCH]] as const) {
    await shell.raise({ requestId, setupSearch });
    const sheet = await findSheet();
    const approve = await within(sheet).findByRole("button", { name: "Login with Raft" }, { timeout: 5000 });
    // The account card: no Server is offered or named (an account-mode App signs in with no Server).
    await waitFor(() => assert.ok((sheet.textContent ?? "").includes("Orbital Notes")));
    assert.ok(within(sheet).queryByRole("combobox") === null, "no Server picker");
    assert.equal(/Launch Server|Alpha Server/.test(sheet.textContent ?? ""), false, "no Server named");
    await clickWhenEnabled(approve);
    await waitFor(() => assert.deepEqual(shell.calls.at(-1), ["complete", requestId, `${RETURN_URL}?code=code-1&state=state-1`]));
    seen.push(sheet.textContent ?? "");
    await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  }
  assert.equal(seen[1], seen[0], "the sheet said the same thing for both");
  assert.deepEqual(posts.map((post) => post.url), ["/oauth/authorize/account", "/oauth/authorize/account"]);
  assert.deepEqual(posts[0]!.body, {
    clientId: "orbital-notes", returnUrl: RETURN_URL, scopes: ["openid", "profile"], oidc: true, nonce: "nonce-1",
    codeChallenge: undefined, codeChallengeMethod: undefined, source: "desktop_browser",
  });
  assert.deepEqual(posts[1]!.body, { clientId: "orbital-notes", returnUrl: RETURN_URL, scopes: ["openid", "profile"], source: "desktop_browser" }, "the page's own flow for a direct visit");
});

test("the setup page opened directly (no authorize request): a Marketplace App that would first be installed is offered for install as after an authorize", async () => {
  const { posts } = stubApi();
  lookupAnswers(() => ({ ...ORBITAL, marketplace: true, availability: "install_required", installation: { serverId: "server-1", canInstall: true } }));
  const shell = fakeShell();
  renderHost();
  flagOn();
  const seen: string[] = [];
  for (const [requestId, setupSearch] of [["req-authorize", SETUP_SEARCH], ["req-direct", DIRECT_SETUP_SEARCH]] as const) {
    await shell.raise({ requestId, setupSearch });
    const sheet = await findSheet();
    await within(sheet).findByRole("button", { name: en["pages.humanLogin.installAndContinue"] }, { timeout: 5000 });
    seen.push(sheet.textContent ?? "");
    await shell.close(requestId);
    await waitFor(() => assert.ok(screen.queryByTestId("desktop-browser-sign-in") === null));
  }
  assert.equal(seen[1], seen[0], "the sheet said the same thing for both");
  assert.equal(shell.calls.some((call) => call[0] === "refuse"), false);
  assert.deepEqual(posts, [], "nothing installed or authorized without a press");
});

/** The layouts the sheet can show an App in, each with the lookup's fields that pick it and its approving button. */
const LOGO_LAYOUTS: [string, Record<string, unknown>, string][] = [
  ["ready on a Server", { availability: "ready" }, "Login with Raft"],
  [
    "installed first from the Marketplace",
    { marketplace: true, availability: "install_required", installation: { canInstall: true } },
    en["pages.humanLogin.installAndContinue"],
  ],
  ["signed in with the Raft account", { availability: "ready", loginMode: "account" }, "Login with Raft"],
];

test.each(LOGO_LAYOUTS)("the App's card shows the logo its lookup returns: %s", async (_layout, fields, approve) => {
  const LOGO = "/api/integration-logos/app-1/logo.webp";
  stubApi();
  // Only the client lookup is answered here; any other GET still meets stubApi's guard.
  const others = api.get;
  api.get = (async (url: string, config?: { params?: { server_id?: string } }) => {
    if (url !== "/oauth/clients/lookup") return others(url, config as never);
    const installation = "installation" in fields ? { ...(fields.installation as object), serverId: config?.params?.server_id } : undefined;
    return {
      data: {
        id: "app-1",
        clientId: "orbital-notes",
        appType: "third_party_global",
        name: "Orbital Notes",
        description: "Review launch notes from Raft.",
        homepageUrl: null,
        returnUrl: RETURN_URL,
        logoUrl: LOGO,
        ...fields,
        ...(installation ? { installation } : null),
      },
    };
  }) as typeof api.get;
  const shell = fakeShell();
  renderHost();
  flagOn();
  await shell.raise(REQUEST);
  const sheet = await findSheet();
  await within(sheet).findByRole("button", { name: approve }, { timeout: 5000 });
  const body = within(sheet).getByTestId("login-setup-sheet-body");
  const logos = [...body.querySelectorAll("img")].filter((image) => image.getAttribute("src") === LOGO);
  assert.equal(logos.length, 1, "the App's logo, once");
  // In the App's card, beside its name.
  assert.ok(logos[0]!.closest("[data-slot='card']")?.textContent?.includes("Orbital Notes"), "in the App's card");
});

test("another account right after the first, with no sign-out between and the flag off for it: the shell is told who is signed in", async () => {
  stubApi();
  const shell = fakeShell();
  renderHost();
  flagOn();
  assert.deepEqual(shell.order, [["account", "user-1"], ["arm", "user-1"]], "named before it is armed");
  // user-2 replaces user-1 in the same window, on a Server where the flag is off: never armed.
  act(() => {
    useServerStore.setState({ current: alpha } as never);
    signIn("user-2", "other@example.com");
  });
  assert.deepEqual(shell.order.slice(2), [["disarm"], ["account", "user-2"]], "the shell empties what user-1 left when its record names another account");
  assert.equal(shell.calls.some((call) => call[0] === "signedOut"), false, "nobody signed out");
  // With the flag on for the new account: named first, then armed.
  act(() => {
    useServerStore.setState({ current: launch } as never);
    signIn("user-3", "third@example.com");
  });
  assert.deepEqual(shell.order.slice(4), [["account", "user-3"], ["arm", "user-3"]]);
  // A session still loading is nobody: nothing is named.
  act(() => useAuthStore.setState({ user: null } as never));
  assert.deepEqual(shell.order.slice(6), [["disarm"]]);

  // A shell from before `account` existed: the host works as it did.
  cleanup();
  const older = fakeShell();
  delete (window as unknown as { raftDesktop: { webPreview: { raftSignIn: { account?: unknown } } } }).raftDesktop.webPreview.raftSignIn.account;
  signIn();
  renderHost();
  assert.deepEqual(older.order, [["arm", "user-1"]]);
});
