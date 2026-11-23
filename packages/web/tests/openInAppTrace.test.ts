import assert from "node:assert/strict";
import "./helpers/domSetup";
import { afterEach, test, vi } from "vitest";
import {
  HAND_OVER_MS,
  OPEN_IN_APP_ATTEMPT_KEY,
  __resetOpenInAppWatchForTest,
  __setOpenInAppEmitterForTest,
  openInAppLinkOf,
  openInAppPlatformOf,
  reportOncePerOffer,
  reportOpenInAppMissing,
  reportOpenInAppOffered,
  reportOpenInAppOpen,
} from "../src/utils/openInAppTrace";
import type { OpenInAppContext } from "../src/utils/openInAppTrace";

// The open-in-app events (#proj-mobile:#128): closed sets from the path and query only, and the hand-over's rules.
// No component is rendered: what the offer does with these is the offer's; this is what reaches the report.

type Seen = Record<string, unknown> & { urgent: boolean };
function watch(): Seen[] {
  const seen: Seen[] = [];
  __setOpenInAppEmitterForTest((name, attrs, urgent) => {
    if (name === "slock.open_in_app") seen.push({ ...attrs, urgent });
  });
  return seen;
}
const ROW: OpenInAppContext = { surface: "phone_row", link: "message", signedIn: true };
const BANNER: OpenInAppContext = { surface: "desktop_banner", link: "channel", signedIn: true };

afterEach(() => {
  __resetOpenInAppWatchForTest();
  __setOpenInAppEmitterForTest(null);
  window.sessionStorage.clear();
  vi.useRealTimers();
});

test("the kind of link, by path and query", () => {
  assert.equal(openInAppLinkOf("/s/acme/channel/c1", ""), "channel");
  assert.equal(openInAppLinkOf("/s/acme/channel/c1", "?msg=m1"), "message");
  assert.equal(openInAppLinkOf("/s/acme/dm/d1", ""), "dm");
  assert.equal(openInAppLinkOf("/s/acme/dm/d1", "?msg=m1"), "message");
  assert.equal(openInAppLinkOf("/s/acme/channel/c1", "?thread=t1"), "thread");
  assert.equal(openInAppLinkOf("/s/acme/channel/c1/tasks/7", ""), "task");
  assert.equal(openInAppLinkOf("/artifacts/RT6C1WA38drf4u9DrwcZqZ", ""), "artifact");
  assert.equal(openInAppLinkOf("/artifacts/RT6C1WA38drf4u9DrwcZqZ/v/3", ""), "artifact");
  assert.equal(openInAppLinkOf("/s/acme/artifacts", "?artifact=pt_1"), "artifact");
  assert.equal(openInAppLinkOf("/s/acme/artifacts", ""), "other");
  assert.equal(openInAppLinkOf("/s/acme", ""), "other");
  assert.equal(openInAppLinkOf("/settings", ""), "other");
});

test("the platform, coarse, by user agent", () => {
  assert.equal(openInAppPlatformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15"), "ios");
  assert.equal(openInAppPlatformOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile"), "android");
  assert.equal(openInAppPlatformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130"), "mac");
  assert.equal(openInAppPlatformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130"), "windows");
  assert.equal(openInAppPlatformOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130"), "linux");
  assert.equal(openInAppPlatformOf(""), "other");
});

test("Open sends open at once with an attempt; losing focus sends handed_over at once with the same attempt, only once", () => {
  const seen = watch();
  reportOpenInAppOpen(BANNER);
  assert.deepEqual([seen[0]!.step, seen[0]!.urgent, seen[0]!.remembered, typeof seen[0]!.attempt], ["open", true, false, "string"]);
  window.dispatchEvent(new window.Event("blur"));
  window.dispatchEvent(new window.Event("blur"));
  assert.deepEqual(seen.map((each) => [each.step, each.urgent]), [["open", true], ["handed_over", true]]);
  assert.equal(seen[1]!.attempt, seen[0]!.attempt);
  assert.equal("signed_in" in seen[0]!, false);
});

test("Open with the page keeping focus: not_handed after the window, and a late blur changes nothing", () => {
  vi.useFakeTimers();
  const seen = watch();
  reportOpenInAppOpen(ROW);
  vi.advanceTimersByTime(HAND_OVER_MS + 10);
  window.dispatchEvent(new window.Event("blur"));
  assert.deepEqual(seen.map((each) => each.step), ["open", "not_handed"]);
});

test("Open twice, then the app takes over: one handed_over, for the later Open", () => {
  const seen = watch();
  reportOpenInAppOpen(BANNER);
  reportOpenInAppOpen(BANNER);
  window.dispatchEvent(new window.Event("blur"));
  assert.deepEqual(seen.map((each) => each.step), ["open", "open", "handed_over"]);
  assert.equal(seen[2]!.attempt, seen[1]!.attempt);
});

test("a phone sent back with app=missing reports app_missing with the Open's attempt, taken once", () => {
  const seen = watch();
  reportOpenInAppOpen(ROW);
  const attempt = seen[0]!.attempt;
  assert.equal(window.sessionStorage.getItem(OPEN_IN_APP_ATTEMPT_KEY), attempt, "kept for the page coming back");
  reportOpenInAppMissing({ surface: "phone_sheet", link: "message", signedIn: true });
  assert.deepEqual([seen.at(-1)!.step, seen.at(-1)!.attempt], ["app_missing", attempt]);
  assert.equal(window.sessionStorage.getItem(OPEN_IN_APP_ATTEMPT_KEY), null);
});

test("signed out nothing is sent: it would be dropped on the way", () => {
  const seen = watch();
  const signedOut = { ...ROW, signedIn: false };
  reportOpenInAppOffered(signedOut);
  reportOpenInAppOpen(signedOut);
  window.dispatchEvent(new window.Event("blur"));
  reportOpenInAppMissing(signedOut);
  assert.deepEqual(seen, []);
});

test("once per offer, counted only when sent: shown before the account loads, reported once it has (a cold start); never twice", () => {
  const seen = watch();
  const reportOffered = reportOncePerOffer(reportOpenInAppOffered);
  reportOffered({ ...ROW, signedIn: false });
  reportOffered({ ...ROW, signedIn: false });
  assert.deepEqual(seen, [], "signed out: nothing, and not counted as done");
  reportOffered(ROW);
  reportOffered(ROW);
  assert.deepEqual(seen.map((each) => each.step), ["offered"], "once the account is there: exactly one");
  const another = reportOncePerOffer(reportOpenInAppOffered);
  another(BANNER);
  assert.equal(seen.length, 2, "each offer has its own");
});
