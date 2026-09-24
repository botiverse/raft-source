import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChineseCommunityPage from "../src/pages/ChineseCommunityPage";
import { TestIntlProvider } from "./helpers/intl";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;
const originalQrConfigUrl = window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__;

function renderPage() {
  return render(
    <TestIntlProvider locale="zh-cn">
      <ChineseCommunityPage />
    </TestIntlProvider>,
  );
}

function installClipboard() {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value);
      },
    },
  });
  return writes;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  if (originalQrConfigUrl === undefined) {
    delete window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__;
  } else {
    window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__ = originalQrConfigUrl;
  }
});

test("Chinese community page loads a runtime QR config with no-store cache", async () => {
  const requested: Array<{ url: string; init?: RequestInit }> = [];
  window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__ = "/runtime/chinese-qr.json";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(url), init });
    return {
      ok: true,
      json: async () => ({
        imageUrl: " /runtime/wechat-qr.png ",
        updatedAt: "2026-09-08T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        fallbackContact: "@Raft",
      }),
    } as Response;
  }) as typeof fetch;

  renderPage();

  const image = await screen.findByTestId("chinese-community-qr-image");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.url, "/runtime/chinese-qr.json");
  assert.equal(requested[0]?.init?.cache, "no-store");
  assert.equal(image.getAttribute("src"), "/runtime/wechat-qr.png");
  assert.equal(image.getAttribute("alt"), "Raft 中文社群微信群二维码");
  assert.ok(screen.getByText("扫码加入中文社群"));
  assert.equal(screen.queryByText("扫码加入微信群，获取中文交流、使用问题和活动通知。"), null);
});

test("Chinese community page shows a missing state when QR config is unavailable", async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    json: async () => ({}),
  } as Response)) as typeof fetch;

  renderPage();

  await screen.findByTestId("chinese-community-qr-missing");
  assert.ok(screen.getByText("二维码暂未配置。请稍后刷新，或联系 Raft 团队。"));
});

test("Chinese community page switches to fallback when the QR image fails to load", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      imageUrl: "/missing/wechat-qr.png",
      fallbackContact: "@Raft",
    }),
  } as Response)) as typeof fetch;

  renderPage();

  const image = await screen.findByTestId("chinese-community-qr-image");
  fireEvent.error(image);

  await screen.findByTestId("chinese-community-qr-missing");
  assert.equal(screen.queryByTestId("chinese-community-qr-image"), null);
  assert.ok(screen.getByText("二维码无法加载。请稍后刷新，或联系 Raft 团队。"));
});

test("Chinese community page does not render an expired QR image as scannable", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      imageUrl: "/community/expired-qr.png",
      expiresAt: "2000-01-01T00:00:00.000Z",
      fallbackContact: "@Raft",
    }),
  } as Response)) as typeof fetch;

  renderPage();

  await screen.findByTestId("chinese-community-qr-missing");
  assert.equal(screen.queryByTestId("chinese-community-qr-image"), null);
  assert.ok(screen.getByText("这个二维码已过期。请稍后刷新，或联系 Raft 团队。"));
});

test("Chinese community page keeps the scannable surface minimal", async () => {
  const writes = installClipboard();
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ imageUrl: "/community/qr.png" }),
  } as Response)) as typeof fetch;

  renderPage();
  await screen.findByTestId("chinese-community-qr-image");
  assert.equal(screen.queryByRole("button", { name: "复制页面链接" }), null);
  assert.deepEqual(writes, []);
});
