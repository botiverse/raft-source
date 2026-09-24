import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

const EXPECTED_MAIN_LAYOUT_SOCKET_EVENTS = [
  "message:new",
  "message:updated",
  "reaction_viewer:updated",
  "scope_read:updated",
  "read_state:updated",
  "read_state:updated_bulk",
  "agent:activity",
  "agent:session",
  "dm:new",
  "machine:status",
  "machine:capabilities",
  "machine:updated",
  "computer:restart:done",
  "computer:upgrade:progress",
  "computer:upgrade:done",
  "daemon:status",
  "agent:created",
  "agent:deleted",
  "channel:updated",
  "channel:members-updated",
  "notification_prefs:updated",
  "message_display_prefs:updated",
  "server:plan-updated",
  "server:member-added",
  "server:member:left",
  "server:member-removed",
  "server:member-updated",
  "server:membership-removed",
  "thread:updated",
  "thread:followers-updated",
  "connect",
  "rooms:joined",
  "sync:resume:response",
  "heartbeat",
  "task:created",
  "task:updated",
  "task:deleted",
];

function readSocketBridge() {
  return readFileSync(resolve(repoRoot, "src/store/socketBridge.ts"), "utf8");
}

function readChannelRealtimeSync() {
  return readFileSync(resolve(repoRoot, "src/store/channelRealtimeSync.ts"), "utf8");
}

test("socketBridge owns the MainLayout event equivalence list", () => {
  const source = readSocketBridge();
  const channelRealtimeSource = readChannelRealtimeSync();
  const match = source.match(/export const MAIN_LAYOUT_SOCKET_EVENT_NAMES = \[([\s\S]*?)\] as const;/);
  assert.ok(match, "socketBridge should expose a reviewable MainLayout socket event list");

  const events = Array.from(match![1].matchAll(/"([^"]+)"/g), (eventMatch) => eventMatch[1]);
  assert.deepEqual(events, EXPECTED_MAIN_LAYOUT_SOCKET_EVENTS);

  for (const event of EXPECTED_MAIN_LAYOUT_SOCKET_EVENTS) {
    if (event.startsWith("task:")) continue;
    const ownerSource = event === "dm:new" || event === "channel:updated" || event === "channel:members-updated"
      ? channelRealtimeSource
      : source;
    assert.match(
      ownerSource,
      new RegExp(`event: "${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `${event} should be registered through the socketBridge or delegated domain binding table`,
    );
  }

  assert.match(source, /registerTaskRealtimeHandlers\(socket\)/);
});

test("thread reply socket events patch Activity before the lagging snapshot refresh", () => {
  const source = readSocketBridge();

  assert.match(source, /applyLiveMessageActivity\(result\.message, scheduleInboxRefresh\);/);
  assert.match(source, /if \(accepted\) applyLiveMessageActivity\(msg, scheduleInboxRefresh\);/);
  assert.match(source, /function applyLiveMessageActivity\([\s\S]*?isMessageActivitySuppressedByMute\(msg\)[\s\S]*?receiveThreadReply\(msg\)[\s\S]*?applyMessageChannelActivity\(msg, scheduleInboxRefresh\);/);
  assert.match(
    source,
    /useInboxStore\.getState\(\)\.updateThreadActivityMeta\(\s*data\.threadChannelId,\s*effectiveReplyCount,\s*data\.lastReplyAt,\s*\);/s,
  );
  assert.match(source, /if \(data\.latestReply\) useInboxStore\.getState\(\)\.receiveThreadReply\(data\.latestReply\);/);
  assert.match(source, /updateThreadActivityMeta\([\s\S]*?scheduleInboxRefresh\(\);/);
});

test("socketBridge cleanup is handler-specific and preserves unrelated listeners", () => {
  const source = readSocketBridge();

  assert.match(
    source,
    /installSocketBridge\(socket, "main-layout", bindings\)/,
    "MainLayout should install through the named socket bridge",
  );
  assert.match(
    source,
    /const uninstall = \(\) => \{\s*for \(const \{ event, handler \} of handlers\) socket\.off\(event, handler\);/s,
    "named bridge cleanup should remove exactly the handlers it installed",
  );
  assert.doesNotMatch(
    source,
    /socket\.off\("agent:activity"\)/,
    "bridge cleanup must not broad-remove all listeners for a shared event",
  );
  assert.match(source, /socket\.offAny\(markServerActivity\);/);
});

test("socketBridge owns live-session recovery paths", () => {
  const source = readSocketBridge();
  const recoveryStart = source.indexOf("const recoverLiveSession = () => {");
  const recoveryEnd = source.indexOf("\n  const recoverFromBfcache", recoveryStart);
  const recoverySource = source.slice(recoveryStart, recoveryEnd);

  assert.match(source, /const STATUS_RECONCILE_INTERVAL_MS = 60_000;/);
  assert.match(
    source,
    /function bootstrapMainLayoutRealtimeBridge\([\s\S]*?void useAnnouncementStore\.getState\(\)\.load\(\);[\s\S]*?\}/s,
    "initial entry must pull Announcement truth immediately",
  );
  assert.match(source, /window\.addEventListener\("pagehide", handlePageHide\);/);
  assert.match(source, /document\.addEventListener\("visibilitychange", recoverLiveSession\);/);
  assert.match(source, /window\.addEventListener\("focus", recoverLiveSession\);/);
  assert.match(source, /window\.addEventListener\("online", recoverLiveSession\);/);
  assert.match(source, /window\.addEventListener\("pageshow", recoverFromBfcache\);/);
  assert.match(source, /planStatusReconcile\(/);
  assert.match(source, /recordConnect\(\);\s*if \(typeof window !== "undefined"\)/);
  assert.match(source, /socket\.disconnect\(\);\s*socket\.connect\(\);/s);
  assert.match(
    recoverySource,
    /if \(plan\.reloadLiveData\) \{[\s\S]*?void useAnnouncementStore\.getState\(\)\.load\(\);/s,
    "entry-adjacent visibility, focus, and online recovery must pull Announcement truth immediately",
  );
  assert.doesNotMatch(
    source,
    /if \(shouldReconcileAnnouncementTruth\(|event: "announcement:new"/,
    "publish and periodic status reconciliation must not pull announcements into every open tab",
  );
});

test("socketBridge keeps live inbox refreshes background-only", () => {
  const source = readSocketBridge();
  const messageNewStart = source.indexOf("const messageNew = (msg: Message) => {");
  const messageNewEnd = source.indexOf("\n  // Merge-only updates for existing messages", messageNewStart);
  const messageNewSource = source.slice(messageNewStart, messageNewEnd);

  assert.match(
    source,
    /function loadInboxReset\(opts: \{ background\?: boolean \} = \{\}\) \{\s*void useInboxStore\.getState\(\)\.loadInbox\(\{ reset: true, background: opts\.background \}\);/s,
    "socketBridge refresh helper should preserve the caller's background intent",
  );
  assert.match(
    source,
    /loadInboxReset\(\{ background: true \}\);/,
    "coalesced live inbox refreshes must not flip the visible Activity loading state",
  );
  assert.doesNotMatch(
    source,
    /loadInboxReset\(\);/,
    "bootstrap, reconnect, rooms-joined, and live-message socket reconciliation must all remain background-only",
  );
  assert.match(
    messageNewSource,
    /const messageNew = \(msg: Message\) => \{[\s\S]*?applyMessageChannelActivity\(msg, scheduleInboxRefresh\);[\s\S]*?\};/s,
    "message:new, including current-user echo, should reconcile Activity through the scheduled background inbox refresh",
  );
  assert.ok(messageNewStart >= 0 && messageNewEnd > messageNewStart, "message:new handler should be locally inspectable");
  assert.doesNotMatch(
    messageNewSource,
    /loadInboxReset\(\);/,
    "message:new must not perform a foreground inbox reset that flashes Activity Unread skeletons",
  );
});
