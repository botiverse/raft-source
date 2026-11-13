// The desktop loopback flows (src/utils/desktopOAuth.ts) with a fake shell
// loopback and fake HTTP: what reaches the server, what ends the attempt, and
// the in-app wording of a failed sign-in (task #103).
import { createHash } from "node:crypto";
import { createIntl, createIntlCache } from "react-intl";
import { vi } from "vitest";

vi.mock("../src/api/client", () => ({ default: { post: vi.fn() } }));
vi.mock("../src/store/authStore", () => ({ useAuthStore: { getState: () => ({}) } }));
vi.mock("../src/components/message/forwardToast", () => ({ forwardToast: { info: vi.fn(), error: vi.fn() } }));

import type { DesktopAuthBridge } from "@botiverse/raft-shared";
import { describeDesktopSignInFailure, desktopSignInLeg, linkAccountWithDesktopLoopback, providerErrorCodeFromFailure } from "../src/utils/desktopOAuth";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

const enIntl = createIntl({ locale: "en", messages: en }, createIntlCache());
const zhIntl = createIntl({ locale: "zh-CN", messages: { ...en, ...zhCn } }, createIntlCache());

function harness({ start, callback }: { start?: () => unknown; callback?: (state: string) => Promise<{ code: string; state: string }> } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const events: string[] = [];
  let state = "";
  const auth: DesktopAuthBridge = {
    beginLoopback: async (request) => {
      events.push("begin");
      state = request.state;
      return { attemptId: "attempt-1", redirectUri: `http://127.0.0.1:49152/auth/done#state=${request.state}` };
    },
    openAuthorizationUrl: async (_id, url) => { events.push(`open ${url}`); },
    awaitCallback: async () => {
      events.push("await");
      return callback ? callback(state) : { code: "handoff-code", state };
    },
    cancel: (id) => { events.push(`cancel ${id}`); },
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path.endsWith("/start")) return start ? start() : { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" };
    return { ok: true };
  };
  return { deps: { auth, post }, calls, events, state: () => state };
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

test("link: the authenticated link endpoints get the loopback redirect and an S256 PKCE pair", async () => {
  const h = harness();
  await linkAccountWithDesktopLoopback("google", h.deps);
  expect(h.calls.map((c) => c.path)).toEqual(["/auth/mobile/oauth/google/link/start", "/auth/mobile/oauth/google/link/complete"]);
  const [start, complete] = h.calls;
  expect(start.body).toEqual({ returnUri: `http://127.0.0.1:49152/auth/done#state=${h.state()}`, codeChallenge: s256(String(complete.body.codeVerifier)) });
  expect(complete.body).toEqual({ code: "handoff-code", codeVerifier: complete.body.codeVerifier });
  expect(h.state()).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
  expect(h.events).toEqual(["begin", "open https://accounts.google.com/o/oauth2/v2/auth?state=s", "await"]);
});

test("a failed or malformed start ends the attempt before the browser opens", async () => {
  const failed = harness({ start: () => { throw Object.assign(new Error("Request failed"), { response: { status: 401 } }); } });
  await expect(linkAccountWithDesktopLoopback("github", failed.deps)).rejects.toThrow(/Request failed/);
  expect(failed.events).toEqual(["begin", "cancel attempt-1"]);
  const malformed = harness({ start: () => ({}) });
  await expect(desktopSignInLeg("google", malformed.deps)).rejects.toThrow(/oauth_bad_start_response/);
  expect(malformed.events).toEqual(["begin", "cancel attempt-1"]);
});

test("a provider-leg failure, a timeout or a foreign state never reaches complete", async () => {
  for (const callback of [
    () => Promise.reject(new Error("oauth_provider_error:provider_cancelled")),
    () => Promise.reject(new Error("oauth_loopback_timeout")),
    () => Promise.resolve({ code: "c", state: "another_attempts_state_0123" }),
  ]) {
    const h = harness({ callback });
    await expect(linkAccountWithDesktopLoopback("google", h.deps)).rejects.toThrow();
    expect(h.calls.map((c) => c.path)).toEqual(["/auth/mobile/oauth/google/link/start"]);
    expect(h.events.at(-1)).toBe("cancel attempt-1");
  }
});

test("sign-in starts in login mode with linkOnConflict; a provider that is not a bare slug never begins", async () => {
  const h = harness();
  await desktopSignInLeg("apple", h.deps);
  expect(h.calls[0]).toMatchObject({ path: "/auth/mobile/oauth/start", body: { provider: "apple", mode: "login", linkOnConflict: true } });
  const bad = harness();
  await expect(linkAccountWithDesktopLoopback("../google", bad.deps)).rejects.toThrow(/oauth_bad_provider/);
  expect(bad.events).toEqual([]);
});

test("providerErrorCodeFromFailure reads only a well-formed provider reason", () => {
  expect(providerErrorCodeFromFailure(new Error("oauth_provider_error:Access_Denied"))).toBe("access_denied");
  expect(providerErrorCodeFromFailure(new Error("Error invoking remote method 'auth:await-callback': Error: oauth_provider_error:account_conflict"))).toBe("account_conflict");
  for (const err of [new Error("oauth_loopback_timeout"), new Error("oauth_provider_error:<script>"), new Error("oauth_provider_error:"), { message: "oauth_provider_error:expired" }, new Error("prefix oauth_provider_error:expired trailing"), undefined]) {
    expect(providerErrorCodeFromFailure(err)).toBeNull();
  }
});

test("describeDesktopSignInFailure: specific copy per server reason, generic plus code otherwise, translated", () => {
  const f = enIntl.formatMessage;
  expect(describeDesktopSignInFailure(new Error("oauth_provider_error:account_conflict"), "Google", f)).toMatch(/already has a Raft account.*link Google/);
  for (const code of ["registration_disabled", "expired", "request_not_pending", "provider_cancelled", "access_denied", "provider_exchange_failed"]) {
    expect(describeDesktopSignInFailure(new Error(`oauth_provider_error:${code}`), "GitHub", f)).not.toMatch(/Couldn't complete/);
  }
  expect(describeDesktopSignInFailure(new Error("oauth_provider_error:brand_new_reason"), "GitHub", f)).toBe("Couldn't complete GitHub sign-in — please try again, or sign in with email and password. (reason: brand_new_reason)");
  expect(describeDesktopSignInFailure(new Error("oauth_loopback_timeout"), "GitHub", f)).toBe("Couldn't complete GitHub sign-in — please try again, or sign in with email and password.");
  for (const code of ["constructor", "__proto__", "tostring"]) {
    expect(describeDesktopSignInFailure(new Error(`oauth_provider_error:${code}`), "Google", f)).toContain(`(reason: ${code})`);
  }
  expect(describeDesktopSignInFailure(new Error("oauth_provider_error:expired"), "Google", zhIntl.formatMessage)).toBe("浏览器还没完成，这次登录请求就已过期。请重试。");
});
