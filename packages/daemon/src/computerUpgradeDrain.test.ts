// Reconciler step 13 (PR 3): the runner's drain channel against stand-in
// agent hosts and real files. The hosts' holding itself is tested beside
// each host (agentProcessManager.drain.test.ts, oarAgentHost.drain.test.ts).
//
// RED proof: drop `onConnected` from handleConnect / its release and the
// reconnect test keeps holding; drop the `ended` set and a removed-then-left
// request file begins the same drain again.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerUpgradeDrainingMessage, ComputerUpgradeDrainStateFile } from "@botiverse/raft-shared";
import type { AgentDrainOptions, AgentDrainProgress, AgentDrainSummary } from "./agentDrain";
import { ComputerUpgradeDrainChannel } from "./computerUpgradeDrain";

function fakeHosts() {
  const calls: string[] = [];
  let holding = false;
  let progress: AgentDrainProgress = { live: 1, notQuiet: [{ agentId: "agent-a", reason: "agent_busy" }] };
  let resolve: ((summary: AgentDrainSummary) => void) | null = null;
  return {
    calls,
    hosts: {
      beginDrain(options: AgentDrainOptions): Promise<AgentDrainSummary> {
        calls.push(`begin:${options.deadlineMs}`);
        holding = true;
        return new Promise((done) => { resolve = done; });
      },
      endDrain(): void {
        calls.push("end");
        holding = false;
        resolve?.({ finished: "ended", deadlineAtMs: 0, durationMs: 0, waitedFor: [], notQuiet: [], live: 0 });
      },
      drainProgress: (): AgentDrainProgress | null => (holding ? progress : null),
    },
    setProgress(next: AgentDrainProgress) { progress = next; },
    finish(finished: AgentDrainSummary["finished"]) {
      resolve?.({ finished, deadlineAtMs: 0, durationMs: 5, waitedFor: ["agent-a"], notQuiet: [], live: progress.live });
    },
    /** The hold cap fired inside the hosts. */
    expire() { holding = false; },
  };
}

function setup(options: { origin?: boolean; connected?: boolean; serviceAlive?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "raft-upgrade-drain-"));
  const paths = { requestPath: path.join(dir, "upgrade-drain.json"), statePath: path.join(dir, "upgrade-drain-state.json") };
  const fake = fakeHosts();
  const sent: ComputerUpgradeDrainingMessage[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const nowMs = 1_000_000;
  const channel = new ComputerUpgradeDrainChannel({
    paths,
    hosts: fake.hosts,
    connected: () => options.connected ?? true,
    send: (frame) => sent.push(frame),
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => nowMs,
    pid: 4242,
    isAlive: () => options.serviceAlive ?? true,
  });
  const writeRequest = (requestId = "req-1") =>
    writeFileSync(paths.requestPath, JSON.stringify({ formatVersion: 1, requestId, origin: options.origin ?? true, deadlineAtMs: nowMs + 60_000, servicePid: 777 }));
  const removeRequest = () => rmSync(paths.requestPath, { force: true });
  const state = () => JSON.parse(readFileSync(paths.statePath, "utf8")) as ComputerUpgradeDrainStateFile;
  return { dir, paths, fake, sent, events, channel, writeRequest, removeRequest, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("upgrade drain: the service's request begins the hosts' drain with the time left; progress goes to the state file and, from the origin runner, to the Server", async () => {
  const t = setup();
  try {
    t.channel.tick();
    assert.deepEqual(t.fake.calls, [], "no request: nothing");
    t.writeRequest();
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000"]);
    assert.deepEqual(t.state(), { formatVersion: 1, requestId: "req-1", pid: 4242, live: 1, notQuietAgentIds: ["agent-a"], updatedAtMs: 1_000_000 });
    assert.deepEqual(t.sent, [{
      type: "computer:upgrade:draining",
      requestId: "req-1",
      deadlineAt: new Date(1_060_000).toISOString(),
      live: 1,
      notQuietAgentIds: ["agent-a"],
    }]);
    t.channel.tick();
    assert.equal(t.sent.length, 1, "nothing changed: nothing sent");
    t.fake.setProgress({ live: 1, notQuiet: [] });
    t.fake.finish("quiet");
    await flush();
    assert.equal(t.state().finished, "quiet");
    assert.deepEqual(t.sent.at(-1), { type: "computer:upgrade:draining", requestId: "req-1", deadlineAt: new Date(1_060_000).toISOString(), live: 1, notQuietAgentIds: [], finished: "quiet" });
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000"], "quiet: still held, the shutdown comes next");
  } finally {
    t.cleanup();
  }
});

test("upgrade drain: a runner of another Server drains too but sends nothing; a request of a service that is gone is ignored", () => {
  const other = setup({ origin: false });
  const stale = setup({ serviceAlive: false });
  try {
    other.writeRequest();
    other.channel.tick();
    assert.deepEqual(other.fake.calls, ["begin:60000"]);
    assert.equal(other.state().requestId, "req-1");
    assert.deepEqual(other.sent, []);
    stale.writeRequest();
    stale.channel.tick();
    assert.deepEqual(stale.fake.calls, []);
  } finally {
    other.cleanup();
    stale.cleanup();
  }
});

test("upgrade drain: the service removing the request (the upgrade did not go on) ends the drain; the same request is not begun again", () => {
  const t = setup();
  try {
    t.writeRequest();
    t.channel.tick();
    t.removeRequest();
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"]);
    assert.equal(t.state().finished, "ended");
    assert.equal(t.sent.at(-1)?.finished, "ended");
    t.writeRequest();
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"], "an ended request stays ended");
    t.writeRequest("req-2");
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end", "begin:60000"], "a new request drains");
  } finally {
    t.cleanup();
  }
});

// Tenny f8ae3b79 condition 2.
test("upgrade drain: a re-established Server connection ends a drain still holding, which is not begun again", () => {
  const t = setup();
  try {
    t.writeRequest();
    t.channel.tick();
    t.channel.onConnected();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"]);
    assert.equal(t.channel.activeRequestId, null);
    assert.equal(t.state().finished, "ended", "the service stops waiting for this runner");
    assert.deepEqual(t.events.at(-1), { name: "daemon.computer_upgrade.drain.released", attrs: { request_id: "req-1", reason: "reconnected" } });
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"], "the request file is still there, the drain stays ended");
    t.channel.onConnected();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"], "no drain: a connect does nothing");
  } finally {
    t.cleanup();
  }
});

test("upgrade drain: hosts that let go at their hold cap are not drained again for the same request", () => {
  const t = setup();
  try {
    t.writeRequest();
    t.channel.tick();
    t.fake.expire();
    t.channel.tick();
    assert.deepEqual(t.events.at(-1), { name: "daemon.computer_upgrade.drain.released", attrs: { request_id: "req-1", reason: "expired" } });
    t.channel.tick();
    assert.deepEqual(t.fake.calls, ["begin:60000", "end"]);
  } finally {
    t.cleanup();
  }
});

test("upgrade drain: no frame while disconnected; the state file is still written", () => {
  const t = setup({ connected: false });
  try {
    t.writeRequest();
    t.channel.tick();
    assert.deepEqual(t.sent, []);
    assert.equal(t.state().live, 1);
  } finally {
    t.cleanup();
  }
});
