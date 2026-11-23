/**
 * Web's loader for the Activity row contract cases the app and the server run
 * too (packages/shared/contract-cases/activity-row/, format in its README).
 *
 * 1. Every case file is validated against the schema, and every agreed case
 *    runs against the shared rule web applies with inbox_row_position_v1 on
 *    (inbox redesign #244, step 2): reduceActivityRow for position cases,
 *    activityLiveUnread for predicate cases; sync_inbox_row cases through the
 *    same reducer (an upsert is an answer) and applySyncInboxRowChange for a
 *    delete (web does not request inbox_row changes yet). A pending case is a
 *    skipped test naming its question.
 * 2. Web, flag on (inbox_row_position_v1, step 2): each predicate case runs
 *    through web's adapter of the shared predicate (inboxRowPosition.ts
 *    rowPositionVerdict, from the row, the message and what the screen knows)
 *    and must give the case's verdict exactly, `counts: null` included. A web
 *    `knownGaps` entry would mean the flag-on path differs: it is reported as
 *    a failure until the path follows the case. Position cases need no web
 *    adapter: the flag-on path runs reduceActivityRow itself (part 1), and the
 *    store's use of it is pinned by tests/inboxRowPositionFlag.test.ts.
 * 3. Web, flag off (the live patch before step 2: liveActivityUnread +
 *    liveUnreadFields, inboxInPlaceUnread.ts), documented: an agreed case must
 *    match, except the cases in FLAG_OFF_DIFFERS, which must still differ (the
 *    old patch is kept as it was while the flag is off). Web leaves a message
 *    it cannot judge uncounted for its re-read, which is how it meets
 *    `counts: null`. A case web's live patch cannot be driven for here is
 *    listed in WEB_TODAY_NOT_DRIVEN with the reason.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { activityLiveUnread, activityRowDisplayPosition, activityRowFromAnswer, applySyncInboxRowChange, reduceActivityRow } from "@botiverse/raft-shared";
import type {
  ActivityRowAnswer,
  ActivityRowEvent,
  ActivityRowState,
  ActivityUnreadMessage,
  ActivityUnreadScope,
  ActivityUnreadViewer,
} from "@botiverse/raft-shared";
import type { InboxItem } from "../src/store/inboxStore";
import type { Message } from "../src/store/messageStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { liveActivityUnread, liveUnreadFields } = await import("../src/store/inboxInPlaceUnread");
const { rowPositionVerdict } = await import("../src/store/inboxRowPosition");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");

const KNOWN_FORMAT_VERSIONS = new Set([1]);

/** Predicate cases web's flag-off live patch is not driven for here, and why. */
const WEB_TODAY_NOT_DRIVEN: Readonly<Record<string, string>> = {
  predicate_read_on_arrival: "read on arrival is the message store's screen state (the open conversation at its bottom, a queued read, a read hold), not an input",
};

/**
 * Agreed predicate cases web's flag-off live patch still differs from (it
 * stays as it was while inbox_row_position_v1 is off; the flag-on path follows
 * them, part 2). Each must still differ: one that stops differing is removed.
 */
const FLAG_OFF_DIFFERS: Readonly<Record<string, string>> = {
  predicate_channel_own_caused_system: "the flag-off patch applies the system rule on thread rows only",
  predicate_dm_own_caused_system: "the flag-off patch applies the system rule on thread rows only",
  predicate_channel_uncounted_subtype: "the flag-off patch applies the noise subtypes on thread rows only",
  predicate_channel_self_unfollow_subtype: "the flag-off patch applies the noise subtypes on thread rows only",
  predicate_muted_channel_message: "the flag-off patch has no mute input",
  predicate_muted_channel_mention: "the flag-off patch has no mute input",
};

type CaseRow = { unreadCount: number; hasMention: boolean; position: string | null; mentionOnly: boolean; readSeq?: string };
type ShownRow = Omit<CaseRow, "readSeq">;
type CaseStep =
  | { act: "liveMessage"; seq: string; counts: boolean | null; mentionsViewer: boolean; moves?: boolean }
  | { act: "answer"; row: CaseRow }
  | { act: "read"; seq: string }
  | { act: "markUnread" }
  | { act: "syncDelete"; position: string | null; reason: "done" | "left" };
type Verdict = { counts: boolean | null; mention: boolean; moves: boolean };
type ContractCase = {
  formatVersion: number;
  id: string;
  rule: "position" | "predicate" | "sync_inbox_row";
  status: "agreed" | "pending-product-decision";
  knownGaps?: { client: string; reason: string }[];
  given: { row?: CaseRow; viewer?: ActivityUnreadViewer; scope?: ActivityUnreadScope; message?: ActivityUnreadMessage };
  steps: CaseStep[];
  checkpoints?: { afterStep: number; row?: Partial<ShownRow>; reread?: boolean; removed?: boolean }[];
  expect?: { row?: Partial<ShownRow>; reread?: boolean; removed?: boolean; verdict?: Verdict };
  decision?: { question: string; candidates: { id: string; currentBehaviourOf: string[]; expect: { verdict?: Verdict } }[] };
};

const sharedRoot = dirname(createRequire(import.meta.url).resolve("@botiverse/raft-shared/package.json"));
const casesDir = join(sharedRoot, "contract-cases", "activity-row");
const schema = JSON.parse(readFileSync(join(casesDir, "case.schema.json"), "utf8")) as object;
const cases = readdirSync(join(casesDir, "cases"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, value: JSON.parse(readFileSync(join(casesDir, "cases", name), "utf8")) as ContractCase }));

/** Seqs stay decimal strings end to end: never through Number (64-bit seqs lose precision past 2^53). */
const answerOf = (row: CaseRow): ActivityRowAnswer => ({ ...row });

function eventOf(step: Exclude<CaseStep, { act: "syncDelete" }>): ActivityRowEvent {
  switch (step.act) {
    case "liveMessage": return { type: "live", seq: step.seq, counts: step.counts, mentionsViewer: step.mentionsViewer, ...(step.moves === undefined ? {} : { moves: step.moves }) };
    case "answer": return { type: "answer", row: answerOf(step.row) };
    case "read": return { type: "read", seq: step.seq };
    case "markUnread": return { type: "markUnread" };
  }
}

function assertShown(row: ActivityRowState | null, expected: { row?: Partial<ShownRow>; removed?: boolean }, where: string): void {
  if (expected.removed !== undefined) assert.equal(row === null, expected.removed, `removed ${where}`);
  if (!expected.row) return;
  assert.ok(row, `${where}: the row is held`);
  assertRowShown(row, expected.row, where);
}

function assertRowShown(row: ActivityRowState, expected: Partial<ShownRow>, where: string): void {
  const shown: ShownRow = { unreadCount: row.unreadCount, hasMention: row.hasMention, position: activityRowDisplayPosition(row), mentionOnly: row.mentionOnly };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, shown[key as keyof ShownRow]])), expected, where);
}

function runShared(contractCase: ContractCase): void {
  const expect = contractCase.expect!;
  if (contractCase.rule === "predicate") {
    const { viewer, scope, message } = contractCase.given;
    assert.deepEqual(activityLiveUnread(message!, viewer!, scope!), expect.verdict);
    return;
  }
  // sync_inbox_row: an upsert is an `answer` (the same merge), a delete the shared applySyncInboxRowChange.
  let row: ActivityRowState | null = activityRowFromAnswer(answerOf(contractCase.given.row!));
  let reread = false;
  contractCase.steps.forEach((step, index) => {
    if (step.act === "syncDelete") {
      row = applySyncInboxRowChange(row, { op: "delete", position: step.position }).row;
    } else {
      assert.ok(row, `step ${index + 1}: the row was removed by an earlier step`);
      const result = reduceActivityRow(row, eventOf(step));
      row = result.row;
      reread ||= result.reread;
    }
    for (const checkpoint of contractCase.checkpoints ?? []) {
      if (checkpoint.afterStep !== index + 1) continue;
      assertShown(row, checkpoint, `after step ${index + 1}`);
      if (checkpoint.reread !== undefined) assert.equal(reread, checkpoint.reread, `reread after step ${index + 1}`);
    }
  });
  assertShown(row, expect, "at the end");
  assert.equal(reread, expect.reread, "reread at the end");
}

type ConversationRow = Exclude<InboxItem, { kind: "mention_action" | "object" }>;

function webRow(scope: ActivityUnreadScope): ConversationRow {
  if (scope.rowKind === "channel" || scope.rowKind === "dm") {
    return {
      kind: scope.rowKind, channelId: "conversation-1", channelName: "c", channelType: scope.rowKind === "dm" ? "dm" : "channel",
      lastMessageId: "message-0", latestActivitySeq: "100", firstUnreadMessageId: null, firstMentionMessageId: null,
      lastMessageAt: "2026-11-14T10:00:00.000Z", lastMessagePreview: "", lastMessageSenderType: "user", lastMessageSenderId: "user-2",
      lastMessageSenderName: null, unreadCount: 0, hasMention: false,
    };
  }
  return {
    kind: "thread", threadChannelId: "conversation-1", parentMessageId: "parent-1", parentChannelId: "channel-1", parentChannelName: "c",
    parentChannelType: "channel", parentMessagePreview: "", parentMessageSenderType: "user", parentMessageSenderId: "user-2",
    latestActivityPreview: "", latestActivitySenderType: "user", latestActivitySenderId: "user-2", latestActivitySenderName: null,
    latestActivityMessageId: "message-0", latestActivitySeq: "100", firstUnreadMessageId: null, firstMentionMessageId: null,
    replyCount: 1, lastActivityAt: "2026-11-14T10:00:00.000Z", lastReplyAt: null, unreadCount: 0, hasMention: false,
    taskNumber: null, taskStatus: null, taskClaimedByName: null, isFollowing: scope.threadFollowed !== false,
    ...(scope.rowKind === "task" ? { conversationKind: "task" as const } : {}),
  } as ConversationRow;
}

/** What web's live patch does with the case's message today, as a verdict (`moves` is not the flag-off patch's input). */
function webToday(contractCase: ContractCase): Omit<Verdict, "moves"> {
  const { viewer, scope, message } = contractCase.given;
  assert.equal(viewer!.type, "user", "web's viewer is a person");
  useMessageStore.setState({ currentUserId: viewer!.id, currentChannelId: null });
  const msg = { id: "message-1", channelId: "conversation-1", seq: 101, content: "", createdAt: "2026-11-14T10:00:05.000Z", ...message } as unknown as Message;
  const row = webRow(scope!);
  const fields = liveUnreadFields(row, msg, liveActivityUnread(msg, row.kind === "thread" ? "thread_reply" : "message_new"));
  return { counts: fields.unreadCount !== undefined, mention: fields.hasMention === true };
}

/**
 * Web's flag-on verdict: the row and message as the store has them, the
 * conversation muted in the channel store when the case says so, and the
 * screen's read-on-arrival as the live verdict's `counts` (liveActivityUnread
 * says false for a message read as it arrives).
 */
function webFlagOn(contractCase: ContractCase): Verdict {
  const { viewer, scope, message } = contractCase.given;
  assert.equal(viewer!.type, "user", "web's viewer is a person");
  useMessageStore.setState({ currentUserId: viewer!.id, currentChannelId: null });
  const muted = { id: "conversation-1", activityMuted: scope!.activityMuted === true, muteFromSeq: null };
  useChannelStore.setState({
    channels: scope!.rowKind === "channel" ? [muted] : [],
    dmChannels: scope!.rowKind === "dm" ? [muted] : [],
  } as never);
  const msg = { id: "message-1", channelId: "conversation-1", seq: 101, content: "", createdAt: "2026-11-14T10:00:05.000Z", ...message } as unknown as Message;
  return rowPositionVerdict(webRow(scope!), msg, { counts: scope!.readOnArrival !== true, loaded: false });
}

/** null ("cannot be judged") is met by leaving the message uncounted for the re-read. */
function assertWebToday(contractCase: ContractCase, expected: Verdict): void {
  const actual = webToday(contractCase);
  assert.deepEqual(actual, { counts: expected.counts ?? false, mention: expected.mention });
}

function skipReason(contractCase: ContractCase): string | null {
  if (!KNOWN_FORMAT_VERSIONS.has(contractCase.formatVersion)) return `formatVersion ${contractCase.formatVersion} is not one this loader knows`;
  if (contractCase.status === "pending-product-decision") {
    const web = contractCase.decision?.candidates.find((candidate) => candidate.currentBehaviourOf.includes("web"));
    return `pending product decision: ${contractCase.decision?.question} (web today: ${web?.id ?? "none"})`;
  }
  return null;
}

const webGap = (contractCase: ContractCase) => contractCase.knownGaps?.find((entry) => entry.client === "web");

describe("activity row contract cases", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

  it("finds the case files", () => {
    assert.ok(cases.length > 0, `no cases in ${casesDir}`);
  });

  for (const { name, value } of cases) {
    it(`${name} is valid against case.schema.json`, () => {
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
      assert.equal(`${value.id}.json`, name);
    });
  }

  for (const { value } of cases) {
    const skip = skipReason(value);
    if (skip) it.skip(`${value.id} (skipped: ${skip})`, () => {});
    else it(`${value.id}`, () => runShared(value));
  }
});

describe("activity row predicate cases: web with inbox_row_position_v1 on", () => {
  for (const { value } of cases) {
    if (value.rule !== "predicate" || value.status !== "agreed") continue;
    const gap = webGap(value);
    it(`${value.id}: web's flag-on verdict is the case's`, () => {
      assert.equal(gap, undefined, `a web knownGaps entry, but the flag-on path is meant to follow every agreed case: ${gap?.reason}`);
      assert.deepEqual(webFlagOn(value), value.expect!.verdict);
    });
  }
});

describe("activity row predicate cases: web's live patch with the flag off (as before step 2)", () => {
  it("lists only existing predicate cases as not driven or differing", () => {
    for (const id of [...Object.keys(WEB_TODAY_NOT_DRIVEN), ...Object.keys(FLAG_OFF_DIFFERS)]) {
      assert.equal(cases.find(({ value }) => value.id === id)?.value.rule, "predicate", id);
    }
  });

  for (const { value } of cases) {
    if (value.rule !== "predicate") continue;
    const notDriven = WEB_TODAY_NOT_DRIVEN[value.id];
    if (notDriven) {
      it.skip(`${value.id} (skipped: ${notDriven})`, () => {});
      continue;
    }
    const differs = FLAG_OFF_DIFFERS[value.id];
    if (value.status === "agreed" && differs) {
      it(`${value.id}: the flag-off patch differs (${differs})`, () => {
        const expected = value.expect!.verdict!;
        assert.notDeepEqual(webToday(value), { counts: expected.counts ?? false, mention: expected.mention }, "the flag-off patch follows the case now: remove it from FLAG_OFF_DIFFERS");
      });
      continue;
    }
    if (value.status === "agreed") {
      it(`${value.id}: the flag-off patch agrees`, () => assertWebToday(value, value.expect!.verdict!));
      continue;
    }
    const candidate = value.decision?.candidates.find((entry) => entry.currentBehaviourOf.includes("web"));
    it(`${value.id}: the flag-off patch is the "${candidate?.id}" candidate`, () => {
      assert.ok(candidate?.expect.verdict, "a pending predicate case names web's current behaviour");
      assertWebToday(value, candidate.expect.verdict);
    });
  }
});
