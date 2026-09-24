import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import ProfilePanel from "../src/components/profile/ProfilePanel";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useProfileStore } from "../src/store/profileStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// profile batch (Task 8): ProfilePanel skeleton Loading… / Back via shared MessageIds.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

window.matchMedia = window.matchMedia ?? (() => ({
  matches: true,
  media: "",
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [], activityLogs: {} } as never);
  useProfileStore.setState({
    profileType: null,
    profileId: null,
    defaultAgentTabIntent: null,
  } as never);
  useServerStore.setState({ current: null, members: [], servers: [] } as never);
});

test("catalog pins profile skeleton MessageIds (shared common.*)", () => {
  assert.equal(en["common.loading"], "Loading…");
  assert.equal(en["common.announcement.back"], "Back");
  assert.match(zh["common.loading"], /\p{Script=Han}/u);
  assert.match(zh["common.announcement.back"], /\p{Script=Han}/u);
});

test("ProfilePanel renders its unresolved-profile skeleton in zh-cn", (t) => {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1" },
    members: [],
    servers: [],
  } as never);
  t.mock.method(api, "get", async () => await new Promise(() => undefined));

  render(
    <MemoryRouter initialEntries={["/s/server-1/members"]}>
      <TestIntlProvider locale="zh-cn">
        <ProfilePanel
          target={{ type: "agent", id: "loading-agent" }}
          presentation="embedded"
          onBack={() => undefined}
          onClose={() => undefined}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId("profile-panel"));
  assert.equal(screen.getByText(zh["common.loading"]).textContent, zh["common.loading"]);
  assert.equal(
    screen.getByTestId("agent-mobile-back").getAttribute("title"),
    zh["common.announcement.back"],
  );
  assert.ok(screen.getByRole("button", { name: zh["common.close"] }));
});
