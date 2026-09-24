import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

const avatarSlotSource = readFileSync(resolve(repoRoot, "src/components/ui/AvatarSlot.tsx"), "utf8");
const gravatarAvatarSource = readFileSync(resolve(repoRoot, "src/components/member/GravatarAvatar.tsx"), "utf8");
const settingsPanelSource = readFileSync(resolve(repoRoot, "src/components/settings/SettingsPanel.tsx"), "utf8");
const serverSwitcherSource = readFileSync(resolve(repoRoot, "src/components/ui/ServerSwitcherMenu.tsx"), "utf8");
const messageInputSource = readFileSync(resolve(repoRoot, "src/components/message/MessageInput.tsx"), "utf8");
const messageItemSource = readFileSync(resolve(repoRoot, "src/components/message/MessageItem.tsx"), "utf8");
const agentDetailSource = readFileSync(resolve(repoRoot, "src/components/agent/AgentDetailPanel.tsx"), "utf8");
const quotedMessageCardSource = readFileSync(resolve(repoRoot, "src/components/ui/cards/QuotedMessageCard.tsx"), "utf8");
const searchPageSource = readFileSync(resolve(repoRoot, "src/components/search/MessageSearchPage.tsx"), "utf8");
const paletteAuditSource = readFileSync(resolve(repoRoot, "src/pages/PaletteAuditPage.tsx"), "utf8");
const pixelAvatarSource = readFileSync(resolve(repoRoot, "src/components/agent/PixelAvatar.tsx"), "utf8");
const sidebarSource = readFileSync(resolve(repoRoot, "src/components/layout/Sidebar.tsx"), "utf8");
const channelMemberListSource = readFileSync(resolve(repoRoot, "src/components/channel/ChannelMemberList.tsx"), "utf8");

test("AvatarSlot carries identity-keyed placeholder bg AND real images must fill the full frame", () => {
  // Identity-keyed bg: agent = cyan, human = lavender, app = yellow, server = black/yellow.
  // The bg is visible only when the inner content is a placeholder/loading
  // state; real avatar images cover it edge-to-edge.
  assert.match(
    avatarSlotSource,
    /type === "agent"[\s\S]*\? "bg-brutal-cyan"[\s\S]*: type === "human"[\s\S]*\? "bg-brutal-lavender"[\s\S]*: type === "app"[\s\S]*\? "bg-soft-signal text-black font-display font-black"[\s\S]*: "bg-black text-soft-signal font-display font-bold"/,
    "AvatarSlot should derive an identity-keyed placeholder bg (cyan agent / lavender human / yellow app / black-yellow server)",
  );
  assert.match(
    avatarSlotSource,
    /const baseClass = `relative flex shrink-0 items-center justify-center overflow-hidden \$\{spec\.size\} \$\{spec\.border\} border-black \$\{fallbackBg\}`;/,
    "AvatarSlot should compose the role bg into the canonical black-framed container",
  );

  // Fill invariant — real images must cover the bg edge-to-edge or the role
  // tint leaks around the image (the regression stdrc filed in #1873; this
  // test pins both sides so neither rule can silently drop again).
  assert.match(
    avatarSlotSource,
    /<AgentAvatar avatarUrl=\{agentAvatarUrl \?\? null\} size=\{spec\.agentPixel\} className="!w-full !h-full" \/>/,
    "agent avatars should fill the full frame edge-to-edge so role bg never leaks",
  );
  assert.match(
    gravatarAvatarSource,
    /gravatarLoaded\s*\?\s*"absolute inset-0 h-full w-full object-cover"/,
    "human Gravatar images should fill the full frame edge-to-edge so role bg never leaks",
  );
  assert.match(
    gravatarAvatarSource,
    /: "absolute inset-0 h-full w-full object-cover opacity-0 pointer-events-none"/,
    "pending human Gravatar probes should stay mounted and full-frame instead of display:none",
  );
});

test("known avatar surfaces do not reintroduce background-filled frames", () => {
  assert.doesNotMatch(
    settingsPanelSource,
    /bg-brutal-lavender[\s\S]{0,160}<GravatarAvatar|<AgentAvatar avatarUrl="pixel:random:cindy-preview"/,
    "Settings account and Appearance preview avatars must not use hand-rolled background frames",
  );
  assert.match(
    settingsPanelSource,
    /<AvatarSlot context="profile-tile" type="human" humanAvatarUrl=\{user\?\.avatarUrl\} email=\{user\?\.email\} \/>/,
    "Settings account avatar should route through AvatarSlot",
  );
  assert.match(
    settingsPanelSource,
    /<AvatarSlot context="profile-tile" type="server" serverAvatarUrl=\{server\.avatarUrl\} serverInitial=\{serverInitial\}/,
    "Settings server profile avatar should route through AvatarSlot",
  );
  assert.match(
    serverSwitcherSource,
    /<AvatarSlot context="surface-list" type="server" serverAvatarUrl=\{server\.avatarUrl\} serverInitial=\{initial\} \/>/,
    "Server switcher rows should route server avatars through the shared AvatarSlot list primitive",
  );
  assert.doesNotMatch(
    `${settingsPanelSource}\n${serverSwitcherSource}`,
    /server\.avatarUrl[\s\S]{0,120}<img|s\.avatarUrl[\s\S]{0,120}<img/,
    "server profile/switcher avatars must not use hand-rolled img frames",
  );
  assert.doesNotMatch(
    messageInputSource,
    /!bg-brutal-(cyan|lavender)/,
    "muted mention avatars should not add role-colored background fills",
  );
  assert.doesNotMatch(
    `${messageItemSource}\n${agentDetailSource}`,
    /!bg-gray-300 grayscale/,
    "deactivated agent avatars should not add gray background fills",
  );
  assert.doesNotMatch(
    searchPageSource,
    /result\.type === "agentDm"[\s\S]*?bg-brutal-cyan[\s\S]*?<Bot/,
    "search agent-DM fallbacks should use AvatarSlot instead of a cyan icon frame",
  );
  assert.doesNotMatch(
    paletteAuditSource,
    /avatar[\s\S]{0,200}bg-brutal-(cyan|lavender)|bg-brutal-(cyan|lavender)[\s\S]{0,200}avatar/,
    "palette avatar examples must document the no-fill AvatarSlot shape",
  );
});

test("compact quoted-message avatars route through AvatarSlot", () => {
  assert.match(
    quotedMessageCardSource,
    /<AvatarSlot context="compact-list" type="agent" agentAvatarUrl=\{author\.avatar \?\? null\} \/>/,
    "agent quote-preview avatars should use the shared avatar primitive",
  );
  assert.match(
    quotedMessageCardSource,
    /<AvatarSlot context="compact-list" type="human" humanAvatarUrl=\{author\.avatar \?\? null\} gravatarHash=\{author\.gravatarHash \?\? null\} \/>/,
    "human quote-preview avatars should use the shared avatar primitive",
  );
});

test("agent pixel avatars expose a stable share-screenshot marker", () => {
  assert.match(
    pixelAvatarSource,
    /data-agent-pixel-avatar="true"/,
    "share capture must be able to find CSS-grid pixel avatars before rasterization",
  );
});

test("AvatarSlot removes the global badge-size override and lets raft-ui own placement", () => {
  // Named decision: #proj-uiux task #817 removes the global badge size map.
  assert.match(
    avatarSlotSource,
    /<AvatarBadge render=\{badge\} \/>/,
    "AvatarSlot should pass rendered badges to raft-ui without placement overrides",
  );
  assert.doesNotMatch(
    avatarSlotSource,
    /RAFT_AVATAR_BADGE_SIZE|translate-x-1\/4|translate-y-1\/4|<AvatarBadge(?=[^>]*className=)[^>]*>/,
    "AvatarSlot must not restore the global badge size/placement override map",
  );
});

test("Sidebar list status dots use a scoped indicator shell without changing Members modal rows", () => {
  assert.match(
    sidebarSource,
    /function SidebarAgentActivityBadge\(\{ agentId \}: \{ agentId: string \}\)[\s\S]*data-sidebar-avatar-badge-shell="true" className="absolute bottom-0 right-0 block size-0"[\s\S]*<AgentActivityDot[\s\S]*size="sm"[\s\S]*className="absolute left-1\/2 top-1\/2 -translate-x-1\/2 -translate-y-1\/2"/,
    "chat DM and Members rail rows should keep the smaller activity-mapped status dot through a scoped shell without overriding AvatarBadge placement",
  );
  const sidebarBadgeSource = sidebarSource.match(
    /function SidebarAgentActivityBadge[\s\S]*?\n}\n/,
  )?.[0] ?? "";
  assert.doesNotMatch(
    sidebarBadgeSource,
    /\bpulse\b/,
    "sidebar online presence must stay static; thinking/working retain their activity-mapped pulse",
  );
  assert.doesNotMatch(
    sidebarSource,
    /data-sidebar-avatar-badge-shell="true" className="(?![^"]*absolute bottom-0 right-0)[^"]*"/,
    "the scoped shell must anchor the visual dot to the avatar's bottom-right corner",
  );
  assert.match(
    sidebarSource,
    /context="sidebar-list"[\s\S]*badge=\{peerId \? <SidebarAgentActivityBadge agentId=\{peerId\} \/> : undefined\}/,
    "agent DM rows should use the scoped sidebar status badge",
  );
  assert.match(
    sidebarSource,
    /context="sidebar-list"[\s\S]*badge=\{<SidebarAgentActivityBadge agentId=\{agent\.id\} \/>\}/,
    "Members page agent rows should use the scoped sidebar status badge",
  );
  assert.doesNotMatch(
    channelMemberListSource,
    /SidebarAgentActivityBadge|size="sm"|data-sidebar-avatar-badge-shell/,
    "ChannelMemberList must not use the smaller sidebar-only status badge",
  );
  assert.match(
    channelMemberListSource,
    /function ChannelMemberActivityBadge\([\s\S]*data-channel-member-avatar-badge-shell="true" className="absolute bottom-0 right-0 block size-0"[\s\S]*<AgentActivityDot[\s\S]*size="md"[\s\S]*pulse[\s\S]*-translate-x-1\/2 -translate-y-1\/2/,
    "ChannelMemberList agent rows should use a one-step-larger pulsing dot through a scoped shell",
  );
});
