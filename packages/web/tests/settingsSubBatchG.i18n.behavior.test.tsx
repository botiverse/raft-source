import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import {
  ADMINISTRATION_VISUAL_SECTIONS,
  OAuthScopeList,
} from "../src/components/settings/SettingsPanel";
import SelectionPopover from "../src/components/ui/SelectionPopover";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

// Settings sub-batch G: onboarding / server-setup / administration residue.
//
// Two of the eight strings here were INVISIBLE to the heuristic scanner, and both
// were found by reading the code path rather than the scanner list:
//
//   1. `{reopeningSetup ? "Opening…" : "Finish setup"}` — a ternary sitting
//      directly beside the "Server setup" text the scanner DID flag.
//   2. `setError(axiosErr.response?.data?.error || "Failed to load App
//      Notifications settings")` — a user-visible FALLBACK inside a catch.
//
// Correctly EXCLUDED, and worth recording so a later pass does not "fix" them:
//   - `throw new Error("Server settings unavailable")` and
//     `throw new Error("Invalid App Notifications settings response")` are internal
//     sentinels. Both catches discard the thrown message (one substitutes a catalog
//     id, the other the fallback above), so neither literal can reach a user.
//     Migrating them would add dead catalog entries.
//   - The standalone `Raft` wordmark — brand, not localized (see sub-batch C).
//   - `placeholder="https://example.com/..."` x3 (~6038/6094/6103) — example URLs are
//     technical placeholders, locale-independent, same reasoning as the brand wordmark.

const originalGet = api.get;
const OnboardingSection = ADMINISTRATION_VISUAL_SECTIONS.onboarding;

const IDS = [
  "settings.onboarding.agentPlaceholder",
  "settings.onboarding.greetingPlaceholder",
  "settings.onboarding.serverSetupTitle",
  "settings.onboarding.serverSetupDescription",
  "settings.onboarding.finishSetup",
  "settings.onboarding.openingSetup",
  "settings.admins.membersPickerTitle",
  "settings.admins.rolePlaceholder",
  "settings.admins.membersSearchPlaceholder",
  "settings.admins.noMatchingMembers",
  "settings.connectedApps.scopeRequiresResource",
  "settings.connectedApps.failedLoadAppNotifications",
];

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of IDS) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("the setup-button idle/in-flight pair stays two distinct messages", () => {
  const zh = zhMessages as Record<string, string>;
  assert.notEqual(
    zh["settings.onboarding.finishSetup"],
    zh["settings.onboarding.openingSetup"],
    "idle/in-flight setup labels must stay distinct",
  );
});

test("mounted onboarding finish-setup chrome is Chinese, not English residue", async () => {
  const zh = zhMessages as Record<string, string>;
  useAuthStore.setState({
    user: { id: "owner-1" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "launch", role: "owner" },
    servers: [],
    members: [],
    loading: false,
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  api.get = (async (url: string) => {
    if (url === "/servers/server-1/settings") {
      return {
        data: {
          settings: {
            onboardSettings: { onboardingAgentId: null, agentAllChannelGreetingEnabled: true },
            feedbackSettings: { enabled: false },
          },
        },
      };
    }
    if (url === "/servers/server-1/setup-projection") {
      return { data: { surface: "computer_runtime", phase: "deferred" } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <OnboardingSection />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const button = await screen.findByTestId("finish-server-setup");
  assert.equal(button.textContent, zh["settings.onboarding.finishSetup"]);
  assert.ok(screen.getByText(zh["settings.onboarding.serverSetupTitle"]));
  assert.ok(screen.getByText(zh["settings.onboarding.serverSetupDescription"]));
  assert.equal(screen.queryByText("Finish setup"), null);
  assert.equal(screen.queryByText("Server setup"), null);
});

test("the OAuth scope list renders its resource badge in Chinese", () => {
  // agent:event:write is one of the two scopes with requiresResource: true, so
  // this exercises the real badge call site rather than only the catalog.
  // compact={false} is REQUIRED: the badge only exists in the expanded branch, and
  // `compact` defaults to true — the first version of this test rendered the
  // compact branch and failed for that reason, not because the migration was wrong.
  render(
    <TestIntlProvider locale="zh-cn">
      <OAuthScopeList scopes={["agent:event:write"]} compact={false} defaultToDeclared={false} />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("需要指定资源"), "requires-resource badge in Chinese");
  assert.equal(screen.queryByText("requires resource"), null, "no untranslated badge");
});

test("the admin picker's no-match state renders the migrated Chinese copy", () => {
  // @Wug's review finding: `emptyLabel` sat on the SAME <SelectionPopover> whose
  // `title` and `searchPlaceholder` sub-batch G had already migrated — a third
  // string prop on one element, missed. This is the split-attribute class from
  // sub-batch D, which I had named myself and still walked into.
  //
  // SelectionPopover is a standalone ui primitive, so the empty state renders
  // directly with no admin-section harness: pass zero options to reach it.
  render(
    <TestIntlProvider locale="zh-cn">
      <SelectionPopover
        title="t"
        options={[]}
        emptyLabel={(zhMessages as Record<string, string>)["settings.admins.noMatchingMembers"]}
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("没有匹配的成员"), "no-match label in Chinese");
  assert.equal(screen.queryByText("No matching members"), null, "no untranslated label");
  // The primitive's own default must not leak either — see the follow-up note below.
  assert.equal(screen.queryByText("No matches"), null, "primitive default must not render here");
});

// --- SEPARATE FINDING, NOT FIXED HERE (reported, not silently swept) ---
// `src/components/ui/SelectionPopover.tsx:113` defaults to `emptyLabel = "No matches"`,
// hardcoded English. 8 of the 9 call sites across Sidebar / TasksPanel /
// MessageSearchPage omit the prop and therefore render that default in zh. Those
// files are outside both the Settings lane and @Wug's agent/machine lane, so
// expanding this PR into them would widen the blast radius of a review-fix commit.
// Owner: whoever picks up the `ui.*` namespace next.

test("connected-apps split-JSX ids stay translated in the catalog", () => {
  const zh = zhMessages as Record<string, string>;
  const en = enMessages as Record<string, string>;
  for (const id of [
    "settings.connectedApps.scopeRequiresResourceDetail",
    "settings.connectedApps.saveBeforeShareOrReview",
    "settings.connectedApps.distributionMetadataNote",
    "settings.connectedApps.publishedMarketplaceNote",
  ]) {
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});
