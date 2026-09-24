import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchEntityEntriesWhenQueryPresent,
  buildSearchEntityResults,
} from "../src/components/search/searchEntities.js";

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
      gravatarHash: "hash",
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
      peerGravatarHash: "hash",
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
        name: "Ray Mac Mini",
        description: "Build runner",
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["codex"],
        hostname: "ray-mini.local",
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
  assert.deepEqual(results[0].subtitle, { kind: "computer", hostname: "ray-mini.local" });
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
