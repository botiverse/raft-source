import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import WikiPanel from "../src/components/wiki/WikiPanel";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

// Real rendered zh coverage for the wiki main states (batch F2) — @Wug asked
// for behavior-level guards, not source pins. Each state's migrated catalog
// copy must appear under zh-cn, and the old English must not.

const noop = () => {};

function seedWikiServer() {
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server" },
  } as never);
  useChannelStore.setState({ openDM: noop } as never);
}

function renderWikiZh() {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <WikiPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useServerStore.setState({ current: null } as never);
});

test("wiki setup state renders the migrated zh under zh-cn", async () => {
  seedWikiServer();
  api.get = (async () => ({
    data: {
      space: { status: "setup_required" as const },
      job: null,
    },
  })) as typeof api.get;

  renderWikiZh();

  assert.ok(await screen.findByText("设置服务器的 Wiki"));
  assert.ok(screen.getByText("设置只会创建这两项。扫描会在你按下「初始化」后开始。"));
  assert.ok(screen.getByText("设置 Wiki"), "setup card button");
  assert.equal(screen.queryByText("Setup"), null);
  assert.equal(screen.queryByText("Setup Wiki"), null);
  assert.equal(screen.queryByText("Setup only creates these two."), null);
});

test("wiki error state renders the migrated zh under zh-cn", async () => {
  seedWikiServer();
  api.get = (async () => ({
    data: {
      space: { status: "error" as const },
      job: { status: "failed" as const, error: "boom" },
    },
  })) as typeof api.get;

  renderWikiZh();

  assert.ok(await screen.findByText("重试初始化"));
  assert.ok(screen.getByText("Wiki 维护失败"), "error banner title");
  assert.equal(screen.queryByText("Retry initialization"), null);
});

test("wiki ready state renders the migrated zh under zh-cn", async () => {
  seedWikiServer();
  api.get = (async () => ({
    data: {
      space: {
        status: "ready_uninitialized" as const,
        wikiAgentName: null,
        wikiAgentId: null,
        wikiChannelName: null,
        wikiChannelId: null,
      },
      job: null,
    },
  })) as typeof api.get;

  renderWikiZh();

  assert.ok(await screen.findByText("Wiki 资源已就绪"));
  assert.ok(screen.getByText(/准备好构建第一批 Wiki 文档时/));
  assert.ok(screen.getByText(/Wiki Agent 会读取符合条件的公共频道历史/), "ready long paragraph");
  assert.ok(screen.getByText(zhCn["wiki.agentLabel"]), "agent label is rendered through the catalog");
  assert.ok(screen.getByText(`#${zhCn["wiki.channelNameFallback"]}`), "missing channel name uses the catalog fallback");
  assert.equal(screen.queryByText("Wiki resources are ready"), null);
  assert.equal(screen.queryByText(/reads eligible public channel history/), null);
});

test("active wiki status renders localized pending ingest and lint schedules", async () => {
  seedWikiServer();
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      return {
        data: {
          space: {
            status: "active" as const,
            lastScannedAt: null,
            dailyScanNextAt: null,
            weeklyLintNextAt: null,
          },
          job: null,
        },
      };
    }
    if (url === "/wiki/directory") {
      return {
        data: {
          pages: [],
          index: { id: "index-1", artifactType: "index", title: "Index" },
          log: { id: "log-1", artifactType: "log", title: "Log" },
          lintSummary: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderWikiZh();

  const pending = zhCn["wiki.status.pendingSetup"];
  assert.ok(await screen.findByText(zhCn["wiki.status.nextIngest"].replace("{date}", pending)));
  assert.ok(screen.getByRole("heading", { name: zhCn["wiki.title"] }));
  assert.ok(screen.getByRole("button", { name: zhCn["wiki.indexLabel"] }));
  assert.ok(screen.getByRole("button", { name: zhCn["wiki.logLabel"] }));
  assert.ok(screen.getByText(zhCn["wiki.status.nextLint"].replace("{date}", pending)));
  assert.equal(screen.queryByText(/Next ingest|Next lint/), null);
});
