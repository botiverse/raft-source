import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { AGENT_GRANTABLE_SCOPES, userInfo } from "@botiverse/raft-shared";

import { updateAgentScopes } from "../services/agentScopesService";
import {
  agentApiClientFor,
  assertNoChannelsCapabilityParity,
  CALLER_CHANNEL_FIELDS,
  assertUserChannelsParity,
  seedUserChannelsScenario,
} from "./internalAgentApi.userChannels.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * GET /internal/agent-api/users/:name/channels — `raft user info` in one
 * request. Byte parity with the server.info + per-channel roster algorithm it
 * replaces but for its listed differences (the same scenario runs on real
 * PostgreSQL in internalAgentApi.userChannels.realPg.test.ts), and a gate at
 * least as strict as both routes it replaces. The differences:
 * - Q3: a joint channel's roster spans every server's projection and is
 *   matched by identity, not by name.
 * - Q1: a membership row is the channel plus the subject's membership (its own
 *   channel role where channel roles exist), none of the caller's fields.
 * - Q2: the caller's built-in app conversations are inspected and list no one,
 *   never skipped.
 */

function get(baseUrl: string, apiKey: string, path: string) {
  return fetch(`${baseUrl}/internal/agent-api${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

test("users.info over the new route equals server.info + one roster per channel but for Q3, Q1, Q2 (reduced matrix; the full one runs on real PostgreSQL)", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const visible = await assertUserChannelsParity(app.baseUrl, scenario, "visible directory", [
    { subjects: ["Scout", "alice"], windows: [{}, { offset: 5, limit: 4 }] },
    { subjects: ["ALICE", "nobody"], windows: [{}] },
  ]);
  assert.ok(visible.memberships >= 10, `memberships ${visible.memberships}`);
  assert.ok(visible.skipped > 0 && visible.notFound > 0);
  assert.equal(visible.jointNamesakeOnly.human, 0);
  assert.ok(visible.jointNamesakeOnly.agent > 0, JSON.stringify(visible.jointNamesakeOnly));
  assert.ok(visible.jointSelfMember.agent > 0 && visible.jointSelfMember.human > 0, JSON.stringify(visible.jointSelfMember));
  // Q1 and Q2 are exercised: every listed row lost the caller's fields, the
  // subjects' own roles (both kinds) are reported, and `#system.canary`
  // resolves the regular twin, whose roster listed Scout for the built-in
  // conversations too.
  assert.equal(visible.callerFieldRows, visible.memberships);
  assert.ok(visible.subjectRoles.admin > 0 && visible.subjectRoles.member > 0, JSON.stringify(visible.subjectRoles));
  assert.ok(visible.builtInListed > 0, `builtInListed ${visible.builtInListed}`);
  assert.equal(await assertNoChannelsCapabilityParity(app.baseUrl, scenario, "visible directory"), 3);

  // Without the regular twin, `#system.canary` resolves nothing: the old
  // algorithm skipped every built-in conversation.
  await scenario.removeAppTwin();
  const noTwin = await assertUserChannelsParity(app.baseUrl, scenario, "no app twin", [
    { subjects: ["Mem", "alice"], windows: [{}] },
  ]);
  assert.ok(noTwin.builtInSkipped > 0, `builtInSkipped ${noTwin.builtInSkipped}`);

  await scenario.setHumanDirectoryHidden(true);
  const hidden = await assertUserChannelsParity(app.baseUrl, scenario, "hidden directory", [
    { subjects: ["alice"], windows: [{}] },
  ]);
  assert.equal(hidden.notFound, 1);
});

test("users/:name/channels: the gate of both routes it replaces (channels + channel:read, read + server:read)", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const admin = scenario.callers[0];

  const noChannels = await get(app.baseUrl, scenario.noChannelsApiKey, "/users/Scout/channels");
  assert.equal(noChannels.status, 403);
  assert.deepEqual(await noChannels.json(), {
    error: "Agent credential is not authorized for this capability",
    code: "capability_not_authorized",
    requiredCapability: "channels",
  });

  const { mintAgentCredential } = await import("../services/agentCredentialService");
  const channelsOnly = (await mintAgentCredential({ agentId: admin.agentId, scopes: ["channels"], name: "channels-only", issuedVia: "computer", createdByUserId: null })).apiKey;
  const noRead = await get(app.baseUrl, channelsOnly, "/users/Scout/channels");
  assert.equal(noRead.status, 403);
  assert.equal(((await noRead.json()) as { requiredCapability?: string }).requiredCapability, "read");

  for (const missing of ["channel:read", "server:read"] as const) {
    await updateAgentScopes({ agentId: admin.agentId, scopes: AGENT_GRANTABLE_SCOPES.filter((scope) => scope !== missing), updatedByUserId: scenario.ownerUserId });
    const denied = await get(app.baseUrl, admin.apiKey, "/users/Scout/channels");
    assert.equal(denied.status, 403, missing);
    assert.deepEqual(await denied.json(), { error: "missing required scope", requiredScope: missing, reason: "missing_scope" });
  }
  await updateAgentScopes({ agentId: admin.agentId, scopes: [...AGENT_GRANTABLE_SCOPES], updatedByUserId: scenario.ownerUserId });
  assert.equal((await get(app.baseUrl, admin.apiKey, "/users/Scout/channels")).status, 200);
});

test("users/:name/channels: unknown and directory-hidden users are 404 user_not_found; paging is validated", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();

  const unknown = await get(app.baseUrl, scenario.memberApiKey, "/users/nobody/channels");
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json() as { code?: string };
  assert.equal(unknownBody.code, "user_not_found");

  // Exact, case-sensitive names: "scout" is not "Scout".
  assert.equal((await get(app.baseUrl, scenario.memberApiKey, "/users/scout/channels")).status, 404);

  const visible = await get(app.baseUrl, scenario.memberApiKey, `/users/${scenario.hiddenHumanName}/channels`);
  assert.equal(visible.status, 200);
  assert.equal(((await visible.json()) as { kind: string }).kind, "human");

  await scenario.setHumanDirectoryHidden(true);
  const hidden = await get(app.baseUrl, scenario.memberApiKey, `/users/${scenario.hiddenHumanName}/channels`);
  assert.equal(hidden.status, 404);
  // A hidden human answers exactly as a name nobody has.
  assert.deepEqual(await hidden.json(), unknownBody);
  // A server-admin agent still sees the directory.
  assert.equal((await get(app.baseUrl, scenario.adminApiKey, `/users/${scenario.hiddenHumanName}/channels`)).status, 200);

  for (const query of ["limit=201", "limit=0", "limit=-1", "offset=-1", "offset=1.5", "limit=abc"]) {
    const invalid = await get(app.baseUrl, scenario.memberApiKey, `/users/Scout/channels?${query}`);
    assert.equal(invalid.status, 400, query);
    assert.equal(((await invalid.json()) as { code?: string }).code, "agent_api_contract_invalid", query);
  }
  const max = await get(app.baseUrl, scenario.memberApiKey, "/users/Scout/channels?limit=200");
  assert.equal(max.status, 200);
  assert.deepEqual(((await max.json()) as { page: unknown }).page, { total: 8, offset: 0, limit: 200 });
  const byDefault = await get(app.baseUrl, scenario.memberApiKey, "/users/@Scout/channels");
  assert.deepEqual(((await byDefault.json()) as { page: unknown }).page, { total: 8, offset: 0, limit: 50 });
});

type UserChannelsBody = { memberships: Array<{ name: string; type: string }>; uncheckedCount: number };

async function jointMemberships(baseUrl: string, apiKey: string, name: string): Promise<{ joint: string[]; uncheckedCount: number }> {
  const response = await get(baseUrl, apiKey, `/users/${encodeURIComponent(name)}/channels?limit=200`);
  assert.equal(response.status, 200, name);
  const body = await response.json() as UserChannelsBody;
  return {
    joint: body.memberships.filter((channel) => channel.type === "joint").map((channel) => channel.name).sort(),
    uncheckedCount: body.uncheckedCount,
  };
}

test("users/:name/channels: a joint channel lists the subject itself, never its namesake on another server", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const peers = scenario.jointNamesakeOnly[0].channel;
  const local = scenario.jointSelfMember[0].channel;
  const gone = local.replace("joint-local-", "joint-gone-");

  // The admin agent is in A's projection of every joint channel (the member
  // agent only in joint-peers and joint-gone), so it can read every roster.
  const apiKey = scenario.adminApiKey;
  // A's Scout is only in joint-local (its own projection); B's Scout is in
  // both joint-peers and joint-local. joint-gone (A's projection disconnected)
  // is unchecked, as its roster route 404s.
  const scout = await jointMemberships(app.baseUrl, apiKey, "Scout");
  assert.deepEqual(scout.joint, [local]);
  assert.ok(!scout.joint.includes(gone));
  // Mem is in A's projections of joint-peers and joint-gone.
  assert.deepEqual((await jointMemberships(app.baseUrl, apiKey, "Mem")).joint, [peers]);
  // ALICE is in A's projection of joint-local.
  assert.deepEqual((await jointMemberships(app.baseUrl, apiKey, "ALICE")).joint, [local]);
  // alice is one person on both servers: her row on B's projection counts.
  assert.deepEqual((await jointMemberships(app.baseUrl, apiKey, "alice")).joint, [peers, local].sort());
  // The member agent cannot read joint-local's roster: unchecked, not a membership.
  assert.deepEqual((await jointMemberships(app.baseUrl, scenario.memberApiKey, "Scout")).joint, []);
  // The roster route is unchanged: joint-peers' merged roster still lists B's
  // Scout, which is what the old algorithm matched by name (Q3).
  const roster = await agentApiClientFor(app.baseUrl, scenario.memberApiKey).client.channels.members({ channel: `#${peers}` });
  assert.ok(roster.ok);
  assert.ok(roster.data.agents?.some((agent) => agent.name === "Scout"));
});

test("users/:name/channels: disconnected joint projections are absent from the local directory or peer roster", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const before = await jointMemberships(app.baseUrl, scenario.memberApiKey, "Scout");
  const peerGone = await scenario.addPeerDisconnectedJoint();

  // B's projection is disconnected, so its rows are out of the roster: neither
  // B's Scout nor alice (a member only through B's projection) count.
  for (const name of ["Scout", "alice"]) {
    const after = await jointMemberships(app.baseUrl, scenario.memberApiKey, name);
    assert.ok(!after.joint.includes(peerGone), name);
  }
  // A's own projection is active: its members are.
  for (const name of ["Mem", "Ada"]) {
    assert.ok((await jointMemberships(app.baseUrl, scenario.memberApiKey, name)).joint.includes(peerGone), name);
  }
  // A's disconnected joint-gone projection stays absent from the directory.
  const after = await jointMemberships(app.baseUrl, scenario.memberApiKey, "Scout");
  assert.equal(after.uncheckedCount, before.uncheckedCount);
  assert.ok(before.uncheckedCount >= 1);
});

type MembershipRow = Record<string, unknown> & { name: string; type?: string };

test("users/:name/channels: an admin caller's rows describe the subject, not the caller (no caller role, admin basis, capabilities, or mute state)", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const admin = scenario.callers[0];
  // The admin agent: a server admin and a channel admin of priv-both.
  const info = await agentApiClientFor(app.baseUrl, admin.apiKey).client.server.info();
  assert.ok(info.ok);
  const callerRow = (info.data.channels as MembershipRow[]).find((channel) => channel.name === "priv-both");
  assert.equal(callerRow?.channelRole, "admin");
  assert.equal(callerRow?.channelAdminBasis, "both");

  // Mem is a plain member of priv-both (and has no admin anywhere).
  const response = await get(app.baseUrl, admin.apiKey, "/users/Mem/channels");
  assert.equal(response.status, 200);
  const body = await response.json() as { memberships: MembershipRow[] };
  const privBoth = body.memberships.find((channel) => channel.name === "priv-both");
  assert.ok(privBoth);
  assert.equal(privBoth.joined, true);
  assert.equal(privBoth.channelRole, "member");
  for (const row of body.memberships) {
    for (const field of CALLER_CHANNEL_FIELDS) {
      if (field === "channelRole") continue;
      assert.ok(!(field in row), `#${row.name} carries ${field}`);
    }
    // Channel roles exist only on public and private channels other than #all.
    const roleBearing = (row.type === "channel" || row.type === "private") && row.name !== "all";
    assert.equal(row.channelRole, roleBearing ? "member" : undefined, row.name);
  }
  assert.ok(body.memberships.some((row) => row.type === "joint"));
  assert.ok(body.memberships.some((row) => row.name === "all"));

  const outcome = await userInfo(agentApiClientFor(app.baseUrl, admin.apiKey).client, { name: "Mem" });
  assert.ok(outcome.ok);
  assert.match(outcome.text, /^#priv-both \[private, joined, channel role=member, no posts yet\]$/m);
  assert.doesNotMatch(outcome.text, /admin/);

  // Scout is a channel admin of pub-one, where the admin caller is a plain member.
  const scout = await get(app.baseUrl, admin.apiKey, "/users/Scout/channels");
  const pubOne = ((await scout.json()) as { memberships: MembershipRow[] }).memberships.find((channel) => channel.name === "pub-one");
  assert.equal(pubOne?.channelRole, "admin");
  assert.equal((info.data.channels as MembershipRow[]).find((channel) => channel.name === "pub-one")?.channelRole, "member");
});

test("users/:name/channels: built-in app conversations are inspected and list no one, never unchecked", async ({ app }) => {
  const scenario = await seedUserChannelsScenario();
  const read = async (name: string) => {
    const response = await get(app.baseUrl, scenario.memberApiKey, `/users/${name}/channels?limit=200`);
    assert.equal(response.status, 200, name);
    return await response.json() as { memberships: MembershipRow[]; uncheckedCount: number; page: { total: number } };
  };
  const roster = () => agentApiClientFor(app.baseUrl, scenario.memberApiKey).client.channels.members({ channel: "#system.canary" });

  // `#system.canary` resolves the regular twin, whose roster lists Scout: the
  // built-in conversation is not Scout's membership, the twin is.
  assert.ok((await roster()).ok);
  const withTwin = await read("Scout");
  assert.deepEqual(withTwin.memberships.filter((row) => row.name === "system.canary").map((row) => row.type), ["channel"]);

  // Without the twin `#system.canary` resolves nothing (the roster route 404s),
  // yet the built-in conversation stays in the window and is not unchecked:
  // the disconnected joint-gone entry is absent from the directory. Only
  // `#weird:abcdef12` (a thread reference) is unchecked.
  await scenario.removeAppTwin();
  assert.equal((await roster()).ok, false);
  for (const name of ["Scout", "Mem", "alice"]) {
    const body = await read(name);
    assert.equal(body.page.total, withTwin.page.total - 1, name);
    assert.equal(body.uncheckedCount, 1, name);
    assert.ok(!body.memberships.some((row) => row.type === "dm"), name);
  }
  const outcome = await userInfo(agentApiClientFor(app.baseUrl, scenario.memberApiKey).client, { name: "Mem" });
  assert.ok(outcome.ok);
  assert.match(outcome.text, /^Skipped 1 visible channel roster checks because the server rejected them\.$/m);
});
