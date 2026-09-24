import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import {
  notifyAllChannelMembersChanged,
  notifyChannelMembersChanged,
} from "../src/store/channelMemberEvents";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelMembers } from "../src/hooks/useChannelMembers";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiPatch = api.patch;
const originalConsoleError = console.error;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  console.error = originalConsoleError;
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
});

test("role update failures remain observable to mounted member surfaces", async () => {
  api.get = (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get;
  api.patch = (async () => {
    throw new Error("role update rejected");
  }) as typeof api.patch;
  console.error = () => {};

  let channelId = "channel-a";
  const view = renderHook(() => useChannelMembers(channelId));
  await waitFor(() => assert.equal(view.result.current.loading, false));

  await act(async () => {
    await assert.rejects(
      view.result.current.changeMemberRole("user", "peer-1", "admin"),
      /role update rejected/,
    );
  });

  assert.equal(view.result.current.roleChangeFailed, true);

  channelId = "channel-b";
  view.rerender();
  assert.equal(view.result.current.roleChangeFailed, false, "a failed write must not leak into another channel");
});

test("channel member projections react to the canonical agent store while retaining remote fallbacks", async () => {
  let getCalls = 0;
  api.get = (async () => {
    getCalls += 1;
    return {
      data: {
        agents: [
          {
            id: "agent-local",
            name: "local",
            displayName: "Stale local",
            avatarUrl: "/avatars/stale-local.webp",
          },
          {
            id: "agent-remote",
            name: "remote",
            displayName: "Remote fallback",
            avatarUrl: "/avatars/remote.webp",
          },
        ],
        humans: [],
      },
    };
  }) as typeof api.get;
  useAgentStore.setState({
    agents: [{
      id: "agent-local",
      name: "local",
      displayName: "Current local",
      avatarUrl: "/avatars/current-local.webp",
    }],
    agentActivities: {},
  } as never);

  const view = renderHook(() => useChannelMembers("channel-a"));

  await waitFor(() => {
    assert.equal(view.result.current.channelAgents.length, 2);
    assert.equal(view.result.current.channelAgents[0]?.displayName, "Current local");
    assert.equal(view.result.current.channelAgents[0]?.avatarUrl, "/avatars/current-local.webp");
    assert.equal(view.result.current.channelAgents[1]?.avatarUrl, "/avatars/remote.webp");
  });

  act(() => {
    useAgentStore.setState({
      agents: [{
        id: "agent-local",
        name: "local",
        displayName: "Updated local",
        avatarUrl: "/avatars/updated-local.webp",
      }],
    } as never);
  });

  await waitFor(() => {
    assert.equal(view.result.current.channelAgents[0]?.displayName, "Updated local");
    assert.equal(view.result.current.channelAgents[0]?.avatarUrl, "/avatars/updated-local.webp");
  });
  assert.equal(getCalls, 1, "identity updates should not refetch the membership relation");
});

test("scoped invalidation reloads one channel while server-wide invalidation reloads all mounted snapshots", async () => {
  const calls = new Map<string, number>();
  api.get = (async (url: string) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;

  const channelA = renderHook(() => useChannelMembers("channel-a"));
  const channelB = renderHook(() => useChannelMembers("channel-b"));

  await waitFor(() => {
    assert.equal(calls.get("/channels/channel-a/members"), 1);
    assert.equal(calls.get("/channels/channel-b/members"), 1);
  });

  act(() => notifyChannelMembersChanged("channel-a"));
  await waitFor(() => {
    assert.equal(calls.get("/channels/channel-a/members"), 2);
    assert.equal(calls.get("/channels/channel-b/members"), 1);
  });

  act(() => notifyAllChannelMembersChanged());
  await waitFor(() => {
    assert.equal(calls.get("/channels/channel-a/members"), 3);
    assert.equal(calls.get("/channels/channel-b/members"), 2);
  });

  channelA.unmount();
  channelB.unmount();
});

test("adding a human reloads sibling same-channel hook instances without a socket round-trip", async () => {
  const originalPost = api.post;
  const gets: string[] = [];
  let humans = [{ id: "user-a", name: "Ada", displayName: "Ada", description: null, avatarUrl: null, gravatarHash: "", role: "member" }];
  api.get = (async (url: string) => {
    gets.push(url);
    return { data: { agents: [], humans } };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/channels/channel-a/members");
    assert.deepEqual(body, { userId: "user-b" });
    humans = [
      ...humans,
      { id: "user-b", name: "Bea", displayName: "Bea", description: null, avatarUrl: null, gravatarHash: "", role: "member" },
    ];
    return { data: {} };
  }) as typeof api.post;

  const composer = renderHook(() => useChannelMembers("channel-a"));
  const membersRail = renderHook(() => useChannelMembers("channel-a"));
  await waitFor(() => {
    assert.equal(composer.result.current.channelHumans.length, 1);
    assert.equal(membersRail.result.current.channelHumans.length, 1);
  });
  const getsAfterMount = gets.length;
  assert.equal(getsAfterMount, 1, "simultaneous same-channel consumers share one in-flight members request");

  await act(async () => {
    await composer.result.current.addHuman("user-b");
  });
  await waitFor(() => {
    assert.equal(composer.result.current.channelHumans.map((human) => human.id).join(","), "user-a,user-b");
    assert.equal(membersRail.result.current.channelHumans.map((human) => human.id).join(","), "user-a,user-b");
  });
  assert.ok(gets.length > getsAfterMount, "local membership write must refetch without waiting for a socket event");

  composer.unmount();
  membersRail.unmount();
  api.post = originalPost;
});

test("adding an agent hydrates activity snapshots for sibling consumers", async () => {
  let agents: Array<{
    id: string;
    name: string;
    displayName: string;
    activity?: string;
    activityDetail?: string;
  }> = [];
  api.get = (async () => ({
    data: { agents, humans: [] },
  })) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/channels/channel-a/members");
    assert.deepEqual(body, { agentId: "agent-remote" });
    agents = [{
      id: "agent-remote",
      name: "remote",
      displayName: "Remote",
      activity: "working",
      activityDetail: "compiling",
    }];
    return { data: {} };
  }) as typeof api.post;

  const composer = renderHook(() => useChannelMembers("channel-a"));
  const membersRail = renderHook(() => useChannelMembers("channel-a"));
  await waitFor(() => {
    assert.equal(composer.result.current.loading, false);
    assert.equal(membersRail.result.current.loading, false);
  });
  assert.equal(composer.result.current.channelAgents.length, 0);
  assert.equal(membersRail.result.current.channelAgents.length, 0);
  assert.equal(useAgentStore.getState().agentActivities["agent-remote"], undefined);

  await act(async () => {
    await composer.result.current.addAgent("agent-remote");
  });
  await waitFor(() => {
    assert.equal(composer.result.current.channelAgents[0]?.id, "agent-remote");
    assert.equal(membersRail.result.current.channelAgents[0]?.id, "agent-remote");
    assert.equal(useAgentStore.getState().agentActivities["agent-remote"]?.activity, "working");
  });

  composer.unmount();
  membersRail.unmount();
});

test("adding a mixed member selection uses one batch request and one roster refresh", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  let getCalls = 0;
  let agents: Array<{ id: string; name: string; displayName: string }> = [];
  let humans: Array<{
    id: string;
    name: string;
    displayName: string;
    description: null;
    avatarUrl: null;
    gravatarHash: string;
    role: "member";
  }> = [];
  api.get = (async () => {
    getCalls += 1;
    return { data: { agents, humans } };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    agents = [{ id: "agent-a", name: "agent-a", displayName: "Agent A" }];
    humans = [
      { id: "human-a", name: "human-a", displayName: "Human A", description: null, avatarUrl: null, gravatarHash: "", role: "member" },
      { id: "human-b", name: "human-b", displayName: "Human B", description: null, avatarUrl: null, gravatarHash: "", role: "member" },
    ];
    return {
      data: {
        ok: true,
        added: { userIds: ["human-a", "human-b"], agentIds: ["agent-a"] },
        alreadyMembers: { userIds: [], agentIds: [] },
      },
    };
  }) as typeof api.post;

  const view = renderHook(() => useChannelMembers("channel-a"));
  await waitFor(() => assert.equal(view.result.current.loading, false));
  const getsBeforeAdd = getCalls;

  let result: Awaited<ReturnType<typeof view.result.current.addMembers>> | undefined;
  await act(async () => {
    result = await view.result.current.addMembers({
      userIds: ["human-a", "human-b"],
      agentIds: ["agent-a"],
    });
  });

  assert.deepEqual(posts, [{
    url: "/channels/channel-a/members/batch",
    body: { userIds: ["human-a", "human-b"], agentIds: ["agent-a"] },
  }]);
  assert.deepEqual(result, {
    added: { userIds: ["human-a", "human-b"], agentIds: ["agent-a"] },
    alreadyMembers: { userIds: [], agentIds: [] },
  });
  await waitFor(() => {
    assert.equal(view.result.current.channelAgents.length, 1);
    assert.equal(view.result.current.channelHumans.length, 2);
  });
  assert.equal(getCalls, getsBeforeAdd + 1, "one batch mutation should trigger one coalesced roster refresh");

  view.unmount();
});
