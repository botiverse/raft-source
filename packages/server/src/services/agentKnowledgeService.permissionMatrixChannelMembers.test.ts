import assert from "node:assert/strict";
import {
  CHANNEL_ADMIN_CAPABILITIES,
  canAddChannelMembers,
  hasEffectiveChannelCapability,
  hasServerCapability,
} from "@botiverse/raft-shared";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// permission-matrix carried no tooth, so its channel-member rows drifted away
// from membership.md and from the implementation: they said a Member cannot add
// or remove anyone, and that an agent needs server-admin authority. Both are
// false. These bind the two rows to the functions the server actually calls, so
// a permission-model change turns this page red instead of leaving the two
// Manual pages contradicting each other (Josh, 2026-09-23).

const addAsPlainMemberInChannel = {
  serverRole: "member" as const,
  admissionClass: "current_member" as const,
  isChannelMember: true,
  channelType: "channel",
  channelName: "general",
  archived: false,
  deleted: false,
};

test("implementation still lets a plain member add peers to a channel they are in", () => {
  assert.equal(canAddChannelMembers(addAsPlainMemberInChannel), true);
  assert.equal(canAddChannelMembers({ ...addAsPlainMemberInChannel, isChannelMember: false }), false);
  assert.equal(canAddChannelMembers({ ...addAsPlainMemberInChannel, channelType: "private" }), true);
  assert.equal(canAddChannelMembers({ ...addAsPlainMemberInChannel, admissionClass: "guest" }), false);
  assert.equal(canAddChannelMembers({ ...addAsPlainMemberInChannel, channelName: "all" }), false);
  assert.equal(
    canAddChannelMembers({ ...addAsPlainMemberInChannel, serverRole: "admin", isChannelMember: false }),
    true,
  );
});

test("implementation still requires the channel-admin role for a member to remove", () => {
  const removeAsChannelAdmin = {
    serverRole: "member" as const,
    channelRole: "admin" as const,
    isChannelMember: true,
    supportsChannelRoles: true,
    capability: "removeChannelMembers" as const,
    channelType: "channel",
  };
  assert.equal(hasEffectiveChannelCapability(removeAsChannelAdmin), true);
  assert.equal(hasEffectiveChannelCapability({ ...removeAsChannelAdmin, channelRole: "member" }), false);
});

// The table's seven columns. Matching a whole row lets one column satisfy an
// assertion written for another: the Member and the agent cells of these rows
// differ only by a hyphen ("channel admin" / "channel-admin role"), so a style
// polish could have made the agent cell carry the Member assertion while the
// Member cell quietly went back to a flat no (Cat, 2026-09-23).
const COLUMNS = ["operation", "owner", "admin", "member", "agentCli", "agentCard", "uiPath"] as const;
type Column = typeof COLUMNS[number];

function rowCells(content: string, label: string): Record<Column, string> {
  const line = content.split("\n").find((l) => l.startsWith(`| ${label}`));
  assert.ok(line, `${label} row must exist`);
  // A leading and a trailing empty segment bracket the seven cells. A cell that
  // ever contains a pipe changes this count, so the row is reported instead of
  // being silently misread one column over.
  const parts = line.split("|");
  assert.equal(parts.length, COLUMNS.length + 2,
    `${label} row must have exactly ${COLUMNS.length} cells, got ${parts.length - 2}`);
  const cells = parts.slice(1, -1).map((cell) => cell.trim());
  return Object.fromEntries(COLUMNS.map((name, i) => [name, cells[i]])) as Record<Column, string>;
}

test("permission-matrix states both channel-member rules the server applies", async () => {
  const doc = await resolveAgentKnowledgeDoc("permission-matrix");
  assert.ok(doc, "the topic must resolve");
  // Matched on the condition each cell must carry, not on its exact phrasing:
  // a copy polish should not turn this red, but dropping the condition must.
  const add = rowCells(doc.content, "Add member to channel");
  const remove = rowCells(doc.content, "Remove member from channel");
  assert.match(add.member, /already in/i,
    "the Member add cell must carry the already-in-that-channel condition, not a flat no");
  assert.match(remove.member, /channel[- ]admin/i,
    "the Member remove cell must carry the channel-admin condition");
  assert.match(add.agentCli, /already/i,
    "the agent add cell must carry the same already-in-that-channel condition");
  assert.match(remove.agentCli, /channel[- ]admin role/i,
    "the agent remove cell must keep the channel-admin path, not server admin alone");
  assert.doesNotMatch(doc.content, /add-member` — agent admin role/,
    "the agent add row must not require server-admin authority");
  assert.doesNotMatch(doc.content, /remove-member` — agent admin role/,
    "the agent remove row must not require server-admin authority alone");
  assert.match(doc.content, /Neither works on a DM, a thread, `#all`, or an archived or deleted channel\./,
    "the channel-type limits must stay with the rule");
});

// The same defect ran through four more rows of this table: create, rename,
// edit description and archive all said a Member cannot, and all said an agent
// needs server-admin authority. createPublicChannels / createPrivateChannels are member capabilities, and
// editChannelMetadata / archiveChannels are channel-admin capabilities, so a
// member holding the channel-admin role has them (Josh, 2026-09-23).
test("implementation still gives every member both create-channel capabilities", () => {
  for (const capability of ["createPublicChannels", "createPrivateChannels"] as const) {
    assert.equal(hasServerCapability("member", capability), true);
    assert.equal(hasServerCapability("guest", capability), false);
  }
});

test("edit and archive are channel-admin capabilities, reachable without server admin", () => {
  for (const capability of ["editChannelMetadata", "archiveChannels"] as const) {
    assert.ok(
      (CHANNEL_ADMIN_CAPABILITIES as readonly string[]).includes(capability),
      `${capability} must stay in the channel-admin set`,
    );
    assert.equal(hasServerCapability("member", capability), false);
    assert.equal(
      hasEffectiveChannelCapability({
        serverRole: "member",
        channelRole: "admin",
        isChannelMember: true,
        supportsChannelRoles: true,
        capability,
        channelType: "channel",
      }),
      true,
    );
  }
});

test("permission-matrix channel-operation rows carry their real conditions", async () => {
  const doc = await resolveAgentKnowledgeDoc("permission-matrix");
  assert.ok(doc, "the topic must resolve");

  const create = rowCells(doc.content, "Create channel");
  assert.equal(create.member, "✅", "a member can create a channel");
  assert.match(create.agentCli, /createPublicChannels/,
    "the agent create cell must name the capabilities the route checks");
  assert.match(create.agentCli, /createPrivateChannels/,
    "the agent create cell must name the capabilities the route checks");

  for (const label of ["Rename channel", "Edit description", "Archive / Unarchive"]) {
    const cells = rowCells(doc.content, label);
    assert.match(cells.member, /channel[- ]admin/i, `${label}: the Member cell must carry the channel-admin condition`);
    assert.match(cells.agentCli, /channel[- ]admin role/i, `${label}: the agent cell must keep the channel-admin path`);
    assert.doesNotMatch(cells.agentCli, /agent admin role/i, `${label} must not require an agent admin role`);
  }

  // changeChannelVisibility is in neither MEMBER_SERVER_CAPABILITIES nor
  // CHANNEL_ADMIN_CAPABILITIES, so this row is the one channel operation a
  // channel admin cannot reach. It IS in CHANNEL_MANAGEMENT_CAPABILITIES, which
  // sits directly beside the other list in the same file and reads like the
  // authority set while giving the opposite answer (Josh, 2026-09-23).
  const visibility = rowCells(doc.content, "Change visibility");
  assert.equal(visibility.member, "❌");
  assert.match(visibility.agentCli, /changeChannelVisibility/,
    "the visibility cell must name the capability, not a role");
  assert.doesNotMatch(visibility.agentCli, /channel-admin role in that channel/,
    "a channel-admin role does not reach changeChannelVisibility");

  // Bound to the identifier, not to a sentence: manageChannels was removed from
  // the permission model, and actorPermissions.boundary.test.ts forbids the
  // literal in server source. A page that still teaches it is teaching a name
  // the code refuses to carry.
  assert.doesNotMatch(doc.content, /manageChannels/,
    "manageChannels is not a capability any more; name the per-operation capability the code checks");
});
