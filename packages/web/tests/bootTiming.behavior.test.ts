import assert from "node:assert/strict";
import "./helpers/domSetup";
import {
  __resetBootTimingForTest,
  bootLandingOf,
  markBootMilestone,
  markBootTokenRefreshedFirst,
  startBootTiming,
} from "../src/boot/bootTiming";

let events: Array<Record<string, unknown>> = [];
let urgentFlags: boolean[] = [];

beforeEach(() => {
  events = [];
  urgentFlags = [];
  __resetBootTimingForTest((_name, attrs, urgent) => {
    events.push(attrs);
    urgentFlags.push(urgent);
  });
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new window.Event("visibilitychange"));
}

afterEach(() => {
  __resetBootTimingForTest();
});

test("bootLandingOf reads what the URL opens, without ids", () => {
  assert.equal(bootLandingOf("/", ""), "root");
  assert.equal(bootLandingOf("/s/acme/channel/c1", ""), "channel");
  assert.equal(bootLandingOf("/s/acme/dm/d1", ""), "dm");
  assert.equal(bootLandingOf("/s/acme/channel/c1", "?thread=c1:m1&msg=m1"), "thread");
  assert.equal(bootLandingOf("/s/acme/channel/c1", "?msg=m1"), "message");
  assert.equal(bootLandingOf("/s/acme/activity", ""), "other");
  assert.equal(bootLandingOf("/login", ""), "other");
});

test("a conversation landing reports once, at its content, with every milestone reached", () => {
  startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
  markBootTokenRefreshedFirst();
  markBootMilestone("auth");
  markBootMilestone("servers");
  markBootMilestone("frame");
  assert.equal(events.length, 0, "the frame is not the content of a conversation landing");
  markBootMilestone("content");
  markBootMilestone("content");
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.landing, "channel");
  assert.equal(event.outcome, "rendered");
  assert.equal(event.token_refreshed_first, true);
  for (const key of ["auth_ms", "servers_ms", "frame_ms", "content_ms"]) assert.equal(typeof event[key], "number", key);
  assert.equal(JSON.stringify(event).includes("c1"), false, "no ids or URLs");
});

test("another landing's content is its frame", () => {
  startBootTiming({ pathname: "/s/acme/activity", search: "" });
  markBootMilestone("frame");
  assert.equal(events.length, 1);
  assert.equal(events[0].content_ms, events[0].frame_ms);
});

test("leaving before content reports what was reached, the rest null", () => {
  startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
  markBootMilestone("auth");
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "unloaded");
  assert.equal(typeof events[0].auth_ms, "number");
  assert.equal(events[0].servers_ms, null);
  assert.equal(events[0].content_ms, null);
  assert.deepEqual(urgentFlags, [true], "sent on the urgent path: the page is going away");
  markBootMilestone("content");
  assert.equal(events.length, 1, "one event per load");
});

test("a tab opened in the background says so, and a later hide before content still reports hidden", () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
  setVisibility("visible");
  assert.equal(events.length, 0);
  setVisibility("hidden");
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "hidden");
  assert.equal(events[0].started_hidden, true);
  assert.deepEqual(urgentFlags, [true]);
  setVisibility("visible");
});

test("a rendered load goes out on the normal batch", () => {
  setVisibility("visible");
  startBootTiming({ pathname: "/s/acme/activity", search: "" });
  markBootMilestone("frame");
  assert.deepEqual(urgentFlags, [false]);
  assert.equal(events[0].started_hidden, false);
});

test("the load also says when the script ran, when /auth/me and the first messages went out and answered, and on what device", () => {
  startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
  markBootMilestone("auth_sent");
  markBootMilestone("auth");
  markBootMilestone("servers");
  markBootMilestone("frame");
  markBootMilestone("messages_sent");
  markBootMilestone("messages");
  markBootMilestone("content");
  const [event] = events;
  for (const key of ["bundle_ms", "auth_sent_ms", "messages_sent_ms", "messages_ms"]) assert.equal(typeof event[key], "number", key);
  assert.ok(["phone", "computer"].includes(String(event.form_factor)));
  assert.ok(["desktop_app", "pwa", "browser"].includes(String(event.platform)));
});

test("milestones not reached are null, not 0", () => {
  startBootTiming({ pathname: "/s/acme/channel/c1", search: "" });
  markBootMilestone("frame");
  setVisibility("hidden");
  const [event] = events;
  assert.equal(event.auth_sent_ms, null);
  assert.equal(event.messages_sent_ms, null);
  assert.equal(event.messages_ms, null);
  setVisibility("visible");
});
