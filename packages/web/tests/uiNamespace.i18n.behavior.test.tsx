import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import NotificationCenter from "../src/components/ui/NotificationCenter";
import type {
  NotificationCenterEntry,
} from "../src/components/ui/NotificationCenter";
import ServerSwitcherMenu from "../src/components/ui/ServerSwitcherMenu";
import QuotedMessageCard from "../src/components/ui/cards/QuotedMessageCard";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

// ui namespace (react-intl migration acceptance): the shared components/ui/
// primitives that carry their own copy — finalized by @AngLee on 2026-07-22
// (notes/i18n-ui-zh-final.md) — must actually reach the DOM in Chinese when the
// active display locale is zh-cn.
//
// Sibling of layoutNamespace.i18n.behavior.test.tsx. The teeth are spread across
// the THREE production call-site families the ui catalog owns — one family per
// component, because a single component rendering Chinese proves nothing about
// the other two:
//
//   1. NotificationCenter.tsx        → `ui.notificationCenter.*`
//   2. ServerSwitcherMenu.tsx        → `ui.serverSwitcher.*`   (PLACEHOLDER)
//   3. cards/QuotedMessageCard.tsx   → `ui.quotedMessage.*`
//
// Two ids interpolate an argument and are asserted twice — the seeded value must
// appear in the DOM AND no raw `{count}` / `{name}` may survive:
//   - `ui.notificationCenter.countItems` (count) — a plural in en, single arm zh.
//   - `ui.serverSwitcher.reorderServer` (name).

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

/** A server name no catalog string could ever contain — so finding it in the
 *  reorder button's accessible name can only mean the ICU `{name}` argument was
 *  really passed through. */
const PROBE_SERVER_NAME = "zh-probe-51820";

const probeServer: Server = {
  id: "server-probe",
  name: PROBE_SERVER_NAME,
  avatarUrl: null,
  slug: "probe",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-22T00:00:00.000Z",
};

function seedServerStore() {
  useServerStore.setState({
    current: probeServer,
    servers: [probeServer],
    members: [],
    loading: false,
    updateServerOrder: async () => {},
  } as never);
}

afterEach(() => {
  cleanup();
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

function renderZh(node: ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/s/probe"]}>
      <TestIntlProvider locale="zh-cn">{node}</TestIntlProvider>
    </MemoryRouter>,
  );
}

/** No message may leak an unresolved ICU argument into the DOM. */
function assertNoRawPlaceholders(scope: HTMLElement = document.body) {
  const text = scope.textContent ?? "";
  assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `unresolved ICU placeholder in: ${text.slice(0, 240)}`);
  for (const el of scope.querySelectorAll("[title], [aria-label], [placeholder]")) {
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attribute);
      if (value) assert.doesNotMatch(value, /\{[a-zA-Z]+\}/, `unresolved ICU placeholder in ${attribute}="${value}"`);
    }
  }
}

// Family 1a — NotificationCenter empty state / `ui.notificationCenter.*`.
test("NotificationCenter renders the finalized Chinese empty state + chrome under zh-cn", () => {
  renderZh(<NotificationCenter entries={[]} viewport="desktop" />);

  // Header title + dialog accessible name.
  assert.ok(screen.getByText("通知"), "notification-center title");
  assert.ok(screen.getByRole("dialog", { name: "通知中心" }), "notification-center aria-label");
  // Empty-state title + body.
  assert.ok(screen.getByText("暂无通知"), "empty-state title");
  assert.ok(screen.getByText("需要你关注的事项会显示在这里。"), "empty-state body");
  // With zero entries the count label reads the "all clear" arm.
  assert.ok(screen.getByText("全部已处理"), "count all-clear label");
  // No English remnant.
  assert.equal(screen.queryByText("No notifications right now"), null, "empty title not migrated");
  assert.equal(screen.queryByText("all clear"), null, "count label not migrated");
  assertNoRawPlaceholders();
});

// Family 1b — the count PLACEHOLDER. Three entries must render "3 项", the kind
// dot must carry the migrated accessible name, and no literal `{count}` survives.
test("NotificationCenter renders the count-items plural and kind labels under zh-cn", () => {
  const entries: NotificationCenterEntry[] = [
    { id: "n1", kind: "warning", title: "a" },
    { id: "n2", kind: "warning", title: "b" },
    { id: "n3", kind: "warning", title: "c" },
  ];
  renderZh(<NotificationCenter entries={entries} viewport="desktop" />);

  // countItems arg really reached the DOM: "{count} 项" with count=3.
  assert.ok(screen.getByText("3 项"), "count-items label with interpolated count");
  // The list aria-label + per-entry kind label are migrated too.
  assert.ok(screen.getByRole("list", { name: "通知" }), "list aria-label");
  assert.ok(screen.getAllByLabelText("警告").length >= 3, "warning kind labels");
  assert.equal(screen.queryByLabelText("Warning"), null, "kind label not migrated");
  assertNoRawPlaceholders();
});

// Family 2 — ServerSwitcherMenu / `ui.serverSwitcher.*`, including the reorder
// PLACEHOLDER whose `{name}` interpolates the real server name.
test("ServerSwitcherMenu renders the finalized Chinese actions + reorder placeholder under zh-cn", () => {
  seedServerStore();
  renderZh(
    <ServerSwitcherMenu open onClose={() => {}} serverUnreadCounts={{}} />,
  );

  // Footer action.
  assert.ok(screen.getByText("切换或创建服务器"), "switch-or-create action");
  assert.equal(screen.queryByText("Switch or Create Server"), null, "action not migrated");
  // reorderServer placeholder: the real server name must survive interpolation.
  const reorder = screen.getByRole("button", { name: `重新排序 ${PROBE_SERVER_NAME}` });
  assert.ok(reorder, "reorder button accessible name carries the interpolated server name");
  assert.match(reorder.getAttribute("aria-label") ?? "", new RegExp(PROBE_SERVER_NAME), "{name} argument reached the DOM");
  assertNoRawPlaceholders();
});

// Family 3 — QuotedMessageCard / `ui.quotedMessage.*` markers.
test("QuotedMessageCard renders the finalized Chinese unavailable marker under zh-cn", () => {
  renderZh(
    <QuotedMessageCard
      channelName="general"
      timestamp="12:00"
      author={{ name: "a", kind: "user" }}
      content=""
      unavailable
    />,
  );

  assert.ok(screen.getByText("消息不可用"), "unavailable marker");
  assert.equal(screen.queryByText("Message unavailable"), null, "marker not migrated");
  assertNoRawPlaceholders();
});

test("QuotedMessageCard renders the finalized Chinese thread + archived markers under zh-cn", () => {
  renderZh(
    <QuotedMessageCard
      channelName="general"
      timestamp="12:00"
      author={{ name: "a", kind: "user" }}
      content="hello"
      isThread
      isArchived
    />,
  );

  assert.ok(screen.getByText("消息列"), "thread marker");
  assert.ok(screen.getByText("已归档"), "archived marker");
  assert.equal(screen.queryByText("Thread"), null, "thread marker not migrated");
  assert.equal(screen.queryByText("Archived"), null, "archived marker not migrated");
  assertNoRawPlaceholders();
});
