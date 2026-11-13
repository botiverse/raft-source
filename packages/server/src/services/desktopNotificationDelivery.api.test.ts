import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DESKTOP_NOTIFICATION_EVENT, parseDesktopNotificationV1, type DesktopNotificationV1 } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { headers, seedThreadFixture } from "../routes/channels.api.fixtures";

// `desktop_notification_push_v0` is retired: with no flag row at all, a real
// message reaches EVERY desktop socket of each recipient over a real
// connection, and no browser socket. The sender's own desktop gets nothing.

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type ClientSocket = {
  connect(): void;
  close(): void;
  on(event: string, handler: (value: unknown) => void): void;
  once(event: string, handler: (value: unknown) => void): void;
};

function connect(baseUrl: string, token: string, serverId: string, clientKind: "desktop" | "web") {
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

async function until(check: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

test("with no flag, a channel message and a thread reply reach every desktop socket of each recipient and no browser", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerDesktopA = connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  const ownerDesktopB = connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  const ownerBrowser = connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  const followerDesktop = connect(app.baseUrl, f.followerToken, f.serverId, "desktop");
  const senderDesktop = connect(app.baseUrl, f.memberBToken, f.serverId, "desktop");
  const all = [ownerDesktopA, ownerDesktopB, ownerBrowser, followerDesktop, senderDesktop];
  try {
    await Promise.all(all.map((client) => client.ready));

    const channelSend = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(f.memberBToken, f.serverId),
      body: JSON.stringify({ channelId: f.parentChannelId, content: "deploy is green" }),
    });
    assert.equal(channelSend.status, 200);
    const channelMessage = await channelSend.json() as { id: string };

    const threadSend = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(f.memberBToken, f.serverId),
      body: JSON.stringify({ channelId: f.threadId, content: "reply in the thread" }),
    });
    assert.equal(threadSend.status, 200);
    const threadMessage = await threadSend.json() as { id: string };

    await until(() => ownerDesktopA.received.length >= 2 && ownerDesktopB.received.length >= 2 && followerDesktop.received.length >= 1);
    // Give anything that should not arrive the same chance to land.
    await new Promise((r) => setTimeout(r, 150));

    for (const desktop of [ownerDesktopA, ownerDesktopB]) {
      assert.deepEqual(
        desktop.received.map((n) => [n.id, n.kind, n.serverId]),
        [
          [`message:${channelMessage.id}`, "channel", f.serverId],
          [`message:${threadMessage.id}`, "thread", f.serverId],
        ],
        "both of the owner's desktop sockets get both events",
      );
    }
    assert.deepEqual(followerDesktop.received.map((n) => n.id), [`message:${threadMessage.id}`], "a thread follower outside the channel gets the reply only");
    assert.deepEqual(ownerBrowser.received, [], "a browser socket never receives notification:desktop");
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
    const send = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(f.memberBToken, f.serverId),
      body: JSON.stringify({
        channelId: f.threadId,
        content: "@owner can you look",
        mentions: [{ type: "user", id: f.ownerId, name: "owner" }],
      }),
    });
    assert.equal(send.status, 200);
    await until(() => ownerDesktop.received.length >= 1 && followerDesktop.received.length >= 1);
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
