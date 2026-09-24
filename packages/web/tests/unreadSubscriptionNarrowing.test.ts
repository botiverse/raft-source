import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (p: string) => {
  const text = readFileSync(resolve(repoRoot, p), "utf8");
  if (!text.startsWith("// @ts-nocheck\n") && !text.includes("function stryNS_")) return text;
  return execFileSync("git", ["show", `HEAD:packages/web/${p}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
};

// broad-subscription sweep P0-A / P0-B.
//
// `messageStore.unreadCounts` is a `Record<string, number>` that the reducer
// rebuilds with a NEW reference on every `message:new` (`{ ...unreadCounts, ... }`).
// Any always-mounted component that subscribes to the whole Record therefore
// re-renders on every inbound message anywhere in the app — the render-storm
// this sweep targets.
//
// The bare whole-Record selector `useMessageStore((s) => s.unreadCounts)` is the
// regression signature. Always-mounted consumers must instead derive the minimal
// slice they need IN the selector so Zustand's Object.is check short-circuits:
//   - LeftRail only lights a "has eligible unread" dot → derive a boolean (P0-A)
//   - ChatPanel only shows the current channel count → index by channel.id (P0-A)
//   - Sidebar renders hundreds of rows → push per-row unread into leaf
//     components that each select s.unreadCounts[id]; the parent derives only
//     narrowed booleans (collapsed-section dots) + a closed-DM id list (P0-B).
//     The Sidebar is the highest-fanout consumer, so its whole-Record
//     subscription was the dominant freeze when switching channels in large
//     servers — P0-A (LeftRail/ChatPanel) alone did NOT fix it.
const BARE_WHOLE_RECORD = /useMessageStore\(\s*\(s\)\s*=>\s*s\.unreadCounts\s*\)/;

test("LeftRail does not subscribe to the whole unreadCounts Record (P0-A)", () => {
  const src = read("src/components/layout/LeftRail.tsx");
  assert.doesNotMatch(
    src,
    BARE_WHOLE_RECORD,
    "LeftRail must derive a has-any-unread boolean in the selector, not subscribe to the whole unreadCounts Record",
  );
  assert.match(
    src,
    /hasChatAttentionUnread\(chatAttentionChannelIds, s\.unreadCounts\)/,
    "LeftRail should derive its boolean inside the selector",
  );
});

test("ChatPanel does not subscribe to the whole unreadCounts Record (P0-A)", () => {
  const src = read("src/components/message/ChatPanel.tsx");
  assert.doesNotMatch(
    src,
    BARE_WHOLE_RECORD,
    "ChatPanel must select the current channel's count, not the whole unreadCounts Record",
  );
  assert.match(
    src,
    /s\.unreadCounts\[channel\.id\]/,
    "ChatPanel should narrow the selector to the current channel",
  );
});

test("Sidebar does not subscribe to the whole unreadCounts or drafts Record (P0-B)", () => {
  const src = read("src/components/layout/Sidebar.tsx");
  assert.doesNotMatch(
    src,
    BARE_WHOLE_RECORD,
    "Sidebar must not subscribe to the whole unreadCounts Record — per-row unread lives in the ChannelRow/DmRow/AgentDmRow leaves; the parent derives only narrowed aggregates",
  );
  assert.doesNotMatch(
    src,
    /useMessageStore\(\s*\(s\)\s*=>\s*s\.drafts\s*\)/,
    "Sidebar must not subscribe to the whole drafts Record — per-row draft lives in the row leaves",
  );
  // Per-row leaves index a single id (the slice that actually changes per message).
  assert.match(
    src,
    /useMessageStore\(\s*\(s\)\s*=>\s*s\.unreadCounts\[channel\.id\]\s*\|\|\s*0\s*\)/,
    "ChannelRow leaf should select only its own channel's unread count",
  );
});
