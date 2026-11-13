import assert from "node:assert/strict";
import {
  buildSearchEntityEntriesWhenQueryPresent,
  buildSearchEntityResults,
} from "../searchEntities";

test("skips entity entry construction until the query has non-whitespace text", () => {
  let channelScans = 0;
  const channels = new Proxy([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) channelScans += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const params = {
    channels,
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  };

  assert.deepEqual(buildSearchEntityEntriesWhenQueryPresent("".trim().length > 0, params), []);
  assert.deepEqual(buildSearchEntityEntriesWhenQueryPresent(" \n\t".trim().length > 0, params), []);
  assert.equal(channelScans, 0, "empty and whitespace-only queries must not invoke the entity builder");

  assert.deepEqual(buildSearchEntityEntriesWhenQueryPresent("d".trim().length > 0, params), []);
  assert.equal(channelScans, 1, "the first non-empty query must enter the shared entity builder");
});

test("ranks exact/prefix entity matches ahead of substring matches", () => {
  const results = buildSearchEntityResults({
    query: "gen",
    channels: [
      { id: "c1", name: "general", description: null, type: "channel", createdAt: "" },
      { id: "c2", name: "eng-general", description: null, type: "channel", createdAt: "" },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });

  assert.deepEqual(
    results.map((result) => result.key),
    ["channel:c1", "channel:c2"]
  );
});

test("matches channels by hash-prefixed channel name", () => {
  const results = buildSearchEntityResults({
    query: "#general",
    channels: [
      { id: "c1", name: "general", description: null, type: "channel", createdAt: "" },
      { id: "c2", name: "random", description: null, type: "channel", createdAt: "" },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });

  assert.deepEqual(
    results.map((result) => result.key),
    ["channel:c1"],
  );
});

test("includes agents and humans as DM targets even if no DM channel exists yet", () => {
  const results = buildSearchEntityResults({
    query: "ray",
    channels: [],
    members: [
      {
        userId: "u1",
        email: "ray@slock.ai",
        name: "ray",
        displayName: "Ray",
        avatarUrl: null,
        role: "member",
        joinedAt: "",
      },
    ],
    agents: [
      {
        id: "a1",
        name: "ray-agent",
        displayName: "Ray Agent",
        avatarUrl: null,
        description: null,
        status: "active",
        model: "gpt-5",
        runtime: "codex",
        reasoningEffort: null,
        executionMode: "cloud",
        envVars: null,
        machineId: null,
        deletedAt: null,
        createdAt: "",
      },
    ],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });

  assert.equal(results.length, 2);
  assert.deepEqual(
    new Set(results.map((result) => `${result.key}:${String(result.channelId)}`)),
    new Set(["agent:a1:null", "human:u1:null"])
  );
});

test("never offers another person's personal assistant; the viewer's own stays findable", () => {
  const assistant = (id: string, ownerId: string) => ({
    id,
    name: `${ownerId}-assistant`,
    displayName: "Ottie",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "external",
    runtime: "external",
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    deletedAt: null,
    createdAt: "",
    assistantOwnerUserId: ownerId,
  });
  const results = buildSearchEntityResults({
    query: "ottie",
    channels: [],
    members: [],
    agents: [assistant("a-mine", "me"), assistant("a-theirs", "bob")] as Parameters<typeof buildSearchEntityResults>[0]["agents"],
    machines: [],
    currentUser: { id: "me", email: "me@slock.ai", name: "me", displayName: null, avatarUrl: null, emailVerified: true },
    dmChannels: [],
  });
  assert.deepEqual(results.map((result) => result.key), ["agent:a-mine"]);
});

test("includes the current user as a self DM entity match", () => {
  const results = buildSearchEntityResults({
    query: "dev",
    channels: [],
    agents: [],
    machines: [],
    currentUser: {
      id: "user-self",
      email: "dev@slock.ai",
      name: "Developer",
      displayName: null,
      avatarUrl: null,
      emailVerified: true,
    },
    members: [{
      userId: "user-self",
      email: "dev@slock.ai",
      name: "Developer",
      displayName: null,
      description: null,
      avatarUrl: null,
      role: "owner",
      joinedAt: new Date().toISOString(),
    }],
    dmChannels: [{
      id: "dm-self",
      name: "Developer",
      description: null,
      type: "dm",
      createdAt: new Date().toISOString(),
      peerType: "user",
      peerId: "user-self",
      peerName: "Developer",
      peerDisplayName: null,
      peerDescription: null,
      peerAvatarUrl: null,
    }],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, "humanDm");
  assert.equal(results[0].channelId, "dm-self");
  assert.equal(results[0].title, "Developer");
  assert.deepEqual(results[0].subtitle, { kind: "selfDm" });
});

test("excludes thread rows from channel entity candidates", () => {
  // Threads land in `channelStore.channels` after ensureChannel(threadId) runs
  // for a thread search hit (PR #2164). They must not surface as "Channel"
  // entity candidates — stdrc msg=4b24a914 2026-05-28.
  const results = buildSearchEntityResults({
    query: "team",
    channels: [
      { id: "c1", name: "team-chat", description: null, type: "channel", createdAt: "" },
      { id: "t1", name: "team thread title", description: null, type: "thread", createdAt: "" },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });

  assert.deepEqual(
    results.map((result) => result.key),
    ["channel:c1"]
  );
});

test("includes managed computers as searchable entity targets", () => {
  const results = buildSearchEntityResults({
    query: "mac",
    channels: [],
    members: [],
    agents: [],
    machines: [
      {
        id: "m-computer",
        name: "Alice Mac Mini",
        description: "Build runner",
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["codex"],
        hostname: "alice-mini.local",
        os: "darwin",
        daemonVersion: "0.1.0",
        isComputer: true,
        lastHeartbeat: null,
        createdAt: "",
      },
      {
        id: "m-daemon",
        name: "Legacy Mac Daemon",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: [],
        hostname: "legacy-mini.local",
        os: "darwin",
        daemonVersion: "0.1.0",
        isComputer: false,
        lastHeartbeat: null,
        createdAt: "",
      },
    ],
    currentUser: null,
    dmChannels: [],
  });

  assert.deepEqual(results.map((result) => result.key), ["computer:m-computer"]);
  assert.equal(results[0].type, "computer");
  assert.equal(results[0].machineId, "m-computer");
  assert.deepEqual(results[0].subtitle, { kind: "computer", hostname: "alice-mini.local" });
});

test("global entity search shares pinyin full and initials matching across channels, computers, and people", () => {
  const params = {
    channels: [
      { id: "c-pinyin", name: "对话流专修", description: null, type: "channel" as const, createdAt: "" },
    ],
    members: [
      {
        userId: "u-pinyin",
        email: "zhaozq@example.com",
        name: "zhaozq",
        displayName: "赵梓淇",
        avatarUrl: null,
        role: "member" as const,
        joinedAt: "",
      },
    ],
    agents: [
      {
        id: "a-pinyin",
        name: "assistant-xm",
        displayName: "小明助手",
        avatarUrl: null,
        description: null,
        status: "active" as const,
        model: "gpt-5",
        runtime: "codex",
        reasoningEffort: null,
        executionMode: "cloud" as const,
        envVars: null,
        machineId: null,
        deletedAt: null,
        createdAt: "",
      },
    ],
    machines: [
      {
        id: "m-pinyin",
        name: "上海工作站",
        description: null,
        status: "online" as const,
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["codex"],
        hostname: "build-sh.local",
        os: "darwin",
        daemonVersion: "0.1.0",
        isComputer: true,
        lastHeartbeat: null,
        createdAt: "",
      },
    ],
    currentUser: null,
    dmChannels: [],
  };

  const keysFor = (query: string) =>
    buildSearchEntityResults({ ...params, query }).map((result) => result.key);

  assert.deepEqual(keysFor("duihua"), ["channel:c-pinyin"]);
  assert.deepEqual(keysFor("dh"), ["channel:c-pinyin"]);
  assert.deepEqual(keysFor("shanghai"), ["computer:m-pinyin"]);
  assert.deepEqual(keysFor("shgzz"), ["computer:m-pinyin"]);
  assert.deepEqual(keysFor("zhaiziqi"), []);
  assert.deepEqual(keysFor("zhaoziqi"), ["human:u-pinyin"]);
  assert.deepEqual(keysFor("zzq"), ["human:u-pinyin"]);
  assert.deepEqual(keysFor("xiaoming"), ["agent:a-pinyin"]);
  assert.deepEqual(keysFor("xmzs"), ["agent:a-pinyin"]);
});

test("a channel matched by its description gets the description, cut like a message snippet", async () => {
  const { searchEntitySubtitleForQuery } = await import("../searchEntities");
  const { splitSearchHighlight } = await import("../searchHighlightParts");
  const channel = {
    key: "channel:c1",
    type: "channel" as const,
    title: "release",
    subtitle: { kind: "channel" as const },
    channelId: "c1",
    channelType: "channel" as const,
    machineId: null,
    agentId: null,
    userId: null,
    archivedAt: null,
    description: "这个频道用于讨论每周的发布计划和阻塞问题最终由remy确认上线",
  };

  // The shared snippet cut (raft-shared buildSearchSnippet): 12 CJK characters = 24 columns before the hit.
  assert.deepEqual(searchEntitySubtitleForQuery(channel, "remy"), { kind: "text", text: "…发布计划和阻塞问题最终由remy确认上线" });
  // Latin: the cut moves off the middle of "of" to the next word.
  assert.deepEqual(
    searchEntitySubtitleForQuery({ ...channel, description: "Every decision of that is written down, Remy will check it" }, "remy"),
    { kind: "text", text: "…that is written down, Remy will check it" },
  );
  // CJK: the comma the cut leaves at the start is dropped.
  assert.deepEqual(
    searchEntitySubtitleForQuery({ ...channel, description: "先把需求背景和验收标准整理好，这些都写清楚之后再请 remy 看一下" }, "@remy"),
    { kind: "text", text: "…这些都写清楚之后再请 remy 看一下" },
  );
  assert.deepEqual(searchEntitySubtitleForQuery({ ...channel, description: "Ask remy" }, "remy"), { kind: "text", text: "Ask remy" });
  assert.deepEqual(searchEntitySubtitleForQuery(channel, "release"), { kind: "channel" }, "no hit in the description keeps the label");
  assert.deepEqual(searchEntitySubtitleForQuery(channel, ""), { kind: "channel" });

  assert.deepEqual(
    splitSearchHighlight("cc @Remy-dev and #remy", "remy remy-dev"),
    [
      { text: "cc ", hit: false },
      { text: "@Remy-dev", hit: true },
      { text: " and ", hit: false },
      { text: "#remy", hit: true },
    ],
  );
});

test("archived channels rank below live ones, and channels you haven't joined below ones you're in, whatever the match", () => {
  // xxchan, #triage:666d1506: "onboarding" put three archived onboarding-<name> channels above wg-onboarding-v3.
  const archivedAt = "2026-11-01T00:00:00.000Z";
  const results = buildSearchEntityResults({
    query: "onboarding",
    channels: [
      { id: "a1", name: "onboarding-xxchan02", description: null, type: "private", createdAt: "", archivedAt, joined: true },
      { id: "a2", name: "onboarding-qizhi-wang", description: null, type: "private", createdAt: "", archivedAt, joined: false },
      { id: "p1", name: "onboarding-zhiqiang-zhou", description: null, type: "private", createdAt: "", joined: false },
      { id: "w1", name: "wg-onboarding-v3", description: null, type: "channel", createdAt: "", joined: true },
      { id: "t1", name: "team-management", description: "Team organization and onboarding.", type: "channel", createdAt: "", joined: true },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  } as never);

  assert.deepEqual(
    results.map((result) => result.key),
    // Joined and live (name match before description match), then live but not joined, then archived.
    ["channel:w1", "channel:t1", "channel:p1", "channel:a1", "channel:a2"],
  );
});

test("archived matches never push live ones off the capped list", () => {
  const archivedAt = "2026-11-01T00:00:00.000Z";
  const archived = Array.from({ length: 40 }, (_, index) => ({
    id: `a${index}`, name: `onboarding-${index}`, description: null, type: "channel", createdAt: "", archivedAt, joined: true,
  }));
  const results = buildSearchEntityResults({
    query: "onboarding",
    channels: [...archived, { id: "w1", name: "wg-onboarding-v3", description: null, type: "channel", createdAt: "", joined: true }],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  } as never);

  assert.equal(results[0]?.key, "channel:w1");
  assert.equal(results.length, 30);
});

test("an exact name you haven't joined still comes first, so Enter goes to it", () => {
  const results = buildSearchEntityResults({
    query: "design",
    channels: [
      { id: "j1", name: "dev-sign-off", description: null, type: "channel", createdAt: "", joined: true },
      { id: "u1", name: "design", description: null, type: "channel", createdAt: "", joined: false },
    ],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  } as never);
  assert.equal(results[0]?.key, "channel:u1");
});
