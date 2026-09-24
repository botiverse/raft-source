import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CHANNEL_ADMIN_CAPABILITIES,
  CHANNEL_ROLES,
  MANAGEABLE_SERVER_ROLES,
  canAddChannelMembers,
  hasEffectiveChannelCapability,
} from "@botiverse/raft-shared";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// The membership topic now states the channel-permission contract. These teeth
// bind the prose to the implementation it describes, so a later change to the
// permission model turns the DOC red instead of leaving agents with a rule the
// server no longer applies.

test("membership doc names the capabilities the server actually checks", async () => {
  const doc = await resolveAgentKnowledgeDoc("membership");
  assert.ok(doc);
  for (const capability of ["addChannelMembers", "removeChannelMembers"]) {
    assert.match(doc.content, new RegExp(capability), `doc must name ${capability}`);
  }
});

test("the documented channel-admin capability set equals the implementation's closed set", async () => {
  const doc = await resolveAgentKnowledgeDoc("membership");
  assert.ok(doc);
  for (const capability of CHANNEL_ADMIN_CAPABILITIES) {
    assert.match(
      doc.content,
      new RegExp(capability),
      `channel-admin capability ${capability} is granted by the code but missing from the doc`,
    );
  }
  // The reverse direction, and it must be asserted against the DOC — an
  // earlier version of this test only checked the code, so adding
  // `deleteChannels` to the doc's granted list left it green. Over-promising is
  // the more dangerous direction: an agent believing it may delete a channel
  // acts and is refused, or worse, asks a human to grant a role that cannot
  // help. These identifiers are server-level only, so the topic must not name
  // them as things a channel role grants.
  for (const notGranted of ["deleteChannels", "changeChannelVisibility", "federateChannels"]) {
    assert.ok(
      !CHANNEL_ADMIN_CAPABILITIES.includes(notGranted as never),
      `${notGranted} must stay out of the channel-admin set`,
    );
    assert.doesNotMatch(
      doc.content,
      new RegExp("`" + notGranted + "`"),
      `the topic names ${notGranted} as a channel-role capability, but the closed set does not grant it`,
    );
  }
});

test("both documented channel roles exist in the implementation", async () => {
  const doc = await resolveAgentKnowledgeDoc("membership");
  assert.ok(doc);
  assert.deepEqual([...CHANNEL_ROLES], ["member", "admin"]);
  assert.match(doc.content, /`member` \/ `admin`/);
});

test("the documented add-member rule matches canAddChannelMembers", () => {
  // Doc claim: any CURRENT MEMBER of an ordinary channel may add peers, channel
  // admin not required; #all, archived and deleted are excluded; server
  // owner/admin may add without membership.
  const base = { channelType: "channel", archived: false, deleted: false } as const;
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "member", admissionClass: "current_member", isChannelMember: true }),
    true,
    "a plain current member must be able to add peers",
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "member", admissionClass: "current_member", isChannelMember: false }),
    false,
    "a non-member must not",
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "owner", admissionClass: "visitor", isChannelMember: false }),
    true,
    "server owner may add without channel membership",
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "member", admissionClass: "current_member", isChannelMember: true, channelName: "all" }),
    false,
    "#all is excluded",
  );
  assert.equal(
    canAddChannelMembers({ ...base, archived: true, serverRole: "owner", admissionClass: "current_member", isChannelMember: true }),
    false,
    "archived channels are excluded",
  );
});

test("the add-member rule documents Guest as a shipped but non-manageable role", async () => {
  // Guest is now part of ServerRole, but remains deliberately absent from the
  // admission/role-management surface in this foundation release. The manual
  // must name that role and its add-member denial without implying that Guest
  // can already be selected by the role-management UI.
  assert.deepEqual([...MANAGEABLE_SERVER_ROLES], ["owner", "admin", "member"]);

  const doc = await resolveAgentKnowledgeDoc("membership");
  assert.ok(doc);
  assert.match(doc.content, /guest/i, "the topic must document the shipped Guest role");
  for (const role of MANAGEABLE_SERVER_ROLES) {
    assert.match(doc.content, new RegExp("`" + role + "`"), `the topic must name the ${role} role`);
  }

  // The predicate itself, over in-domain values only.
  const base = { channelType: "channel", archived: false, deleted: false } as const;
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "member", admissionClass: "current_member", isChannelMember: true }),
    true,
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "member", admissionClass: "current_member", isChannelMember: false }),
    false,
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "owner", admissionClass: "current_member", isChannelMember: false }),
    true,
  );
  assert.equal(
    canAddChannelMembers({ ...base, serverRole: "guest", admissionClass: "guest", isChannelMember: true }),
    false,
    "a joined Guest cannot add channel members",
  );
});

test("the documented version gate is real: channel roles need supportsChannelRoles", () => {
  const input = {
    serverRole: "member" as const,
    channelRole: "admin" as const,
    isChannelMember: true,
    capability: "removeChannelMembers" as const,
  };
  assert.equal(hasEffectiveChannelCapability({ ...input, supportsChannelRoles: true }), true);
  assert.equal(
    hasEffectiveChannelCapability({ ...input, supportsChannelRoles: false }),
    false,
    "without supportsChannelRoles the channel role must grant nothing",
  );
});
