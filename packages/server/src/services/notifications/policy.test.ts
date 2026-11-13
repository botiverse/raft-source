import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS,
  type NotificationAccountSettings,
  type NotificationCategory,
  type NotificationLevel,
  type NotificationLevelSetting,
} from "@botiverse/raft-shared";
import {
  categoryNotifiesAt,
  decide,
  decideNotification,
  isMutedFor,
  resolveEffectiveLevel,
  type NotificationPolicyInput,
  type NotificationPolicyPrefs,
  type NotificationPolicyRow,
} from "./policy";
import { messageFactCategory } from "./enqueue";
import type { NotificationDecision } from "./types";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const NOTIFY: NotificationDecision = { kind: "notify" };
const QUIET: NotificationDecision = { kind: "quiet" };
const suppressed = (reason: Extract<NotificationDecision, { kind: "suppressed" }>["reason"]): NotificationDecision => ({ kind: "suppressed", reason });

const account = (overrides: Partial<NotificationAccountSettings> = {}): NotificationAccountSettings => ({
  ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS,
  ...overrides,
  quietHours: { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS.quietHours, ...overrides.quietHours },
});

function input(overrides: Partial<NotificationPolicyInput>): NotificationPolicyInput {
  return {
    category: "channel",
    personal: false,
    serverLevel: "all",
    channelLevel: null,
    muted: false,
    account: account(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract §1.2 table
// ---------------------------------------------------------------------------

const LEVELS: NotificationLevel[] = ["all", "mentions", "none"];

const TABLE: Array<{ category: NotificationCategory; personal: boolean; notifies: Record<NotificationLevel, boolean> }> = [
  { category: "dm", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "mention", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "task_assigned", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "agent_attention", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "reminder", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "task_status", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "task_status", personal: false, notifies: { all: true, mentions: true, none: false } },
  { category: "thread", personal: false, notifies: { all: true, mentions: true, none: false } },
  { category: "channel", personal: false, notifies: { all: true, mentions: false, none: false } },
  { category: "system_notice", personal: true, notifies: { all: true, mentions: true, none: false } },
  { category: "test", personal: false, notifies: { all: true, mentions: true, none: true } },
];

describe("contract §1.2: category x effective level", () => {
  for (const row of TABLE) {
    for (const level of LEVELS) {
      const label = `${row.category}${row.category === "task_status" ? (row.personal ? " (personal)" : " (follower)") : ""} at ${level}`;
      test(`${label} ${row.notifies[level] ? "notifies" : "does not notify"}`, () => {
        assert.equal(categoryNotifiesAt(row.category, row.personal, level), row.notifies[level]);
        const decision = decideNotification(input({ category: row.category, personal: row.personal, serverLevel: level }), NOW);
        if (row.notifies[level]) assert.deepEqual(decision, NOTIFY);
        else assert.deepEqual(decision, suppressed(level === "none" ? "server_none" : "server_mentions"));
      });
    }
  }

  test("the personal flag only matters for task_status", () => {
    assert.equal(categoryNotifiesAt("dm", false, "mentions"), true);
    assert.equal(categoryNotifiesAt("channel", true, "mentions"), false);
  });
});

describe("the shared level fixture (docs/contracts/fixtures/notification-levels.json)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../../docs/contracts/fixtures/notification-levels.json", import.meta.url), "utf8")) as {
    cases: Array<{ name: string; server: NotificationLevel; channel: NotificationLevelSetting | null; thread: NotificationLevelSetting | null; muted: boolean; effective: NotificationLevel }>;
    categoryDecisions: Record<"personal" | "thread" | "follower_task_status" | "channel", Record<NotificationLevel, boolean>>;
  };

  test("has cases", () => {
    assert.ok(fixture.cases.length > 0);
  });

  for (const fixtureCase of fixture.cases) {
    test(`resolveEffectiveLevel: ${fixtureCase.name}`, () => {
      assert.equal(resolveEffectiveLevel({
        server: fixtureCase.server,
        channel: fixtureCase.channel,
        thread: fixtureCase.thread,
        muted: fixtureCase.muted,
      }), fixtureCase.effective);
    });
  }

  test("categoryDecisions agree with categoryNotifiesAt", () => {
    const categories: Record<keyof typeof fixture.categoryDecisions, Array<[NotificationCategory, boolean]>> = {
      personal: [["dm", true], ["mention", true], ["task_assigned", true], ["agent_attention", true], ["reminder", true], ["task_status", true], ["system_notice", true]],
      thread: [["thread", false]],
      follower_task_status: [["task_status", false]],
      channel: [["channel", false]],
    };
    for (const [group, members] of Object.entries(categories) as Array<[keyof typeof categories, Array<[NotificationCategory, boolean]>]>) {
      for (const level of LEVELS) {
        for (const [category, personal] of members) {
          assert.equal(categoryNotifiesAt(category, personal, level), fixture.categoryDecisions[group][level], `${group} ${category} at ${level}`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence and suppression reasons
// ---------------------------------------------------------------------------

describe("explicit precedence: channel > server; a thread has no level", () => {
  test("server none + channel all: a channel message notifies", () => {
    assert.deepEqual(decideNotification(input({ serverLevel: "none", channelLevel: "all" }), NOW), NOTIFY);
  });

  test("default reads as inherit at the channel", () => {
    assert.deepEqual(decideNotification(input({ serverLevel: "mentions", channelLevel: "default" }), NOW), suppressed("server_mentions"));
    assert.deepEqual(decideNotification(input({ serverLevel: "all", channelLevel: "default" }), NOW), NOTIFY);
  });
});

describe("suppression reasons", () => {
  test("server_none", () => {
    assert.deepEqual(decideNotification(input({ category: "dm", personal: true, serverLevel: "none" }), NOW), suppressed("server_none"));
  });

  test("server_mentions", () => {
    assert.deepEqual(decideNotification(input({ serverLevel: "mentions" }), NOW), suppressed("server_mentions"));
  });

  test("channel_level (explicit mentions on a channel message, explicit none on a DM)", () => {
    assert.deepEqual(decideNotification(input({ channelLevel: "mentions" }), NOW), suppressed("channel_level"));
    assert.deepEqual(decideNotification(input({ category: "dm", personal: true, channelLevel: "none" }), NOW), suppressed("channel_level"));
  });

  test("not_member (no server level)", () => {
    assert.deepEqual(decideNotification(input({ category: "dm", personal: true, serverLevel: null }), NOW), suppressed("not_member"));
  });

  test("test always notifies: no member, level none, muted, paused", () => {
    assert.deepEqual(decideNotification(input({
      category: "test",
      serverLevel: null,
      channelLevel: "none",
      muted: true,
      account: account({ pausedUntil: "2099-01-01T00:00:00.000Z" }),
    }), NOW), NOTIFY);
    assert.deepEqual(decideNotification(input({ category: "test", serverLevel: "none" }), NOW), NOTIFY);
  });
});

describe("mute caps the level at mentions", () => {
  test("a channel message in a muted channel is suppressed as muted", () => {
    assert.deepEqual(decideNotification(input({ muted: true }), NOW), suppressed("muted"));
    assert.deepEqual(decideNotification(input({ muted: true, channelLevel: "all" }), NOW), suppressed("muted"));
  });

  test("a mute silences everything in the conversation: thread replies, @mentions, tasks, a DM's @mention", () => {
    for (const [category, personal, mentioned] of [
      ["thread", false, false], ["mention", true, false], ["dm", true, false], ["dm", true, true],
      ["task_status", false, false], ["task_status", true, false], ["task_assigned", true, false],
    ] as const) {
      assert.deepEqual(decideNotification(input({ category, personal, mentioned, muted: true }), NOW), suppressed("muted"), `${category}`);
    }
  });

  test("a mute does not explain a suppression the level already makes", () => {
    assert.deepEqual(decideNotification(input({ muted: true, serverLevel: "none" }), NOW), suppressed("server_none"));
    assert.deepEqual(decideNotification(input({ muted: true, serverLevel: "mentions" }), NOW), suppressed("server_mentions"));
    assert.deepEqual(decideNotification(input({ muted: true, channelLevel: "mentions" }), NOW), suppressed("channel_level"));
  });
});

describe("design §4.0 examples", () => {
  test("server none, #incidents all: #incidents notifies, other channels are silent", () => {
    assert.deepEqual(decideNotification(input({ serverLevel: "none", channelLevel: "all" }), NOW), NOTIFY);
    assert.deepEqual(decideNotification(input({ serverLevel: "none" }), NOW), suppressed("server_none"));
    assert.deepEqual(decideNotification(input({ category: "mention", personal: true, serverLevel: "none" }), NOW), suppressed("server_none"));
  });

  test("server all, #random mentions: only @me and followed threads notify in #random", () => {
    assert.deepEqual(decideNotification(input({ channelLevel: "mentions" }), NOW), suppressed("channel_level"));
    assert.deepEqual(decideNotification(input({ category: "mention", personal: true, channelLevel: "mentions" }), NOW), NOTIFY);
    assert.deepEqual(decideNotification(input({ category: "thread", channelLevel: "mentions" }), NOW), NOTIFY);
  });

  test("a muted channel set to all is still silent", () => {
    assert.deepEqual(decideNotification(input({ channelLevel: "all", muted: true }), NOW), suppressed("muted"));
    assert.deepEqual(decideNotification(input({ category: "mention", personal: true, channelLevel: "all", muted: true }), NOW), suppressed("muted"));
  });
});

// ---------------------------------------------------------------------------
// Quiet
// ---------------------------------------------------------------------------

describe("quiet: pause and quiet hours", () => {
  const nightUtc = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60, timeZone: "UTC" };

  test("pausedUntil in the future is quiet, in the past is not", () => {
    assert.deepEqual(decideNotification(input({ account: account({ pausedUntil: "2026-01-15T12:00:01.000Z" }) }), NOW), QUIET);
    assert.deepEqual(decideNotification(input({ account: account({ pausedUntil: "2026-01-15T11:59:59.000Z" }) }), NOW), NOTIFY);
    assert.deepEqual(decideNotification(input({ account: account({ pausedUntil: null }) }), NOW), NOTIFY);
  });

  test("pause overrides every level, personal events included", () => {
    const paused = account({ pausedUntil: "2099-01-01T00:00:00.000Z" });
    assert.deepEqual(decideNotification(input({ category: "dm", personal: true, account: paused }), NOW), QUIET);
    assert.deepEqual(decideNotification(input({ category: "mention", personal: true, channelLevel: "all", account: paused }), NOW), QUIET);
  });

  test("quiet hours across midnight (22:00-08:00): 23:30 and 07:59 are quiet, 08:00 is not", () => {
    const quiet = account({ quietHours: nightUtc });
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T23:30:00.000Z")), QUIET);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T07:59:00.000Z")), QUIET);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T08:00:00.000Z")), NOTIFY);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T22:00:00.000Z")), QUIET);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T21:59:00.000Z")), NOTIFY);
  });

  test("quiet hours within a day (09:00-17:00)", () => {
    const quiet = account({ quietHours: { enabled: true, startMinute: 9 * 60, endMinute: 17 * 60, timeZone: "UTC" } });
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T12:00:00.000Z")), QUIET);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T17:00:00.000Z")), NOTIFY);
    assert.deepEqual(decideNotification(input({ account: quiet }), new Date("2026-01-15T08:59:00.000Z")), NOTIFY);
  });

  test("quiet hours are read in the user's time zone", () => {
    // 07:30 UTC = 23:30 the day before in Los Angeles (PST), 16:30 in Tokyo.
    const instant = new Date("2026-01-15T07:30:00.000Z");
    const inZone = (timeZone: string) => account({ quietHours: { ...nightUtc, timeZone } });
    assert.deepEqual(decideNotification(input({ account: inZone("America/Los_Angeles") }), instant), QUIET);
    assert.deepEqual(decideNotification(input({ account: inZone("Asia/Tokyo") }), instant), NOTIFY);
  });

  test("start == end and enabled=false disable quiet hours", () => {
    const allDay = account({ quietHours: { enabled: true, startMinute: 600, endMinute: 600, timeZone: "UTC" } });
    assert.deepEqual(decideNotification(input({ account: allDay }), new Date("2026-01-15T10:00:00.000Z")), NOTIFY);
    const disabled = account({ quietHours: { ...nightUtc, enabled: false } });
    assert.deepEqual(decideNotification(input({ account: disabled }), new Date("2026-01-15T23:30:00.000Z")), NOTIFY);
  });

  test("quiet only applies when the level would notify: a suppressed event stays suppressed", () => {
    const paused = account({ pausedUntil: "2099-01-01T00:00:00.000Z", quietHours: nightUtc });
    const night = new Date("2026-01-15T23:30:00.000Z");
    assert.deepEqual(decideNotification(input({ serverLevel: "none", account: paused }), night), suppressed("server_none"));
    assert.deepEqual(decideNotification(input({ serverLevel: "mentions", account: paused }), night), suppressed("server_mentions"));
    assert.deepEqual(decideNotification(input({ muted: true, account: paused }), night), suppressed("muted"));
    assert.deepEqual(decideNotification(input({ serverLevel: null, account: paused }), night), suppressed("not_member"));
  });
});

// ---------------------------------------------------------------------------
// decide() over loaded prefs
// ---------------------------------------------------------------------------

describe("isMutedFor", () => {
  test("a mute applies from its seq on; a null seq (thread reply / notice) is muted", () => {
    assert.equal(isMutedFor(5, 4), false);
    assert.equal(isMutedFor(5, 5), true);
    assert.equal(isMutedFor(5, 6), true);
    assert.equal(isMutedFor(5, null), true);
  });

  test("no mute (null / missing) is never muted", () => {
    assert.equal(isMutedFor(null, 10), false);
    assert.equal(isMutedFor(null, null), false);
    assert.equal(isMutedFor(undefined, null), false);
  });
});

describe("decide(row, prefs, now, defaults)", () => {
  const USER = "user-1";
  const SERVER = "server-1";
  const CHANNEL = "channel-1";
  const THREAD = "thread-1";

  function prefs(overrides: {
    account?: Array<[string, NotificationAccountSettings]>;
    serverLevel?: Array<[string, NotificationLevel]>;
    channelLevel?: Array<[string, NotificationLevel]>;
    mutedFromSeq?: Array<[string, number | null]>;
  } = {}): NotificationPolicyPrefs {
    return {
      account: new Map(overrides.account ?? []),
      serverLevel: new Map(overrides.serverLevel ?? [[`${SERVER}:${USER}`, "all"]]),
      channelLevel: new Map(overrides.channelLevel ?? []),
      mutedFromSeq: new Map(overrides.mutedFromSeq ?? []),
    };
  }

  function row(overrides: Partial<NotificationPolicyRow> = {}): NotificationPolicyRow {
    return {
      receiverId: USER,
      serverId: SERVER,
      category: "channel",
      personal: false,
      levelChannelId: CHANNEL,
      threadChannelId: null,
      levelChannelSeq: 10,
      ...overrides,
    };
  }

  const defaults = account();

  test("reads the server level by `<serverId>:<userId>`; a missing one is not_member", () => {
    assert.deepEqual(decide(row(), prefs(), NOW, defaults), NOTIFY);
    assert.deepEqual(decide(row(), prefs({ serverLevel: [[`${SERVER}:someone-else`, "all"]] }), NOW, defaults), suppressed("not_member"));
    assert.deepEqual(decide(row(), prefs({ serverLevel: [[`${SERVER}:${USER}`, "none"]] }), NOW, defaults), suppressed("server_none"));
  });

  test("reads the channel level by `<channelId>:<userId>`", () => {
    const loaded = prefs({ serverLevel: [[`${SERVER}:${USER}`, "none"]], channelLevel: [[`${CHANNEL}:${USER}`, "all"]] });
    assert.deepEqual(decide(row(), loaded, NOW, defaults), NOTIFY);
    assert.deepEqual(decide(row({ levelChannelId: "other-channel" }), loaded, NOW, defaults), suppressed("server_none"));
    assert.deepEqual(decide(row({ levelChannelId: null }), loaded, NOW, defaults), suppressed("server_none"));
  });

  test("with no channel level set, the server level and mute alone decide, thread rows included", () => {
    // Removing thread levels changes nothing for someone who never set a level:
    // a followed thread's reply notifies at all / mentions, not at none.
    const cases: Array<[NotificationLevel, boolean, NotificationCategory, boolean]> = [
      ["all", false, "channel", true], ["all", false, "thread", true], ["all", false, "mention", true],
      ["all", true, "channel", false], ["all", true, "thread", false], ["all", true, "mention", false],
      ["mentions", false, "channel", false], ["mentions", false, "thread", true], ["mentions", false, "mention", true],
      ["none", false, "channel", false], ["none", false, "thread", false], ["none", false, "mention", false],
    ];
    for (const [server, muted, category, notifies] of cases) {
      const loaded = prefs({
        serverLevel: [[`${SERVER}:${USER}`, server]],
        mutedFromSeq: muted ? [[`${CHANNEL}:${USER}`, 1]] : [],
      });
      const thread = category === "thread";
      const decision = decide(row({ category, personal: category === "mention", threadChannelId: thread ? THREAD : null, levelChannelSeq: thread ? null : 10 }), loaded, NOW, defaults);
      assert.equal(decision.kind, notifies ? "notify" : "suppressed", `server ${server}${muted ? ", muted" : ""}, ${category}`);
    }
  });

  test("a mute from seq 5 covers seq 5 and later, and null-seq rows", () => {
    const loaded = prefs({ mutedFromSeq: [[`${CHANNEL}:${USER}`, 5]] });
    assert.deepEqual(decide(row({ levelChannelSeq: 4 }), loaded, NOW, defaults), NOTIFY);
    assert.deepEqual(decide(row({ levelChannelSeq: 5 }), loaded, NOW, defaults), suppressed("muted"));
    assert.deepEqual(decide(row({ levelChannelSeq: null }), loaded, NOW, defaults), suppressed("muted"));
    // A thread reply under a muted parent is silent too.
    assert.deepEqual(decide(row({ category: "thread", threadChannelId: THREAD, levelChannelSeq: null }), loaded, NOW, defaults), suppressed("muted"));
  });

  test("a mute value of null is not muted; no channel means no mute", () => {
    assert.deepEqual(decide(row({ levelChannelSeq: 10 }), prefs({ mutedFromSeq: [[`${CHANNEL}:${USER}`, null]] }), NOW, defaults), NOTIFY);
    assert.deepEqual(decide(row({ levelChannelId: null, levelChannelSeq: null }), prefs({ mutedFromSeq: [[`${CHANNEL}:${USER}`, 1]] }), NOW, defaults), NOTIFY);
  });

  test("account settings by receiver id; missing ones use the defaults", () => {
    const paused = account({ pausedUntil: "2099-01-01T00:00:00.000Z" });
    assert.deepEqual(decide(row(), prefs({ account: [[USER, paused]] }), NOW, defaults), QUIET);
    assert.deepEqual(decide(row(), prefs({ account: [["someone-else", paused]] }), NOW, defaults), NOTIFY);
    assert.deepEqual(decide(row(), prefs(), NOW, paused), QUIET);
  });

  test("reminders and system notices are judged against the server level only", () => {
    const loaded = prefs({ serverLevel: [[`${SERVER}:${USER}`, "mentions"]] });
    assert.deepEqual(decide(row({ category: "reminder", personal: true, levelChannelId: null, levelChannelSeq: null }), loaded, NOW, defaults), NOTIFY);
    const none = prefs({ serverLevel: [[`${SERVER}:${USER}`, "none"]] });
    assert.deepEqual(decide(row({ category: "system_notice", personal: true, levelChannelId: null, levelChannelSeq: null }), none, NOW, defaults), suppressed("server_none"));
  });
});

describe("a security notice (two-step verification recovery started)", () => {
  const quiet = account({ pausedUntil: "2099-01-01T00:00:00.000Z" });
  test("notifies past server level none and quiet; still only for a member", () => {
    assert.deepEqual(decideNotification(input({ category: "system_notice", personal: true, serverLevel: "none", account: quiet, securityNotice: true }), NOW), NOTIFY);
    assert.deepEqual(decideNotification(input({ category: "system_notice", personal: true, serverLevel: null, securityNotice: true }), NOW), suppressed("not_member"));
  });
  test("without the flag, or on another category, nothing changes", () => {
    assert.deepEqual(decideNotification(input({ category: "system_notice", personal: true, serverLevel: "none", account: quiet }), NOW), suppressed("server_none"));
    assert.deepEqual(decideNotification(input({ category: "system_notice", personal: true, serverLevel: "all", account: quiet }), NOW), QUIET);
    assert.deepEqual(decideNotification(input({ category: "mention", personal: true, serverLevel: "none", account: quiet, securityNotice: true }), NOW), suppressed("server_none"));
  });
});

// ---------------------------------------------------------------------------
// "Replies in threads I follow" (account followedThreadReplies, #triage:#357)
// ---------------------------------------------------------------------------

describe("followedThreadReplies: off, a followed-thread reply alerts only when it @mentions the receiver", () => {
  const off = account({ followedThreadReplies: false });
  const on = account({ followedThreadReplies: true });

  // A reply's category as enqueue gives it, for a thread and a task conversation.
  const reply = (kind: "thread" | "task", mentioned: boolean) => {
    const category = messageFactCategory({ kind, personalMention: mentioned });
    return { category, personal: mentioned, mentioned };
  };

  test("defaults to on, and an account without the field (older stored shape) reads as on", () => {
    assert.equal(DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS.followedThreadReplies, true);
    const { followedThreadReplies: _dropped, ...legacy } = account();
    assert.deepEqual(decideNotification(input({ category: "thread", account: legacy }), NOW), NOTIFY);
    assert.equal(categoryNotifiesAt("thread", false, "all"), true);
  });

  for (const kind of ["thread", "task"] as const) {
    describe(`a ${kind === "thread" ? "thread" : "task conversation"} reply`, () => {
      test("on: notifies with and without an @mention, at all and mentions", () => {
        for (const level of ["all", "mentions"] as const) {
          for (const mentioned of [false, true]) {
            assert.deepEqual(decideNotification(input({ ...reply(kind, mentioned), serverLevel: level, account: on }), NOW), NOTIFY, `${level} mentioned=${mentioned}`);
          }
        }
      });

      test("off, no @mention: suppressed as followed_thread_replies_off", () => {
        for (const level of ["all", "mentions"] as const) {
          assert.deepEqual(decideNotification(input({ ...reply(kind, false), serverLevel: level, account: off }), NOW), suppressed("followed_thread_replies_off"), level);
        }
      });

      test("off, @mention: notifies (category mention), and so does a thread-category row flagged mentioned", () => {
        for (const level of ["all", "mentions"] as const) {
          assert.deepEqual(decideNotification(input({ ...reply(kind, true), serverLevel: level, account: off }), NOW), NOTIFY, level);
          assert.deepEqual(decideNotification(input({ category: "thread", mentioned: true, serverLevel: level, account: off }), NOW), NOTIFY, level);
        }
      });

      test("off or on, level none still silences it, with the level's reason", () => {
        assert.deepEqual(decideNotification(input({ ...reply(kind, false), serverLevel: "none", account: off }), NOW), suppressed("server_none"));
        assert.deepEqual(decideNotification(input({ ...reply(kind, true), serverLevel: "none", account: on }), NOW), suppressed("server_none"));
      });
    });
  }

  test("categoryNotifiesAt: thread is the only category the switch narrows", () => {
    assert.equal(categoryNotifiesAt("thread", false, "all", { followedThreadReplies: false }), false);
    assert.equal(categoryNotifiesAt("thread", false, "mentions", { followedThreadReplies: false, mentioned: true }), true);
    for (const level of LEVELS) {
      for (const entry of TABLE.filter((candidate) => candidate.category !== "thread")) {
        assert.equal(
          categoryNotifiesAt(entry.category, entry.personal, level, { followedThreadReplies: false }),
          entry.notifies[level],
          `${entry.category} personal=${entry.personal} at ${level}`,
        );
      }
    }
  });

  test("task_status (personal and follower) and task_assigned are unchanged when off", () => {
    for (const level of ["all", "mentions"] as const) {
      assert.deepEqual(decideNotification(input({ category: "task_status", personal: false, serverLevel: level, account: off }), NOW), NOTIFY, `follower ${level}`);
      assert.deepEqual(decideNotification(input({ category: "task_status", personal: true, serverLevel: level, account: off }), NOW), NOTIFY, `personal ${level}`);
      assert.deepEqual(decideNotification(input({ category: "task_assigned", personal: true, serverLevel: level, account: off }), NOW), NOTIFY, `assigned ${level}`);
    }
  });

  test("decide() reads the receiver's own switch from the loaded account settings", () => {
    const USER = "user-1";
    const SERVER = "server-1";
    const loaded = (settings: NotificationAccountSettings): NotificationPolicyPrefs => ({
      account: new Map([[USER, settings]]),
      serverLevel: new Map([[`${SERVER}:${USER}`, "all"]]),
      channelLevel: new Map(),
      mutedFromSeq: new Map(),
    });
    const threadRow: NotificationPolicyRow = {
      receiverId: USER,
      serverId: SERVER,
      category: "thread",
      personal: false,
      levelChannelId: "channel-1",
      threadChannelId: "thread-1",
      levelChannelSeq: null,
      mentioned: false,
    };
    assert.deepEqual(decide(threadRow, loaded(off), NOW, account()), suppressed("followed_thread_replies_off"));
    assert.deepEqual(decide(threadRow, loaded(on), NOW, account()), NOTIFY);
    // No stored settings: the defaults (on).
    assert.deepEqual(decide(threadRow, { ...loaded(on), account: new Map() }, NOW, account()), NOTIFY);
  });

  test("a mute or quiet is still reported as before for what the switch lets through", () => {
    assert.deepEqual(decideNotification(input({ ...reply("thread", true), muted: true, account: off }), NOW), suppressed("muted"));
    const pausedOff = account({ followedThreadReplies: false, pausedUntil: "2099-01-01T00:00:00.000Z" });
    assert.deepEqual(decideNotification(input({ ...reply("task", true), account: pausedOff }), NOW), QUIET);
  });
});
