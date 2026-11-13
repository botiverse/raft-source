import assert from "node:assert/strict";
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import type { Server as SocketServer } from "socket.io";
import {
  jointChannelAdmissions,
  jointMembershipDepartures,
  jointMembershipRemovals,
} from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  addHuman,
  addAgent,
} from "../services/channelService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addMember } from "../services/serverService";
import {
  configureJointDepartureEffects,
  cleanJointMembershipDepartureBatch,
  type JointDepartureEffects,
  type JointMembershipDepartureId,
} from "../services/jointMembershipDeparture";
import { createSeed } from "./integration/seed";
import { createHttpClient } from "./integration/http";
import { accessTokenForTest } from "./integration/credentials";

async function socket(
  baseUrl: string,
  userId: string,
  serverId: string,
): Promise<WebSocket> {
  const token = await accessTokenForTest(userId);
  const ws = new WebSocket(
    `${baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("joint socket rooms not acknowledged")),
        5000,
      );
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("message", (data) => {
        const packet = data.toString();
        if (packet.startsWith("0"))
          ws.send(
            `40${JSON.stringify({ token, serverId })}`,
          );
        if (packet.includes('"rooms:joined"')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}
const json = (body: object) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export async function jointHumanHttpScenario({
  db,
  seed,
  baseUrl,
  io,
  departureEffects,
  socketReplica,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
  baseUrl: string;
  io: SocketServer;
  departureEffects?: JointDepartureEffects;
  socketReplica?: {
    baseUrl: string;
    roomSize: (room: string) => Promise<number>;
  };
}) {
  const host = await seed.human(),
    peerAdmin = await seed.human(),
    person = await seed.human(),
    bIntroduced = await seed.human(),
    external = await seed.human();
  const h = await seed.server({
      owner: host,
      members: [person, bIntroduced, external],
    }),
    b = await seed.server({ owner: peerAdmin, members: [person, bIntroduced] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: host.id,
    name: "http-joint-membership",
    targetServerSlug: b.slug,
    invitedPeople: [`@${peerAdmin.name}`],
    userIds: [person.id, external.id],
  });
  const local = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: peerAdmin.id,
  });
  await db
    .delete(jointChannelAdmissions)
    .where(
      and(
        eq(jointChannelAdmissions.jointChannelId, created.jointChannel.id),
        eq(jointChannelAdmissions.userId, external.id),
      ),
    );
  const http = createHttpClient(baseUrl),
    hClient = http.as(host, h),
    bClient = http.as(peerAdmin, b),
    personClient = http.as(person, b);
  const channels = await personClient.get("/api/channels");
  assert.equal(channels.status, 200, await channels.clone().text());
  const listed = await channels.json();
  assert.ok(
    (Array.isArray(listed) ? listed : listed.channels).some(
      (row: { id: string }) => row.id === local.id,
    ),
  );
  const post = await personClient.request(
    "/api/messages",
    json({ channelId: local.id, content: "computed B entry posts without CH" }),
  );
  assert.equal(post.status, 200, await post.clone().text());
  const profile = await bClient.get(
    `/api/servers/${b.id}/members/${external.id}/profile`,
  );
  assert.equal(profile.status, 200, await profile.clone().text());
  const publicProfile = await profile.json();
  assert.equal(publicProfile.userId, external.id);
  assert.equal(publicProfile.serverId, "");
  assert.equal(publicProfile.email, null);
  assert.equal(publicProfile.role, null);
  const actors = await bClient.request(
    "/api/actors/resolve",
    json({ actors: [{ kind: "human", id: external.id }] }),
  );
  assert.equal(actors.status, 200);
  assert.equal((await actors.json()).actors[0]?.homeServerId, "");
  const rejected = await bClient.request(
    `/api/channels/${local.id}/members/user/${person.id}`,
    { method: "DELETE" },
  );
  assert.equal(rejected.status, 403, await rejected.clone().text());
  await addHuman(local.id, bIntroduced.id);
  const removedB = await bClient.request(
    `/api/channels/${local.id}/members/user/${bIntroduced.id}`,
    { method: "DELETE" },
  );
  assert.equal(removedB.status, 403, await removedB.clone().text());
  const removedByHost = await hClient.request(
    `/api/channels/${created.channel.id}/members/user/${bIntroduced.id}`,
    { method: "DELETE" },
  );
  assert.equal(removedByHost.status, 200, await removedByHost.clone().text());
  const participant = await createAgent(b.id, "joint-http-participant", {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(local.id, participant.id);
  const { apiKey } = await mintAgentCredential({
    agentId: participant.id,
    scopes: ["read", "send", "tasks", "channels"],
    name: "disposable-joint-check",
    issuedVia: "computer",
    createdByUserId: null,
  });
  const agentRequest = (path: string, body?: object) =>
    fetch(`${baseUrl}/internal/agent-api${path}`, {
      ...(body ? json(body) : {}),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
  const jointRef = `#${local.name}`;
  const agentCalls = () => [
    agentRequest(
      `/history?channel=${encodeURIComponent(jointRef)}&consume=false`,
    ),
    agentRequest(`/channel-members?channel=${encodeURIComponent(jointRef)}`),
    agentRequest("/send", {
      target: jointRef,
      content: "agent credential before disconnect",
    }),
    agentRequest("/tasks", {
      channel: jointRef,
      tasks: [{ title: "agent credential before disconnect" }],
    }),
  ];
  for (const pending of agentCalls()) {
    const response = await pending;
    assert.equal(response.status, 200, await response.clone().text());
  }
  for (const path of [
    `/api/messages/channel/${local.id}`,
    `/api/channels/${local.id}`,
  ]) {
    const response = await personClient.get(path);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const socketUrl = socketReplica?.baseUrl ?? baseUrl;
  const roomSize = (room: string) =>
    socketReplica
      ? socketReplica.roomSize(room)
      : Promise.resolve(io.of("/").adapter.rooms.get(room)?.size ?? 0);
  const ws = await socket(socketUrl, person.id, b.id);
  let second: WebSocket | undefined;
  try {
    assert.equal(
      await roomSize(`channel:${local.id}`),
      1,
      "B subscriber has no local CH yet joins the authorized room",
    );
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("revoked joint socket stayed open")),
        5000,
      );
      ws.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const removed = await hClient.request(
      `/api/channels/${created.channel.id}/members/user/${person.id}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 200, await removed.clone().text());
    await closed;
    const denied = await personClient.request(
      "/api/messages",
      json({ channelId: local.id, content: "must be denied" }),
    );
    assert.ok([403, 404].includes(denied.status), await denied.clone().text());
    const hidden = await personClient.get(
      `/api/servers/${b.id}/members/${external.id}/profile`,
    );
    assert.equal(hidden.status, 404);
    const invisible = await personClient.request(
      "/api/actors/resolve",
      json({ actors: [{ kind: "human", id: external.id }] }),
    );
    assert.equal(invisible.status, 200);
    assert.deepEqual((await invisible.json()).actors, []);
    second = await socket(socketUrl, person.id, b.id);
    assert.equal(
      await roomSize(`channel:${local.id}`),
      0,
      "reconnect cannot recover a removed J room",
    );
  } finally {
    ws.terminate();
    second?.terminate();
  }
  if (departureEffects) {
    await addMember(b.id, host.id);
    const hSocket = await socket(socketUrl, host.id, h.id),
      bSocket = await socket(socketUrl, host.id, b.id);
    let hReconnect: WebSocket | undefined, bReconnect: WebSocket | undefined;
    try {
      configureJointDepartureEffects({
        revoke: async (batch, lease) => {
          await departureEffects.revoke(batch, lease);
          throw new Error("injected external confirmation failure");
        },
      });
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("B entry transport stayed open")),
          5000,
        );
        bSocket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const disconnected = await bClient.request(
        `/api/channels/${local.id}/disconnect`,
        { method: "POST" },
      );
      assert.equal(disconnected.status, 200, await disconnected.clone().text());
      await closed;
      const [departure] = await db
        .select()
        .from(jointMembershipDepartures)
        .where(eq(jointMembershipDepartures.localChannelId, local.id));
      assert.ok(departure);
      assert.equal(departure.completedAt, null);
      const entryOnly = await db
        .select()
        .from(jointMembershipRemovals)
        .where(
          and(
            eq(jointMembershipRemovals.departureId, departure.id),
            eq(jointMembershipRemovals.userId, host.id),
          ),
        );
      assert.equal(entryOnly[0]?.removeMembership, false);
      assert.equal(
        hSocket.readyState,
        WebSocket.OPEN,
        "entry-only withdrawal must not close H transport",
      );
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("H missed message while B cleanup pending")),
          5000,
        );
        hSocket.on("message", (data) => {
          if (data.toString().includes("H live while B cleanup pending")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const sent = await hClient.request(
        "/api/messages",
        json({
          channelId: created.channel.id,
          content: "H live while B cleanup pending",
        }),
      );
      assert.equal(sent.status, 200, await sent.clone().text());
      await received;
      hReconnect = await socket(socketUrl, host.id, h.id);
      assert.equal(
        await roomSize(`channel:${created.channel.id}`),
        2,
        "H reconnect works while B header is incomplete",
      );
      bReconnect = await socket(socketUrl, host.id, b.id);
      assert.equal(
        await roomSize(`channel:${local.id}`),
        0,
        "late B handshake cannot join disconnected entry",
      );
      const denied = await http
        .as(host, b)
        .request(
          "/api/messages",
          json({ channelId: local.id, content: "late B is denied" }),
        );
      assert.ok(
        [403, 404].includes(denied.status),
        await denied.clone().text(),
      );
      for (const pending of agentCalls()) {
        const response = await pending;
        assert.ok(
          [403, 404].includes(response.status),
          await response.clone().text(),
        );
      }
      const stillAuthorized = await agentRequest(
        "/history?channel=%23all&consume=false",
      );
      assert.equal(
        stillAuthorized.status,
        200,
        "revocation must preserve unrelated server channel access",
      );
      assert.equal(
        await cleanJointMembershipDepartureBatch(
          departure.id as JointMembershipDepartureId,
          departureEffects,
        ),
        true,
      );
    } finally {
      configureJointDepartureEffects(null);
      hSocket.terminate();
      bSocket.terminate();
      hReconnect?.terminate();
      bReconnect?.terminate();
    }
  }
}
