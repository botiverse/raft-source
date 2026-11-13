import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import type { EmailDelivery } from "../services/emailService";

// #88: a signed-out person who opens an Artifact link and signs up lands back
// on it after verifying. The page travels as `returnTo` through sign-up, the
// verification email's link and verify-email; only a same-site relative path
// survives, anything else is dropped silently (the link lands on `/`).
const test = createApiTest();

const LEGAL = {
  acceptTerms: true,
  termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
  privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
};

/** Signs up with `returnTo` and answers the verification link's own params. */
async function signUp(baseUrl: string, email: string, returnTo: unknown) {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  try {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123", ...LEGAL, returnTo }),
    });
    assert.equal(response.status, 200);
    const { accessToken } = await response.json() as { accessToken: string };
    const verification = deliveries.find((d) => d.subject.startsWith("Verify your email"));
    assert.ok(verification, "a verification email is sent");
    const href = /class="slock-button" href="([^"]+)"/.exec(verification.html)?.[1];
    assert.ok(href);
    const link = new URL(href.replaceAll("&amp;", "&"));
    return { accessToken, token: link.searchParams.get("verify")!, returnTo: link.searchParams.get("returnTo") };
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
}

async function verify(baseUrl: string, accessToken: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return await response.json() as { ok: boolean; returnTo?: string };
}

test("sign-up from an Artifact link: the verification link and verify-email keep the path", async ({ app }) => {
  const signedUp = await signUp(app.baseUrl, "returnto-ok@slock.test", "/artifacts/pt_abc/v/2?c=1");
  assert.ok(signedUp.token);
  assert.equal(signedUp.returnTo, "/artifacts/pt_abc/v/2?c=1");
  assert.deepEqual(await verify(app.baseUrl, signedUp.accessToken, { token: signedUp.token, returnTo: signedUp.returnTo }), {
    ok: true,
    returnTo: "/artifacts/pt_abc/v/2?c=1",
  });
});

test("an off-site or malformed returnTo is dropped silently at sign-up and at verify", async ({ app }) => {
  const hostile = ["//evil.com", "https://evil", "/\\evil", "javascript:alert(1)", "/a\u0000b", `/${"a".repeat(3000)}`, { path: "/x" }];
  for (const [index, returnTo] of hostile.entries()) {
    const signedUp = await signUp(app.baseUrl, `returnto-bad-${index}@slock.test`, returnTo);
    assert.equal(signedUp.returnTo, null, `no returnTo in the link for ${JSON.stringify(returnTo).slice(0, 40)}`);
    // Even when the link is edited to carry it, verify-email doesn't hand it back: the web lands on `/`.
    assert.deepEqual(await verify(app.baseUrl, signedUp.accessToken, { token: signedUp.token, returnTo }), { ok: true });
  }
});

test("sign-up without returnTo is unchanged: /?verify=<token>", async ({ app }) => {
  const signedUp = await signUp(app.baseUrl, "returnto-none@slock.test", undefined);
  assert.equal(signedUp.returnTo, null);
  assert.deepEqual(await verify(app.baseUrl, signedUp.accessToken, { token: signedUp.token }), { ok: true });
});
