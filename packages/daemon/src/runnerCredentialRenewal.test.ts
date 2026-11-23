// #wg-rbac:#27: the daemon renews the runner credentials its launches hold at
// half-life, swaps every use to the new key, falls back to a fresh mint on any
// refusal or a lost answer, and renews then retries once on a 401
// agent_credential_expired (never on another 401).
import assert from "node:assert/strict";
import {
  __resetRunnerCredentialRenewalForTest,
  currentRunnerCredentialKey,
  expiringRunnerCredentialCount,
  fetchWithRunnerCredential,
  heldRunnerCredentialIdsWithRenewals,
  installRunnerCredentialRenewer,
  noteRunnerCredentialLaunch,
  renewExpiredRunnerCredential,
  RUNNER_CREDENTIAL_RENEW_OVERLAP_MS,
  RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS,
  RUNNER_CREDENTIAL_RENEW_SWEEP_MS,
  noteRunnerCredentialStreamExpired,
  __runnerCredentialLineageSizeForTest,
  forgetRunnerCredentialLineage,
  runnerCredentialLineageIds,
  trackRunnerCredential,
  type RunnerCredential,
  type RunnerCredentialRenewerDeps,
} from "./runnerCredentialRenewal";
import { revokeManagedRunnerCredential } from "./runnerCredentialRevoke";

const DAY_MS = 24 * 60 * 60_000;
const TTL_MS = 7 * DAY_MS;
const HALF_LIFE_MS = TTL_MS / 2;
const SERVER = "https://raft.example.com";
const AGENT = "agent-1";
const OLD_KEY = "sk_agent_old_secret";
const NEW_KEY = "sk_agent_renewed_secret";
const MINTED_KEY = "sk_agent_minted_secret";

type Event = { name: string; attrs: Record<string, unknown>; status: string };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function renewedBody(at: number, call = 1): Record<string, unknown> {
  return {
    credentialId: call === 1 ? "cred-renewed" : `cred-renewed-${call}`,
    apiKey: call === 1 ? NEW_KEY : `${NEW_KEY}_${call}`,
    expiresAt: new Date(at + TTL_MS).toISOString(),
    scopes: ["read"],
    agentId: AGENT,
    replacedCredentialId: "cred-old",
    replacedExpiresAt: new Date(at + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS).toISOString(),
  };
}

function setup(options: {
  renew?: (call: number) => Response | Promise<Response>;
  mint?: () => Promise<RunnerCredential>;
  held?: () => boolean;
  random?: number;
} = {}) {
  const renewCalls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const mintCalls: string[] = [];
  const revoked: string[] = [];
  const events: Event[] = [];
  const deps: RunnerCredentialRenewerDeps = {
    serverUrl: SERVER,
    computerKey: () => "sk_computer_test",
    fetch: async (url, init) => {
      renewCalls.push({ url, body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get("authorization") });
      return (options.renew ?? ((call) => json(201, renewedBody(Date.now(), call))))(renewCalls.length);
    },
    freshMint: async (agentId) => {
      mintCalls.push(agentId);
      return options.mint
        ? options.mint()
        : { apiKey: MINTED_KEY, credentialId: "cred-minted", expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
    },
    revoke: (agentId, credentialId) => { revoked.push(`${agentId}/${credentialId}`); },
    isHeld: options.held ?? (() => true),
    recordEvent: (name, attrs, status) => { events.push({ name, attrs, status }); },
    random: () => options.random ?? 0.5,
  };
  const uninstall = installRunnerCredentialRenewer(deps);
  const track = (expiresInMs = TTL_MS) => trackRunnerCredential({
    agentId: AGENT,
    runtime: "claude",
    credential: { apiKey: OLD_KEY, credentialId: "cred-old", expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
  });
  return { renewCalls, mintCalls, revoked, events, uninstall, track };
}

const renewEvents = (events: Event[]) => events.filter((event) => event.name === "daemon.runner_credential.renew");

function assertNoKeyInAttrs(events: Event[]): void {
  for (const event of events) {
    const serialized = JSON.stringify(event.attrs);
    assert.ok(!/sk_agent_/.test(serialized), `no key in ${event.name} attrs: ${serialized}`);
  }
}

afterEach(() => {
  vi.useRealTimers();
  __resetRunnerCredentialRenewalForTest();
});

// Teeth: drop scheduleHalfLife from trackRunnerCredential -> RED.
test("renews at half-life within +/-10% jitter", async () => {
  for (const [random, fireAt] of [[0, HALF_LIFE_MS * 0.9], [1, HALF_LIFE_MS * 1.1], [0.5, HALF_LIFE_MS]] as const) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = setup({ random });
    t.track();
    await vi.advanceTimersByTimeAsync(fireAt - 1_000);
    assert.equal(t.renewCalls.length, 0, `random=${random}: not before ${fireAt}`);
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(t.renewCalls.length, 1, `random=${random}: renewed at ${fireAt}`);
    assert.equal(t.renewCalls[0]!.url, `${SERVER}/internal/computer/runners/${AGENT}/credentials/renew`);
    assert.deepEqual(t.renewCalls[0]!.body, { credentialId: "cred-old" });
    assert.equal(t.renewCalls[0]!.authorization, "Bearer sk_computer_test", "authenticated with the Computer's key");
    t.uninstall();
    vi.useRealTimers();
  }
});

// Teeth: skip swap() on 201 -> the key never changes -> RED.
test("a renewal swaps the key, reports the new id as held (the old one only during its overlap), and schedules the next", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup();
  t.track();
  noteRunnerCredentialLaunch(OLD_KEY, "launch-1");
  assert.equal(expiringRunnerCredentialCount(), 1);
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), NEW_KEY);
  assert.deepEqual(runnerCredentialLineageIds("cred-old"), ["cred-old", "cred-renewed"]);
  assert.deepEqual(heldRunnerCredentialIdsWithRenewals(["cred-old", "cred-other"]).sort(), ["cred-old", "cred-other", "cred-renewed"]);
  await vi.advanceTimersByTimeAsync(RUNNER_CREDENTIAL_RENEW_OVERLAP_MS + 1);
  assert.deepEqual(heldRunnerCredentialIdsWithRenewals(["cred-old"]), ["cred-renewed"], "the replaced id is dropped once it stops authenticating");
  assert.equal(expiringRunnerCredentialCount(), 1);

  const [event] = renewEvents(t.events);
  assert.equal(event?.status, "ok");
  assert.deepEqual(event?.attrs, {
    agentId: AGENT,
    launchId: "launch-1",
    trigger: "half_life",
    old_credential_id: "cred-old",
    ms_to_expiry: TTL_MS - HALF_LIFE_MS,
    outcome: "renewed",
    http_status: 201,
    new_credential_id: "cred-renewed",
    new_expires: true,
  });
  assertNoKeyInAttrs(t.events);

  // The renewed key renews at its own half-life, as itself.
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.equal(t.renewCalls.length, 2);
  assert.deepEqual(t.renewCalls[1]!.body, { credentialId: "cred-renewed" });
});

const REFUSALS: Array<[number, string]> = [
  [409, "runner_credential_already_renewed"],
  [409, "runner_credential_revoked"],
  [409, "runner_credential_renew_window_passed"],
  [404, "agent_missing"],
  [404, "credential_missing"],
  [403, "credential_not_runner"],
  [403, "credential_not_issued_by_this_computer"],
];

// Teeth: return null instead of mintInstead() for a refusal -> RED.
test.each(REFUSALS)("a %i %s renewal refusal mints a fresh credential and swaps to it", async (status, code) => {
  const t = setup({ renew: () => json(status, { error: "refused", code }) });
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), MINTED_KEY);
  assert.deepEqual(t.mintCalls, [AGENT]);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), MINTED_KEY);
  assert.deepEqual(runnerCredentialLineageIds("cred-old"), ["cred-old", "cred-minted"]);
  const [event] = renewEvents(t.events);
  const { ms_to_expiry: msToExpiry, ...attrs } = event?.attrs ?? {};
  assert.ok(typeof msToExpiry === "number" && msToExpiry <= TTL_MS && msToExpiry > TTL_MS - 5_000);
  assert.deepEqual(attrs, {
    agentId: AGENT,
    launchId: undefined,
    trigger: "expired_401",
    old_credential_id: "cred-old",
    outcome: "expired_retry",
    swap_path: "fallback_mint",
    http_status: status,
    refusal_code: code,
    new_credential_id: "cred-minted",
    new_expires: true,
  });
  assertNoKeyInAttrs(t.events);
});

test("a half-life refusal is reported as fallback_mint", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({ renew: () => json(409, { code: "runner_credential_already_renewed" }) });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), MINTED_KEY);
  const [event] = renewEvents(t.events);
  assert.equal(event?.attrs.outcome, "fallback_mint");
  assert.equal(event?.attrs.trigger, "half_life");
  assert.equal(event?.attrs.refusal_code, "runner_credential_already_renewed");
  assert.equal(event?.attrs.new_credential_id, "cred-minted");
  assert.equal(event?.attrs.swap_path, undefined);
  assertNoKeyInAttrs(t.events);
});

// Teeth: answer a thrown renew fetch with null instead of a mint -> RED.
test("a renewal whose answer is lost mints a fresh credential", async () => {
  const t = setup({ renew: () => { throw new TypeError("fetch failed"); } });
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), MINTED_KEY);
  assert.deepEqual(t.mintCalls, [AGENT]);
  assert.equal(renewEvents(t.events)[0]?.attrs.refusal_code, "network_error:TypeError");
});

// Teeth: mint at once on 429 (drop the wait branch) -> RED.
test("a 429 with time left waits and renews again before expiry; near expiry it mints instead", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({ renew: (call) => (call === 1 ? json(429, { code: "runner_credential_renew_rate_limited" }, { "retry-after": "30" }) : json(201, renewedBody(Date.now()))) });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.equal(t.renewCalls.length, 1);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), OLD_KEY, "nothing swapped yet");
  assert.deepEqual(t.mintCalls, []);
  const [limited] = renewEvents(t.events);
  assert.equal(limited?.attrs.outcome, "rate_limited");
  assert.equal(limited?.attrs.http_status, 429);
  assert.equal(limited?.attrs.retry_in_ms, 30_000);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(t.renewCalls.length, 2);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), NEW_KEY);
  vi.useRealTimers();
  __resetRunnerCredentialRenewalForTest();

  const near = setup({ renew: () => json(429, { code: "runner_credential_renew_rate_limited" }) });
  near.track(60_000);
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), MINTED_KEY, "a minute from expiry: no time to wait");
  assert.deepEqual(near.mintCalls, [AGENT]);
});

// Teeth: drop the code check in fetchWithRunnerCredential (renew on any 401) -> RED.
test("a 401 agent_credential_expired renews and sends once more; another 401 is not renewed", async () => {
  const t = setup();
  t.track();
  const sent: string[] = [];
  const expired = await fetchWithRunnerCredential(OLD_KEY, async (key) => {
    sent.push(key);
    return key === OLD_KEY ? json(401, { code: "agent_credential_expired" }) : json(200, { ok: true });
  });
  assert.equal(expired.status, 200);
  assert.deepEqual(sent, [OLD_KEY, NEW_KEY], "retried once with the renewed key");
  assert.equal(t.renewCalls.length, 1);
  assert.deepEqual(renewEvents(t.events).map((event) => [event.attrs.outcome, event.attrs.swap_path, event.attrs.trigger]), [["expired_retry", "renewed", "expired_401"]]);

  // Already renewed: the next request goes out with the new key at once.
  sent.length = 0;
  await fetchWithRunnerCredential(OLD_KEY, async (key) => { sent.push(key); return json(200, {}); });
  assert.deepEqual(sent, [NEW_KEY]);

  // Once only: the retry's own 401 expired is answered as it is.
  sent.length = 0;
  const twice = await fetchWithRunnerCredential(OLD_KEY, async (key) => { sent.push(key); return json(401, { code: "agent_credential_expired" }); });
  assert.equal(twice.status, 401);
  assert.equal(sent.length, 2);

  // A plain 401 (a revoked key) renews nothing.
  const before = t.renewCalls.length;
  sent.length = 0;
  const revoked = await fetchWithRunnerCredential(NEW_KEY, async (key) => { sent.push(key); return json(401, { error: "Invalid agent credential" }); });
  assert.equal(revoked.status, 401);
  assert.deepEqual(sent.length, 1);
  assert.equal(t.renewCalls.length, before);
  assertNoKeyInAttrs(t.events);
});

test("concurrent expired requests share one renewal", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = setup({ renew: async () => { await gate; return json(201, renewedBody(Date.now())); } });
  t.track();
  const both = Promise.all([renewExpiredRunnerCredential(OLD_KEY), renewExpiredRunnerCredential(OLD_KEY)]);
  release!();
  assert.deepEqual(await both, [NEW_KEY, NEW_KEY]);
  assert.equal(t.renewCalls.length, 1);
  assert.equal(renewEvents(t.events).length, 1);
});

test("an untracked key's expiry is reported and not retried", async () => {
  const t = setup();
  const sent: string[] = [];
  const res = await fetchWithRunnerCredential("sk_agent_unknown", async (key) => { sent.push(key); return json(401, { code: "agent_credential_expired" }); });
  assert.equal(res.status, 401);
  assert.equal(sent.length, 1);
  assert.equal(t.renewCalls.length, 0);
  assert.equal(renewEvents(t.events)[0]?.attrs.outcome, "expired_no_renew");
});

// Teeth: drop the isHeld check -> RED (a renewal is sent).
test("a half-life renewal of a credential no launch holds renews nothing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({ held: () => false });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS * 1.2);
  assert.equal(t.renewCalls.length, 0);
  assert.equal(expiringRunnerCredentialCount(), 0);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 }, "forgotten, key and all");
});

// Teeth: revoke only config.agentCredentialId in revokeManagedRunnerCredential -> RED.
test("the launch end revokes the current (renewed) credential, and stops renewing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup();
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), NEW_KEY);
  const deletes: string[] = [];
  revokeManagedRunnerCredential({
    serverUrl: SERVER,
    daemonApiKey: "sk_computer_test",
    agentId: AGENT,
    config: { agentCredentialKey: OLD_KEY, agentCredentialId: "cred-old" } as never,
    launchId: "launch-1",
    fetchImpl: async (url, init) => { deletes.push(`${init?.method} ${new URL(url).pathname}`); return new Response(null, { status: 204 }); },
    recordEvent: () => {},
  });
  assert.deepEqual(deletes, [
    `DELETE /internal/computer/runners/${AGENT}/credentials/cred-renewed`,
    `DELETE /internal/computer/runners/${AGENT}/credentials/cred-old`,
  ]);
  assert.equal(expiringRunnerCredentialCount(), 0);
  await vi.advanceTimersByTimeAsync(TTL_MS);
  assert.equal(t.renewCalls.length, 1, "no renewal after the launch ended");
});

test("nothing is tracked without a renewer or an expiry", () => {
  trackRunnerCredential({ agentId: AGENT, runtime: "claude", credential: { apiKey: OLD_KEY, credentialId: "cred-old", expiresAt: new Date().toISOString() } });
  assert.equal(expiringRunnerCredentialCount(), 0);
  setup();
  trackRunnerCredential({ agentId: AGENT, runtime: "claude", credential: { apiKey: OLD_KEY, credentialId: "cred-old", expiresAt: null } });
  assert.equal(expiringRunnerCredentialCount(), 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The launch ends as the hosts end one: revoke-and-forget its lineage (runnerCredentialRevoke.ts), and stop holding it. */
function endLaunch(state: { held: boolean }): void {
  state.held = false;
  forgetRunnerCredentialLineage("cred-old");
}

// Teeth: drop the live() check after the renew fetch -> the new key is swapped in, never revoked -> RED.
test("a launch that ends while its renewal is out: the issued key is revoked, nothing is swapped or kept", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const answer = deferred<Response>();
  const state = { held: true };
  const t = setup({ renew: () => answer.promise, held: () => state.held });
  t.track();
  const renewal = renewExpiredRunnerCredential(OLD_KEY);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(t.renewCalls.length, 1, "the renewal is out");
  endLaunch(state);
  answer.resolve(json(201, renewedBody(Date.now())));
  assert.equal(await renewal, null);
  assert.deepEqual(t.revoked, [`${AGENT}/cred-renewed`], "the key the renewal got is revoked");
  assert.equal(currentRunnerCredentialKey(OLD_KEY), OLD_KEY, "nothing swapped in");
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 });
  assert.equal(expiringRunnerCredentialCount(), 0);
  await vi.advanceTimersByTimeAsync(TTL_MS);
  assert.equal(t.renewCalls.length, 1, "nothing scheduled for the ended launch");
  const [event] = renewEvents(t.events);
  assert.equal(event?.attrs.outcome, "failed");
  assert.equal(event?.attrs.reason, "launch_ended");
  assert.equal(event?.attrs.revoked_credential_id, "cred-renewed");
  assertNoKeyInAttrs(t.events);
});

// Teeth: drop the live() check after the renew answer -> a fresh key is minted after the launch ended -> RED.
test("a launch that ends while its renewal is out, answered revoked: no fresh mint", async () => {
  const answer = deferred<Response>();
  const state = { held: true };
  const t = setup({ renew: () => answer.promise, held: () => state.held });
  t.track();
  const renewal = renewExpiredRunnerCredential(OLD_KEY);
  await new Promise((resolve) => setImmediate(resolve));
  // The launch's revoke reached the server first.
  endLaunch(state);
  answer.resolve(json(409, { code: "runner_credential_revoked" }));
  assert.equal(await renewal, null);
  assert.deepEqual(t.mintCalls, [], "never minted for an ended launch");
  assert.deepEqual(t.revoked, []);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 });
});

// Teeth: drop the live() check after freshMint -> the minted key is swapped in for an ended launch -> RED.
test("a launch that ends while its fallback mint is out: the minted key is revoked", async () => {
  const minted = deferred<RunnerCredential>();
  const state = { held: true };
  const t = setup({ renew: () => json(409, { code: "runner_credential_already_renewed" }), mint: () => minted.promise, held: () => state.held });
  t.track();
  const renewal = renewExpiredRunnerCredential(OLD_KEY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(t.mintCalls, [AGENT]);
  endLaunch(state);
  minted.resolve({ apiKey: MINTED_KEY, credentialId: "cred-minted", expiresAt: new Date(Date.now() + TTL_MS).toISOString() });
  assert.equal(await renewal, null);
  assert.deepEqual(t.revoked, [`${AGENT}/cred-minted`]);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 });
});

// Teeth: live() checks only isHeld (no forgotten / renewer check) -> the uninstalled renewer swaps the key in -> RED.
test("a daemon stop (uninstall) during a renewal: the issued key is revoked, nothing is kept", async () => {
  const answer = deferred<Response>();
  const t = setup({ renew: () => answer.promise });
  t.track();
  const renewal = renewExpiredRunnerCredential(OLD_KEY);
  await new Promise((resolve) => setImmediate(resolve));
  t.uninstall();
  answer.resolve(json(201, renewedBody(Date.now())));
  assert.equal(await renewal, null);
  assert.deepEqual(t.revoked, [`${AGENT}/cred-renewed`]);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 });
});

// Teeth: mint on runner_credential_renew_not_declared once time is short (waitOrMint) -> RED.
test("403 runner_credential_renew_not_declared waits 5 s, 10 s, 20 s, then backs off, and never mints, also past expiry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Woken past expiry: the reconnect's ready has not reached the server yet.
  const t = setup({ renew: (call) => (call <= 4 ? json(403, { code: "runner_credential_renew_not_declared" }) : json(201, renewedBody(Date.now()))) });
  t.track();
  vi.setSystemTime(Date.now() + TTL_MS + DAY_MS);
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), null, "the 401 is answered as is meanwhile");
  assert.ok((renewEvents(t.events)[0]!.attrs.ms_to_expiry as number) < 0, "past expiry");
  for (const wait of [5_000, 10_000, 20_000, 60_000]) {
    assert.equal(renewEvents(t.events).at(-1)?.attrs.retry_in_ms, wait);
    await vi.advanceTimersByTimeAsync(wait);
  }
  assert.deepEqual(t.mintCalls, [], "never minted: it would get a key that never expires");
  assert.equal(t.renewCalls.length, 5);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), NEW_KEY, "renewed once the server saw the capability");
  assert.ok(renewEvents(t.events).slice(0, 4).every((event) => event.attrs.refusal_code === "runner_credential_renew_not_declared"));
});

// Teeth: drop the follow-up schedule for a null-expiry mint -> the launch stays on a key never renewed -> RED.
test("a fallback mint that returns a key that never expires is traced and renewed shortly after", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({
    renew: (call) => (call === 1 ? json(409, { code: "runner_credential_already_renewed" }) : json(201, { ...renewedBody(Date.now()), replacedCredentialId: "cred-minted" })),
    mint: async () => ({ apiKey: MINTED_KEY, credentialId: "cred-minted", expiresAt: null }),
  });
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), MINTED_KEY);
  assert.equal(renewEvents(t.events)[0]?.attrs.new_expires, false, "a fallback key that never expires is visible");
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(t.renewCalls.length, 2);
  assert.deepEqual(t.renewCalls[1]!.body, { credentialId: "cred-minted" }, "the never-expiring key is renewed");
  assert.equal(currentRunnerCredentialKey(OLD_KEY), NEW_KEY);
  assert.equal(renewEvents(t.events).at(-1)?.attrs.new_expires, true);
});

// Teeth: treat a missing expiry as "expiring now" (msToExpiry ?? 0) -> a 429 on a never-expiring key mints again at once -> RED.
test("a never-expiring key answered 429 waits instead of minting again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({
    renew: (call) => (call === 1
      ? json(409, { code: "runner_credential_already_renewed" })
      : call === 2
        ? json(429, { code: "runner_credential_renew_rate_limited" })
        : json(201, { ...renewedBody(Date.now()), replacedCredentialId: "cred-minted" })),
    mint: async () => ({ apiKey: MINTED_KEY, credentialId: "cred-minted", expiresAt: null }),
  });
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), MINTED_KEY);
  assert.equal(t.mintCalls.length, 1);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(t.renewCalls.length, 2, "the follow-up renew of the never-expiring key ran and got 429");
  assert.equal(t.mintCalls.length, 1, "a 429 on a never-expiring key waits, it does not mint again");
  assert.ok((renewEvents(t.events).at(-1)?.attrs.retry_in_ms as number) > 0, "a wait was scheduled");
});

// Teeth: drop the Retry-After floor -> retry_in_ms 0 -> RED.
test("Retry-After: 0 waits at least 5 seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({ renew: () => json(429, { code: "runner_credential_renew_rate_limited" }, { "retry-after": "0" }) });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.equal(renewEvents(t.events)[0]?.attrs.retry_in_ms, 5_000);
  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(t.renewCalls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(t.renewCalls.length, 2);
});

// Teeth: a flat RUNNER_CREDENTIAL_RENEW_RETRY_MS in backoffMs -> RED.
test("offline: lost answers with failing mints back off 60 s doubling, at most 30 minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({
    renew: () => { throw new TypeError("fetch failed"); },
    mint: async () => { throw new TypeError("fetch failed"); },
  });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  for (let i = 0; i < 8; i += 1) {
    const last = renewEvents(t.events).at(-1)!;
    await vi.advanceTimersByTimeAsync(last.attrs.retry_in_ms as number);
  }
  assert.deepEqual(
    renewEvents(t.events).map((event) => event.attrs.retry_in_ms),
    [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS, RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS, RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS],
  );
  assert.ok(renewEvents(t.events).every((event) => event.attrs.outcome === "failed"));
});

// Teeth: drop the dropTimer in swap -> the replaced key stays in the lookup -> RED.
test("a replaced key other than the first leaves the lookup once its overlap ends; the first still resolves", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup();
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), NEW_KEY);
  assert.equal(await renewExpiredRunnerCredential(NEW_KEY), `${NEW_KEY}_2`);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 3, ids: 3, dropped: 0 });
  await vi.advanceTimersByTimeAsync(RUNNER_CREDENTIAL_RENEW_OVERLAP_MS + 1);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 2, ids: 3, dropped: 1 }, "the first and the current key, every id");
  assert.equal(currentRunnerCredentialKey(OLD_KEY), `${NEW_KEY}_2`, "the launch's first key still resolves");
  assert.equal(currentRunnerCredentialKey(NEW_KEY), `${NEW_KEY}_2`, "the dropped key resolves through its hash only");
  assert.deepEqual(runnerCredentialLineageIds("cred-old"), ["cred-old", "cred-renewed", "cred-renewed-2"]);
});

// Teeth: drop the `node.next` short-cut in renewKey -> a second renewal of the replaced key -> RED.
test("a 401 for a key already replaced answers with the current key and starts no second renewal", async () => {
  const t = setup();
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), NEW_KEY);
  // A request that went out with the old key before the swap comes back expired.
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), NEW_KEY);
  const sent: string[] = [];
  const res = await fetchWithRunnerCredential(OLD_KEY, async (key) => { sent.push(key); return json(200, {}); });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [NEW_KEY]);
  assert.equal(t.renewCalls.length, 1);
  assert.equal(renewEvents(t.events).length, 1);
});

/** OLD_KEY renewed into NEW_KEY, then NEW_KEY into NEW_KEY_2, and NEW_KEY's overlap over: NEW_KEY left the lookup. */
async function renewTwiceAndDrop(t: ReturnType<typeof setup>): Promise<void> {
  t.track();
  assert.equal(await renewExpiredRunnerCredential(OLD_KEY), NEW_KEY);
  assert.equal(await renewExpiredRunnerCredential(NEW_KEY), `${NEW_KEY}_2`);
  await vi.advanceTimersByTimeAsync(RUNNER_CREDENTIAL_RENEW_OVERLAP_MS + 1);
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 2, ids: 3, dropped: 1 });
}

// Teeth: look dropped keys up in nodesByKey only (no droppedKeyNodes) -> expired_no_renew -> RED.
test("a wake-hint stream ending credential-expired for a replaced, dropped key renews nothing and reports nothing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup();
  await renewTwiceAndDrop(t);
  const before = { renewals: t.renewCalls.length, events: renewEvents(t.events).length };
  noteRunnerCredentialStreamExpired(NEW_KEY);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(t.renewCalls.length, before.renewals, "no renewal");
  assert.equal(renewEvents(t.events).length, before.events, "no event (no expired_no_renew)");
  assert.deepEqual(t.mintCalls, []);
});

// Teeth: same -> the request is answered with its 401, not retried -> RED.
test("a 401 expired for a replaced, dropped key is retried with the lineage's current key", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup();
  await renewTwiceAndDrop(t);
  const renewals = t.renewCalls.length;
  assert.equal(currentRunnerCredentialKey(NEW_KEY), `${NEW_KEY}_2`, "a dropped key still resolves to the current one");
  // A request that captured the dropped key (sent before the swap, answered after its overlap).
  assert.equal(await renewExpiredRunnerCredential(NEW_KEY), `${NEW_KEY}_2`);
  assert.equal(t.renewCalls.length, renewals);
  assert.ok(!renewEvents(t.events).some((event) => event.attrs.outcome === "expired_no_renew"));
  // Forgetting the lineage forgets its dropped keys too.
  forgetRunnerCredentialLineage("cred-old");
  assert.deepEqual(__runnerCredentialLineageSizeForTest(), { keys: 0, ids: 0, dropped: 0 });
});

// Teeth: mint on a 5xx (no wait) -> the 409 never comes; or skip the fallback on 409 -> RED.
test("a 5xx, then 409 runner_credential_already_renewed (the first renewal did land), recovers by a fresh mint", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = setup({ renew: (call) => (call === 1 ? json(503, { error: "unavailable" }) : json(409, { code: "runner_credential_already_renewed" })) });
  t.track();
  await vi.advanceTimersByTimeAsync(HALF_LIFE_MS);
  assert.deepEqual(t.mintCalls, []);
  assert.equal(renewEvents(t.events)[0]?.attrs.http_status, 503);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(t.renewCalls.length, 2);
  assert.deepEqual(t.mintCalls, [AGENT]);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), MINTED_KEY);
  const last = renewEvents(t.events).at(-1)!;
  assert.equal(last.attrs.outcome, "fallback_mint");
  assert.equal(last.attrs.refusal_code, "runner_credential_already_renewed");
});

// Teeth: drop runOverdueAttempts (the wall-clock sweep) -> nothing runs until the timer's awake time passes -> RED.
test("a machine asleep past expiry renews on waking, without any call", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const t = setup({ renew: () => json(409, { code: "runner_credential_renew_window_passed" }) });
  t.track();
  // Asleep for 8 days: the wall clock moves, the (monotonic) timers do not.
  vi.setSystemTime(Date.now() + TTL_MS + DAY_MS);
  assert.equal(t.renewCalls.length, 0);
  await vi.advanceTimersByTimeAsync(RUNNER_CREDENTIAL_RENEW_SWEEP_MS);
  assert.equal(t.renewCalls.length, 1, "renewed once awake");
  assert.deepEqual(t.mintCalls, [AGENT], "the window passed: a fresh mint");
  assert.equal(currentRunnerCredentialKey(OLD_KEY), MINTED_KEY);
  const [event] = renewEvents(t.events);
  assert.equal(event?.attrs.trigger, "half_life");
  assert.ok((event?.attrs.ms_to_expiry as number) < 0, "attempted after expiry");
});

// Teeth: schedule the mint-failure retry only while remaining > 0 -> no retry after expiry -> RED.
test("an expired key whose renewal and mint fail is tried again by itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let mintOk = false;
  const t = setup({
    renew: () => json(403, { code: "credential_not_issued_by_this_computer" }),
    mint: async () => {
      if (!mintOk) throw new TypeError("fetch failed");
      return { apiKey: MINTED_KEY, credentialId: "cred-minted", expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
    },
  });
  t.track(1_000);
  // Its half-life attempt and the retries until expiry all fail.
  await vi.advanceTimersByTimeAsync(2_000);
  const failed = renewEvents(t.events);
  assert.ok(failed.length >= 2 && failed.every((event) => event.attrs.outcome === "failed"));
  assert.ok((failed.at(-1)!.attrs.ms_to_expiry as number) <= 0, "the last one after expiry");
  assert.ok((failed.at(-1)!.attrs.retry_in_ms as number) > 0, "and it is tried again");
  mintOk = true;
  await vi.advanceTimersByTimeAsync(RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS);
  assert.equal(currentRunnerCredentialKey(OLD_KEY), MINTED_KEY, "recovered with no call");
});
