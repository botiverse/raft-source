import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import LoginPage from "../src/components/auth/LoginPage";
import type { AccountLinkSignIn } from "../src/components/auth/LoginPage";
import { clearSecondFactorSignIn } from "../src/components/auth/secondFactorSignIn";
import { useAuthStore } from "../src/store/authStore";
import { installFakeDesktopAuth } from "./helpers/fakeDesktopAuth";
import type { FakeDesktopAuth } from "./helpers/fakeDesktopAuth";
import { assertionJSON, closedPrompt, credentialFor, installFakeWebAuthn } from "./helpers/fakeWebAuthn";
import type { FakeWebAuthn } from "./helpers/fakeWebAuthn";
import { TestIntlProvider } from "./helpers/intl";

// Passkey sign-in on the sign-in page (#triage:#135; the link's rule
// tygg's, #triage:5c43fdb1): the email field's autofill (invisible without a
// passkey) and "Sign in with a passkey" in every browser that can use
// passkeys, whose prompt also reaches a passkey on a phone.
// The server is stubbed at the axios client; the browser's WebAuthn by
// helpers/fakeWebAuthn.

vi.mock("../src/hooks/useAuthProviders", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuthProviders: () => ({ enabledProviders: [], loading: false, expectedCount: 0 }),
}));

const OPTIONS_URL = "/auth/passkey/options";
const VERIFY_URL = "/auth/passkey/verify";
const SIGNED_IN = {
  user: { id: "user-1", email: "owner@example.com", name: "owner", preferredMessageBodyFontSize: null },
  accessToken: "access-1",
  refreshToken: "refresh-1",
};

const originalPost = api.post;
let webauthn: FakeWebAuthn | null = null;
let desktop: FakeDesktopAuth | null = null;

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

afterEach(() => {
  cleanup();
  webauthn?.restore();
  webauthn = null;
  desktop?.cleanup();
  desktop = null;
  api.post = originalPost;
  clearSecondFactorSignIn();
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

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

/** Fresh options each call, with a different single-use challenge (base64url, 43 characters). */
function optionsHandler(): Handler {
  let n = 0;
  return () => {
    n += 1;
    return {
      options: { challenge: String(n).repeat(43), rpId: "localhost", userVerification: "required", allowCredentials: [] },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  };
}

function renderLogin(accountLink?: AccountLinkSignIn) {
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <LoginPage onForgotPassword={vi.fn()} accountLink={accountLink} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function passkeyLinks() {
  return screen.queryAllByRole("button", { name: "Sign in with a passkey" });
}

/** Lets the page's first effects (the autofill's feature check, options) run. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickPasskeyLink() {
  const link = await screen.findByRole("button", { name: "Sign in with a passkey" });
  await waitFor(() => assert.equal(link.hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(link);
  });
}

test("a browser without passkeys: the sign-in page is as before and never asks for passkey options", async () => {
  const posts = stubPosts({});
  renderLogin();

  await screen.findByLabelText("Password");
  await settle();
  assert.equal(passkeyLinks().length, 0);
  assert.deepEqual(posts, []);
});

test("a device that never used a passkey gets the autofill and the link", async () => {
  webauthn = installFakeWebAuthn({ autofill: true });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()] });
  renderLogin();

  await waitFor(() => assert.equal(webauthn?.gets.length, 1));
  assert.equal(webauthn.gets[0]!.mediation, "conditional");
  assert.equal(screen.getByLabelText("Email").getAttribute("autocomplete"), "username webauthn");
  assert.equal(passkeyLinks().length, 1);
  assert.deepEqual(posts.map((post) => post.url), [OPTIONS_URL]);
});

test("the link replaces the pending autofill with a discoverable prompt, so a phone's passkey signs in here", async () => {
  webauthn = installFakeWebAuthn({ autofill: true, get: () => credentialFor(assertionJSON("phone-cred")) });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()], [VERIFY_URL]: [() => SIGNED_IN] });
  renderLogin();

  await waitFor(() => assert.equal(webauthn?.gets.length, 1));
  const autofill = webauthn.gets[0]!;
  await clickPasskeyLink();
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));

  assert.equal(autofill.signal?.aborted, true, "the autofill's request ends before the prompt starts");
  const prompt = webauthn.gets.at(-1)!;
  assert.equal(prompt.mediation, undefined, "a prompt, not the autofill");
  assert.equal(prompt.publicKey?.allowCredentials?.length ?? 0, 0, "discoverable: any passkey, on any device");
  assert.deepEqual(posts.at(-1), { url: VERIFY_URL, body: { challenge: "2".repeat(43), response: assertionJSON("phone-cred") } });
});

test("clicking the link again while its prompt is open starts no second prompt", async () => {
  let answer: (credential: unknown) => void = () => {};
  webauthn = installFakeWebAuthn({ autofill: true, get: () => new Promise((resolve) => { answer = resolve; }) });
  stubPosts({ [OPTIONS_URL]: [optionsHandler()], [VERIFY_URL]: [() => SIGNED_IN] });
  renderLogin();

  await waitFor(() => assert.equal(webauthn?.gets.length, 1));
  const link = await screen.findByRole("button", { name: "Sign in with a passkey" });
  await act(async () => {
    fireEvent.click(link);
    fireEvent.click(link);
  });
  await waitFor(() => assert.equal(webauthn?.gets.length, 2));
  // The replaced autofill's ending must not re-enable the link.
  await settle();
  await act(async () => {
    fireEvent.click(link);
  });
  await settle();
  const prompts = webauthn.gets.filter((get) => get.mediation !== "conditional");
  assert.equal(prompts.length, 1, "one prompt at a time");
  assert.equal(webauthn.gets.length, 2, "no autofill restarts under the open prompt");

  await act(async () => {
    answer(credentialFor(assertionJSON("phone-cred")));
  });
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
});

test("an account-link sign-in shows no passkey link and starts no autofill", async () => {
  webauthn = installFakeWebAuthn({ autofill: true });
  const posts = stubPosts({});
  renderLogin({
    terminal: null,
    restart: vi.fn(),
    attemptId: "link-1",
    provider: "github",
    providerLabel: "GitHub",
    email: "owner@example.com",
    signInMethods: { password: true, providers: [] },
    busy: false,
    error: "",
    signIn: vi.fn(),
    socialSignIn: vi.fn(),
    cancel: vi.fn(),
  });

  await screen.findByLabelText("Password");
  await settle();
  assert.equal(passkeyLinks().length, 0);
  assert.deepEqual(webauthn.gets, []);
  assert.deepEqual(posts, []);
});

test("Raft Desktop shows one passkey link (its browser handoff) and no autofill", async () => {
  localStorage.setItem("raft.passkey.desktop-account", "1");
  desktop = installFakeDesktopAuth({ appLogin: true });
  // Desktop's Chromium has WebAuthn; Raft can't use it there (design A5).
  webauthn = installFakeWebAuthn({ autofill: true });
  const posts = stubPosts({});
  renderLogin();

  await screen.findByLabelText("Password");
  await settle();
  assert.equal(passkeyLinks().length, 1);
  assert.deepEqual(webauthn.gets, []);
  assert.deepEqual(posts, []);
});

test("picking a passkey from the autofill signs in, with no second step", async () => {
  webauthn = installFakeWebAuthn({ autofill: true, pendingAutofill: false, get: () => credentialFor(assertionJSON()) });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()], [VERIFY_URL]: [() => SIGNED_IN] });
  renderLogin();

  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.equal(localStorage.getItem("slock_access_token"), "access-1");
  assert.deepEqual(posts.at(-1), { url: VERIFY_URL, body: { challenge: "1".repeat(43), response: assertionJSON() } });
  assert.ok(screen.queryByText("Two-step verification") === null);
});

test("in a browser without the autofill, the link signs in with a passkey", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()], [VERIFY_URL]: [() => SIGNED_IN] });
  renderLogin();

  await clickPasskeyLink();
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  assert.deepEqual(posts.map((post) => post.url), [OPTIONS_URL, VERIFY_URL]);
  assert.deepEqual(posts[1]!.body, { challenge: "1".repeat(43), response: assertionJSON() });
  // A prompt, not the autofill.
  assert.equal(webauthn.gets.at(-1)!.mediation, undefined);
});

test("an unrecognized passkey says so; trying again uses fresh options", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  const posts = stubPosts({
    [OPTIONS_URL]: [optionsHandler()],
    [VERIFY_URL]: [fail(401, { code: "passkey_not_recognized", error: "That passkey wasn't recognized." }), () => SIGNED_IN],
  });
  renderLogin();

  await clickPasskeyLink();
  await screen.findByText("That passkey wasn't recognized. Try again, or sign in another way.");
  assert.equal(useAuthStore.getState().user, null);

  await clickPasskeyLink();
  await waitFor(() => assert.equal(useAuthStore.getState().user?.id, "user-1"));
  const verifies = posts.filter((post) => post.url === VERIFY_URL).map((post) => (post.body as { challenge: string }).challenge);
  assert.deepEqual(verifies, ["1".repeat(43), "2".repeat(43)], "each attempt answers its own single-use challenge");
});

test("closing the passkey prompt is not an error: it only says the prompt was closed", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()] });
  renderLogin();

  await clickPasskeyLink();
  await screen.findByText("The passkey prompt was closed, so you haven't been signed in. Try again, or sign in another way.");
  assert.ok(screen.queryByText("Sign-in failed") === null);
  assert.ok(screen.queryByText("That passkey wasn't recognized. Try again, or sign in another way.") === null);
  assert.equal(useAuthStore.getState().user, null);
  assert.ok(!posts.some((post) => post.url === VERIFY_URL), "nothing is sent for a closed prompt");
  // The link stays, to try again.
  screen.getByRole("button", { name: "Sign in with a passkey" });
});

test("a browser error in the autofill, before anyone picks a passkey, shows nothing (#triage:989056fc)", async () => {
  webauthn = installFakeWebAuthn({
    autofill: true,
    pendingAutofill: false,
    get: () => { throw new DOMException("No authenticator", "NotSupportedError"); },
  });
  const posts = stubPosts({ [OPTIONS_URL]: [optionsHandler()] });
  renderLogin();

  await waitFor(() => assert.ok(webauthn.gets.length >= 1, "the autofill asked the browser"));
  await settle();
  assert.ok(screen.queryByText("Sign-in failed") === null, "the page opened untouched shows no failure");
  assert.ok(!posts.some((post) => post.url === VERIFY_URL), "nothing was picked, nothing is sent");
  // One autofill, not a loop of fresh options and the same error.
  assert.equal(posts.filter((post) => post.url === OPTIONS_URL).length, 1);
  assert.equal(webauthn.gets.length, 1);
  // The link is still there for a deliberate try.
  screen.getByRole("button", { name: "Sign in with a passkey" });
});

test("the same browser error after the link's click is a failed sign-in", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw new DOMException("No authenticator", "NotSupportedError"); } });
  stubPosts({ [OPTIONS_URL]: [optionsHandler()] });
  renderLogin();

  await clickPasskeyLink();
  await screen.findByText("Sign-in failed");
});

// The server answers 404 since v1.21.45 and answered 503 before; the page reads only the code.
for (const status of [404, 503]) {
  test(`without passkeys on the server the link goes away (${status})`, async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
    stubPosts({ [OPTIONS_URL]: [fail(status, { code: "passkeys_unavailable", error: "Passkeys are not available right now." })] });
    renderLogin();

    await clickPasskeyLink();
    await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Sign in with a passkey" }) === null));
    assert.ok(screen.queryByText("Sign-in failed") === null);
  });
}

test("with the autofill, a server without passkeys hides the link before anyone clicks it", async () => {
  webauthn = installFakeWebAuthn({ autofill: true });
  const posts = stubPosts({ [OPTIONS_URL]: [fail(404, { code: "passkeys_unavailable", error: "Passkeys are not available right now." })] });
  renderLogin();

  await waitFor(() => assert.deepEqual(posts.map((post) => post.url), [OPTIONS_URL]));
  await waitFor(() => assert.equal(passkeyLinks().length, 0));
  assert.deepEqual(webauthn.gets, []);
  assert.ok(screen.queryByText("Sign-in failed") === null);
});
