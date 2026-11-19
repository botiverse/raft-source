import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { flushProductEvents, resetProductEventsForTest, setProductEventServerIdGetter } from "../src/analytics/track";
import DesktopDownloadOptions, { resetDesktopPlatformsForTest } from "../src/components/settings/DesktopDownloadOptions";
import { MobileAppDownloads } from "../src/features/settings/about/MobileAppDownloads";
import { TestIntlProvider } from "./helpers/intl";

// cindyz (2026-11-13, user source work, #proj-analytics:72b5e0e2): a click on a link that
// gets the Raft app is counted (app_download_clicked), and the link goes on
// as it would without the count.

type SentEvent = { event: string; properties: Record<string, unknown> };

let serverId: string | undefined;
/** What the server's sharing check answers (GET /product-events/config). */
let sharing = true;
/** Every request the sender made, in order. */
let requests: string[] = [];
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalGlobalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

/** The device the page reads (navigator.userAgent), wherever this Node keeps `navigator`. */
function useDevice(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
}
/** Whether each click's default action (following the link) was still to happen when it reached the document. */
let followed: boolean[] = [];

function captureProductEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  // As the sender reads it (globalThis): on a Node that has a localStorage of its own, that is not jsdom's window.localStorage.
  globalThis.localStorage.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    requests.push(url.replace(/^.*\/product-events\//, ""));
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: sharing }), { status: 200 });
    for (const { event, properties } of (JSON.parse(String(init?.body)) as { events: SentEvent[] }).events) sent.push({ event, properties });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return sent;
}

// jsdom follows no link: note that the click was left alone, then stop it there.
function onDocumentClick(event: Event): void {
  followed.push(!event.defaultPrevented);
  event.preventDefault();
}

beforeEach(() => {
  serverId = "server-1";
  sharing = true;
  requests = [];
  followed = [];
  setProductEventServerIdGetter(() => serverId);
  resetDesktopPlatformsForTest(async () => ({ mac: { status: "available" }, linux: { status: "available" }, windows: { status: "available" } }));
  document.addEventListener("click", onDocumentClick);
});

afterEach(() => {
  cleanup();
  document.removeEventListener("click", onDocumentClick);
  resetProductEventsForTest();
  resetDesktopPlatformsForTest();
  setProductEventServerIdGetter(() => undefined);
  if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  else delete (window.navigator as { userAgent?: string }).userAgent;
  if (originalGlobalNavigator) Object.defineProperty(globalThis, "navigator", originalGlobalNavigator);
  globalThis.localStorage.removeItem("slock_access_token");
});

/** The Windows build's link: plain text ("not available yet") until the release has said it has one. */
async function windowsLink(): Promise<HTMLElement> {
  return waitFor(() => {
    const link = screen.getByTestId("desktop-download-windows");
    assert.equal(link.tagName, "A");
    return link;
  });
}

function renderAbout() {
  return render(
    <TestIntlProvider locale="en">
      <DesktopDownloadOptions />
      <MobileAppDownloads />
    </TestIntlProvider>,
  );
}

test("Settings › About: each download link's click sends app_download_clicked with its target, and the link is still followed", async () => {
  const sent = captureProductEvents();
  renderAbout();

  // jsdom is no known device: every desktop build and every mobile link is listed.
  fireEvent.click(await windowsLink());
  fireEvent.click(screen.getByTestId("desktop-download-mac-arm64"));
  fireEvent.click(screen.getByTestId("desktop-download-linux-deb"));
  fireEvent.click(screen.getByTestId("mobile-download-ios"));
  fireEvent.click(screen.getByTestId("mobile-download-google-play"));
  fireEvent.click(screen.getByTestId("mobile-download-android"));

  // A store link's click sends at once, taking what is queued with it; the rest goes with the next batch.
  await waitFor(async () => {
    await flushProductEvents();
    assert.equal(sent.length, 6);
  });
  assert.deepEqual(sent, [
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "windows", desktop_build: "windows" } },
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "mac", desktop_build: "mac_arm64" } },
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "linux", desktop_build: "linux_deb" } },
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "ios" } },
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "google_play" } },
    { event: "app_download_clicked", properties: { surface: "settings_about", target: "apk" } },
  ]);
  assert.deepEqual(followed, [true, true, true, true, true, true], "no click was stopped");
  // The QR code is on screen and is not a click: nothing is sent for it.
});

// A store link opens another tab and hides this one; the sender's flush on
// hide asks no server about sharing, so an event still queued then is dropped.
test("a click before the tab's first batch is sent at once, sharing asked first, so hiding the tab right after loses nothing", async () => {
  const sent = captureProductEvents();
  renderAbout();

  fireEvent.click(screen.getByTestId("mobile-download-google-play"));
  // The new tab takes over: what track.ts does when the page is hidden.
  await flushProductEvents({ onPageHide: true });

  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent, [{ event: "app_download_clicked", properties: { surface: "settings_about", target: "google_play" } }]);
  assert.deepEqual(requests, ["config", "batch"], "asked whether this person shares, then sent");
  assert.deepEqual(followed, [true]);
});

// An installer or the APK is a download that navigates this page: a request started at that moment
// may be aborted, and an aborted sharing check would count as "does not share" for the rest of the page.
test("a same-tab download's click starts no request of its own; a store link's (new tab) asks about sharing at once", async () => {
  const sent = captureProductEvents();
  renderAbout();

  fireEvent.click(await windowsLink());
  fireEvent.click(screen.getByTestId("desktop-download-linux-appimage"));
  fireEvent.click(screen.getByTestId("mobile-download-android"));
  // Let anything a click had started show itself.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [], "nothing at the click");
  assert.deepEqual(sent, []);

  fireEvent.click(screen.getByTestId("mobile-download-ios"));
  assert.deepEqual(requests, ["config"], "the store link's click asked, in the click itself");

  // The queued downloads were not lost: they go with the batch.
  await waitFor(() => assert.equal(sent.length, 4));
  assert.deepEqual(sent.map((event) => event.properties.target), ["windows", "linux", "apk", "ios"]);
  assert.deepEqual(requests, ["config", "batch"]);
});

test("the ordinary batch alone delivers a same-tab download's click", async () => {
  const sent = captureProductEvents();
  renderAbout();

  fireEvent.click(await windowsLink());
  assert.deepEqual(requests, []);
  await flushProductEvents();
  assert.deepEqual(sent, [{ event: "app_download_clicked", properties: { surface: "settings_about", target: "windows", desktop_build: "windows" } }]);
});

test("someone who does not share usage data: the click asks once and sends nothing, then and later", async () => {
  const sent = captureProductEvents();
  sharing = false;
  renderAbout();

  fireEvent.click(screen.getByTestId("mobile-download-google-play"));
  await waitFor(() => assert.deepEqual(requests, ["config"]));
  fireEvent.click(screen.getByTestId("mobile-download-android"));
  await flushProductEvents({ onPageHide: true });
  await flushProductEvents();

  assert.deepEqual(sent, []);
  assert.deepEqual(requests, ["config"], "no batch, and not asked again");
  assert.deepEqual(followed, [true, true]);
});

// On a phone's own browser the phone's store is a Button (raft-ui renders the <a>), not a TextLink.
test("the store button a phone gets counts its click like the links", async () => {
  useDevice(IPHONE_SAFARI);
  const sent = captureProductEvents();
  renderAbout();

  const button = screen.getByTestId("mobile-download-ios");
  assert.equal(button.getAttribute("data-slot"), "button");
  fireEvent.click(button);

  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent, [{ event: "app_download_clicked", properties: { surface: "settings_about", target: "ios" } }]);
  assert.deepEqual(followed, [true]);
});

test("with no server in the tab nothing is queued or sent, and the link is still followed", async () => {
  const sent = captureProductEvents();
  serverId = undefined;
  renderAbout();

  fireEvent.click(await windowsLink());
  fireEvent.click(screen.getByTestId("mobile-download-ios"));

  await flushProductEvents();
  assert.deepEqual(sent, []);
  assert.deepEqual(requests, [], "not even the sharing check");
  assert.deepEqual(followed, [true, true]);
});
