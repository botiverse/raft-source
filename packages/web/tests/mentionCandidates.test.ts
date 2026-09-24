import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOCOMPLETE_TRIGGER_QUERY,
  CHANNEL_TRIGGER,
  MENTION_TRIGGER,
} from "../src/components/message/autocompleteTriggers.js";
import {
  buildMentionCandidateGroups,
  buildMentionCandidateGroupsFromRankedCandidates,
  createMentionCandidateSearchEntries,
  getMentionCandidateDescription,
  getMentionCandidateServerLabel,
  isMemberScopedMentionChannel,
} from "../src/components/message/mentionCandidates.js";
import type {
  MentionCandidate,
} from "../src/components/message/mentionCandidates.js";
import type { Message } from "../src/store/messageStore.js";

const candidates: MentionCandidate[] = [
  { id: "member-idle", name: "alice", displayName: "Alice", type: "user", avatarUrl: null },
  { id: "outsider-recent", name: "zoe", displayName: "Zoe", type: "user", avatarUrl: null },
  { id: "member-recent", name: "bob", displayName: "Bob", type: "agent", avatarUrl: null, description: "Builds frontend flows" },
  { id: "outsider-idle", name: "maya", displayName: "Maya", type: "agent", avatarUrl: null, description: "Research\nand synthesis" },
];

function makeMessage(senderId: string, createdAt: string): Message {
  return {
    id: `${senderId}-${createdAt}`,
    channelId: "thread-1",
    senderType: "user",
    senderId,
    content: "hi",
    createdAt,
  };
}

test("channel thread keeps channel members ahead of non-members", () => {
  const groups = buildMentionCandidateGroups({
    candidates,
    query: "",
    channelMemberIds: new Set(["member-idle", "member-recent"]),
    prioritizeThreadParticipants: true,
    threadMessages: [
      makeMessage("member-recent", "2026-04-21T19:00:00.000Z"),
      makeMessage("outsider-recent", "2026-04-21T19:05:00.000Z"),
    ],
  });

  assert.deepEqual(groups.inChannel.map((candidate) => candidate.id), ["member-recent", "member-idle"]);
  assert.deepEqual(groups.notInChannel.map((candidate) => candidate.id), ["outsider-recent", "outsider-idle"]);
  assert.deepEqual(groups.flat.map((candidate) => candidate.id), [
    "member-recent",
    "member-idle",
    "outsider-recent",
    "outsider-idle",
  ]);
});

test("thread recency only reorders candidates within each membership bucket", () => {
  const groups = buildMentionCandidateGroups({
    candidates,
    query: "",
    channelMemberIds: new Set(["member-idle", "member-recent"]),
    prioritizeThreadParticipants: true,
    threadMessages: [
      makeMessage("member-idle", "2026-04-21T19:00:00.000Z"),
      makeMessage("member-recent", "2026-04-21T19:10:00.000Z"),
      makeMessage("outsider-idle", "2026-04-21T19:15:00.000Z"),
      makeMessage("outsider-recent", "2026-04-21T19:20:00.000Z"),
    ],
  });

  assert.deepEqual(groups.inChannel.map((candidate) => candidate.id), ["member-recent", "member-idle"]);
  assert.deepEqual(groups.notInChannel.map((candidate) => candidate.id), ["outsider-recent", "outsider-idle"]);
});

test("non-thread mode preserves original candidate order inside each bucket", () => {
  const groups = buildMentionCandidateGroups({
    candidates,
    query: "a",
    channelMemberIds: new Set(["member-idle", "member-recent"]),
  });

  assert.deepEqual(groups.inChannel.map((candidate) => candidate.id), ["member-idle"]);
  assert.deepEqual(groups.notInChannel.map((candidate) => candidate.id), ["outsider-idle"]);
  assert.deepEqual(groups.flat.map((candidate) => candidate.id), ["member-idle", "outsider-idle"]);
});

test("non-thread mode ignores thread messages even when callers provide them", () => {
  const rankedCandidates = [candidates[0], candidates[2], candidates[1], candidates[3]];
  const groups = buildMentionCandidateGroupsFromRankedCandidates({
    rankedCandidates,
    channelMemberIds: new Set(["member-idle", "member-recent"]),
    prioritizeThreadParticipants: false,
    threadMessages: [
      makeMessage("member-recent", "2026-04-21T19:10:00.000Z"),
      makeMessage("outsider-idle", "2026-04-21T19:20:00.000Z"),
    ],
  });

  assert.deepEqual(groups.inChannel.map((candidate) => candidate.id), ["member-idle", "member-recent"]);
  assert.deepEqual(groups.notInChannel.map((candidate) => candidate.id), ["outsider-recent", "outsider-idle"]);
});

test("mention autocomplete supports pinyin and fuzzy matching", () => {
  const pinyinCandidates: MentionCandidate[] = [
    { id: "kmp-expert", name: "KMP-专家", displayName: "KMP-专家", type: "agent", avatarUrl: null },
    { id: "kmp-dev", name: "KMP-Developer", displayName: "KMP Developer", type: "agent", avatarUrl: null },
    { id: "android-dev", name: "android-developer", displayName: "Android Developer", type: "user", avatarUrl: null },
  ];

  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: pinyinCandidates,
      query: "zhuanjia",
      channelMemberIds: new Set(["kmp-expert", "kmp-dev", "android-dev"]),
    }).flat.map((candidate) => candidate.id),
    ["kmp-expert"],
  );
  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: pinyinCandidates,
      query: "kmpzhuanjia",
      channelMemberIds: new Set(["kmp-expert", "kmp-dev", "android-dev"]),
    }).flat.map((candidate) => candidate.id),
    ["kmp-expert"],
  );
  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: pinyinCandidates,
      query: "anddev",
      channelMemberIds: new Set(["kmp-expert", "kmp-dev", "android-dev"]),
    }).flat.map((candidate) => candidate.id),
    ["android-dev"],
  );
});

test("mention autocomplete can match agent description and source server labels", () => {
  const scopedCandidates: MentionCandidate[] = [
    { id: "owner", name: "owner", displayName: "Product Owner", type: "agent", avatarUrl: null, description: "Android developer contact" },
    {
      id: "remote",
      name: "remote-agent",
      displayName: "Remote Agent",
      type: "agent",
      avatarUrl: null,
      serverName: "Dialogue Flow",
    },
  ];

  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: scopedCandidates,
      query: "developer",
      channelMemberIds: new Set(["owner", "remote"]),
    }).flat.map((candidate) => candidate.id),
    ["owner"],
  );
  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: scopedCandidates,
      query: "dialogue",
      channelMemberIds: new Set(["owner", "remote"]),
    }).flat.map((candidate) => candidate.id),
    ["remote"],
  );
});

test("mention autocomplete indexes display names without adding fallback text for null display names", () => {
  const displayNameCandidates: MentionCandidate[] = [
    { id: "display-only", name: "handle-only", displayName: "专家", type: "agent", avatarUrl: null },
    { id: "no-display", name: "plain", displayName: null, type: "user", avatarUrl: null },
  ];

  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: displayNameCandidates,
      query: "zhuanjia",
      channelMemberIds: new Set(["display-only", "no-display"]),
    }).flat.map((candidate) => candidate.id),
    ["display-only"],
  );
  assert.deepEqual(
    buildMentionCandidateGroups({
      candidates: displayNameCandidates,
      query: "Stryker was here!",
      channelMemberIds: new Set(["display-only", "no-display"]),
    }).flat.map((candidate) => candidate.id),
    [],
  );
});

test("mention group builder keeps ranked order when thread prioritization is omitted", () => {
  const rankedCandidates = [...candidates].reverse();
  const groups = buildMentionCandidateGroupsFromRankedCandidates({
    rankedCandidates,
    channelMemberIds: new Set(["member-idle", "member-recent"]),
  });

  assert.deepEqual(groups.inChannel.map((candidate) => candidate.id), ["member-recent", "member-idle"]);
  assert.deepEqual(groups.notInChannel.map((candidate) => candidate.id), ["outsider-idle", "outsider-recent"]);
  assert.deepEqual(createMentionCandidateSearchEntries(displayNameOnlyCandidate()).map((entry) => entry.fields[1]?.raw), ["Only Display"]);
});

test("Computer and App references keep distinct groups and keyboard order", () => {
  const resourceCandidates: MentionCandidate[] = [
    ...candidates,
    { id: "computer-1", name: "Desk", displayName: "Desk", type: "computer", avatarUrl: null, description: "Office Mac" },
    { id: "system.reminder", name: "system.reminder", displayName: "Reminder", type: "app", avatarUrl: null },
  ];
  const groups = buildMentionCandidateGroups({
    candidates: resourceCandidates,
    query: "",
    channelMemberIds: new Set(["member-idle", "member-recent"]),
  });

  assert.deepEqual(groups.computers.map((candidate) => candidate.id), ["computer-1"]);
  assert.deepEqual(groups.apps.map((candidate) => candidate.id), ["system.reminder"]);
  assert.deepEqual(groups.flat.map((candidate) => candidate.type), [
    "user", "agent", "user", "agent", "computer", "app",
  ]);
});

function displayNameOnlyCandidate(): MentionCandidate[] {
  return [{ id: "display", name: "plain", displayName: "Only Display", type: "user", avatarUrl: null }];
}

test("candidate descriptions are normalized for compact dropdown display", () => {
  assert.equal(getMentionCandidateDescription(candidates[2]!), "Builds frontend flows");
  assert.equal(getMentionCandidateDescription(candidates[3]!), "Research and synthesis");
  assert.equal(getMentionCandidateDescription(candidates[0]!), null);
  assert.equal(getMentionCandidateDescription({ id: "c", name: "Desk", displayName: "Desk", type: "computer", avatarUrl: null, description: "Office\nMac" }), "Office Mac");
});

test("joint mention candidates preserve peer server labels", () => {
  assert.equal(
    getMentionCandidateServerLabel({
      id: "peer-agent",
      serverId: "peer-server",
      serverName: "Isolation",
      serverSlug: "isolation",
      name: "orphan-agent",
      displayName: "Orphan Agent",
      type: "agent",
      avatarUrl: null,
      description: null,
    }),
    "Isolation",
  );
  assert.equal(
    getMentionCandidateServerLabel({
      id: "peer-user",
      serverId: "peer-server",
      serverName: null,
      serverSlug: "isolation",
      name: "isolation-admin",
      displayName: "Isolation Admin",
      type: "user",
      avatarUrl: null,
    }),
    "isolation",
  );
});

test("mention autocomplete scopes candidates only for private and joint channels", () => {
  assert.equal(isMemberScopedMentionChannel({ type: "private" }), true);
  assert.equal(isMemberScopedMentionChannel({ type: "joint" }), true);
  assert.equal(isMemberScopedMentionChannel({ type: "dm" }), false);
  assert.equal(isMemberScopedMentionChannel({ type: "channel" }), false);
  assert.equal(isMemberScopedMentionChannel({ type: null }), false);
  assert.equal(isMemberScopedMentionChannel(null), false);
  assert.equal(isMemberScopedMentionChannel(undefined), false);
});

test("MessageInput #channel autocomplete keeps CJK query text like @mentions", () => {
  assert.equal(AUTOCOMPLETE_TRIGGER_QUERY, String.raw`[\p{L}\p{N}_-]*`);
  assert.equal("hello @铁根".match(MENTION_TRIGGER)?.[1], "铁根");
  assert.equal("hello #项目".match(CHANNEL_TRIGGER)?.[1], "项目");
  assert.equal("hello #proj-uiux".match(CHANNEL_TRIGGER)?.[1], "proj-uiux");
});
