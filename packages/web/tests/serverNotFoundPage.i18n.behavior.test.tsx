import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { ServerAccessDeniedPage, ServerSelectionPage } from "../src/App";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// App.tsx — 5 ids, all in ServerAccessDeniedPage.
//
// SCOPE, because the raw numbers disagree: the sweep reports 25 candidates in
// this file and the queue listed it as "10". Only FIVE are user-visible.
//   * ~17 belong to SlockdevDebugPanel / EnvironmentBadge, which return null
//     unless deploymentEnv === "slockdev" — a local raftdev environment. They
//     never render in production, staging, or preview, for any user.
//   * 2 are console.error text (`Failed to join ${slug} from direct route`,
//     `Failed to accept joint channel invite`) — developer-facing.
// Localizing either group is waste, so they are deliberately out of scope rather
// than silently skipped. If that call is wrong, it is wrong visibly.
//
// ServerAccessDeniedPage is newly exported so this test can mount it. It has no
// import.meta.env gate, so unlike WorkspaceModeSettingsCard it genuinely is
// render-testable — and the test below actually mounts it, rather than the
// export being decoration that implies coverage it does not provide.

afterEach(() => {
  cleanup();
  useServerStore.setState({ servers: [], current: null, members: [] } as never);
});

/** Defaults to ServerAccessDeniedPage. Takes an explicit node for the other
 *  components in this file — it previously ignored its argument entirely, which
 *  meant a test could believe it was mounting one component while rendering
 *  another. The added assertion is what surfaced that. */
function renderZh(node: ReactElement = <ServerAccessDeniedPage />) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>{node}</MemoryRouter>
    </TestIntlProvider>,
  );
}

test("with a fallback server, the page names it inside the sentence", () => {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "home", name: "回声工作区", role: "owner" }],
    current: { id: "s1", slug: "home", name: "回声工作区", role: "owner" },
    members: [], loading: false,
  } as never);
  renderZh();

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("未找到服务器"), "title");
  assert.ok(text.includes("3 秒后将跳转到 回声工作区。"), "server name interpolated into the zh clause");
  assert.ok(text.includes("前往我的服务器"), "action");
  assert.ok(!text.includes("Redirecting to"), "no untranslated sentence");
  assert.ok(!text.includes("Server not found"), "no untranslated title");
});

test("with no fallback server, the other branch of every pair renders", () => {
  // Both strings here are the ELSE arms — a render with a server never reaches
  // them, and they are exactly the pair a later "dedupe" could collapse.
  renderZh();

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("3 秒后将跳转到你的服务器列表。"), "list-redirect sentence");
  assert.ok(text.includes("选择服务器"), "choose-a-server action");
  assert.ok(!text.includes("Choose a server"), "no untranslated action");
});

test("the server name is a movable tag, not a fixed code position", () => {
  // English puts the name mid-sentence, Chinese puts it at the end. If the
  // <strong> stayed in the JSX around a bare {name}, the zh translation could
  // not move it — the sentence would be assembled in English word order forever.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const cat of [en, zh]) {
    assert.match(cat["pages.serverNotFound.redirectingToServer"], /<name><\/name>/, "tag must live in the message");
  }
  assert.notEqual(
    en["pages.serverNotFound.redirectingToServer"].indexOf("<name>"),
    zh["pages.serverNotFound.redirectingToServer"].indexOf("<name>"),
    "the whole point is that the two locales place it differently",
  );
});

test("both branch pairs stay distinct and translated", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  const ids = Object.keys(en).filter((k) => k.startsWith("pages.serverNotFound."));
  assert.equal(ids.length, 5);
  for (const id of ids) {
    assert.notEqual(zh[id], en[id], `${id} is still English`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  assert.notEqual(zh["pages.serverNotFound.goToMyServer"], zh["pages.serverNotFound.chooseServer"]);
  assert.notEqual(zh["pages.serverNotFound.redirectingToServer"], zh["pages.serverNotFound.redirectingToList"]);
});

test("the servers-loading state renders in Chinese, from ONE shared id", async () => {
  // @Wug's finding on #5762. I claimed the remaining scanner hits were all
  // dev-only. I had SIX scanner findings I could not enumerate — `--help` printed
  // the default report so I assumed they matched my sweep's dev-only set instead
  // of finding the `--list` flag that prints them. Five were live user-facing
  // loading states on production paths.
  //
  // My sweep missed them too, for the SIXTH enumerated-character-class bug in a
  // row: rule 3b's class had no ELLIPSIS, so "Loading servers…" escaped while its
  // three-word siblings did not. Both JSX-text rules now exclude markup chars
  // rather than enumerate allowed ones.
  useServerStore.setState({ servers: [], current: null, members: [], loading: true } as never);
  renderZh(<ServerSelectionPage />);

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("正在加载服务器…"), "loading state must be Chinese");
  assert.ok(!text.includes("Loading servers"), "no untranslated loading state");
});

test("loading and joining-community copy stay distinct and translated", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const id of ["pages.app.loadingServers", "pages.app.joiningCommunity"]) {
    assert.notEqual(zh[id], en[id], `${id} is still English`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  assert.notEqual(zh["pages.app.loadingServers"], zh["pages.app.joiningCommunity"]);
});
