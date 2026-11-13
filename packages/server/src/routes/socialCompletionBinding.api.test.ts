// A web social sign-in's one-time completion code completes only in the
// browser the provider answered (login CSRF): someone else's callback link,
// opened in another browser, must not sign that browser into their account.
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { BasicTracer, CURRENT_LEGAL_ACCEPTANCE, MemoryTraceSink } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { featureFlags, users } from "../db/schema";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const ATTACKER_EMAIL = "attacker@slock.test";
const LEGAL = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion };

function withOAuthEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.JWT_SECRET = "completion-binding-test-secret";
  process.env.SOCIAL_AUTH_STATE_SECRET = "completion-binding-state-secret";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.SERVER_URL = "https://api.example.test";
  return fn();
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installGoogle(email: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ sub: "google-sub-attacker", email, email_verified: true, name: "Attacker" });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

/** The attacker's own browser: start, provider callback; the app redirect and the cookie the callback left. */
async function attackerRoundTrip(baseUrl: string): Promise<{ code: string; binding: string }> {
  const start = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { Cookie: stateCookie } },
  );
  assert.equal(callback.status, 302);
  const code = new URL(callback.headers.get("location")!).searchParams.get("code");
  assert.ok(code, `the callback hands the web app a completion code: ${callback.headers.get("location")}`);
  const binding = (callback.headers.getSetCookie().find((line) => line.startsWith("raft_social_done_")) ?? "").split(";")[0]!;
  return { code, binding };
}

/**
 * The retired `social_completion_binding` row as production may still hold it,
 * on or off: the binding no longer reads it (#raft-architecture:#32).
 */
async function seedRetiredSwitch(defaultEnabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key: "social_completion_binding", randomizationUnit: "user", salt: "test", enabled: true, defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled } });
}

async function complete(baseUrl: string, code: string, cookie: string, client: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/auth/google/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...client, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ code, ...LEGAL }),
  });
  return { status: response.status, body: await response.json() as { code?: string; accessToken?: string } };
}

test("web social sign-in: another browser cannot redeem someone's completion code; the browser that got it can", async ({ app }) => {
  await withOAuthEnv(async () => {
    const restore = installGoogle(ATTACKER_EMAIL);
    try {
      // The attacker's Google account is new to Raft: completing it creates their account.
      const accounts = async () => (await getDb().select({ id: users.id }).from(users).where(eq(users.email, ATTACKER_EMAIL))).length;

      const sink = new MemoryTraceSink();
      app.app.set("serverTracer", new BasicTracer({ sink }));
      const { code, binding } = await attackerRoundTrip(app.baseUrl);
      assert.match(binding, /^raft_social_done_[0-9a-f]{16}=/u, "the callback binds the code to the attacker's browser");

      // The victim opens the attacker's callback link: no cookie, or a forged one.
      const refused = { status: 400, code: "browser_mismatch" };
      const victim = await complete(app.baseUrl, code, "");
      assert.deepEqual({ status: victim.status, code: victim.body.code }, refused);
      // The switch is judged by this attribute per client version once it is on.
      const refusedSpan = sink.getAllSpans().find((span) =>
        span.name === "server.http.request" && span.attrs?.route_pattern === "/api/auth/:provider/complete");
      assert.equal(refusedSpan?.attrs?.error_code, "browser_mismatch");
      assert.equal(victim.body.accessToken, undefined, "no session for the victim's browser");
      const forged = await complete(app.baseUrl, code, `${binding.split("=")[0]}=forged`);
      assert.deepEqual({ status: forged.status, code: forged.body.code }, refused);
      // An unknown code gets the same answer: the refusal reveals nothing about the code.
      const unknown = await complete(app.baseUrl, "no-such-code", "");
      assert.deepEqual({ status: unknown.status, code: unknown.body.code }, refused);
      assert.equal(await accounts(), 0, "the victim's browser created nothing");

      // The refusals spent nothing: the browser the provider answered still completes.
      const own = await complete(app.baseUrl, code, binding);
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.ok(own.body.accessToken);
      assert.equal(await accounts(), 1);
    } finally {
      restore();
    }
  });
});

const webBuild = (version: string, platform = "browser") => ({ "X-Raft-Client-Platform": platform, "X-Raft-Client-Version": version });

// Warden's invariant for retiring social_completion_binding (#raft-architecture:#32,
// msg a314916f): the permanent behaviour is the switch-on one, the binding is
// enforced for EVERY client, including web builds older than 1.21.53, a missing
// or unparseable version and a non-web platform; never #13084's switch-off rule
// that let older bundles through. A leftover flag row, on or off, changes nothing.
test("web social sign-in: the binding is required for every client, whatever version it names and whatever the retired switch row says", async ({ app }) => {
  await withOAuthEnv(async () => {
    const restore = installGoogle(ATTACKER_EMAIL);
    try {
      const refused = { status: 400, code: "browser_mismatch" };
      for (const retiredSwitch of [false, true]) {
        await seedRetiredSwitch(retiredSwitch);
        for (const [label, client] of [
          ["1.21.52 (before the credentials post)", webBuild("1.21.52")],
          ["an old web build", webBuild("1.21.0")],
          ["1.21.53", webBuild("1.21.53")],
          ["a later build in the desktop shell", webBuild("1.22.0", "desktop_app")],
          ["no version header", {}],
          ["an unparseable version", webBuild("latest")],
          ["not a web platform", webBuild("1.22.0", "cli")],
        ] as const) {
          const { code, binding } = await attackerRoundTrip(app.baseUrl);
          const victim = await complete(app.baseUrl, code, "", client);
          assert.deepEqual({ status: victim.status, code: victim.body.code }, refused, `${label}, retired switch ${retiredSwitch ? "on" : "off"}: no cookie is refused`);
          const own = await complete(app.baseUrl, code, binding, client);
          assert.equal(own.status, 200, `${label}: the browser that got the code completes (the refusal spent nothing)`);
        }
      }
    } finally {
      restore();
    }
  });
});
