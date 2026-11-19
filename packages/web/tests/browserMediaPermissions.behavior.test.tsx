// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The built-in browser's site permissions for the microphone and the camera, on the web's side (the shell decides,
// apps/desktop webPreviewMediaPermissions.ts):
// - the prompt bar says which site wants which device, and Allow / Block / Dismiss answer the shell's prompt by its id;
// - the shell's report is checked before it shows (an unknown device, a prompt with none, a shell before it);
// - the system's refusal (macOS) says where to turn the device on;
// - the site settings at the address row's start show the device in use, change a setting, and Stop and block.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserBlockedNotice } from "../src/features/webPreview/BrowserBlockedNotice";
import { BrowserPermissionPrompt } from "../src/features/webPreview/BrowserPermissionPrompt";
import { siteName } from "../src/features/webPreview/browserSitePermissions";
import { BrowserSiteSettings } from "../src/features/webPreview/BrowserSiteSettings";
import { browserMediaKinds, browserPermissionPrompt, browserSitePermissions, browserTabBlocked } from "../src/features/webPreview/browserTabsStore";
import type { BrowserTab } from "../src/features/webPreview/browserTabsStore";

afterEach(() => cleanup());

function fakeBridge() {
  const answers: unknown[][] = [];
  const settings: unknown[][] = [];
  const bridge = {
    answerPermission: (...args: unknown[]) => { answers.push(args); },
    setSitePermission: (...args: unknown[]) => { settings.push(args); },
  } as unknown as DesktopWebPreviewTabsBridge;
  return { bridge, answers, settings };
}

test("the prompt names the site and the devices; Allow, Block and Dismiss answer it by its id", () => {
  const { bridge, answers } = fakeBridge();
  const cases: [string[], string][] = [
    [["microphone"], "deck.raft.build wants to use your microphone"],
    [["camera"], "deck.raft.build wants to use your camera"],
    [["microphone", "camera"], "deck.raft.build wants to use your microphone and camera"],
  ];
  for (const [kinds, words] of cases) {
    render(<TestIntlProvider><BrowserPermissionPrompt bridge={bridge} tabId="t1" prompt={{ id: "p1", origin: "https://deck.raft.build", kinds: kinds as ("microphone" | "camera")[] }} /></TestIntlProvider>);
    assert.equal(screen.getByTestId("web-preview-permission-text").textContent, words);
    cleanup();
  }
  render(<TestIntlProvider><BrowserPermissionPrompt bridge={bridge} tabId="t1" prompt={{ id: "p1", origin: "https://deck.raft.build", kinds: ["microphone"] }} /></TestIntlProvider>);
  fireEvent.click(screen.getByTestId("web-preview-permission-allow"));
  fireEvent.click(screen.getByTestId("web-preview-permission-block"));
  fireEvent.click(screen.getByTestId("web-preview-permission-dismiss"));
  assert.deepEqual(answers, [["t1", "p1", "allow"], ["t1", "p1", "block"], ["t1", "p1", "dismiss"]]);
  assert.equal(siteName("http://localhost:5173"), "localhost:5173");
});

test("the shell's report is checked: known devices only, a prompt needs one, a setting is allow / block / ask", () => {
  assert.deepEqual(browserMediaKinds(["camera", "screen", "microphone", "camera"]), ["microphone", "camera"]);
  assert.deepEqual(browserMediaKinds(undefined), []);
  assert.deepEqual(browserPermissionPrompt({ id: "p", origin: "https://a.example", kinds: ["camera"] }), { id: "p", origin: "https://a.example", kinds: ["camera"] });
  assert.equal(browserPermissionPrompt({ id: "p", origin: "https://a.example", kinds: ["geolocation"] }), null);
  assert.equal(browserPermissionPrompt(undefined), null, "a shell before site permissions");
  assert.deepEqual(browserSitePermissions({ origin: "https://a.example", microphone: "allow", camera: "sometimes" }), { origin: "https://a.example", microphone: "allow", camera: "ask" });
  assert.equal(browserSitePermissions(null), null);
  assert.deepEqual(browserTabBlocked({ url: "https://a.example/", reason: "media-system", media: ["microphone", "x"], at: 3 }), { url: "https://a.example/", reason: "media-system", media: ["microphone"], at: 3 });
});

test("the system refused Raft the device: the notice says where to turn it on", () => {
  const tab = { id: "t1", url: "https://deck.raft.build/" } as BrowserTab;
  render(<TestIntlProvider><BrowserBlockedNotice conversationId="c1" tab={tab} blocked={{ url: tab.url!, reason: "media-system", media: ["microphone"], at: 1 }} /></TestIntlProvider>);
  assert.match(screen.getByTestId("web-preview-blocked-text").textContent ?? "", /System Settings › Privacy & Security › Microphone/);
});

function siteTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return { id: "t1", url: "https://deck.raft.build/room", site: { origin: "https://deck.raft.build", microphone: "allow", camera: "ask" }, media: [], ...overrides } as BrowserTab;
}

test("site settings: none for a page that may not ask or a shell without them", () => {
  const { bridge } = fakeBridge();
  render(<TestIntlProvider><BrowserSiteSettings bridge={bridge} tab={siteTab({ site: null })} /></TestIntlProvider>);
  assert.ok(screen.queryByTestId("web-preview-site-settings") === null, "no site settings");
  cleanup();
  render(<TestIntlProvider><BrowserSiteSettings bridge={{} as DesktopWebPreviewTabsBridge} tab={siteTab()} /></TestIntlProvider>);
  assert.ok(screen.queryByTestId("web-preview-site-settings") === null, "no site settings");
});

test("site settings: the device in use shows; a setting changes; Stop and block blocks what is in use", async () => {
  const { bridge, settings } = fakeBridge();
  render(<TestIntlProvider><BrowserSiteSettings bridge={bridge} tab={siteTab({ media: ["microphone"] })} /></TestIntlProvider>);
  const trigger = screen.getByTestId("web-preview-site-settings");
  assert.equal(trigger.getAttribute("data-in-use"), "microphone");
  assert.equal(trigger.getAttribute("aria-label"), "Using your microphone");
  fireEvent.click(trigger);
  await screen.findByTestId("web-preview-site-settings-popover");
  fireEvent.click(screen.getByTestId("web-preview-site-camera-block"));
  fireEvent.click(screen.getByTestId("web-preview-site-stop"));
  assert.deepEqual(settings, [["t1", "camera", "block"], ["t1", "microphone", "block"]]);
});
