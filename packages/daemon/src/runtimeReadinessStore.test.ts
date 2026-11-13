import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRuntimeReadinessReport, type AgentConfig } from "@botiverse/raft-shared";
import { ProviderLimitLedger, providerLimitCredentialKey } from "./providerLimitLedger";
import { RUNTIME_READINESS_FILE, RuntimeReadinessStore } from "./runtimeReadinessStore";

function runnerFile(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-readiness-"));
  return path.join(home, "machines", "machine-a", RUNTIME_READINESS_FILE);
}

function open(file: string, ledger: ProviderLimitLedger, now: () => number) {
  const store = new RuntimeReadinessStore({ file, now });
  store.load();
  store.attach(ledger);
  return store;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

const verification = (recordedAtMs: number) => ({ invalidReason: "user_reauth" as const, recordedAtMs, code: "verification_required" as const });
const claudeOnMachineLogin = { runtime: "claude", model: "sonnet" } as AgentConfig;
const claudeOnOwnHome = { runtime: "claude", model: "sonnet", envVars: { HOME: "/srv/agents/a2" } } as unknown as AgentConfig;

test("#68: a verification hold on the machine login is one fact on shared:claude; on an own credential, on agent:<id>; nothing else is persisted", () => {
  const file = runnerFile();
  const ledger = new ProviderLimitLedger();
  const store = open(file, ledger, () => 1_000);

  const sharedKey = providerLimitCredentialKey("a1", claudeOnMachineLogin);
  const ownKey = providerLimitCredentialKey("a2", claudeOnOwnHome);
  assert.equal(sharedKey, "shared:claude");
  assert.equal(ownKey, "agent:a2");
  ledger.recordInvalid(sharedKey, verification(1_000), { host: "legacy", agentId: "a1" });
  ledger.recordInvalid(ownKey, verification(1_000), { host: "legacy", agentId: "a2" });
  // A plain rejected sign-in carries no readiness code in this step.
  ledger.recordInvalid("agent:a3", { invalidReason: "user_reauth", recordedAtMs: 1_000 }, { host: "legacy", agentId: "a3" });

  const doc = readJson(file);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.credentials, {
    "shared:claude": { state: "verification_required", since: 1_000, recordedAt: 1_000 },
    "agent:a2": { state: "verification_required", since: 1_000, recordedAt: 1_000 },
  });
  assert.deepEqual(store.report().facts, [
    { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "blocked", since: 1_000 },
    { resource: { kind: "login", key: "agent:a2" }, code: "verification_required", behaviour: "blocked", since: 1_000 },
  ]);
  // Contract: a daemon login fact carries no params, so no provider text or account field can leak.
  assert.ok(store.report().facts.every((fact) => fact.params === undefined));
  // The one shared record holds every agent on the machine login, not one on its own credential.
  assert.equal(ledger.invalidFor(providerLimitCredentialKey("a9", claudeOnMachineLogin), "opus")?.code, "verification_required");
  assert.equal(ledger.invalidFor(providerLimitCredentialKey("a9", claudeOnOwnHome), "opus"), undefined);
  store.close();
});

test("#68: a restart clears nothing: the facts come back into the ledger and seq keeps growing", () => {
  const file = runnerFile();
  const before = new ProviderLimitLedger();
  const first = open(file, before, () => 5_000);
  before.recordInvalid("shared:claude", verification(5_000), { host: "legacy", agentId: "a1" });
  const seqBefore = first.report().seq;
  first.close();

  // The clock reads earlier than the stored seq: seq still grows.
  const after = new ProviderLimitLedger();
  const second = open(file, after, () => 10);
  const held = after.invalidFor("shared:claude", null);
  assert.equal(held?.code, "verification_required");
  assert.equal(held?.invalidReason, "user_reauth");
  assert.equal(held?.recordedAtMs, 5_000, "model output must come from a turn started after the original finding");
  assert.ok(second.report().seq > seqBefore);
  assert.deepEqual(second.report().facts.map((fact) => fact.since), [5_000]);
  second.close();
});

test("#68: model output or a credential change ends it; the same finding again keeps since and sends nothing", () => {
  const file = runnerFile();
  let now = 1_000;
  const ledger = new ProviderLimitLedger();
  const store = open(file, ledger, () => now);
  const sent: number[] = [];
  store.onChange(() => sent.push(store.report().seq));

  ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  now = 61_000;
  ledger.recordInvalid("shared:claude", verification(61_000), { host: "legacy", agentId: "a2" });
  assert.equal(sent.length, 1, "the same state again is not a change of the report");
  assert.deepEqual(store.entry("shared:claude"), { state: "verification_required", since: 1_000, recordedAt: 61_000 });
  assert.equal((readJson(file).credentials as Record<string, { recordedAt: number }>)["shared:claude"]?.recordedAt, 61_000);

  ledger.releaseInvalid("shared:claude", "model_output", { host: "legacy", agentId: "a1" });
  assert.equal(store.entry("shared:claude"), undefined);
  assert.deepEqual(readJson(file).credentials, {});
  // #69: for the other runners, the file keeps when and why the machine login's hold ended.
  assert.deepEqual(readJson(file).ended, { "shared:claude": { at: 61_001, cause: "model_output" } });
  assert.equal(sent.length, 2);
  assert.ok(sent[1]! > sent[0]!);

  ledger.recordInvalid("agent:a2", verification(70_000), { host: "legacy", agentId: "a2" });
  ledger.releaseInvalid("agent:a2", "credentials_changed", { host: "legacy" });
  assert.deepEqual(store.report().facts, []);
  assert.equal((readJson(file).ended as Record<string, unknown>)["agent:a2"], undefined, "an agent's own credential concerns no other runner");
  // A plain sign-in rejection replacing the verification record ends the fact too.
  ledger.recordInvalid("shared:claude", verification(80_000), { host: "legacy", agentId: "a1" });
  ledger.recordInvalid("shared:claude", { invalidReason: "user_reauth", recordedAtMs: 81_000 }, { host: "legacy", agentId: "a1" });
  assert.deepEqual(store.report().facts, []);
  // #69: the login is still refused, so that is no end: the earlier end is gone and none is written.
  assert.equal(readJson(file).ended, undefined);
  store.close();
});

test("#68: the report round-trips through the lenient parser, which keeps unknown codes and drops unreadable facts", () => {
  const file = runnerFile();
  const ledger = new ProviderLimitLedger();
  const store = open(file, ledger, () => 1_000);
  ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  const report = store.report();
  assert.deepEqual(parseRuntimeReadinessReport({ type: "machine:runtime_readiness", ...report }), report);
  store.close();
});

// ── #69: several runners on one Computer share the machine login ──

const DAY = 24 * 60 * 60_000;

/** Runners of one Computer: sibling directories under one `machines/`. */
function runners(names: readonly string[], now: () => number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-readiness-"));
  return names.map((name) => {
    const file = path.join(home, "machines", `machine-${name}`, RUNTIME_READINESS_FILE);
    const ledger = new ProviderLimitLedger();
    return { file, ledger, store: open(file, ledger, now) };
  });
}

const sharedOf = (file: string) => ({
  held: (readJson(file).credentials as Record<string, unknown> | undefined)?.["shared:claude"],
  ended: (readJson(file).ended as Record<string, unknown> | undefined)?.["shared:claude"],
});

test("#69: a finding one runner makes on the machine login holds the other runner's agents too, with the same times; an agent's own credential stays with its runner", () => {
  let now = 1_000;
  const [a, b] = runners(["a", "b"], () => now);
  const sentB: number[] = [];
  b!.store.onChange(() => sentB.push(b!.store.report().seq));

  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  a!.ledger.recordInvalid("agent:a2", verification(1_000), { host: "legacy", agentId: "a2" });
  now = 5_000;
  assert.equal(b!.store.syncSharedLogins(), true);

  const held = b!.ledger.invalidFor("shared:claude", "opus");
  assert.equal(held?.code, "verification_required");
  assert.equal(held?.recordedAtMs, 1_000, "the original finding's time: only a turn started after it proves the login");
  assert.equal(b!.ledger.invalidFor("agent:a2", "opus"), undefined);
  assert.deepEqual(readJson(b!.file).credentials, {
    "shared:claude": { state: "verification_required", since: 1_000, recordedAt: 1_000 },
  });
  assert.deepEqual(b!.store.report().facts, [
    { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "blocked", since: 1_000 },
  ]);
  assert.equal(sentB.length, 1, "runner B tells its own server");
  // The same evidence again changes nothing and sends nothing, on either side.
  assert.equal(b!.store.syncSharedLogins(), false);
  assert.equal(a!.store.syncSharedLogins(), false);
  assert.equal(sentB.length, 1);
  a!.store.close();
  b!.store.close();
});

test("#69: three runners hold the login; one runner's call succeeds: it is not held again by the others' older entries, and both others are released with the same end", () => {
  let now = 1_000;
  const [a, b, c] = runners(["a", "b", "c"], () => now);
  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  now = 2_000;
  b!.ledger.recordInvalid("shared:claude", verification(2_000), { host: "legacy", agentId: "b1" });
  assert.equal(a!.store.syncSharedLogins(), true, "B's finding is later: A takes its time over");
  assert.equal(a!.ledger.invalidFor("shared:claude", null)?.recordedAtMs, 2_000);
  assert.deepEqual(sharedOf(a!.file).held, { state: "verification_required", since: 1_000, recordedAt: 2_000 }, "held here since A's own first finding");
  assert.equal(c!.store.syncSharedLogins(), true);

  // The account holder verified; a turn runner A started at 9_000 produced output.
  now = 10_000;
  a!.ledger.releaseInvalid("shared:claude", "model_output", { host: "legacy", agentId: "a1" }, (record) => 9_000 > record.recordedAtMs, 9_000);
  assert.deepEqual(sharedOf(a!.file), { held: undefined, ended: { at: 9_000, cause: "model_output" } });

  // A reads B's and C's files, which still hold the login from 2_000: older than A's end.
  now = 11_000;
  assert.equal(a!.store.syncSharedLogins(), false);
  assert.equal(a!.ledger.invalidFor("shared:claude", null), undefined, "not held again by the other runners' older entries");

  for (const other of [b!, c!]) {
    const released: string[] = [];
    other.ledger.subscribe((change) => { if (change.kind === "invalid_released") released.push(change.cause); });
    assert.equal(other.store.syncSharedLogins(), true);
    assert.equal(other.ledger.invalidFor("shared:claude", null), undefined);
    assert.deepEqual(released, ["model_output"]);
    assert.deepEqual(other.store.report().facts, []);
    assert.deepEqual(sharedOf(other.file), { held: undefined, ended: { at: 9_000, cause: "model_output" } });
    assert.equal(other.store.syncSharedLogins(), false);
  }
  for (const each of [a!, b!, c!]) each.store.close();
});

test("#69: a finding recorded after the turn that proved the login started is the later evidence: it holds both runners; at the same instant the finding wins", () => {
  let now = 1_000;
  const [a, b] = runners(["a", "b"], () => now);
  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  // A's turn started at 5_000; B was refused at 6_000; A's turn then produced output at 7_000.
  now = 6_000;
  b!.ledger.recordInvalid("shared:claude", verification(6_000), { host: "legacy", agentId: "b1" });
  now = 7_000;
  a!.ledger.releaseInvalid("shared:claude", "model_output", { host: "legacy", agentId: "a1" }, (record) => 5_000 > record.recordedAtMs, 5_000);
  assert.equal(a!.ledger.invalidFor("shared:claude", null), undefined);

  assert.equal(a!.store.syncSharedLogins(), true);
  assert.equal(a!.ledger.invalidFor("shared:claude", null)?.recordedAtMs, 6_000, "B's refusal came after A's turn started");
  assert.equal(sharedOf(a!.file).ended, undefined, "the end is history once a later finding is taken over");
  assert.equal(b!.store.syncSharedLogins(), false);
  assert.equal(b!.ledger.invalidFor("shared:claude", null)?.recordedAtMs, 6_000, "A's earlier success does not end B's later finding");

  // The same instant: A's end at exactly B's finding time does not release B.
  now = 8_000;
  a!.ledger.releaseInvalid("shared:claude", "explicit_stop", { host: "legacy" }, () => true, 6_000);
  assert.deepEqual(sharedOf(a!.file).ended, { at: 6_001, cause: "explicit_stop" }, "an end is strictly after the finding it ends");
  fs.writeFileSync(a!.file, JSON.stringify({ version: 1, seq: 1, credentials: {}, ended: { "shared:claude": { at: 6_000, cause: "explicit_stop" } } }));
  assert.equal(b!.store.syncSharedLogins(), false);
  assert.equal(b!.ledger.invalidFor("shared:claude", null)?.recordedAtMs, 6_000);
  a!.store.close();
  b!.store.close();
});

test("#69: a changed credential on one runner ends the hold on the other as a changed credential, so its hosts run their account check", () => {
  let now = 1_000;
  const [a, b] = runners(["a", "b"], () => now);
  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  b!.store.syncSharedLogins();
  const released: Array<{ cause: string; evidenceAtMs?: number }> = [];
  b!.ledger.subscribe((change) => { if (change.kind === "invalid_released") released.push({ cause: change.cause, evidenceAtMs: change.evidenceAtMs }); });
  now = 3_000;
  a!.ledger.releaseInvalid("shared:claude", "credentials_changed", { host: "legacy" });
  assert.equal(b!.store.syncSharedLogins(), true);
  assert.deepEqual(released, [{ cause: "credentials_changed", evidenceAtMs: 3_000 }]);
  a!.store.close();
  b!.store.close();
});

test("#69: a finding the readiness model does not track replaces the hold without ending it for the other runners; the newer own finding is not overwritten by their copy", () => {
  let now = 1_000;
  const [a, b] = runners(["a", "b"], () => now);
  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  b!.store.syncSharedLogins();
  // On A, a plain rejected sign-in (no readiness code) replaces the record: the login is still refused.
  now = 2_000;
  a!.ledger.recordInvalid("shared:claude", { invalidReason: "user_reauth", recordedAtMs: 2_000 }, { host: "oar", agentId: "a9" });
  assert.deepEqual(sharedOf(a!.file), { held: undefined, ended: undefined });

  assert.equal(b!.store.syncSharedLogins(), false);
  assert.equal(b!.ledger.invalidFor("shared:claude", null)?.code, "verification_required", "B still holds: nothing ended");
  // A reads B's copy (from 1_000): A's own later finding stands.
  assert.equal(a!.store.syncSharedLogins(), false);
  const heldOnA = a!.ledger.invalidFor("shared:claude", null);
  assert.equal(heldOnA?.recordedAtMs, 2_000);
  assert.equal(heldOnA?.code, undefined);
  a!.store.close();
  b!.store.close();
});

test("#69: a runner that is gone leaves its file behind: a finding older than a day is not taken over, its end still counts; an unreadable file reads as empty", () => {
  let now = 10 * DAY;
  const [live] = runners(["live"], () => now);
  const machines = path.dirname(path.dirname(live!.file));
  const leftBehind = (name: string, doc: unknown) => {
    fs.mkdirSync(path.join(machines, name), { recursive: true });
    fs.writeFileSync(path.join(machines, name, RUNTIME_READINESS_FILE), typeof doc === "string" ? doc : JSON.stringify(doc));
  };
  leftBehind("machine-gone", { version: 1, seq: 1, credentials: { "shared:claude": { state: "verification_required", since: 1_000, recordedAt: now - DAY - 1 } } });
  leftBehind("machine-broken", "{ not json");
  assert.equal(live!.store.syncSharedLogins(), false);
  assert.equal(live!.ledger.invalidFor("shared:claude", null), undefined, "one call of its own tells this runner; a stale file does not hold it");

  // Within the day it is taken over.
  leftBehind("machine-recent", { version: 1, seq: 1, credentials: { "shared:claude": { state: "verification_required", since: now - 5_000, recordedAt: now - 5_000 } } });
  assert.equal(live!.store.syncSharedLogins(), true);
  assert.equal(live!.ledger.invalidFor("shared:claude", null)?.recordedAtMs, now - 5_000);
  // An end left behind is evidence however old the file gets.
  leftBehind("machine-recent", { version: 1, seq: 2, credentials: {}, ended: { "shared:claude": { at: now - 1_000, cause: "model_output" } } });
  now += 3 * DAY;
  assert.equal(live!.store.syncSharedLogins(), true);
  assert.equal(live!.ledger.invalidFor("shared:claude", null), undefined);
  live!.store.close();
});

test("#69: after a restart what ended holds nobody; another runner's later finding is taken over when the store opens; the timer reads the other files and stops on close", () => {
  let now = 1_000;
  const [a, b] = runners(["a", "b"], () => now);
  a!.ledger.recordInvalid("shared:claude", verification(1_000), { host: "legacy", agentId: "a1" });
  now = 2_000;
  a!.ledger.releaseInvalid("shared:claude", "credentials_changed", { host: "legacy" });
  a!.store.close();

  const restarted = new ProviderLimitLedger();
  const again = open(a!.file, restarted, () => now);
  assert.equal(restarted.invalidFor("shared:claude", null), undefined);
  assert.deepEqual(again.report().facts, []);
  assert.deepEqual(sharedOf(a!.file).ended, { at: 2_000, cause: "credentials_changed" }, "kept across the restart");
  again.close();

  now = 3_000;
  b!.ledger.recordInvalid("shared:claude", verification(3_000), { host: "legacy", agentId: "b1" });
  const third = new ProviderLimitLedger();
  const ticks: Array<() => void> = [];
  let cleared = 0;
  const reopened = new RuntimeReadinessStore({
    file: a!.file,
    now: () => now,
    timers: { setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => { cleared += 1; } },
  });
  reopened.load();
  reopened.attach(third);
  assert.equal(third.invalidFor("shared:claude", null)?.recordedAtMs, 3_000, "read at attach, before any agent starts");

  reopened.startSharedLoginSync();
  reopened.startSharedLoginSync();
  assert.equal(ticks.length, 1, "one timer");
  now = 4_000;
  b!.ledger.releaseInvalid("shared:claude", "model_output", { host: "legacy", agentId: "b1" }, () => true, 3_500);
  ticks[0]!();
  assert.equal(third.invalidFor("shared:claude", null), undefined, "the tick applied B's end");
  reopened.close();
  assert.equal(cleared, 1);
  b!.store.close();
});
