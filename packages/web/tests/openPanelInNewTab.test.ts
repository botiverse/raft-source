import assert from "node:assert/strict";
import "global-jsdom/register";
import { buildTaskChannelUrl, closeThreadWindow } from "../src/components/window/closeThreadWindow";

const {
  buildLegacyTaskWindowUrl,
  buildThreadWindowUrl,
  openPanelInNewTab,
} = await import("../src/utils/openPanelInNewTab");

test("thread window URL preserves live view/filter state and replaces stale panel state", () => {
  const url = new URL(buildThreadWindowUrl(
    {
      origin: "https://raft.test",
      pathname: "/s/acme/tasks",
      search: "?view=list&channel=keep&thread=old:old&msg=old&task=1&profile=agent:old",
    },
    {
      serverSlug: "acme",
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
      focusedMessageId: "reply-2",
    },
  ));

  assert.equal(url.pathname, "/s/acme/thread-window");
  assert.equal(url.searchParams.get("view"), "list");
  assert.equal(url.searchParams.get("channel"), "keep");
  assert.equal(url.searchParams.get("thread"), "channel-1:parent-1");
  assert.equal(url.searchParams.get("msg"), "reply-2");
  assert.equal(url.searchParams.has("task"), false);
  assert.equal(url.searchParams.has("profile"), false);
});

test("message task window URL cold-loads with durable task intent", () => {
  const url = new URL(buildThreadWindowUrl(
    { origin: "https://raft.test", pathname: "/s/acme/tasks", search: "?view=board" },
    {
      serverSlug: "acme",
      parentChannelId: "dm-1",
      parentMessageId: "task-message-1",
      parentChannelType: "dm",
    },
    "task",
  ));

  assert.equal(url.pathname, "/s/acme/thread-window");
  assert.equal(url.searchParams.get("thread"), "dm-1:task-message-1");
  assert.equal(url.searchParams.get("msg"), "task-message-1");
  assert.equal(url.searchParams.get("task"), "1");
  assert.equal(url.searchParams.get("view"), "board");
});

test("legacy task window URL carries channel and task identity", () => {
  const url = new URL(buildLegacyTaskWindowUrl(
    { origin: "https://raft.test", pathname: "/s/acme/tasks", search: "?view=list&thread=old:old" },
    { serverSlug: "acme", channelId: "channel-1", taskId: "legacy-7" },
  ));

  assert.equal(url.pathname, "/s/acme/thread-window");
  assert.equal(url.searchParams.get("legacyTask"), "channel-1:legacy-7");
  assert.equal(url.searchParams.get("chatTab"), "tasks");
  assert.equal(url.searchParams.get("view"), "list");
  assert.equal(url.searchParams.has("thread"), false);
});

test("new-tab opener uses a noopener anchor instead of popup features", () => {
  const originalCreateElement = document.createElement.bind(document);
  let anchor: HTMLAnchorElement | null = null;
  document.createElement = ((tagName: string) => {
    const element = originalCreateElement(tagName);
    if (tagName === "a") {
      anchor = element as HTMLAnchorElement;
      element.click = () => {};
    }
    return element;
  }) as typeof document.createElement;
  try {
    assert.equal(openPanelInNewTab("https://raft.test/thread"), true);
    assert.ok(anchor);
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener noreferrer");
    assert.equal(anchor.href, "https://raft.test/thread");
  } finally {
    document.createElement = originalCreateElement;
  }
});

test("thread-window route closes a script-opened tab without navigating", () => {
  const events: string[] = [];
  closeThreadWindow({
    serverSlug: "acme",
    closeThread: () => events.push("thread"),
    closeLegacyTask: () => events.push("legacy"),
    closeBrowserWindow: () => events.push("window.close"),
    isBrowserWindowClosed: () => true,
    navigate: () => events.push("navigate"),
  });
  assert.deepEqual(events, ["thread", "legacy", "window.close"]);
});

test("thread-window route returns a normal tab when browser close is unavailable", () => {
  const events: string[] = [];
  closeThreadWindow({
    serverSlug: "acme space",
    closeThread: () => events.push("thread"),
    closeLegacyTask: () => events.push("legacy"),
    closeBrowserWindow: () => events.push("window.close"),
    isBrowserWindowClosed: () => false,
    navigate: (to, options) => events.push(`navigate:${to}:${options.replace}`),
  });
  assert.deepEqual(events, ["thread", "legacy", "window.close", "navigate:/s/acme%20space:true"]);
});

test("task page view-in-channel URL preserves message focus and legacy task tab", () => {
  assert.equal(
    buildTaskChannelUrl("acme space", "channel-1", "message-7"),
    "/s/acme%20space/channel/channel-1?msg=message-7",
  );
  assert.equal(
    buildTaskChannelUrl("acme space", "channel-1", "legacy-7", true),
    "/s/acme%20space/channel/channel-1?chatTab=tasks",
  );
  assert.equal(
    buildTaskChannelUrl("acme", "dm-1", "message-7", false, "dm"),
    "/s/acme/dm/dm-1?msg=message-7",
  );
});
