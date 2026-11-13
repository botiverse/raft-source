// A channel's last post in agent-facing listings (#wg-ax:3db7ecba): the
// minute it happened and how long ago, "no posts yet" for null, and nothing at
// all when the Server doesn't know (an unknown time must not read as "no posts").
import assert from "node:assert/strict";
import { test } from "vitest";

import { channelLastPost, formatAgentServerChannels, formatAgentServerInfo } from "./server";

const now = Date.parse("2026-10-21T08:30:00.000Z");

test("channelLastPost: minute stamp and age, no posts yet, nothing when unknown", () => {
  assert.equal(channelLastPost({ lastPostAt: "2026-10-18T07:12:40.000Z" }, now), "last post 2026-10-18 07:12Z (3d ago)");
  assert.equal(channelLastPost({ lastPostAt: "2026-10-21T08:29:30.000Z" }, now), "last post 2026-10-21 08:29Z (just now)");
  assert.equal(channelLastPost({ lastPostAt: "2026-10-21T08:05:00.000Z" }, now), "last post 2026-10-21 08:05Z (25m ago)");
  assert.equal(channelLastPost({ lastPostAt: "2026-10-19T09:30:00.000Z" }, now), "last post 2026-10-19 09:30Z (47h ago)");
  assert.equal(channelLastPost({ lastPostAt: "2026-10-21T08:31:00.000Z" }, now), "last post 2026-10-21 08:31Z (just now)");
  assert.equal(channelLastPost({ lastPostAt: null }, now), "no posts yet");
  assert.equal(channelLastPost({}, now), undefined);
  assert.equal(channelLastPost({ lastPostAt: "not a time" }, now), undefined);
});

test("listings put the last post last in the status brackets, the same for the CLI and tools", () => {
  const channels = [
    { name: "alpha", joined: true, type: "public", muted: false, lastPostAt: "2026-10-18T07:12:40.000Z" },
    { name: "quiet", joined: false, type: "public", lastPostAt: null },
    { name: "older-server", joined: true, type: "public" },
  ];
  const page = formatAgentServerChannels(channels, undefined, now);
  assert.match(page, /#alpha \[public, joined, not muted, last post 2026-10-18 07:12Z \(3d ago\)\]/);
  assert.match(page, /#quiet \[public, not joined, no posts yet\]/);
  assert.match(page, /#older-server \[public, joined\]\n?/);
  for (const style of ["cli", "tool"] as const) {
    const full = formatAgentServerInfo({ channels }, style, now);
    assert.match(full, /- #alpha \[public, joined, not muted, last post 2026-10-18 07:12Z \(3d ago\)\]/);
    assert.match(full, /- #quiet \[public, not joined, no posts yet\]/);
    assert.match(full, /- #older-server \[public, joined\]\n/);
  }
});
