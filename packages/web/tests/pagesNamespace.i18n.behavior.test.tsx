import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderWithIntl } from "./helpers/intl";
import api from "../src/api/client";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import HumanLoginSetupPage from "../src/pages/HumanLoginSetupPage";
import IntegrationInvitePage from "../src/pages/IntegrationInvitePage";
import PaletteAuditPage from "../src/pages/PaletteAuditPage";

// Behavior gate for the `pages.*` react-intl migration (4 standalone routed
// pages under src/pages/). Each page is rendered under the zh-cn locale and we
// assert a representative @AngLee-final Chinese string reaches the DOM — proving
// the page reads through the react-intl catalog rather than an inline English
// literal, and that the zh key actually resolved (no raw `pages.*` id leaks).
//
// The pages namespace includes ICU-placeholder ids (e.g. connectTitle's
// {serviceName}/{serverName}) and a rich-text tag id (useAccountWith wraps the
// service name in a <b> emphasis), so we assert their *resolved* zh reaches the
// DOM — proving placeholders/tags interpolate rather than leaking a raw `{…}`
// pattern or an unresolved `pages.*` id.

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  window.history.pushState({}, "", "/");
});

function assertNoRawPagesId() {
  // A missing zh key would fall back to the raw id (or the en overlay); assert
  // no `pages.` id string leaked into the rendered output.
  assert.doesNotMatch(document.body.textContent ?? "", /pages\.[a-zA-Z]+\./);
}

test("DeviceLoginPage renders zh-cn approved copy", () => {
  window.history.pushState({}, "", "/login/device");
  renderWithIntl(<DeviceLoginPage />, { locale: "zh-cn" });

  assert.ok(screen.getByText("使用其他账户"));
  assert.ok(screen.getByText("设备代码"));
  assertNoRawPagesId();
});

test("HumanLoginSetupPage renders zh-cn setup chrome", () => {
  window.history.pushState({}, "", "/login-with-raft/setup");
  renderWithIntl(<HumanLoginSetupPage />, { locale: "zh-cn" });

  assert.ok(screen.getByText("登录方式"));
  assert.ok(screen.getByText("使用 Raft 登录"));
  assert.ok(screen.getByText("常见问题"));
  assertNoRawPagesId();

  // Regression guard for the mixed-language leak @赵梓淇 caught: the connect title
  // and the "this server" fallback were hardcoded English that #3874's catalog
  // missed, so under zh they showed e.g. "该服务 wants to connect to this server".
  // These pin that no such English leaks and that the connect title renders its
  // reorderable ICU zh (with the server fallback spliced in — no server is
  // selected in this default render).
  const body = document.body.textContent ?? "";
  assert.doesNotMatch(body, /wants to connect/i, "connect title must not leak English");
  assert.doesNotMatch(body, /\bthis server\b/i, "server fallback must not leak English");
  assert.ok(screen.getByText(/想要连接到\s*此服务器/), "connect title renders the approved zh with the localized server fallback");

  // finding 2 (@铁根): the connect subtitle used a prefix + <strong> + suffix split
  // whose literal JSX spaces rendered "配合 该服务 。" in zh. It is now one rich-text
  // ICU; pin the exact zh — service name in <strong> emphasis, and NO space injected
  // before the name or the 句号.
  const useAccountLine = screen.getByText(
    (_content, el) =>
      el?.tagName === "P" &&
      el.textContent === "在可用的 Raft Server 上，使用你的 Raft 账户配合该服务。",
  );
  assert.equal(
    useAccountLine.querySelector("strong")?.textContent,
    "该服务",
    "service name stays in <strong> emphasis",
  );
});

test("IntegrationInvitePage renders zh-cn install header", () => {
  api.get = (async () => new Promise(() => {})) as typeof api.get;
  renderWithIntl(
    <MemoryRouter initialEntries={["/integration-invites/share-token"]}>
      <Routes>
        <Route path="/integration-invites/:token" element={<IntegrationInvitePage />} />
      </Routes>
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  assert.ok(screen.getByText("安装已连接应用"));
  assert.ok(screen.getByText("私有应用邀请"));
  assert.ok(screen.getByText("正在加载邀请…"));
  assertNoRawPagesId();
});

test("PaletteAuditPage renders zh-cn audit chrome", () => {
  renderWithIntl(<PaletteAuditPage />, { locale: "zh-cn" });

  assert.ok(screen.getByText("调色板审查"));
  assert.ok(screen.getByText("真实界面中的 Brutal 调色板"));
  // solidTints renders once per ColorRow (one swatch scale per palette token).
  assert.ok(screen.getAllByText("纯色 + 淡化").length >= 1);
  assert.ok(screen.getByText("引用消息内容"));
  assert.ok(screen.getByText("那艘船看上去很危险"));
  assert.doesNotMatch(document.body.textContent ?? "", /quoted message contents/i);
  assert.doesNotMatch(document.body.textContent ?? "", /that ship looks risky/i);
  assertNoRawPagesId();
});
