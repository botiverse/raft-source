import assert from "node:assert/strict";
import { test } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { channelHumans, channels, featureFlags, messages, servers } from "../db/schema.js";
import { createChannel, updateChannel } from "../services/channelService.js";
import { createServer, seedUser, headers } from "./channels.api.fixtures.js";
import { tokenForHuman } from "../test/integration/credentials.js";
import { addMember } from "../services/serverService.js";
import { createMessage } from "../services/messageService.js";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

async function enablePublicServerFeature() {
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
}

/**
 * Task #70, hard requirement 2 (@cindyz): turning `public` off must refuse the
 * same reader's next request, not just prevent a new anonymous session/token.
 *
 * The dangerous way to pass this is a test that only ever issues fresh requests
 * after the flip using a new app — that would stay green even if the running
 * process cached the decision. So this drives the SAME endpoint on the SAME
 * running app before and after, with nothing in between but the column change.
 */
test("public server: a logged-out reader loses access the moment the toggle goes off", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-server-owner@slock.test", "public-server-owner");
    const server = await createServer("Public Server", "public-server-70", owner.id);

    const open = await createChannel(server.id, "open-channel", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // No Authorization header anywhere in this test. That is the point.
    const listUrl = `${app.baseUrl}/api/public/servers/public-server-70`;
    const msgsUrl = `${app.baseUrl}/api/public/servers/public-server-70/channels/${open.id}/messages`;

    const before = await fetch(listUrl);
    assert.equal(before.status, 200, await before.clone().text());
    assert.equal(before.headers.get("cache-control"), "no-store", "a browser or CDN must not carry a public decision past the next request");
    const body = await before.json() as { channels: { id: string }[] };
    assert.deepEqual(body.channels.map((c) => c.id), [open.id], "only the guest-visible ordinary channel is offered");

    const readBefore = await fetch(msgsUrl);
    assert.equal(readBefore.status, 200, "a stranger can read the guest-visible channel while public is on");
    assert.equal(readBefore.headers.get("cache-control"), "no-store");

    // The flip. Nothing else changes: same app, same process, same URLs.
    await db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));

    const afterList = await fetch(listUrl);
    assert.equal(afterList.status, 404, "the server card must disappear immediately");
    const afterRead = await fetch(msgsUrl);
    assert.equal(afterRead.status, 404, "the same reader's next page request must fail without waiting for cache expiry");
  } finally {
    await app.close();
  }
});

test("public server: rollout flag defaults closed at owner and anonymous boundaries", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const owner = await seedUser("public-gate-owner@slock.test", "public-gate-owner");
    const server = await createServer("Gated", "public-gated-70", owner.id);
    const channel = await createChannel(server.id, "would-be-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const ownerToken = await tokenForHuman(owner.email);
    const ownerUrl = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    const ownerRead = await fetch(ownerUrl, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 404, "the owner read must fail closed while rollout is off");
    const ownerWrite = await fetch(ownerUrl, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: false }),
    });
    assert.equal(ownerWrite.status, 404, "the owner write must fail closed while rollout is off");

    const publicList = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70`);
    const publicRead = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70/channels/${channel.id}/messages`);
    const missing = await fetch(`${app.baseUrl}/api/public/servers/does-not-exist-70`);
    assert.equal(publicList.status, 404);
    assert.equal(publicRead.status, 404);
    assert.equal(await publicList.text(), await missing.text(), "flag-off and nonexistent slugs must have byte-identical bodies");

    const [unchanged] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(unchanged.v, true, "a refused owner PATCH must leave the stored setting untouched");
  } finally {
    await app.close();
  }
});

/**
 * The surface must be exactly "ordinary channels the owner marked guest-visible".
 * `guestVisible` alone is not the predicate: it exists on other channel kinds too,
 * so the route requires type = "channel" explicitly. Each negative below is a
 * separate way the surface could widen without anyone intending it.
 */
test("public server: the anonymous surface is only guest-visible ordinary channels", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-surface-owner@slock.test", "public-surface-owner");
    const server = await createServer("Surface", "public-surface-70", owner.id);
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    const creator = { type: "user" as const, id: owner.id };
    const visible = await createChannel(server.id, "visible", undefined, "channel", creator);
    const notMarked = await createChannel(server.id, "not-marked", undefined, "channel", creator);
    const privateMarked = await createChannel(server.id, "private-marked", undefined, "private", creator);
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, visible.id));
    // A private channel that is ALSO marked guest-visible: the trap this predicate exists for.
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, privateMarked.id));

    const listed = await (await fetch(`${app.baseUrl}/api/public/servers/public-surface-70`)).json() as { channels: { id: string }[] };
    assert.deepEqual(listed.channels.map((c) => c.id), [visible.id], "a guest-visible PRIVATE channel must not be listed");

    for (const [label, id] of [["unmarked ordinary", notMarked.id], ["guest-visible private", privateMarked.id]] as const) {
      const res = await fetch(`${app.baseUrl}/api/public/servers/public-surface-70/channels/${id}/messages`);
      assert.equal(res.status, 404, `${label} channel must not be readable anonymously`);
    }

    // A non-public server is indistinguishable from one that does not exist,
    // so this endpoint cannot be used to enumerate slugs.
    const other = await createServer("Private Server", "private-server-70", owner.id);
    assert.ok(other.id);
    const probe = await fetch(`${app.baseUrl}/api/public/servers/private-server-70`);
    assert.equal(probe.status, 404, "a non-public server must 404, not 403");

    const [stillPrivate] = await db.select({ v: servers.publiclyVisible }).from(servers)
      .where(and(eq(servers.slug, "private-server-70")));
    assert.equal(stillPrivate.v, false, "probing must not have changed anything");
  } finally {
    await app.close();
  }
});

test("public server: making an ordinary channel private clears both Guest audience flags", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedUser("public-private-policy-owner@slock.test", "public-private-policy-owner");
    const server = await createServer("Policy", "public-private-policy-70", owner.id);
    const channel = await createChannel(server.id, "before-private", undefined, "channel", { type: "user", id: owner.id });

    await updateChannel(channel.id, { guestVisible: true, guestJoinable: true });
    const updated = await updateChannel(channel.id, { type: "private" });

    assert.equal(updated.type, "private");
    assert.equal(updated.guestVisible, false, "a private channel must not retain the anonymous audience marker");
    assert.equal(updated.guestJoinable, false, "a private channel must not retain Guest join authority");
  } finally {
    await app.close();
  }
});

test("public server: anonymous message history is a narrow public projection", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-projection-owner@slock.test", "public-projection-owner");
    const server = await createServer("Projection", "public-projection-70", owner.id);
    const channel = await createChannel(server.id, "public-projection", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const message = await createMessage(channel.id, "user", owner.id, "Public words only");
    await db.update(messages).set({
      actionMetadata: { kind: "action-card", secretControlPlaneFact: "must-not-leak" },
      taskStatus: "in_progress",
      taskAssigneeId: owner.id,
      taskAssigneeType: "user",
    }).where(eq(messages.id, message.id));

    const response = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`);
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: Array<Record<string, unknown>> };
    assert.equal(body.messages.length, 1);
    assert.deepEqual(Object.keys(body.messages[0]!).sort(), [
      "content", "createdAt", "id", "messageType", "senderName", "senderType",
    ]);
    assert.equal(body.messages[0]!.content, "Public words only");
    assert.equal(body.messages[0]!.senderName, owner.displayName || owner.name);
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(body).includes(owner.id), false, "anonymous DTO must not expose actor ids");

    const second = await createMessage(channel.id, "user", owner.id, "Second public message");
    const older = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${second.id}`);
    assert.equal(older.status, 200);
    const olderBody = await older.json() as { messages: Array<{ id: string }> };
    assert.deepEqual(olderBody.messages.map((row) => row.id), [message.id], "message-id cursor pages only within its channel");

    const other = await createChannel(server.id, "other-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, other.id));
    const otherMessage = await createMessage(other.id, "user", owner.id, "Other channel");
    const crossed = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${otherMessage.id}`);
    assert.equal(crossed.status, 404, "a cursor from another channel must not become an oracle or pagination boundary");
  } finally {
    await app.close();
  }
});

/**
 * The toggle is OWNER-only, and that is the whole reason it is its own endpoint.
 *
 * The obvious implementation — a field on `PATCH /servers/:id` — is gated on
 * `editServerSettings`, which ADMINS also hold. Folding it in would have handed
 * "make this server readable by the entire internet" to every admin, and nothing
 * in that route would have looked wrong. This test is the thing that would go red.
 */
test("public server: only the owner can flip the toggle, not an admin", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-owner@slock.test", "pv-owner");
    const admin = await seedUser("pv-admin@slock.test", "pv-admin");
    const server = await createServer("Toggle", "public-toggle-70", owner.id);
    await addMember(server.id, admin.id, "admin");
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);

    const open = await createChannel(server.id, "open", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));

    const url = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    // The admin holds editServerSettings and is still refused, on both verbs.
    const adminRead = await fetch(url, { headers: headers(adminToken, server.id) });
    assert.equal(adminRead.status, 403, "an admin must not even read the public-visibility state");
    const adminWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(adminWrite.status, 403, "an admin must not be able to publish the server");

    const [untouched] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(untouched.v, false, "the refused admin write must not have changed anything");

    // The owner can, and the read tells the UI exactly what becomes world-readable.
    const ownerRead = await fetch(url, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 200, await ownerRead.clone().text());
    const state = await ownerRead.json() as { publiclyVisible: boolean; exposedChannels: { id: string }[] };
    assert.equal(state.publiclyVisible, false);
    assert.deepEqual(state.exposedChannels.map((c) => c.id), [open.id],
      "the owner is shown the exact channel list that becomes world-readable");

    const ownerWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(ownerWrite.status, 200, await ownerWrite.clone().text());

    // And the toggle is wired to the same column the anonymous route reads —
    // proving the owner-facing control and the public surface cannot drift apart.
    const anon = await fetch(`${app.baseUrl}/api/public/servers/public-toggle-70`);
    assert.equal(anon.status, 200, "flipping the owner toggle must open the anonymous surface");
  } finally {
    await app.close();
  }
});

/**
 * Acceptance A5 — a logged-out visitor has NO write path, anywhere.
 *
 * The weak version of this test pokes the public router with a POST and finds a
 * 404. That is trivially true (no such route is registered) and could never have
 * gone red, so it certifies nothing. The property worth pinning is broader: with
 * the server public and a channel world-readable, an anonymous caller must not be
 * able to write through ANY route — and the check is the absence of the side
 * effect, not the status code, because a 401 returned after a row was inserted
 * would look identical from outside.
 */
test("public server: a logged-out visitor has no write path and leaves no state behind", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-write-owner@slock.test", "pv-write-owner");
    const server = await createServer("NoWrite", "public-nowrite-70", owner.id);
    const open = await createChannel(server.id, "readable", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // Confirm the reader really is inside the public surface first — otherwise
    // every refusal below could be "not public" rather than "not writable",
    // and the test would pass for the wrong reason.
    const readable = await fetch(`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`);
    assert.equal(readable.status, 200, "precondition: the anonymous reader can read this channel");

    const before = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));

    const attempts: [string, RequestInit][] = [
      // The real send path, with no credentials.
      [`${app.baseUrl}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: open.id, content: "anonymous write" }) }],
      // The public router itself must expose no write verb.
      [`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "anonymous write" }) }],
      // Nor a way to join, which would convert a reader into a member.
      [`${app.baseUrl}/api/channels/${open.id}/join`, { method: "POST" }],
    ];
    for (const [url, init] of attempts) {
      const res = await fetch(url, init);
      assert.ok(res.status >= 400, `anonymous write must be refused: ${init.method} ${url} returned ${res.status}`);
    }

    const after = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));
    assert.equal(after.length, before.length, "no anonymous attempt may leave a message behind");

    const memberRows = await db.select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, open.id));
    assert.deepEqual(memberRows.map((r) => r.userId), [owner.id], "no anonymous attempt may create a membership row");
  } finally {
    await app.close();
  }
});
