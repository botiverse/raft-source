// Desktop delivery over REAL socket.io connections (the unified successor of
// desktopNotificationDelivery.api.test.ts and desktopNotificationFanout.socket.test.ts):
// the app's own socket server (setupSocket registers it with the dispatcher)
// and the default post-commit drain. Every desktop socket of a recipient
// gets `notification:desktop`; browser and phone sockets never do; the
// sender's own desktop gets nothing. Every payload passes the shared closed
// validator.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DESKTOP_NOTIFICATION_EVENT, parseDesktopNotificationV1, type DesktopNotificationV1 } from "@botiverse/raft-shared";
import { createApiTest } from "../../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../../test/integration/taskV2Flag";
import { headers, seedThreadFixture } from "../../routes/channels.api.fixtures";
import { getDb } from "../../db/index";
import { reminders } from "../../db/schema";
import { createAgent } from "../agentService";
import * as taskService from "../taskService";
import { ensureTaskConversation } from "../taskConversationService";
import { postAgentActionRequiredNotice } from "../agentActionRequiredNoticeService";
import { notifyReminderFired } from "../../apps/reminder/firedNotification";
import { drainNotificationTasksForTests } from "./dispatcher";

const requireWeb = createRequire(new URL("../../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type ClientSocket = {
  connect(): void;
  close(): void;
  on(event: string, handler: (value: unknown) => void): void;
  once(event: string, handler: (value: unknown) => void): void;
};

function connect(baseUrl: string, token: string, serverId: string, clientKind: "desktop" | "web" | "mobile") {
  const socket: ClientSocket = clientIo(baseUrl, { auth: { token, serverId, clientKind }, transports: ["websocket"], autoConnect: false });
  const received: DesktopNotificationV1[] = [];
  socket.on(DESKTOP_NOTIFICATION_EVENT, (value) => {
    const parsed = parseDesktopNotificationV1(value);
    assert.ok(parsed, "every payload passes the shared closed validator");
    received.push(parsed);
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no rooms:joined")), 4_000);
    socket.once("rooms:joined", () => { clearTimeout(timer); resolve(); });
  });
  socket.connect();
  return { socket, received, ready };
}

async function until(check: () => boolean, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

async function post(baseUrl: string, token: string, serverId: string, path: string, body: unknown, method = "POST") {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: headers(token, serverId), body: JSON.stringify(body) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json() as Promise<Record<string, unknown>>;
}

test("a channel message and a thread reply reach every desktop socket of each recipient, no browser or phone, not the sender", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerDesktopA = connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  const ownerDesktopB = connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  const ownerBrowser = connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  const ownerPhone = connect(app.baseUrl, f.ownerToken, f.serverId, "mobile");
  const followerDesktop = connect(app.baseUrl, f.followerToken, f.serverId, "desktop");
  const senderDesktop = connect(app.baseUrl, f.memberBToken, f.serverId, "desktop");
  const all = [ownerDesktopA, ownerDesktopB, ownerBrowser, ownerPhone, followerDesktop, senderDesktop];
  try {
    await Promise.all(all.map((client) => client.ready));
    const channelMessage = await post(app.baseUrl, f.memberBToken, f.serverId, "/api/messages", { channelId: f.parentChannelId, content: "deploy is green" });
    const threadMessage = await post(app.baseUrl, f.memberBToken, f.serverId, "/api/messages", { channelId: f.threadId, content: "reply in the thread" });

    await until(() => ownerDesktopA.received.length >= 2 && ownerDesktopB.received.length >= 2 && followerDesktop.received.length >= 1);
    await drainNotificationTasksForTests();
    // Give anything that should not arrive the same chance to land.
    await new Promise((r) => setTimeout(r, 150));

    for (const desktop of [ownerDesktopA, ownerDesktopB]) {
      assert.deepEqual(
        desktop.received.map((n) => [n.id, n.kind, n.serverId]).sort(),
        [
          [`message:${channelMessage.id as string}`, "channel", f.serverId],
          [`message:${threadMessage.id as string}`, "thread", f.serverId],
        ].sort(),
        "both of the owner's desktop sockets get both events",
      );
    }
    assert.deepEqual(followerDesktop.received.map((n) => n.id), [`message:${threadMessage.id as string}`], "a thread follower outside the channel gets the reply only");
    assert.deepEqual(ownerBrowser.received, [], "a browser socket never receives notification:desktop");
    assert.deepEqual(ownerPhone.received, [], "a phone socket never receives notification:desktop");
    assert.deepEqual(senderDesktop.received, [], "the sender's own messages raise nothing");
  } finally {
    for (const client of all) client.socket.close();
  }
});

test("a thread reply that @mentions a follower reads as a mention on their desktop; another follower's reads as a reply", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerDesktop = connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  const followerDesktop = connect(app.baseUrl, f.followerToken, f.serverId, "desktop");
  try {
    await Promise.all([ownerDesktop.ready, followerDesktop.ready]);
    await post(app.baseUrl, f.memberBToken, f.serverId, "/api/messages", {
      channelId: f.threadId,
      content: "@owner can you look",
      mentions: [{ type: "user", id: f.ownerId, name: "owner" }],
    });
    await until(() => ownerDesktop.received.length >= 1 && followerDesktop.received.length >= 1);
    await drainNotificationTasksForTests();
    const [forOwner] = ownerDesktop.received;
    assert.equal(forOwner?.kind, "mention");
    assert.equal(forOwner?.mentioned, true);
    assert.equal(forOwner?.title, "Thread in #parent-room");
    // `Sender: text`: a mention no longer prefixes "mentioned you" (kind / mentioned carry it).
    assert.match(forOwner?.body ?? "", /^[^:]+: @owner can you look$/);
    assert.doesNotMatch(forOwner?.body ?? "", /mentioned you/);
    const [forFollower] = followerDesktop.received;
    assert.equal(forFollower?.kind, "thread");
    assert.equal(forFollower?.mentioned, false);
  } finally {
    ownerDesktop.socket.close();
    followerDesktop.socket.close();
  }
});

test("task, agent and reminder notifications reach every desktop socket of the recipient and no other socket", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await enableTaskV2ConversationsForServer(f.serverId);
  const { tasks: [task] } = await taskService.createTasks(f.parentChannelId, "user", f.ownerId, [{ title: "Fix login" }]);
  await ensureTaskConversation(task!.id);
  const agent = await createAgent(f.serverId, "ferris", { runtime: "claude", creatorType: "user", creatorId: f.ownerId });
  const [reminder] = await getDb().insert(reminders).values({
    serverId: f.serverId, ownerAgentId: agent.id, title: "Check the deploy", fireAt: new Date(), createdByType: "human", createdById: f.ownerId,
  }).returning();

  const desktops = [0, 1, 2].map(() => connect(app.baseUrl, f.ownerToken, f.serverId, "desktop"));
  const browser = connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  const phone = connect(app.baseUrl, f.ownerToken, f.serverId, "mobile");
  const otherDesktop = connect(app.baseUrl, f.outsiderToken, f.serverId, "desktop");
  const all = [...desktops, browser, phone, otherDesktop];
  try {
    await Promise.all(all.map((client) => client.ready));

    // The task creator hears that someone started it; the actor (member B) does not.
    await post(app.baseUrl, f.memberBToken, f.serverId, `/api/tasks/${task!.id}/status`, { status: "in_progress" }, "PATCH");
    await until(() => desktops.every((client) => client.received.some((n) => n.kind === "task")));
    assert.equal(await postAgentActionRequiredNotice(app.io as never, app.app.get("agentOrchestrator") as never, {
      agentId: agent.id,
      notice: { kind: "runtime_error", requiredAction: "user_model_access" },
    }), true);
    const firedAt = new Date().toISOString();
    await notifyReminderFired({ reminderId: reminder!.id, firedAt });

    await until(() => desktops.every((client) => client.received.length >= 3));
    await drainNotificationTasksForTests();
    await new Promise((r) => setTimeout(r, 150));
    const expectedReminderId = `reminder:${reminder!.id}:${firedAt}`;
    for (const client of desktops) {
      const kinds = client.received.map((n) => n.kind).sort();
      assert.deepEqual(kinds, ["agent", "reminder", "task"], JSON.stringify(client.received.map((n) => [n.kind, n.id])));
      assert.equal(client.received.find((n) => n.kind === "reminder")?.id, expectedReminderId);
      const taskNotification = client.received.find((n) => n.kind === "task")!;
      assert.equal(taskNotification.title, `#${task!.taskNumber} Fix login`);
      assert.equal(taskNotification.mentioned, false, "a task event is not a mention");
      assert.doesNotMatch(taskNotification.body, /mentioned you/);
      const agentNotification = client.received.find((n) => n.kind === "agent")!;
      assert.equal(agentNotification.mentioned, false);
      assert.doesNotMatch(agentNotification.body, /mentioned you/);
    }
    assert.deepEqual(browser.received, [], "browser sockets never get notification:desktop");
    assert.deepEqual(phone.received, [], "phone sockets never get notification:desktop");
    assert.deepEqual(otherDesktop.received, [], "another user's desktop gets nothing");
  } finally {
    for (const client of all) client.socket.close();
  }
});
