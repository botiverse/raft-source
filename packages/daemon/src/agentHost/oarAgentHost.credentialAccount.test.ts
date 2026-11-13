// Reconciler step 15 (task #48), on the OAR host as on the legacy host
// (agentProcessManager.credentialAccount.test.ts): a held credential released
// for a credentials change that now signs in as another account ends the
// idle session and starts the agent again on it with the held deliveries;
// the same account only releases (held deliveries go to the same session).
import assert from "node:assert/strict";
import path from "node:path";
import { ProviderLimitLedger } from "../providerLimitLedger";
import type { CredentialAccount } from "../credentialSource";
import { codexShared, harness, makeConfig, message, sleep, startRequest, until, withFailure, type Harness } from "../testing/oarAgentHostHarness";

async function accountHarness(account: { current: CredentialAccount }): Promise<{ h: Harness; ledger: ProviderLimitLedger; turnInputs: Map<string, string[]> }> {
  const ledger = new ProviderLimitLedger();
  const turnInputs = new Map<string, string[]>();
  const h = await harness({
    turn: (turn) => {
      const agentId = path.basename(String(turn.options.cwd));
      const seen = [...(turnInputs.get(agentId) ?? []), turn.input];
      turnInputs.set(agentId, seen);
      if (seen.length === 1) throw new Error("Your access token could not be refreshed. Please sign in again.");
      turn.say("ok");
    },
    wrapSession: (session) => withFailure(session, "auth"),
    deps: { providerLimits: ledger, credentialAccountReader: () => account.current },
  });
  return { h, ledger, turnInputs };
}

const known = (id: string): CredentialAccount => ({ kind: "known", digest: `digest-${id}` });
const eventsNamed = (h: Harness, name: string) => h.events.filter((event) => event.name === name);

async function heldOarAgent(h: Harness, turnInputs: Map<string, string[]>): Promise<void> {
  await h.host.start(startRequest("agent-1", codexShared({ sessionId: null })));
  await until(() => eventsNamed(h, "daemon.agent.credential_invalid.recorded").length > 0, "the invalid credential");
  assert.equal(await h.host.deliverMessage("agent-1", message("m-held")), true);
  await sleep(50);
  assert.equal(turnInputs.get("agent-1")?.length, 1, "held");
}

test("OAR: released for a credentials change as another account, the idle session ends and the agent starts again with the held delivery", async () => {
  const account = { current: known("A") };
  const { h, ledger, turnInputs } = await accountHarness(account);
  try {
    await heldOarAgent(h, turnInputs);
    const opens = h.opened.length;
    account.current = known("B");
    ledger.releaseInvalid("shared:codex", "credentials_changed", { host: "legacy" });

    await until(() => h.opened.length > opens, "a new session opened");
    assert.ok(h.opened.at(-1)?.options.resume, "it resumes the session");
    await until(() => (turnInputs.get("agent-1") ?? []).some((input) => input.includes("m-held")), "the held delivery in the new session");
    assert.deepEqual(eventsNamed(h, "daemon.agent.credential_account.restart").map((event) => event.attrs), [{
      agentId: "agent-1", runtime: "codex", launchId: "launch-agent-1", release_cause: "credentials_changed",
      account_changed: true, account_unknown: false, held_count: 1, host: "oar",
    }]);
    assert.equal(eventsNamed(h, "daemon.agent.spec_restart_stop").at(-1)?.attrs.drift, "credential_account");
    assert.equal(eventsNamed(h, "daemon.agent.oar.restart_scheduled").at(-1)?.attrs.cause, "credential_account");
  } finally {
    await h.cleanup();
  }
});

test("OAR: the same account signed in again only releases: the held delivery goes to the same session", async () => {
  const account = { current: known("A") };
  const { h, ledger, turnInputs } = await accountHarness(account);
  try {
    await heldOarAgent(h, turnInputs);
    const opens = h.opened.length;
    ledger.releaseInvalid("shared:codex", "credentials_changed", { host: "legacy" });
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 2, "the held delivery's turn");
    assert.equal(h.opened.length, opens, "no new session");
    assert.deepEqual(eventsNamed(h, "daemon.agent.credential_account.restart"), []);
    assert.equal(eventsNamed(h, "daemon.agent.credential_invalid.released").at(-1)?.attrs.account_check, "same_account");
  } finally {
    await h.cleanup();
  }
});

// #triage:#263: a delivery held for the old runtime's credential or usage limit
// kept the session "not idle", so a switch to another runtime waited for that
// hold to lift. A drift that drops the session ends it now; the server's next
// start takes the held delivery to the new runtime.
test("OAR: a held delivery does not hold a switch to another runtime; the session ends and leaves the host", async () => {
  const account = { current: known("A") };
  const { h, turnInputs } = await accountHarness(account);
  try {
    await heldOarAgent(h, turnInputs);
    h.host.applyConfig("agent-1", makeConfig({ runtime: "claude", model: "sonnet" }), 2);
    await until(() => eventsNamed(h, "daemon.agent.spec_restart_stop").length > 0, "the spec stop");
    assert.ok(String(eventsNamed(h, "daemon.agent.spec_restart_stop").at(-1)?.attrs.drift).split(",").includes("runtime"));
    assert.equal(h.host.owns("agent-1"), false, "handed to the server's next start");
  } finally {
    await h.cleanup();
  }
});
