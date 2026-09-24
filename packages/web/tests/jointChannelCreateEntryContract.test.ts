// The Sidebar create-entry and CreateJointChannelDialog halves of this
// contract moved to mounted-DOM assertions in
// jointChannelCreateEntry.behavior.test.tsx:
// - the capability-gated "Create Joint Channel" entry (owner sees it, member
//   does not) and the dialog it opens,
// - the joint section rendering above ordinary channels,
// - invite-draft collection capped at MAX_JOINT_CHANNEL_SERVERS - 1 and the
//   { visibility: "joint", jointInvites } submit payload, and
// - the free-plan allowance banner and the localized free-limit recovery
//   (the zh-cn render of the same states lives in
//   createJointChannelDialog.i18n.behavior.test.tsx; the billing-route wiring
//   is also pinned in billingSummaryContract.test.ts).
// What remains here is wiring a mounted render cannot see (store/api
// forwarding, cross-surface negative guards, task and member-list plumbing)
// plus sort-state persistence in the store.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function sourceRoot(): string {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return resolve(repoRoot, "src");
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : resolve(repoRoot, "src");
}

function readSource(path: string): string {
  return readFileSync(resolve(sourceRoot(), path), "utf8");
}

test("joint channel store forwarding keeps the jointInvites contract", () => {
  const channelStore = readSource("store/channelStore.ts");
  assert.match(channelStore, /jointInvites\?: Array<\{\s*targetServerSlug: string;?\s*invitedPeople: string\[\];?\s*\}>/);
  assert.match(channelStore, /jointInvites: opts\?\.jointInvites/);
});

test("joint channel sort state is independent from ordinary channel sort state", () => {
  const sidebar = readSource("components/layout/Sidebar.tsx");
  const serverStore = readSource("store/serverStore.ts");

  assert.match(serverStore, /jointChannelSortMode: "manual" \| "recent" \| "az"/);
  assert.match(serverStore, /jointChannelSortMode: record\.jointChannelSortMode === undefined \? fallback\.jointChannelSortMode : normalizeSidebarSortMode\(record\.jointChannelSortMode\)/);
  assert.match(serverStore, /updates\.jointChannelSortMode \?\? sidebarOrder\.jointChannelSortMode/);
  assert.match(sidebar, /const jointChannelSortMode = sidebarOrder\.jointChannelSortMode/);
  assert.match(sidebar, /void updateSidebarOrder\(\{ jointChannelSortMode: mode \}\)/);
  assert.match(sidebar, /renderSortMenu\("jointChannels", jointChannelSortMode, updateJointChannelSortMode\)/);
  assert.match(sidebar, /renderSortMenu\("channels", channelSortMode, updateChannelSortMode\)/);
  assert.match(sidebar, /kind="jointChannels"\s+manual=\{jointChannelManualSort\}/);
  assert.doesNotMatch(sidebar, /Joint Channels[\s\S]{0,500}renderSortMenu\("channels", channelSortMode, updateChannelSortMode\)/);
});

test("ordinary channel dialog does not own joint-channel creation", () => {
  const dialog = readSource("components/channel/CreateChannelDialog.tsx");
  const sidebar = readSource("components/layout/Sidebar.tsx");

  assert.match(dialog, /prefilledVisibility\?: "public" \| "private"/);
  assert.doesNotMatch(dialog, /channel\.edit\.inviteSlugRequired/);
  assert.doesNotMatch(dialog, /value: "joint"/);
  assert.doesNotMatch(sidebar, /<CreateChannelDialog[\s\S]{0,240}visibility: "joint"/);
  assert.doesNotMatch(sidebar, /<CreateChannelDialog[\s\S]{0,240}targetServerSlug/);
});

test("joint channel chrome uses a distinct connected-server surface", () => {
  const chatPanel = readSource("components/message/ChatPanel.tsx");
  const sidebar = readSource("components/layout/Sidebar.tsx");
  const channelKindIcon = readSource("components/channel/channelKindIcon.tsx");
  const editDialog = readSource("components/channel/EditChannelDialog.tsx");

  assert.match(chatPanel, /<ChannelKindIcon type=\{channel\.type\}/);
  assert.match(sidebar, /<ChannelKindIcon type=\{channel\.type\}/);
  assert.match(channelKindIcon, /export const CHANNEL_KIND_ICON_SIZE = 14/);
  assert.match(channelKindIcon, /if \(type === "private"\) return <Lock size=\{size\}/);
  assert.match(channelKindIcon, /if \(type === "joint"\) return <GitBranch size=\{size\}/);
  assert.match(channelKindIcon, /if \(type === "channel"\) return <Hash size=\{size\}/);
  assert.match(chatPanel, /const channelSubtitle =\s*isRegularChannel\s*\?\s*channel\.description \|\| undefined\s*:\s*undefined;/);
  assert.doesNotMatch(chatPanel, /Joint with \$\{channel\.jointPeerServerName \|\| channel\.jointPeerServerSlug\}/);
  // Chrome labels are catalog ids now; assert the id at the call site and the
  // wording in en.ts, so neither the wiring nor the copy can drift unnoticed.
  const chromeMsgs = readSource("i18n/messages/en.ts");
  assert.match(editDialog, /id: "channel\.edit\.connectedServers"/);
  assert.match(editDialog, /id: "channel\.edit\.inviteServerSection"/);
  assert.match(chromeMsgs, /"channel\.edit\.connectedServers": "Connected servers"/);
  assert.match(chromeMsgs, /"channel\.edit\.inviteServerSection": "Invite server"/);
  assert.match(editDialog, /jointServers/);
  assert.match(editDialog, /jointPendingInvites/);
  assert.match(editDialog, /invite\.fromServerId === channel\.serverId/);
  assert.match(editDialog, /id: "message\.channelSettings\.jointTitle"/);
  assert.match(chromeMsgs, /"message\.channelSettings\.jointTitle": "Joint channel"/);
  assert.match(editDialog, /!isJointChannel &&/);
});

test("joint channel edit can invite another server", () => {
  const editDialog = readSource("components/channel/EditChannelDialog.tsx");
  const channelStore = readSource("store/channelStore.ts");

  assert.match(editDialog, /MAX_JOINT_CHANNEL_SERVERS/);
  assert.match(editDialog, /validateNameReason/);
  assert.match(editDialog, /validateServerSlugReason/);
  assert.match(editDialog, /inviteJointChannelServer/);
  assert.match(editDialog, /handleInviteJointServer/);
  const inviteMsgs = readSource("i18n/messages/en.ts");
  assert.match(editDialog, /id: "channel\.edit\.sendInvite"/);
  assert.match(inviteMsgs, /"channel\.edit\.sendInvite": "Send Invite"/);
  assert.match(editDialog, /const jointServerLimitReached = jointServers\.length >= MAX_JOINT_CHANNEL_SERVERS/);
  assert.equal(
    (editDialog.match(/id: "channel\.edit\.maxServers"/g) ?? []).length, 2,
    "the error path and the hint must share one maxServers message",
  );
  assert.match(editDialog, /\{ max: MAX_JOINT_CHANNEL_SERVERS \}/);
  assert.match(inviteMsgs, /"channel\.edit\.maxServers": "Joint channels support a maximum of \{max\} servers\."/);
  assert.match(channelStore, /jointServers\?: Array/);
  assert.match(channelStore, /jointPendingInvites\?: Array/);
  assert.match(channelStore, /inviteJointChannelServer: \(channelId: string, input: \{\s*targetServerSlug: string;?\s*invitedPeople: string\[\];?\s*\}\) => Promise<Channel>/);
  assert.match(channelStore, /api\.post\(`\/channels\/\$\{channelId\}\/joint-invites`, input\)/);
});

test("ordinary channel edit can convert the channel to a joint channel", () => {
  const editDialog = readSource("components/channel/EditChannelDialog.tsx");
  const channelStore = readSource("store/channelStore.ts");

  assert.match(editDialog, /const plan = useServerStore\(\(s\) => s\.current\?\.plan\) \|\| "free"/);
  assert.match(editDialog, /const canShowConvertToJointEntry = useServerStore\(\(s\) => s\.current\?\.slug === "botiverse"\)/);
  assert.match(editDialog, /const canUseJointChannels = plan !== "free"/);
  assert.match(editDialog, /const showConvertAction = showManageActions &&\s*canShowConvertToJointEntry &&\s*canUseJointChannels &&\s*!isAllChannel &&\s*!isJointChannel/);
  assert.match(editDialog, /convertChannelToJoint/);
  const convertMsgs = readSource("i18n/messages/en.ts");
  assert.match(editDialog, /id: "channel\.edit\.convertToJoint"/);
  assert.match(editDialog, /id: "channel\.edit\.confirmConvert"/);
  assert.match(convertMsgs, /"channel\.edit\.convertToJoint": "Convert to Joint Channel"/);
  assert.match(convertMsgs, /may be read-only while conversion runs/);
  assert.match(convertMsgs, /any server invited later can see that history through its joint projection/);
  assert.match(channelStore, /convertChannelToJoint:\s*\(\s*channelId: string,\s*opts\?:\s*\{\s*confirmTaskIdentityDrop\?: boolean;?\s*\}\s*\)\s*=> Promise<Channel>/);
  assert.match(channelStore, /confirmTaskIdentityDrop: true/);
  assert.match(channelStore, /api\.post\([\s\S]{0,320}convert-to-joint/);
});

test("joint channels can edit shared metadata but cannot change visibility", () => {
  const editDialog = readSource("components/channel/EditChannelDialog.tsx");

  assert.match(editDialog, /const isJointChannel = channel\?\.type === "joint"/);
  assert.match(editDialog, /disabled=\{isAllChannel \|\| isArchived\}/);
  assert.match(editDialog, /disabled=\{isArchived\}/);
  assert.match(editDialog, /disabled=\{saving \|\| isArchived\}/);
  const jointMsgs = readSource("i18n/messages/en.ts");
  assert.match(editDialog, /id: "channel\.edit\.jointNameShared"/);
  assert.match(jointMsgs, /"channel\.edit\.jointNameShared": "Joint channel names are shared across servers"/);
  assert.match(editDialog, /!isJointChannel && showVisibilityAction && \(/);
  // These two are negative guards. Left anchored on the English literals they
  // would still PASS after the migration -- vacuously, because the literals no
  // longer exist anywhere in the file. A guard that cannot fail is worse than a
  // broken one, so they are re-anchored on the ids that replaced them.
  assert.doesNotMatch(editDialog, /isJointChannel[\s\S]{0,240}channel\.edit\.makePublic/);
  assert.doesNotMatch(editDialog, /isJointChannel[\s\S]{0,240}channel\.edit\.makePrivate/);
  assert.match(editDialog, /id: "channel\.edit\.disconnectJointChannel"/);
  assert.match(jointMsgs, /"channel\.edit\.disconnectJointChannel": "Disconnect Joint Channel"/);
  assert.match(editDialog, /disconnectJointChannel\(channelId\)/);
  assert.doesNotMatch(editDialog, /isJointChannel[\s\S]{0,200}<Trash2 size=\{14\} \/>[\s\S]{0,80}channel\.edit\.deleteChannel/);
});

test("joint member list labels peer agents and humans with source server beside display name", () => {
  const source = readSource("components/agent/ChannelMembers.tsx");

  assert.match(source, /function JointPeerBadge/);
  assert.doesNotMatch(source, /Joint · \{label\}/);
  assert.match(source, /const peerLabel = jointPeerLabel\(agent\.serverId, agent\.serverName, agent\.serverSlug\);/);
  assert.match(source, /<span className="truncate">\{agent\.displayName \|\| agent\.name\}<\/span>\s*\{peerLabel && <JointPeerBadge label=\{peerLabel\} \/>}/);
  assert.match(source, /const peerLabel = jointPeerLabel\(human\.serverId, human\.serverName, human\.serverSlug\);/);
  assert.match(source, /<span className="truncate">\{human\.displayName \|\| human\.name\}<\/span>\s*\{peerLabel && <JointPeerBadge label=\{peerLabel\} \/>}/);
  assert.doesNotMatch(source, /jointPeerLabel=\{jointPeerLabel\(human\.serverId, human\.serverName, human\.serverSlug\)\}/);
});

test("joint add-member candidate filters use only the current local projection", () => {
  const helper = readSource("utils/channelLocalMembership.ts");
  const channelMembers = readSource("components/agent/ChannelMembers.tsx");
  const addMembersDialog = readSource("components/channel/AddMembersDialog.tsx");

  assert.match(helper, /return member\.serverId === channel\.serverId/);
  assert.match(channelMembers, /channelHumans\s*\.\s*filter\(\(h\) => isLocalProjectionMember\(h, currentChannel\)\)\s*\.\s*map\(\(h\) => h\.id\)/);
  assert.match(addMembersDialog, /channelHumans\s*\.\s*filter\(\(m\) => isLocalProjectionMember\(m, channel\)\)\s*\.\s*map\(\(m\) => m\.id\)/);
  assert.doesNotMatch(channelMembers, /const channelHumanIds = new Set\(channelHumans\.map\(\(h\) => h\.id\)\)/);
  assert.doesNotMatch(addMembersDialog, /new Set\(channelHumans\.map\(\(m\) => m\.id\)\)/);
});

test("joint channels expose the Task V2 board and message task actions", () => {
  const chatPanel = readSource("components/message/ChatPanel.tsx");

  assert.doesNotMatch(chatPanel, /channel\?\.type === "joint" \? orderedTabs\.filter\(\(tab\) => tab\.id !== "tasks"\) : orderedTabs/);
  assert.match(chatPanel, /const supportsChannelTasks = channel !== null && channel\.type !== "thread";/);
  assert.match(chatPanel, /if \(!channel \|\| !supportsChannelTasks\) return;/);
  assert.match(chatPanel, /showTaskButton=\{supportsChannelTasks\}/);
  assert.doesNotMatch(chatPanel, /showTaskButton\s*\n\s*autoFocus/);

  const messageItem = readSource("components/message/MessageItem.tsx");
  assert.match(messageItem, /const supportsMessageTasks = taskSurfaceChannel !== undefined && taskSurfaceChannel\.type !== "thread";/);
  assert.match(messageItem, /!\s*parentMessageId && supportsMessageTasks && \(/);

  const taskStore = readSource("store/taskStore.ts");
  assert.match(taskStore, /task\.channelType === "joint"/);

  const properties = readSource("components/task/TaskProperties.tsx");
  assert.match(properties, /dedupeTaskAssigneeMembers\(channelHumans\)/);
  assert.match(properties, /dedupeTaskAssigneeMembers\(channelAgents\)/);
});

test("joint message senders resolve avatars from aggregated channel membership", () => {
  const chatPanel = readSource("components/message/ChatPanel.tsx");
  const threadPanel = readSource("components/message/ThreadPanel.tsx");
  const messageItem = readSource("components/message/MessageItem.tsx");

  for (const source of [chatPanel, threadPanel]) {
    assert.match(source, /for \(const a of mentionChannelAgents\) map\.set\(a\.id, a\);/);
    assert.match(source, /for \(const human of mentionChannelHumans\)/);
    assert.match(source, /userId: human\.id/);
    assert.match(source, /avatarUrl: human\.avatarUrl/);
    assert.match(source, /gravatarHash: human\.gravatarHash/);
  }
  assert.match(messageItem, /senderAgent\?\.description \|\| message\.senderDescription \|\| null/);
});
