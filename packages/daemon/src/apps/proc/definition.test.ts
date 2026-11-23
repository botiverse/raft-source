// The `system.proc` memory-limit notice (#proj-raft-computer:#114). RED proof
// (reverse-verified): put the cap sentence back in the summary and the
// preview bound refuses the mint.
import assert from "node:assert/strict";
import { AGENT_INBOX_PREVIEW_MAX_CHARS, type AgentInboxAppItem } from "@botiverse/raft-shared";
import { createAgentAppInboxStore } from "../../agentAppInbox";
import { notifyProcMemoryLimit, notifyProcOwnerStop, PROC_AGENT_INBOX_REGISTRY, PROC_APP_ID, procMemoryLimitNotice, procOwnerStopNotice } from "./definition";

const GB = 1024 * 1024 * 1024;

test("one item per job, read with raft proc logs <name>; a later stop of the same job updates it; never starts a stopped agent or interrupts a turn", async () => {
  const store = createAgentAppInboxStore({ registry: PROC_AGENT_INBOX_REGISTRY });
  const notices: Array<{ item: AgentInboxAppItem; notice: unknown }> = [];
  const deps = { getInbox: () => store, notifyInbox: async (_agentId: string, item: AgentInboxAppItem, notice?: unknown) => { notices.push({ item, notice }); return true; } };
  assert.equal(await notifyProcMemoryLimit(deps, { agentId: "a1", name: "web", memoryMaxBytes: 4 * GB }), true);
  assert.equal(await notifyProcMemoryLimit(deps, { agentId: "a1", name: "web", memoryMaxBytes: 4 * GB }), true);
  const [item] = store.list();
  assert.equal(store.list().length, 1);
  assert.equal(item?.appId, PROC_APP_ID);
  assert.equal(item?.actionCli, "raft proc logs web");
  assert.equal(item?.title, "web exited: memory_limit (4 GB); it is not restarted");
  assert.deepEqual(notices[0]?.notice, { startStoppedAgent: false, requireIdle: true });
  await notifyProcMemoryLimit(deps, { agentId: "a1", name: "bot", memoryMaxBytes: 512 * 1024 * 1024 });
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find((entry) => entry.sourceRef.id === "bot")?.title, "bot exited: memory_limit (512 MB); it is not restarted");
});

test("the notice fits the preview bound for the longest job name; a name that isn't one is refused", async () => {
  const longest = procMemoryLimitNotice("x".repeat(40), 1.5 * GB);
  assert.ok(longest.title.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, longest.title);
  assert.ok(longest.summary.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, longest.summary);
  const store = createAgentAppInboxStore({ registry: PROC_AGENT_INBOX_REGISTRY });
  const deps = { getInbox: () => store, notifyInbox: async () => true };
  assert.equal(await notifyProcMemoryLimit(deps, { agentId: "a1", name: "a b; rm", memoryMaxBytes: GB }), false);
  assert.deepEqual(store.list(), []);
});

test("a person's Stop from the Computer page: one item per job naming the stopper, read with raft proc logs <name>; never starts a stopped agent or interrupts a turn", async () => {
  const store = createAgentAppInboxStore({ registry: PROC_AGENT_INBOX_REGISTRY });
  const notices: unknown[] = [];
  const deps = { getInbox: () => store, notifyInbox: async (_agentId: string, _item: AgentInboxAppItem, notice?: unknown) => { notices.push(notice); return true; } };
  assert.equal(await notifyProcOwnerStop(deps, { agentId: "a1", name: "web", stoppedBy: "tygg" }), true);
  const [item] = store.list();
  assert.equal(item?.appId, PROC_APP_ID);
  assert.equal(item?.notificationClass, "owner_stop");
  assert.equal(item?.actionCli, "raft proc logs web");
  assert.equal(item?.title, "web exited: stopped by @tygg from the Computer page");
  assert.equal(item?.summary, "It is not restarted. Ask @tygg before you start it again.");
  assert.deepEqual(notices[0], { startStoppedAgent: false, requireIdle: true });
  assert.equal(procOwnerStopNotice("web", null).title, "web exited: stopped by a person from the Computer page");
  assert.equal(procOwnerStopNotice("web", null).summary, "A person stopped it; it is not restarted. Ask them before you start it again.");
});

test("the owner-stop notice fits the preview bound for the longest name and handle: the name is shortened, never the stopper", () => {
  const handle = "h".repeat(64);
  const longest = procOwnerStopNotice("x".repeat(40), handle);
  assert.ok(longest.title.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, longest.title);
  assert.ok(longest.summary.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, longest.summary);
  assert.ok(longest.summary.includes(`@${handle}`), "the summary names the longest handle whole");
  assert.ok(longest.summary.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, longest.summary);
  assert.ok(longest.summary.includes(`@${handle}`), "the summary names the longest handle whole");
  assert.ok(longest.title.includes(`@${handle} from the Computer page`), longest.title);
  assert.ok(longest.title.startsWith("x") && longest.title.includes("…"), longest.title);
  assert.ok(longest.summary.length <= AGENT_INBOX_PREVIEW_MAX_CHARS);
  // A short handle leaves the whole name.
  assert.equal(procOwnerStopNotice("x".repeat(40), "tygg").title, `${"x".repeat(40)} exited: stopped by @tygg from the Computer page`);
});
