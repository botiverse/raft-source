import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";

import * as channelService from "../services/channelService";
import { addHuman, archiveChannel, createChannel, unarchiveChannel } from "../services/channelService";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// Accepting a joint invite answers nothing that tells the accepter more than
// "this invite can't be accepted": a name an archived channel they can't see
// holds reads exactly as a live holder does (#proj-chat:#19), and every
// "not found" below the route (the invite, its joint, the projection) is the
// one invite-not-found answer.

const test = createApiTest();

type Answer = { status: number; text: string };

async function post(baseUrl: string, path: string, token: string, serverId: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${baseUrl}/api/channels${path}`, {
    method: "POST",
    headers: headers(token, serverId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

test("a name an archived channel holds: hidden reads as a live holder, visible names it, on accept and accept-many", async ({ app }) => {
  const hostOwner = await seedUser("joint-accept-name-host@slock.test", "joint-accept-name-host");
  const targetOwner = await seedUser("joint-accept-name-owner@slock.test", "joint-accept-name-owner");
  const targetAdmin = await seedUser("joint-accept-name-admin@slock.test", "joint-accept-name-admin");
  const hostServer = await createServer("Joint Accept Name Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Accept Name Target", "joint-accept-name-target", targetOwner.id);
  await addMember(targetServer.id, targetAdmin.id, "admin");

  // Private and archived, only the target owner in it: the accepting admin can't see it.
  const holder = await createChannel(targetServer.id, "shared-room", undefined, "private");
  await addHuman(holder.id, targetOwner.id);
  await archiveChannel(holder.id, targetOwner.id);

  const hostToken = await tokenForHuman(hostOwner.email);
  const adminToken = await tokenForHuman(targetAdmin.email);
  const created = await post(app.baseUrl, "", hostToken, hostServer.id, {
    name: "shared-room",
    visibility: "joint",
    targetServerSlug: targetServer.slug,
    invitedPeople: [`@${targetAdmin.name}`],
  });
  assert.equal(created.status, 200, created.text);
  const inviteId = (JSON.parse(created.text) as { jointInvite: { id: string } }).jointInvite.id;

  // A failed accept rolls back, so the same invite is tried against each holder.
  const accept = () => post(app.baseUrl, `/joint-invites/${inviteId}/accept`, adminToken, targetServer.id);
  const acceptMany = () => post(app.baseUrl, "/joint-invites/accept-many", adminToken, targetServer.id, { inviteIds: [inviteId] });

  const hidden = { one: await accept(), many: await acceptMany() };

  await addHuman(holder.id, targetAdmin.id);
  const visible = { one: await accept(), many: await acceptMany() };

  await unarchiveChannel(holder.id);
  const live = { one: await accept(), many: await acceptMany() };

  for (const route of ["one", "many"] as const) {
    assert.equal(live[route].status, 409, `${route}: ${live[route].text}`);
    assert.deepEqual(JSON.parse(live[route].text), { error: 'Channel name "shared-room" is already taken' }, route);
    assert.deepEqual(hidden[route], live[route], `${route}: the hidden archived holder must read byte for byte as a live one`);

    assert.equal(visible[route].status, 409, `${route}: ${visible[route].text}`);
    const named = JSON.parse(visible[route].text) as Record<string, unknown>;
    assert.equal(named.code, "archived_name_collision", route);
    assert.equal(named.archivedChannelId, holder.id, route);
    assert.equal(named.archivedChannelName, "shared-room", route);
  }
});

test("every not-found below accept and accept-many is the one invite-not-found answer", async ({ app }) => {
  const owner = await seedUser("joint-accept-missing@slock.test", "joint-accept-missing");
  const server = await createServer("Joint Accept Missing", "joint-accept-missing", owner.id);
  const token = await tokenForHuman(owner.email);
  const accept = () => post(app.baseUrl, `/joint-invites/${randomUUID()}/accept`, token, server.id);
  const acceptMany = () => post(app.baseUrl, "/joint-invites/accept-many", token, server.id, { inviteIds: [randomUUID()] });

  // No such invite, for real.
  const reference = await accept();
  assert.equal(reference.status, 404, reference.text);
  assert.equal(JSON.parse(reference.text).code, "joint_invite_not_found");
  assert.deepEqual(await acceptMany(), reference);

  for (const message of ["Joint channel invite not found", "Joint channel not found", "Joint channel projection not found"]) {
    vi.spyOn(channelService, "acceptJointChannelInvite").mockRejectedValueOnce(new Error(message));
    assert.deepEqual(await accept(), reference, `accept on "${message}"`);
    vi.spyOn(channelService, "acceptJointChannelInvites").mockRejectedValueOnce(new Error(message));
    assert.deepEqual(await acceptMany(), reference, `accept-many on "${message}"`);
  }
  vi.restoreAllMocks();
});
