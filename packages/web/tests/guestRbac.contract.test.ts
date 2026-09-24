import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("both channel-settings implementations gate and preserve the Guest policy invariant", () => {
  for (const path of [
    "src/components/channel/EditChannelDialog.tsx",
    "src/components/channel/LegacyEditChannelDialog.tsx",
  ]) {
    const source = readSource(path);
    assert.match(source, /SERVER_GUEST_FEATURE_FLAG_KEY/);
    assert.match(source, /effectiveCapabilities\.manageGuestAccess/);
    assert.match(source, /!isArchived/);
    assert.match(source, /channel\?\.type === "private" && channel\?\.name !== "all"/);
    assert.match(source, /channel\?\.name !== "all" && <div/);
    assert.match(source, /guestVisible: false, guestJoinable: false/);
    assert.match(source, /guestVisible: true, guestJoinable: true/);
    assert.match(source, /channel\.edit\.guestVisibleTitle/);
    assert.match(source, /channel\.edit\.guestJoinableTitle/);
  }
});

test("Guest roster surfaces stay summary-only", () => {
  const humanDetail = readSource("src/components/member/HumanDetailPanel.tsx");
  const members = readSource("src/components/agent/ChannelMembers.tsx");
  const legacyMembers = readSource("src/components/agent/LegacyChannelMembers.tsx");
  const memberRows = readSource("src/components/channel/ChannelMemberList.tsx");

  assert.match(humanDetail, /currentRole !== "guest" && human\.role !== "guest"/);
  assert.match(humanDetail, /\|\| Boolean\(dmChannel\)/);
  // The roster profile-entry contract is executable, not a source grep:
  // tests/guestRosterProfileEntry.behavior.test.tsx renders the members page
  // as a guest and asserts the human row is reachable. Guests may open human
  // profiles; HumanDetailPanel filters the contents by capability.
  for (const source of [members, legacyMembers]) {
    assert.match(source, /canOpenAgentProfiles/);
    assert.match(source, /canOpenHumanProfiles/);
  }
  assert.match(memberRows, /member-page-role-channel-guest/);
  assert.match(memberRows, /channel\.membersPage\.role\.channelGuest/);
});

test("Guest navigation hides directories while preserving bounded Agent profiles and Leave Server", () => {
  const leftRail = readSource("src/components/layout/LeftRail.tsx");
  const mainLayout = readSource("src/components/layout/MainLayout.tsx");
  const sidebar = readSource("src/components/layout/Sidebar.tsx");
  const settings = readSource("src/components/settings/SettingsPanel.tsx");
  const settingsNavigation = readSource("src/components/settings/settingsNavigation.ts");
  const chatPanel = readSource("src/components/message/ChatPanel.tsx");
  const agentDetail = readSource("src/components/agent/AgentDetailPanel.tsx");
  const humanRoute = mainLayout.slice(
    mainLayout.indexOf("function HumanRoute()"),
    mainLayout.indexOf("function SettingsRoute()"),
  );

  assert.match(leftRail, /\{!isGuest && <RailTabButton icon=\{<Users/);
  assert.match(leftRail, /item !== "members" && item !== "humans" && item !== "computers"/);
  assert.match(mainLayout, /serverRole === "guest" \? \[\] : \[/);
  assert.ok(humanRoute.startsWith("function HumanRoute()"));
  assert.doesNotMatch(humanRoute, /server\?\.role === "guest"/);
  assert.match(sidebar, /canViewApplicationsSettings/);
  assert.match(sidebar, /canViewMcpSettings/);
  assert.match(settingsNavigation, /role === "guest" && \(tab === "integrations" \|\| tab === "mcp"\)/);
  assert.match(settings, /role === "admin" \|\| role === "member" \|\| role === "guest"/);
  assert.match(chatPanel, /data-testid="guest-readonly-channel-banner"/);
  assert.match(chatPanel, /message\.chatPanel\.guestReadOnlyChannel/);
  assert.match(agentDetail, /agent\.profileProjection === "channel_summary"/);
  assert.match(agentDetail, /showOperationalInfo=\{!isBoundedPublicProjection\}/);
  assert.match(agentDetail, /canMessageAgent=\{!isBoundedPublicProjection\}/);
});

test("channel-scoped hover cards keep people visible without leaking Agent runtime details", () => {
  const profileCard = readSource("src/components/message/ProfilePreviewCardContent.tsx");
  const mentionLink = readSource("src/components/message/MentionLink.tsx");
  const messageItem = readSource("src/components/message/MessageItem.tsx");

  assert.match(profileCard, /profileAgent\?\.profileProjection === "channel_summary"/);
  assert.match(profileCard, /!isChannelSummaryAgent \? <dl/);
  assert.match(mentionLink, /fallbackAgent\?: Agent \| null/);
  assert.match(mentionLink, /fallbackMember\?: ServerMember \| null/);
  assert.match(mentionLink, /fallbackAgent=\{fallbackAgent\}/);
  assert.match(mentionLink, /fallbackMember=\{fallbackMember\}/);
  assert.match(messageItem, /fallbackAgent=\{entry\.type === "agent" \? channelParticipantAgentsById\?\.get\(entry\.id\)/);
  assert.match(messageItem, /fallbackMember=\{entry\.type === "user" \? channelParticipantMembersById\?\.get\(entry\.id\)/);
  assert.match(messageItem, /channelParticipantAgentsById=\{channelParticipantAgentsById\}/);
  assert.match(messageItem, /channelParticipantMembersById=\{channelParticipantMembersById\}/);
});

test("Guest task surfaces render read-only state with no edit or drag affordances", () => {
  const taskCard = readSource("src/components/task/TaskCard.tsx");
  const taskProperties = readSource("src/components/task/TaskProperties.tsx");
  const tasksPanel = readSource("src/components/task/TasksPanel.tsx");

  assert.match(taskCard, /canEditTaskStatus\(task, currentUser\?\.id, canManageServer, role\)/);
  assert.match(taskCard, /data-testid="task-status-readonly"/);
  assert.match(taskProperties, /data-testid="task-properties-status-readonly"/);
  assert.match(taskProperties, /data-testid="task-properties-assignee-readonly"/);
  assert.match(tasksPanel, /const canModifyTasks = role !== "guest"/);
  assert.match(tasksPanel, /useDraggable\(\{ id: task\.id, disabled \}\)/);
  assert.match(tasksPanel, /useDroppable\(\{ id: status, disabled: !canModifyTasks \}\)/);
  assert.match(tasksPanel, /\{isChannelMode && canModifyTasks && \(/);
  assert.match(tasksPanel, /onDragTask=\{canModifyTasks \? onDragTask : undefined\}/);
});

test("unavailable linked messages collapse to one chip instead of an empty preview", () => {
  const messageItem = readSource("src/components/message/MessageItem.tsx");
  const preview = readSource("src/components/message/QuotedMessagePermalinkPreview.tsx");
  const chatPanel = readSource("src/components/message/ChatPanel.tsx");
  const threadPanel = readSource("src/components/message/ThreadPanel.tsx");

  assert.match(messageItem, /message\.messageItem\.unavailableLinkedMessage/);
  assert.match(messageItem, /quotedPermalink && !quotedPermalinkUnavailable/);
  assert.match(messageItem, /onUnavailable=\{handleQuotedPermalinkUnavailable\}/);
  assert.match(messageItem, /as=\{quotedMessageUnavailable \? "span" : "a"\}/);
  assert.match(messageItem, /onClick=\{quotedMessageUnavailable \? undefined/);
  assert.match(messageItem, /title=\{quotedMessageUnavailable \? undefined/);
  assert.match(preview, /if \(state\.status === "unavailable"\) \{\s*return null;/);
  assert.match(chatPanel, /const canReactInChannel = !readOnly\s*&& !channel\?\.archivedAt\s*&& \(channel\?\.type === "dm" \|\| channel\?\.type === "thread" \|\| channel\?\.joined === true\)/);
  assert.match(threadPanel, /const canReactToThread = parentJoined === true\s*&& !parentChannel\?\.archivedAt\s*&& !parentJointFeatureLocked/);
});
