import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import MemberGraphSection from "../src/components/settings/MemberGraphSection";
import SettingsNavList from "../src/components/settings/SettingsNavList";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useServerStore } from "../src/store/serverStore";

// Settings sub-batch H1: MemberGraphSection + SettingsNavList — the PURE
// string-swap half of the remaining Settings residue. The structural half
// (AppNotificationsControls' module-level Record constants → Record<..., MessageId>)
// is deliberately a separate batch so review isn't mixing two risk profiles.
//
// PRE-PR SWEEP (per @artin's feedback: close the class, don't wait for review to
// find instances). Sweeping both files for user-facing string props confirmed the
// scanner's list was complete — but the sweep itself had a GAP it then exposed:
//
//   my regex matched JSX attributes (`prop="v"`) and missed DEFAULT PARAMETERS
//   (`prop = "v"` in a destructuring signature). That is how
//   `sectionLabel = "Member Graph"` survived — the same latent-default class as
//   SelectionPopover's `emptyLabel = "No matches"` fixed in #5716.
//
// The default is now resolved through the catalog. Today's only caller
// (MainLayout) passes sectionLabel explicitly, so this is a latent leak, not a
// live one — fixed anyway, because "no caller hits it yet" is a fact about today.

const originalGet = api.get;
const initialServerState = useServerStore.getInitialState();

const IDS = [
  "settings.tabs.navAriaLabel",
  "settings.tabs.navTitle",
  "settings.tabs.groupPersonal",
  "settings.tabs.groupWorkspace",
  "settings.tabs.groupAbout",
  "settings.tabs.about",
  "settings.memberGraph.graphAriaLabel",
  "settings.memberGraph.sectionLabel",
  "settings.memberGraph.humans",
  "settings.memberGraph.agents",
  "settings.memberGraph.links",
  "settings.memberGraph.mostConnectedTitle",
  "settings.memberGraph.noMemberships",
  "settings.memberGraph.largestChannelsTitle",
  "settings.memberGraph.noVisibleChannels",
  "settings.memberGraph.refresh",
  "settings.memberGraph.emptyState",
  "settings.memberGraph.loadFailed",
];

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(initialServerState, true);
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of IDS) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    // `agents` is intentionally "Agent" in zh — the product keeps the English
    // word for the participant type (cf. 引导 Agent / 新 Agent 问候 in the
    // existing catalog), so it is exempt from the Han-character requirement.
    if (id !== "settings.memberGraph.agents") {
      assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
    }
  }
});

test("the settings nav exposes a Chinese accessible name", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SettingsNavList activeTab="account" onSelect={() => {}} />
    </TestIntlProvider>,
  );

  // Queried by role+name: this is an aria-label, so only the accessible name
  // proves it — visible text cannot.
  assert.ok(
    screen.getByRole("complementary", { name: "设置分区" }),
    "settings nav accessible name",
  );
  assert.equal(
    document.querySelector('[aria-label="Settings sections"]'), null,
    "no untranslated nav aria-label",
  );

  // Found by the pre-PR sweep only after widening it past JSX props: the panel
  // header was bare JSX text ("Settings"), and the group headers lived as object
  // literals in settingsNavigation.ts — neither shape was in the scanner's list
  // nor my first sweep regex.
  // Asserted over textContent rather than within(...).getByText: the
  // testing-library queries hung this file for 76s (module loaded fine — it was
  // query cost, not a parse error). Direct text inspection is deterministic here
  // and these are plain static labels.
  const navText = screen.getByTestId("workspace-settings-navigation").textContent ?? "";
  // 工作空间 (not 工作区) — same concept as layout.sidebar.settingsGroupServer;
  // @AngLee ruled this the standing term. The agent's own working directory
  // keeps 工作区; different concept, do not unify them.
  for (const zh of ["设置", "个人", "工作空间", "资源", "关于"]) {
    assert.ok(navText.includes(zh), `nav should render ${zh}`);
  }
  for (const enWord of ["Personal", "Workspace", "Resources"]) {
    assert.ok(!navText.includes(enWord), `untranslated group header: ${enWord}`);
  }
});

test("the member graph resolves its default chrome through the zh-cn catalog", async () => {
  useServerStore.setState({
    current: { id: "server-1", name: "Raft Test", slug: "raft-test" },
  } as never);
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-1/member-graph");
    return { data: { humans: [], agents: [], channels: [], edges: [] } };
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemberGraphSection />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    assert.ok(screen.getByText(zhMessages["settings.memberGraph.emptyState"]));
  });
  for (const id of [
    "settings.memberGraph.sectionLabel",
    "settings.memberGraph.refresh",
    "settings.memberGraph.humans",
    "settings.memberGraph.agents",
    "settings.memberGraph.links",
    "settings.memberGraph.mostConnectedTitle",
    "settings.memberGraph.noMemberships",
    "settings.memberGraph.largestChannelsTitle",
    "settings.memberGraph.noVisibleChannels",
  ] as const) {
    assert.ok(screen.getByText(zhMessages[id]), `${id} should render through zh-cn`);
  }
  assert.equal(screen.queryByText("Member Graph"), null);
  assert.equal(screen.queryByText("Refresh"), null);
});

test("settings-modal nav group headers stay value-equal to the left sidebar's", () => {
  // WHY THIS EXISTS: `layout.sidebar.settingsGroup*` (left sidebar) and
  // `settings.tabs.group*` (settings-modal nav) are two key sets holding the SAME
  // three group headers for two different components. Maintaining them separately
  // is exactly how they drifted: H1 shipped 工作区 while wave-2 had already settled
  // 工作空间 for the same concept — caught by @AngLee in review, not by any test.
  //
  // @Wug and I chose an assertion over merging the key sets: the component
  // boundary is real, so sharing ids would couple settings to layout.* for a
  // cosmetic win. This blocks the drift without the coupling.
  const pairs: Array<[string, string]> = [
    ["settings.tabs.groupPersonal", "layout.sidebar.settingsGroupPersonal"],
    ["settings.tabs.groupWorkspace", "layout.sidebar.settingsGroupServer"],
    ["settings.tabs.groupAbout", "layout.sidebar.settingsGroupAbout"],
  ];

  for (const [settingsId, layoutId] of pairs) {
    for (const [name, catalog] of [
      ["en", enMessages as Record<string, string>],
      ["zh-cn", zhMessages as Record<string, string>],
    ] as const) {
      assert.ok(catalog[settingsId], `${settingsId} missing from ${name}`);
      assert.ok(catalog[layoutId], `${layoutId} missing from ${name}`);
      assert.equal(
        catalog[settingsId],
        catalog[layoutId],
        `${name}: "${settingsId}" and "${layoutId}" are the same group header and must `
          + "not drift apart — change both or neither",
      );
    }
  }
});

test("node link counts use an ICU plural, not an English suffix", () => {
  // `{degree} links` concatenated an English word onto a number. That cannot
  // pluralize or reorder in translation; zh needs "{count} 个连接" with the unit
  // in a different position entirely.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  assert.match(en["settings.memberGraph.nodeLinks"], /\{count, plural,/, "en must be an ICU plural");
  assert.match(zh["settings.memberGraph.nodeLinks"], /\{count, plural,/, "zh must be an ICU plural");
  // zh has a single `other` arm by convention (cf. message.chatPanel.*).
  assert.ok(
    !zh["settings.memberGraph.nodeLinks"].includes("one {"),
    "zh plural should use a single other arm",
  );
});
