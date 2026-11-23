import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { AppStepUpPage } from "../src/pages/AppStepUpPage";
import { appStepUpRedirect } from "../src/pages/appStepUpRedirect";
import { useAuthStore } from "../src/store/authStore";
import { assertionJSON, closedPrompt, credentialFor, installFakeWebAuthn } from "./helpers/fakeWebAuthn";
import type { FakeWebAuthn } from "./helpers/fakeWebAuthn";
import { TestIntlProvider } from "./helpers/intl";

// The app's step-up page (/login/app/verify, docs/contracts/app-web-step-up.md):
// no web sign-in is read; it shows the account and the change first and asks
// for the passkey only after Continue; success, cancel and expiry hand
// control back to the app's callback. Server answers are stubbed at the
// axios client.

const REQUEST = "11111111-2222-4333-8444-555555555555";
const BASE = `/auth/app-login/step-up/requests/${REQUEST}`;
const DESCRIBED = {
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  client: { id: "raft-app", name: "Raft" },
  action: "computer_attach",
  account: { name: "Owner", maskedEmail: "o***@example.com" },
};
const OPTIONS = { options: { challenge: "a".repeat(43), rpId: "raft.build", userVerification: "required", allowCredentials: [{ id: "Y3JlZA", type: "public-key" }] }, rp: "legacy" };

type Handler = (body: unknown) => unknown;

const originalGet = api.get;
const originalPost = api.post;
const originalAssign = appStepUpRedirect.assign;
let webauthn: FakeWebAuthn | null = null;
let assigned: string[] = [];

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}
function fail(status: number, data: Record<string, unknown>): Handler {
  return () => {
    throw httpError(status, data);
  };
}

function stubGet(handler: () => unknown) {
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url !== BASE) throw new Error(`Unexpected GET ${url}`);
    return { data: handler() };
  }) as typeof api.get;
  return gets;
}

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

function renderPage() {
  window.history.pushState({}, "", `/login/app/verify?request=${REQUEST}`);
  render(<TestIntlProvider><AppStepUpPage /></TestIntlProvider>);
}

async function clickContinue() {
  const button = await screen.findByRole("button", { name: "Continue" });
  await waitFor(() => assert.ok(!button.hasAttribute("disabled"), "Continue is enabled"));
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  assigned = [];
  appStepUpRedirect.assign = (url: string) => {
    assigned.push(url);
  };
});

afterEach(() => {
  cleanup();
  webauthn?.restore();
  webauthn = null;
  api.get = originalGet;
  api.post = originalPost;
  appStepUpRedirect.assign = originalAssign;
  window.history.pushState({}, "", "/");
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, loading: false } as never);
});

test("shows the account and the change first, asks for the passkey only after Continue, then returns to the app", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON("cred-legacy")) });
  stubGet(() => DESCRIBED);
  const posts = stubPosts({
    [`${BASE}/options`]: [() => OPTIONS],
    [`${BASE}/verify`]: [() => ({ redirectUrl: `raft://login/callback?requestId=${REQUEST}&code=one-time` })],
  });
  renderPage();

  assert.equal((await screen.findByTestId("app-step-up-account")).textContent, "Owner (o***@example.com)");
  assert.equal(screen.getByTestId("app-step-up-action").textContent, "Add a computer in Raft");
  assert.equal(webauthn.gets.length, 0, "no passkey prompt before Continue");
  assert.deepEqual(posts, []);

  await clickContinue();
  await screen.findByTestId("app-step-up-returned");
  assert.equal(webauthn.gets.length, 1);
  assert.deepEqual(posts.map((post) => post.url), [`${BASE}/options`, `${BASE}/verify`]);
  assert.equal((posts[1]!.body as { webauthn: { id: string } }).webauthn.id, "cred-legacy");
  assert.deepEqual(assigned, [`raft://login/callback?requestId=${REQUEST}&code=one-time`]);
});

test("ignores whoever is signed in on the web: the request's account is shown", async () => {
  useAuthStore.setState({ user: { id: "someone-else", email: "else@example.com", name: "else" }, loading: false } as never);
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  stubGet(() => DESCRIBED);
  stubPosts({});
  renderPage();
  assert.equal((await screen.findByTestId("app-step-up-account")).textContent, "Owner (o***@example.com)");
  assert.ok(screen.queryByText(/else@example.com/) === null, "the web account is not shown");
});

test("a closed prompt or a wrong passkey stays on the page and can try again", async () => {
  let answers = 0;
  webauthn = installFakeWebAuthn({
    get: () => {
      answers += 1;
      if (answers === 1) throw closedPrompt();
      return credentialFor(assertionJSON());
    },
  });
  stubGet(() => DESCRIBED);
  stubPosts({
    [`${BASE}/options`]: [() => OPTIONS],
    [`${BASE}/verify`]: [fail(400, { code: "second_factor_code_invalid" }), () => ({ redirectUrl: "raft://login/callback?code=x" })],
  });
  renderPage();

  await clickContinue();
  assert.equal((await screen.findByTestId("app-step-up-notice")).textContent, "The passkey prompt was closed. Select Continue to try again.");
  await clickContinue();
  await screen.findByText("That passkey didn’t work. Try again with the passkey for this account.");
  assert.deepEqual(assigned, []);
  await clickContinue();
  await screen.findByTestId("app-step-up-returned");
  assert.deepEqual(assigned, ["raft://login/callback?code=x"]);
});

test("Cancel tells the app", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  stubGet(() => DESCRIBED);
  stubPosts({ [`${BASE}/cancel`]: [() => ({ redirectUrl: `raft://login/callback?requestId=${REQUEST}&error=access_denied` })] });
  renderPage();
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await waitFor(() => assert.ok(!cancel.hasAttribute("disabled"), "Cancel is enabled"));
  await act(async () => {
    fireEvent.click(cancel);
  });
  await screen.findByText("Cancelled. Returning to the app");
  assert.deepEqual(assigned, [`raft://login/callback?requestId=${REQUEST}&error=access_denied`]);
  assert.equal(webauthn.gets.length, 0);
});

test("an expired request says so and offers the way back; an unknown one is invalid", async () => {
  stubGet(fail(410, { code: "request_expired", redirectUrl: `raft://login/callback?requestId=${REQUEST}&error=expired` }) as () => unknown);
  stubPosts({});
  renderPage();
  await screen.findByText("This request has expired. Go back to the app and try again.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back to the app" }));
  });
  assert.deepEqual(assigned, [`raft://login/callback?requestId=${REQUEST}&error=expired`]);
  cleanup();

  stubGet(fail(404, { code: "request_not_found" }) as () => unknown);
  renderPage();
  await screen.findByText("This link isn’t valid. Go back to the app and try again.");
  assert.ok(screen.queryByRole("button", { name: "Back to the app" }) === null, "no way back without a callback");
});

test("a request that expires while the passkey is asked for turns into the expired state", async () => {
  webauthn = installFakeWebAuthn({ get: () => credentialFor(assertionJSON()) });
  stubGet(() => DESCRIBED);
  stubPosts({
    [`${BASE}/options`]: [() => OPTIONS],
    [`${BASE}/verify`]: [fail(410, { code: "request_expired", redirectUrl: "raft://login/callback?error=expired" })],
  });
  renderPage();
  await clickContinue();
  await screen.findByTestId("app-step-up-unusable");
  await screen.findByText("This request has expired. Go back to the app and try again.");
});

test("a browser without passkeys says so and cannot continue", async () => {
  stubGet(() => DESCRIBED);
  stubPosts({});
  renderPage();
  await screen.findByTestId("app-step-up-unsupported");
  assert.ok(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"), "Continue is disabled");
});
