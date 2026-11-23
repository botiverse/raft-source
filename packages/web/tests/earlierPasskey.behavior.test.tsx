import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { StepUpBeforeApproval } from "../src/components/auth/SecondFactorCodeEntry";
import SecondFactorSignInStep from "../src/components/auth/SecondFactorSignInStep";
import type { SecondFactorChallenge, SecondFactorChallengeToken } from "../src/components/auth/secondFactorSignIn";
import VerifyItsYouDialog from "../src/components/settings/VerifyItsYouDialog";
import { assertionJSON, closedPrompt, credentialFor, installFakeWebAuthn } from "./helpers/fakeWebAuthn";
import type { FakeWebAuthn } from "./helpers/fakeWebAuthn";
import { TestIntlProvider } from "./helpers/intl";

// "Use an earlier passkey" in the sign-in's second step and the step-ups
// (components/auth/EarlierPasskey.tsx): while passkeys sit under two RP IDs,
// the options name the person's other group (`otherRps`); a prompt that ends
// in NotAllowedError then offers it, and only a click prompts again, once.
// The server is stubbed at the axios client; the browser's WebAuthn by
// helpers/fakeWebAuthn.

// The second step (with its challenge) and step-up (without) share one options URL.
const OPTIONS_URL = "/auth/second-factor/passkeys/assertion/options";
const SIGN_IN_VERIFY_URL = "/auth/second-factor/verify";
const STEP_UP_URL = "/auth/second-factor/step-up";
const EARLIER = "Use an earlier passkey";

const originalPost = api.post;
let webauthn: FakeWebAuthn | null = null;
let posts: Array<{ url: string; body: unknown }> = [];

type Handler = (body: unknown) => unknown;

/** Each URL answers with its handlers in turn (the last one repeats); a thrown value is the failure. */
function stubPosts(handlers: Record<string, Handler[]>) {
  posts = [];
  const calls = new Map<string, number>();
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = calls.get(url) ?? 0;
    calls.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
}

/** Options as a server with a legacy RP ID answers: the group asked for (default current), and the other one. */
function groupedOptions(otherRps: string[] | null = ["legacy"]): Handler {
  // null: the options carry no otherRps (undefined would take the default).
  let n = 0;
  return (body) => {
    n += 1;
    const legacy = (body as { rp?: string } | undefined)?.rp === "legacy";
    return {
      options: { challenge: String(n).repeat(43), rpId: legacy ? "raft.build" : "app.raft.build", userVerification: "required", allowCredentials: [] },
      ...(otherRps && !legacy ? { otherRps } : {}),
    };
  };
}

function rpUnavailable(): Handler {
  return () => {
    throw Object.assign(new Error("Request failed with status code 404"), {
      response: { status: 404, data: { code: "passkey_rp_unavailable", error: "None of this account's passkeys can be used here.", rp: "legacy", availableRps: ["current"] } },
    });
  };
}

/** The first prompt finds nothing to pick (closed); later ones answer. */
function firstPromptClosed() {
  let n = 0;
  return () => {
    n += 1;
    if (n === 1) throw closedPrompt();
    return credentialFor(assertionJSON("old-cred"));
  };
}

const CHALLENGE: SecondFactorChallenge = {
  challenge: "t".repeat(43) as SecondFactorChallengeToken,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  methods: ["passkey"],
  recoveryReady: false,
  maskedEmail: "o***@example.com",
};

function renderSecondStep(onSignedIn = vi.fn(async () => {})) {
  render(
    <TestIntlProvider>
      <SecondFactorSignInStep challenge={{ ...CHALLENGE, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }} onSignedIn={onSignedIn} onBack={vi.fn()} />
    </TestIntlProvider>,
  );
  return onSignedIn;
}

async function click(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(button);
  });
}

function earlierLinks() {
  return screen.queryAllByRole("button", { name: EARLIER });
}

beforeEach(() => {
});

afterEach(() => {
  cleanup();
  webauthn?.restore();
  webauthn = null;
  api.post = originalPost;
});

test("second step: nothing to pick, with an earlier group listed: the line shows, and only its click prompts again, for that group", async () => {
  webauthn = installFakeWebAuthn({ get: firstPromptClosed() });
  const signedIn = { user: { id: "user-1" }, accessToken: "a", refreshToken: "r" };
  stubPosts({ [OPTIONS_URL]: [groupedOptions()], [SIGN_IN_VERIFY_URL]: [() => signedIn] });
  const onSignedIn = renderSecondStep();

  assert.equal(earlierLinks().length, 0, "not before a prompt found nothing");
  await click("Use passkey");
  await screen.findByRole("button", { name: EARLIER });
  assert.equal(webauthn.gets.length, 1, "never a second prompt on its own");

  await click(EARLIER);
  await waitFor(() => assert.deepEqual(onSignedIn.mock.calls, [[signedIn]]));
  assert.deepEqual(
    posts.filter((post) => post.url === OPTIONS_URL).map((post) => post.body),
    [{ challenge: CHALLENGE.challenge }, { challenge: CHALLENGE.challenge, rp: "legacy" }],
  );
  assert.equal(webauthn.gets.length, 2);
  assert.equal(webauthn.gets[1]!.publicKey?.rpId, "raft.build");
});

test("second step: options without otherRps never show the line", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  stubPosts({ [OPTIONS_URL]: [groupedOptions(null)] });
  renderSecondStep();

  await click("Use passkey");
  await screen.findByText("The passkey prompt was closed. Try again, or use another way.");
  assert.equal(earlierLinks().length, 0);
});

test("second step: an empty otherRps never shows the line", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  stubPosts({ [OPTIONS_URL]: [groupedOptions([])] });
  renderSecondStep();

  await click("Use passkey");
  await screen.findByText("The passkey prompt was closed. Try again, or use another way.");
  assert.equal(earlierLinks().length, 0);
});

test("second step: a browser error other than NotAllowedError does not offer the line", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw new DOMException("No authenticator", "NotSupportedError"); } });
  stubPosts({ [OPTIONS_URL]: [groupedOptions()] });
  renderSecondStep();

  await click("Use passkey");
  await screen.findByText("Sign-in failed");
  assert.equal(earlierLinks().length, 0);
});

test("second step: 404 passkey_rp_unavailable for the earlier group takes the line away, with the existing error", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  stubPosts({ [OPTIONS_URL]: [groupedOptions(), rpUnavailable()] });
  renderSecondStep();

  await click("Use passkey");
  await click(EARLIER);
  await screen.findByText("Sign-in failed");
  assert.equal(earlierLinks().length, 0);
  assert.equal(webauthn.gets.length, 1, "no prompt without options");
});

test("Verify it's you: nothing to pick, the line shows; its click answers with a passkey from the earlier group", async () => {
  webauthn = installFakeWebAuthn({ get: firstPromptClosed() });
  stubPosts({ [OPTIONS_URL]: [groupedOptions()] });
  const onAnswer = vi.fn(async () => {});
  render(
    <TestIntlProvider>
      <VerifyItsYouDialog description="Confirm it's you." methods={["passkey"]} onAnswer={onAnswer} onClose={vi.fn()} testId="step-up" />
    </TestIntlProvider>,
  );

  await click("Use passkey");
  await screen.findByRole("button", { name: EARLIER });
  assert.equal(webauthn.gets.length, 1);
  assert.equal(onAnswer.mock.calls.length, 0);

  await click(EARLIER);
  await waitFor(() => assert.deepEqual(onAnswer.mock.calls, [[{ webauthn: assertionJSON("old-cred") }]]));
  assert.deepEqual(posts.map((post) => post.body), [{}, { rp: "legacy" }]);
});

test("Verify it's you: options without otherRps never show the line", async () => {
  webauthn = installFakeWebAuthn({ get: () => { throw closedPrompt(); } });
  stubPosts({ [OPTIONS_URL]: [groupedOptions(null)] });
  render(
    <TestIntlProvider>
      <VerifyItsYouDialog description="Confirm it's you." methods={["passkey"]} onAnswer={vi.fn(async () => {})} onClose={vi.fn()} testId="step-up" />
    </TestIntlProvider>,
  );

  await click("Use passkey");
  await screen.findByText("The passkey prompt was closed. Try again, or use another way.");
  assert.equal(earlierLinks().length, 0);
});

test("approval step-up: nothing to pick, the line shows; its click steps up with the earlier group's passkey", async () => {
  webauthn = installFakeWebAuthn({ get: firstPromptClosed() });
  stubPosts({ [OPTIONS_URL]: [groupedOptions()], [STEP_UP_URL]: [() => ({ verified: true })] });
  const onVerified = vi.fn();
  render(
    <TestIntlProvider>
      <StepUpBeforeApproval notice="Verify before approving." methods={["passkey"]} onVerified={onVerified} />
    </TestIntlProvider>,
  );

  await click("Use passkey");
  await screen.findByRole("button", { name: EARLIER });
  assert.equal(webauthn.gets.length, 1);

  await click(EARLIER);
  await waitFor(() => assert.equal(onVerified.mock.calls.length, 1));
  assert.deepEqual(posts.map((post) => post.url), [OPTIONS_URL, OPTIONS_URL, STEP_UP_URL]);
  assert.deepEqual(posts[1]!.body, { rp: "legacy" });
  assert.deepEqual(posts[2]!.body, { webauthn: assertionJSON("old-cred") });
});
