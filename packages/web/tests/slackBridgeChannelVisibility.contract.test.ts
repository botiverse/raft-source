import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const webRoot = resolve(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(webRoot, "src", path), "utf8");
}

test("channel identity carries provider-neutral bridge metadata without duplicating the channel selector", () => {
  const channelStore = source("store/channelStore.ts");
  const sidebar = source("components/layout/Sidebar.tsx");
  const settings = source("components/channel/EditChannelDialog.tsx");
  const create = source("components/channel/CreateChannelDialog.tsx");
  const bridgeField = source("components/channel/ChannelSlackBridgeField.tsx");

  assert.match(channelStore, /bridge\?:\s*\{[\s\S]*provider:\s*"slack"[\s\S]*providerConversationId:\s*string[\s\S]*state:/);
  assert.match(sidebar, /channel\.bridge[\s\S]*settings\.slackBridge\.providerBadge/);
  assert.doesNotMatch(settings, /channel\.edit\.slackBridgeTitle|providerConversationId/);
  assert.match(create, /ChannelSlackBridgeField[\s\S]*bridgeEditor\.apply\(channel\.id\)/);
  assert.match(settings, /ChannelSlackBridgeField[\s\S]*bridgeEditor\.apply\(channelId\)/);
  assert.match(bridgeField, /from "raft-ui"[\s\S]*<Select[\s\S]*items=\{selectOptions\}[\s\S]*<SelectTrigger className="w-full"/);
  assert.match(bridgeField, /pairedBySlackId[\s\S]*disabled:\s*occupied[\s\S]*<SelectItem[\s\S]*disabled=\{option\.disabled\}/);
  assert.doesNotMatch(bridgeField, /<select\b|<option\b/);
});

test("Slack Bridge master gate hides every setup entry and suppresses channel provisioning I/O", () => {
  const sidebar = source("components/layout/Sidebar.tsx");
  const settings = source("components/settings/SettingsPanel.tsx");
  const bridgeField = source("components/channel/ChannelSlackBridgeField.tsx");

  assert.match(sidebar, /useServerFeatureFlag\(SLACK_BRIDGE_FEATURE_FLAG_KEYS\.master\)[\s\S]*slackBridgeEnabled[\s\S]*id: "im-bridges"/);
  assert.match(settings, /requestedSettingsTab === "im-bridges" && !slackBridgeEnabled[\s\S]*\? "account"/);
  assert.match(bridgeField, /useServerFeatureFlag\(SLACK_BRIDGE_FEATURE_FLAG_KEYS\.master\)[\s\S]*!input\.canManage \|\| !launchEnabled[\s\S]*slackBridgeProvisioningProvider\.load/);
  assert.match(bridgeField, /if \(!launchEnabled \|\| !snapshot \|\| !available\) return/);
});

test("channel member hook keeps external projections separate from Raft principals", () => {
  const hook = source("hooks/useChannelMembers.ts");
  const members = source("components/agent/ChannelMembers.tsx");

  assert.match(hook, /export interface ChannelExternalMember[\s\S]*provider:\s*"slack"/);
  assert.match(hook, /agents:\s*\(data\.agents \?\? \[\]\) as ChannelAgent\[\]/);
  assert.match(hook, /humans:\s*\(data\.humans \?\? \[\]\) as ChannelHuman\[\]/);
  assert.match(hook, /externalMembers:\s*\(data\.externalMembers \?\? \[\]\) as ChannelExternalMember\[\]/);
  assert.match(hook, /channelExternalMembers[\s\S]*\? result\.externalMembers[\s\S]*EMPTY_CHANNEL_EXTERNAL_MEMBERS/);
  assert.match(members, /channelExternalMembers/);
  assert.match(members, /agent\.channelMembers\.slackParticipants/);
  assert.match(members, /settings\.slackBridge\.providerBadge/);
  assert.doesNotMatch(hook, /agents:\s*\(data\.externalMembers/);
  assert.doesNotMatch(hook, /humans:\s*\(data\.externalMembers/);
});
