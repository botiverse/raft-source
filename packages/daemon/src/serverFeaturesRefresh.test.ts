// Server features refresh (serverFeaturesRefresh.ts): one delayed request per
// burst of triggers, only the answer to the latest request on the
// connection's own server applied, and the notice an agent reads at its next
// start. The delay keeps a flag change from making every Computer ask at once;
// the reply checks keep a late or foreign answer from overwriting newer values.
import assert from "node:assert/strict";
import type { ServerFeaturesMessage } from "@botiverse/raft-shared";
import {
  SERVER_FEATURES_REFRESH_MAX_DELAY_MS,
  ServerFeaturesRefresh,
  changedAgentServerFeatureKeys,
  describeAgentServerFeatureChanges,
  serverFeatureChangeNeedsRestart,
  formatServerFeaturesNotice,
  readAgentServerFeatures,
} from "./serverFeaturesRefresh";

function harness(random = () => 0.5) {
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const sent: string[] = [];
  let ids = 0;
  let nowMs = 1_000;
  const refresh = new ServerFeaturesRefresh({
    send: (requestId) => sent.push(requestId),
    now: () => nowMs,
    random,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    newRequestId: () => `req-${++ids}`,
  });
  const fireNext = () => {
    const timer = timers.find((candidate) => !candidate.cleared && candidate.callback);
    assert.ok(timer, "a timer is pending");
    timer.cleared = true;
    timer.callback();
  };
  return { refresh, timers, sent, fireNext, advance: (ms: number) => { nowMs += ms; } };
}

const reply = (requestId: string, serverId = "server-1", features: unknown = { enabledApps: ["artifacts"] }): ServerFeaturesMessage =>
  ({ type: "server:features", requestId, serverId, features } as ServerFeaturesMessage);

test("triggers while a delay runs join it: one request", () => {
  const { refresh, timers, sent, fireNext } = harness();
  refresh.schedule();
  refresh.schedule();
  refresh.schedule();
  assert.equal(timers.length, 1);
  assert.deepEqual(sent, [], "nothing is sent before the delay ends");
  fireNext();
  assert.deepEqual(sent, ["req-1"]);
  assert.equal(refresh.outstandingRequest?.requestId, "req-1");
});

test("the delay is uniform in 0..30 s", () => {
  for (const [random, expected] of [[0, 0], [0.5, 15_000], [0.999_999, 29_999], [1, SERVER_FEATURES_REFRESH_MAX_DELAY_MS]] as const) {
    const { refresh, timers } = harness(() => random);
    refresh.schedule();
    assert.equal(timers[0]!.ms, expected, `random ${random}`);
    assert.ok(timers[0]!.ms >= 0 && timers[0]!.ms <= SERVER_FEATURES_REFRESH_MAX_DELAY_MS);
  }
});

test("only the answer to the latest request, naming the connection's server, is accepted, once", () => {
  const { refresh, fireNext, advance } = harness();
  refresh.schedule();
  fireNext();
  advance(250);
  assert.equal(refresh.outstandingRequest?.sentAtMs, 1_000);
  assert.equal(refresh.acceptReply(reply("req-0"), "server-1"), null, "an unknown request id");
  assert.equal(refresh.acceptReply(reply("req-1", "server-2"), "server-1"), null, "another server's values");
  assert.equal(refresh.acceptReply(reply("req-1"), null), null, "no bound server");
  assert.equal(refresh.acceptReply(reply("req-1", "server-1", "not an object"), "server-1"), null, "a malformed body");
  assert.deepEqual(refresh.acceptReply(reply("req-1"), "server-1"), { enabledApps: ["artifacts"] });
  assert.equal(refresh.acceptReply(reply("req-1"), "server-1"), null, "the same answer again");
  assert.equal(refresh.outstandingRequest, null);
});

test("a trigger after a request went out sends a newer one, and the older answer is then ignored", () => {
  const { refresh, timers, sent, fireNext } = harness();
  refresh.schedule();
  fireNext();
  refresh.schedule();
  assert.equal(timers.length, 2, "a new delay starts while req-1 is outstanding");
  fireNext();
  assert.deepEqual(sent, ["req-1", "req-2"]);
  assert.equal(refresh.acceptReply(reply("req-1"), "server-1"), null);
  assert.deepEqual(refresh.acceptReply(reply("req-2", "server-1", { taskConversations: true }), "server-1"), { taskConversations: true });
});

test("reset (disconnect) cancels the delay and forgets the outstanding request", () => {
  const { refresh, timers, sent, fireNext } = harness();
  refresh.schedule();
  refresh.reset();
  assert.equal(timers[0]!.cleared, true);
  assert.deepEqual(sent, []);
  refresh.schedule();
  assert.equal(timers.length, 2, "a later trigger starts a new delay");
  fireNext();
  refresh.reset();
  assert.equal(refresh.acceptReply(reply("req-1"), "server-1"), null, "no answer is applied across a reconnect");
});

test("a wire body keeps only the known features, in their shape", () => {
  assert.deepEqual(
    readAgentServerFeatures({ passiveAx: true, vaultApp: "yes", reminderApp: false, enabledApps: ["artifacts", 7], runtimeHost: "oar" }),
    { passiveAx: true, enabledApps: ["artifacts"] },
  );
  assert.equal(readAgentServerFeatures(null), null);
  assert.equal(readAgentServerFeatures(["artifacts"]), null);
});

test("a wire body keeps inboxItemsLaunchAt only as a string beside inboxItems: true (RFC 081)", () => {
  const at = "2026-01-01T00:00:00.000Z";
  assert.deepEqual(readAgentServerFeatures({ inboxItems: true, inboxItemsLaunchAt: at }), { inboxItems: true, inboxItemsLaunchAt: at });
  assert.deepEqual(readAgentServerFeatures({ inboxItemsLaunchAt: at }), {});
  assert.deepEqual(readAgentServerFeatures({ inboxItems: true, inboxItemsLaunchAt: 7 }), { inboxItems: true });
});

test("changed keys compare the normalized values", () => {
  assert.deepEqual(changedAgentServerFeatureKeys({ enabledApps: ["b", "a"] }, { enabledApps: ["a", "b", "b"] }), []);
  assert.deepEqual(changedAgentServerFeatureKeys({ passiveAx: true }, { enabledApps: ["artifacts"] }), ["passiveAx", "enabledApps"]);
});

// The notice the agent reads at its next start.
test("notice: an app turned on names its command", () => {
  expect(formatServerFeaturesNotice({ enabledApps: [] }, { enabledApps: ["artifacts"] })).toMatchInlineSnapshot(`
    "Raft notice: this server's features changed: Artifacts turned on (\`raft artifact\`). Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.

    "
  `);
});

test("notice: an app turned off says its command no longer works", () => {
  expect(formatServerFeaturesNotice({ enabledApps: ["artifacts"] }, {})).toMatchInlineSnapshot(`
    "Raft notice: this server's features changed: Artifacts turned off (\`raft artifact\` no longer works here). Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.

    "
  `);
});

test("notice: several changes in one sentence, apps first", () => {
  expect(formatServerFeaturesNotice(
    { taskConversations: true, vaultApp: true, enabledApps: [] },
    { reminderApp: true, enabledApps: ["artifacts"] },
  )).toMatchInlineSnapshot(`
    "Raft notice: this server's features changed: Artifacts turned on (\`raft artifact\`); Task conversations turned off for new tasks (a task that already has a conversation keeps it); reminders moved to the Reminder app (\`raft reminder schedule\`, \`update\` and \`snooze\` are refused here now); your instructions no longer cover the Vault app. Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.

    "
  `);
  expect(formatServerFeaturesNotice(
    { reminderApp: true, enabledApps: [] },
    { taskConversations: true, enabledApps: [] },
  )).toMatchInlineSnapshot(`
    "Raft notice: this server's features changed: Task conversations turned on (a task has its own conversation: \`raft task reply\`); new reminders use \`raft reminder schedule\` again (the ones made in the Reminder app stay there). Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.

    "
  `);
});

test("notice: instruction-only changes are named as such; sub-agents only where the runtime renders them", () => {
  expect(formatServerFeaturesNotice({ enabledApps: [] }, { vaultApp: true, subagentDelegation: true, enabledApps: [] }, { supportsSubagents: true })).toMatchInlineSnapshot(`
    "Raft notice: this server's features changed: your instructions now cover asking for credentials through the Vault app; your instructions now cover working through sub-agents. Your standing instructions now describe what is available here; where your notes (MEMORY.md and the rest) say otherwise, follow the instructions and update the notes. No reply is needed.

    "
  `);
  expect(describeAgentServerFeatureChanges({ vaultApp: true, subagentDelegation: true }, {}, { runtime: { supportsSubagents: true } })).toEqual([
    "your instructions no longer cover the Vault app",
    "your instructions no longer cover working through sub-agents",
  ]);
  expect(describeAgentServerFeatureChanges({}, { vaultApp: true, subagentDelegation: true })).toEqual([
    "your instructions now cover asking for credentials through the Vault app",
  ]);
});

test("notice: nothing an agent would notice gives none", () => {
  assert.equal(formatServerFeaturesNotice({ subagentDelegation: true, passiveAx: true, piSessionRotation: true }, {}), null);
  assert.equal(formatServerFeaturesNotice({ subagentDelegation: true }, {}, { supportsSubagents: false }), null, "a runtime without sub-agents never had that section");
  assert.equal(formatServerFeaturesNotice({ enabledApps: ["artifacts", "future-app"] }, { enabledApps: ["artifacts"] }), null, "an app this build has no entry for");
  assert.equal(formatServerFeaturesNotice({ enabledApps: [] }, {}), null);
});

test("notice: an app entry without a name is not named; one without a command is named alone", () => {
  const table = [
    { appId: "alpha", commands: "**Alpha (test)** — `raft alpha list`.", commandsVersion: 1 },
    { appId: "beta", name: "Beta", commands: "**Beta (test)** — `raft beta list`.", commandsVersion: 1 },
    { appId: "gamma", name: "Gamma", command: "raft gamma", commands: "**Gamma (test)** — `raft gamma list`.", commandsVersion: 1 },
  ];
  assert.deepEqual(
    describeAgentServerFeatureChanges({ enabledApps: ["gamma"] }, { enabledApps: ["alpha", "beta"] }, { table }),
    ["Beta turned on", "Gamma turned off (`raft gamma` no longer works here)"],
  );
});

test("restart: a key restarts only a runtime it changes something for", () => {
  const plain = { supportsSubagents: false, rotatesSessions: false };
  const claude = { supportsSubagents: true, rotatesSessions: false };
  const pi = { supportsSubagents: false, rotatesSessions: true };
  for (const key of ["enabledApps", "taskConversations", "reminderApp", "vaultApp", "passiveAx"] as const) {
    assert.equal(serverFeatureChangeNeedsRestart([key], plain), true, key);
  }
  assert.equal(serverFeatureChangeNeedsRestart(["subagentDelegation"], plain), false);
  assert.equal(serverFeatureChangeNeedsRestart(["subagentDelegation"], claude), true);
  assert.equal(serverFeatureChangeNeedsRestart(["piSessionRotation"], claude), false);
  assert.equal(serverFeatureChangeNeedsRestart(["piSessionRotation"], pi), true);
  assert.equal(serverFeatureChangeNeedsRestart(["piSessionRotation", "subagentDelegation"], plain), false);
  assert.equal(serverFeatureChangeNeedsRestart(["piSessionRotation", "enabledApps"], plain), true, "any key that matters is enough");
  // #proj-runtime:#54: both wake recycle flags are read at idle checks and the next start, never by a running session.
  for (const key of ["wakeRecycleOar", "wakeRecycleTierGate", "wakeRecycleWarm"] as const) {
    assert.equal(serverFeatureChangeNeedsRestart([key], claude), false, key);
    assert.equal(serverFeatureChangeNeedsRestart([key], pi), false, key);
  }
  assert.equal(serverFeatureChangeNeedsRestart([], claude), false);
});


test("turning View Context on or off never restarts a session and is not announced to the agent", () => {
  for (const runtime of [{ supportsSubagents: true, rotatesSessions: true }, { supportsSubagents: false, rotatesSessions: false }]) {
    expect(serverFeatureChangeNeedsRestart(["agentContextView"], runtime)).toBe(false);
  }
  expect(changedAgentServerFeatureKeys({}, { agentContextView: true })).toEqual(["agentContextView"]);
  expect(describeAgentServerFeatureChanges({}, { agentContextView: true }, { runtime: { supportsSubagents: true } })).toEqual([]);
});
