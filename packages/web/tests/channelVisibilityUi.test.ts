import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("edit channel exposes visibility conversion as an explicit action", () => {
  const source = readSource("src/components/channel/EditChannelDialog.tsx");

  assert.doesNotMatch(source, /SegmentedControl/);
  assert.match(source, /const isJointChannel = channel\?\.type === "joint"/);
  assert.match(source, /const isAllChannel = initialName === "all"/);
  assert.match(source, /const showVisibilityAction = showManageActions/);
  assert.match(source, /!isJointChannel && showVisibilityAction && \(/);
  // These four actions and their three confirmation bodies moved into the
  // catalog (`channel.edit.*`). The STRUCTURAL contract — the component still
  // offers each action, and each confirmation still exists — is now anchored on
  // the message id; the WORDING contract is anchored on en.ts, so this test
  // keeps failing if the copy is silently changed as well as if it disappears.
  const messages = readSource("src/i18n/messages/en.ts");
  for (const id of [
    "channel.edit.makePrivate",
    "channel.edit.makePublic",
    "channel.edit.hideAll",
    "channel.edit.restoreAll",
    "channel.edit.confirmHideAll",
    "channel.edit.confirmMakePrivate",
    "channel.edit.confirmMakePublic",
  ]) {
    assert.match(source, new RegExp(`id: "${id.replace(/\./g, "\\.")}"`), `${id} must be used by EditChannelDialog`);
  }
  assert.match(messages, /"channel\.edit\.makePrivate": "Make Private"/);
  assert.match(messages, /"channel\.edit\.makePublic": "Make Public"/);
  assert.match(messages, /"channel\.edit\.hideAll": "Hide #all"/);
  assert.match(messages, /"channel\.edit\.restoreAll": "Restore #all"/);
  assert.match(messages, /#all will disappear from channel lists/);
  assert.match(messages, /Non-joined server members and historical thread followers will lose access/);
  assert.match(messages, /All server members will regain read access/);
  assert.match(source, /currentVisibility === "private" \? "public" : "private"/);
  assert.match(source, /updateChannel\(channelId, \{ visibility: nextVisibility \}\)/);
  assert.match(source, /isAllChannel && nextVisibility === "private"/);
  assert.match(source, /nav\.toChannel\(fallbackChannel\.id\)/);
});

test("administration settings expose hide #all as a checkbox setting", () => {
  const settingsSource = readSource("src/components/settings/SettingsPanel.tsx");
  const storeSource = readSource("src/store/channelStore.ts");

  assert.match(settingsSource, /function SystemChannelsSection\(\)/);
  assert.match(settingsSource, /channels\.find\(\(channel\) => channel\.name === "all"\)/);
  assert.match(settingsSource, /const currentAllChannelHidden = !allChannel/);
  assert.match(settingsSource, /useState\(currentAllChannelHidden\)/);
  assert.match(settingsSource, /capabilities\.changeChannelVisibility && !channelsLoading/);
  assert.match(settingsSource, /label=\{formatMessage\(\{ id: "settings\.systemChannels\.sectionLabel" \}\)\}/);
  assert.match(settingsSource, /<Checkbox/);
  assert.match(settingsSource, /checked=\{allChannelHidden\}/);
  assert.match(settingsSource, /setAllChannelHidden\(event\.currentTarget\.checked\)/);
  assert.match(settingsSource, /settings\.systemChannels\.hideAllTitle/);
  assert.match(settingsSource, /settings\.systemChannels\.hideAllDescription/);
  assert.match(settingsSource, /const dirty = allChannelHidden !== currentAllChannelHidden/);
  assert.match(settingsSource, /disabled=\{!dirty \|\| saving\}/);
  assert.match(settingsSource, /\) : formatMessage\(\{ id: "settings\.common\.save" \}\)/);
  // Both directions now go through #all's own endpoints. The generic visibility
  // field is refused for #all server-side (task #67), so a call to
  // updateChannel(allChannel.id, { visibility: "private" }) here would 403.
  assert.match(settingsSource, /await hideAllChannel\(\)/);
  assert.match(settingsSource, /await restoreAllChannel\(\)/);
  // Asserted as the absence of the binding rather than of a call shape: a call
  // shape can be satisfied by a comment, and a comment is not behaviour.
  assert.doesNotMatch(
    settingsSource,
    /useChannelStore\(\(s\) => s\.updateChannel\)/,
    "the system-channels section must not reach for the generic channel updater at all",
  );
  assert.match(settingsSource, /settingsTab === "administration" && <AdministrationTabContent \/>/);
  assert.match(storeSource, /restoreAllChannel: async \(\) =>/);
  assert.match(storeSource, /api\.post\("\/channels\/system\/all\/restore"\)/);
  assert.match(storeSource, /hideAllChannel: async \(\) =>/);
  assert.match(storeSource, /api\.post\("\/channels\/system\/all\/hide"\)/);
});
