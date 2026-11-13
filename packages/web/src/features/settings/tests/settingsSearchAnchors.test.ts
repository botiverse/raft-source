// Every setting the web's Settings search finds can be opened at: it has the
// web's words, a Settings page, and exactly one element with its id among the
// files that draw that page (/settings/<page>#<id>, useScrollToSettingsSection).
// A source check, so a row that loses or renames its id fails here rather than
// opening the page at the top.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../i18n/messages/en";
import { settingsTabIdForRouteSlug } from "../../../components/settings/settingsNavigation";
import { SETTINGS_SEARCH_COPY, settingsSearchEntriesFor } from "../search/settingsSearchCopy";

const SRC = resolve(import.meta.dirname, "../../..");

/** The file that holds each setting's row, from src/. */
const ANCHOR_FILE: Readonly<Record<string, string>> = {
  "display-name": "features/settings/account/AccountSection.tsx",
  username: "features/settings/account/AccountSection.tsx",
  email: "features/settings/account/AccountSection.tsx",
  password: "features/settings/account/AccountSection.tsx",
  passkeys: "components/settings/PasskeysSection.tsx",
  "two-step": "components/settings/TwoStepVerificationSection.tsx",
  "sign-out": "features/settings/account/AccountSignOutSection.tsx",
  "delete-account": "features/settings/account/DeleteAccountSection.tsx",
  "display-language": "features/settings/language-region/LanguageRegionSection.tsx",
  "translation-mode": "features/settings/language-region/LanguageRegionSection.tsx",
  "time-format": "features/settings/language-region/LanguageRegionSection.tsx",
  timezone: "features/settings/language-region/LanguageRegionSection.tsx",
  "message-font-size": "features/settings/appearance/AppearanceSection.tsx",
  "live-agent-activity": "features/settings/appearance/AppearanceSection.tsx",
  "show-agent-model": "features/settings/appearance/AppearanceSection.tsx",
  "show-sender-description": "features/settings/appearance/AppearanceSection.tsx",
  "hide-empty-sidebar-sections": "features/settings/appearance/AppearanceSection.tsx",
  "send-with": "features/settings/appearance/ComposerSendKeySetting.tsx",
  "push-notifications": "components/settings/notifications/ThisDeviceCard.tsx",
  "pause-notifications": "components/settings/notifications/PauseAndScheduleCard.tsx",
  "quiet-hours": "components/settings/notifications/PauseAndScheduleCard.tsx",
  "notification-preview": "components/settings/notifications/ContentCard.tsx",
  "notification-sound": "components/settings/notifications/ContentCard.tsx",
  "notification-followed-thread-replies": "components/settings/notifications/ContentCard.tsx",
  theme: "components/settings/ServerThemeSection.tsx",
  "server-theme": "components/settings/ServerThemeSection.tsx",
  "mute-server": "components/settings/notifications/ServersCard.tsx",
  "server-name": "features/settings/server/ProfileSection.tsx",
  "public-access": "features/settings/server/PublicVisibilitySection.tsx",
  "leave-server": "features/settings/server/DangerZoneSection.tsx",
  plan: "components/settings/PlanSectionContent.tsx",
  "invite-links": "features/settings/administration/JoinLinksSection.tsx",
  "single-sign-on": "features/settings/sso/ServerSsoSection.tsx",
  "member-permissions": "features/settings/administration/MemberPermissionsSection.tsx",
  "ai-providers": "components/settings/ProviderConnectionsSettings.tsx",
  "desktop-app": "features/settings/about/AboutSection.tsx",
};

/** A file's code without its comments, so an id named in a comment doesn't count. */
function codeOf(file: string): string {
  return readFileSync(resolve(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** How many JSX attributes `id="<id>"` or `id={"<id>"}` the code has. */
function anchorCount(code: string, id: string): number {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return code.match(new RegExp(`(?<![\\w-])id=(?:"${escaped}"|\\{"${escaped}"\\})`, "g"))?.length ?? 0;
}

const webEntries = [...new Map([...settingsSearchEntriesFor("web"), ...settingsSearchEntriesFor("desktop")].map((entry) => [entry.id, entry])).values()];

test("the web has settings to search", () => {
  assert.ok(webEntries.length >= 30, `expected the index's web settings, found ${webEntries.length}`);
});

test("each web setting has the web's words, and each line of words is a web setting", () => {
  for (const entry of webEntries) {
    const copy = SETTINGS_SEARCH_COPY[entry.id];
    assert.ok(copy, `${entry.id}: add its name (and description, section) to SETTINGS_SEARCH_COPY`);
    for (const id of [copy.nameId, copy.descriptionId, copy.sectionId]) {
      if (id) assert.ok(id in en, `${entry.id}: ${id} is not in the catalog`);
    }
  }
  const webIds = new Set(webEntries.map((entry) => entry.id));
  assert.deepEqual(Object.keys(SETTINGS_SEARCH_COPY).filter((id) => !webIds.has(id)), [], "words for a setting the index doesn't have for the web");
});

test("each web setting is on a Settings page", () => {
  for (const entry of webEntries) {
    assert.ok(settingsTabIdForRouteSlug(entry.page), `${entry.id}: ${entry.page} is not a Settings page`);
  }
});

test("each web setting's file is listed here, and each listed file is a web setting's", () => {
  const webIds = new Set(webEntries.map((entry) => entry.id));
  assert.deepEqual(webEntries.filter((entry) => !ANCHOR_FILE[entry.id]).map((entry) => entry.id), [], "add the file that holds its row to ANCHOR_FILE");
  assert.deepEqual(Object.keys(ANCHOR_FILE).filter((id) => !webIds.has(id)), [], "a file for a setting the index doesn't have for the web");
});

test("each web setting has exactly one element with its id among its page's files", () => {
  const pageFiles = new Map<string, Set<string>>();
  for (const entry of webEntries) {
    const file = ANCHOR_FILE[entry.id];
    if (!file) continue;
    pageFiles.set(entry.page, (pageFiles.get(entry.page) ?? new Set()).add(file));
  }
  const problems: string[] = [];
  for (const entry of webEntries) {
    const file = ANCHOR_FILE[entry.id];
    if (!file) continue;
    if (anchorCount(codeOf(file), entry.id) === 0) problems.push(`${entry.id}: no id="${entry.id}" in ${file}`);
    const onPage = [...(pageFiles.get(entry.page) ?? [])].reduce((n, pageFile) => n + anchorCount(codeOf(pageFile), entry.id), 0);
    if (onPage > 1) problems.push(`${entry.id}: ${onPage} elements with its id on the ${entry.page} page`);
  }
  assert.deepEqual(problems, []);
});

test("the count reads JSX id attributes only", () => {
  assert.equal(anchorCount('<div id="plan" />', "plan"), 1);
  assert.equal(anchorCount('<div id={"plan"} />', "plan"), 1);
  assert.equal(anchorCount('<div data-id="plan" />', "plan"), 0);
  assert.equal(anchorCount('<div id="plan-card" />', "plan"), 0);
  assert.equal(anchorCount('<div id="plan" /><div id="plan" />', "plan"), 2);
});
