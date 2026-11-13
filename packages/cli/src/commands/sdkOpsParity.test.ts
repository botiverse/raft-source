/**
 * Text parity between CLI commands and the SDK operations that mirror them
 * (`createRaft().users.info` / `channels.info` / `tasks.show` /
 * `actions.withdraw` / `artifacts.check`, implemented in
 * shared agentOps). Each case runs the real CLI argv (registryPin harness) and
 * the shared operation against the SAME fake Agent API responses, and asserts
 * the CLI's stdout equals the operation's `text` byte for byte; for misses,
 * the CLI's error message is the operation's error message.
 */
import { expect, test } from "vitest";

import { artifactsCheck, channelInfo, createAgentApiClient, showTask, userInfo, withdrawQuestionCard, type AgentApiClient, type RaftOutcome } from "@botiverse/raft-shared";

import { runPinned, type FakeRoute } from "./registryPin/harness";

/** A shared Agent API client answering from the same fake routes as the CLI harness. */
function sdkClient(routes: FakeRoute[]): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        const method = init?.method ?? "GET";
        const route = routes.find((r) => (!r.method || r.method === method) && r.path.test(path));
        if (!route) return Response.json({ error: `no fake route for ${method} ${path}` }, { status: 404 });
        if (route.response && !route.response.ok) {
          return Response.json({ error: route.response.error ?? "failed", code: route.response.errorCode ?? undefined }, { status: route.response.status });
        }
        return Response.json(route.response?.data ?? route.data);
      },
    },
  });
}

async function expectSameText(argv: string[], routes: FakeRoute[], op: (api: AgentApiClient) => Promise<RaftOutcome<unknown, string>>): Promise<string> {
  const cli = await runPinned(argv, routes);
  expect(cli.stderr).toBe("");
  expect(cli.exitCode).toBe(0);
  const outcome = await op(sdkClient(routes));
  if (!outcome.ok) throw new Error(`SDK op failed: ${outcome.text}`);
  expect(outcome.text).toBe(cli.stdout);
  return cli.stdout;
}

async function expectSameMiss(argv: string[], routes: FakeRoute[], op: (api: AgentApiClient) => Promise<RaftOutcome<unknown, string>>, code: string): Promise<void> {
  const cli = await runPinned(argv, routes);
  expect(cli.exitCode).not.toBe(0);
  const outcome = await op(sdkClient(routes));
  if (outcome.ok) throw new Error("SDK op unexpectedly succeeded");
  expect(outcome.error.code).toBe(code);
  expect(cli.stderr).toContain(outcome.error.message);
}

const SERVER_INFO = {
  runtimeContext: { agentId: "agent-pin", serverId: "server-1" },
  serverRole: "member",
  channels: [
    { id: "channel-general", name: "general", joined: true, type: "channel", description: "team-wide chat", muted: false, channelRole: "member", channelCapabilities: { pin: true, archive: false } },
    { id: "channel-eng", name: "engineering", joined: false, type: "channel", description: "build and deploy", activityMuted: true },
    { id: "channel-partners", name: "partners", joined: true, type: "joint", description: "Shared with another server", archived: false },
    { id: "channel-secret", name: "secret", joined: true, type: "private", description: null, archived: true, channelRole: "admin", channelAdminBasis: "both" },
    { id: "channel-old", name: "old", joined: true, type: "channel" },
  ],
  agents: [
    { name: "agent-pin", status: "active", activity: "working", role: "member" },
    { name: "scout", status: "active", activity: "idle", role: "admin", description: "release scout" },
  ],
  humans: [
    { name: "richard", role: "owner", description: "founder" },
    { name: "alice", role: "member" },
  ],
};

const MEMBERS: FakeRoute[] = [
  { path: /channel-members\?channel=%23general$/, data: { channel: { ref: "#general", type: "channel" }, agents: [{ name: "agent-pin", status: "active" }, { name: "scout", status: "active" }], humans: [{ name: "richard", role: "owner" }, { name: "alice" }] } },
  { path: /channel-members\?channel=%23engineering$/, response: { ok: false, status: 403, error: "forbidden", data: null } as never },
  { path: /channel-members\?channel=%23partners$/, data: { channel: { ref: "#partners", type: "joint" }, agents: [], humans: [{ name: "richard", role: "owner" }] } },
  { path: /channel-members\?channel=%23secret$/, data: { channel: { ref: "#secret", type: "private" }, agents: [{ name: "scout" }], humans: [{ name: "richard" }] } },
  { path: /channel-members\?channel=%23old$/, data: { channel: { ref: "#old", type: "channel" }, agents: [{ name: "scout" }], humans: [] } },
];
/**
 * `GET /users/:name/channels` as the Server answers it over the fake rosters
 * above: the user's server.info entry, and each window channel's caller row
 * when its roster lists the name (a refused roster is unchecked).
 */
function userChannelsRoute(name: string, offset: number, limit: number): FakeRoute {
  const path = new RegExp(`/users/${name}/channels\\?offset=${offset}&limit=${limit}$`);
  const agent = SERVER_INFO.agents.find((candidate) => candidate.name === name);
  const human = SERVER_INFO.humans.find((candidate) => candidate.name === name);
  if (!agent && !human) {
    return { path, response: { ok: false, status: 404, error: "User not found or not visible", errorCode: "user_not_found", data: null } };
  }
  const memberships: unknown[] = [];
  let uncheckedCount = 0;
  for (const channel of SERVER_INFO.channels.slice(offset, offset + limit)) {
    const roster = MEMBERS.find((route) => route.path.test(`/internal/agent-api/channel-members?channel=%23${channel.name}`));
    const data = roster?.data as { agents: Array<{ name: string }>; humans: Array<{ name: string }> } | undefined;
    if (!data) {
      uncheckedCount += 1;
      continue;
    }
    if ((agent ? data.agents : data.humans).some((candidate) => candidate.name === name)) memberships.push(channel);
  }
  return {
    path,
    data: { user: agent ?? human, kind: agent ? "agent" : "human", memberships, uncheckedCount, page: { total: SERVER_INFO.channels.length, offset, limit } },
  };
}

const ROUTES: FakeRoute[] = [
  { path: /\/server$/, data: SERVER_INFO },
  ...MEMBERS,
  userChannelsRoute("richard", 0, 50),
  userChannelsRoute("scout", 0, 50),
  userChannelsRoute("scout", 0, 2),
  userChannelsRoute("scout", 2, 2),
  userChannelsRoute("alice", 9, 50),
  userChannelsRoute("nobody", 0, 50),
];

test("users.info text is the CLI's `raft user info` (human, agent, paged, skipped rosters)", async () => {
  await expectSameText(["user", "info", "richard"], ROUTES, (api) => userInfo(api, { name: "richard" }));
  await expectSameText(["user", "info", "@scout"], ROUTES, (api) => userInfo(api, { name: "@scout" }));
  const paged = await expectSameText(["user", "info", "scout", "--limit", "2"], ROUTES, (api) => userInfo(api, { name: "scout", limit: 2 }));
  expect(paged).toContain("raft user info @scout --offset 2 --limit 2");
  expect(paged).toContain("Skipped 1 visible channel roster checks");
  await expectSameText(["user", "info", "scout", "--offset", "2", "--limit", "2"], ROUTES, (api) => userInfo(api, { name: "scout", offset: 2, limit: 2 }));
  await expectSameText(["user", "info", "alice", "--offset", "9"], ROUTES, (api) => userInfo(api, { name: "alice", offset: 9 }));
  const outcome = await userInfo(sdkClient(ROUTES), { name: "scout", limit: 2 });
  expect(outcome.ok && outcome.next?.args).toEqual({ name: "@scout", offset: 2, limit: 2 });
  await expectSameMiss(["user", "info", "nobody"], ROUTES, (api) => userInfo(api, { name: "nobody" }), "NOT_FOUND");
  // Without roster access (the route refuses the credential): server.info, every inspected channel skipped.
  const refused: FakeRoute[] = [
    { path: /\/users\/[^/]+\/channels\?/, response: { ok: false, status: 403, error: "Agent credential is not authorized for this capability", errorCode: "capability_not_authorized", data: null } },
    { path: /\/server$/, data: SERVER_INFO },
  ];
  const skipped = await expectSameText(["user", "info", "scout", "--limit", "2"], refused, (api) => userInfo(api, { name: "scout", limit: 2 }));
  expect(skipped).toContain("Skipped 2 visible channel roster checks");
  await expectSameMiss(["user", "info", "nobody"], refused, (api) => userInfo(api, { name: "nobody" }), "NOT_FOUND");
});

test("channels.info text is the CLI's `raft channel info` (roles, capabilities, mute, archive, refused roster)", async () => {
  for (const target of ["#general", "engineering", "#partners", "secret", "#old"]) {
    await expectSameText(["channel", "info", target], ROUTES, (api) => channelInfo(api, { target }));
  }
  await expectSameMiss(["channel", "info", "#missing"], ROUTES, (api) => channelInfo(api, { target: "#missing" }), "NOT_FOUND");
  await expectSameMiss(["channel", "info", "#general:aaaabbbb"], ROUTES, (api) => channelInfo(api, { target: "#general:aaaabbbb" }), "INVALID_REQUEST");
});

test("tasks.show text is the CLI's `raft task show` (three description states, done tasks, misses)", async () => {
  const tasks = [
    { taskNumber: 1, status: "done", title: "Ship it", description: "multi\nline description", createdByName: "richard", createdByHandle: "richard" },
    { taskNumber: 2, status: "todo", title: "Plan", description: null },
    { taskNumber: 3, status: "in_progress", title: "Omitted description" },
    { taskNumber: 4 },
  ];
  const routes: FakeRoute[] = [{ path: /\/tasks\?/, data: { tasks, scope: "channel" } }];
  for (const taskNumber of [1, 2, 3, 4]) {
    await expectSameText(["task", "show", "--target", "#general", "--number", String(taskNumber)], routes, (api) => showTask(api, { target: "#general", taskNumber }));
  }
  await expectSameMiss(["task", "show", "--target", "#general", "--number", "9"], routes, (api) => showTask(api, { target: "#general", taskNumber: 9 }), "NOT_FOUND");
  const empty: FakeRoute[] = [{ path: /\/tasks\?/, data: { tasks: [] } }];
  await expectSameMiss(["task", "show", "--target", "#general", "--number", "9"], empty, (api) => showTask(api, { target: "#general", taskNumber: 9 }), "NOT_FOUND");
  const complete: FakeRoute[] = [{ path: /\/tasks\?/, data: { tasks, pagination: { mode: "complete", truncated: false } } }];
  await expectSameMiss(["task", "show", "--target", "#general", "--number", "9"], complete, (api) => showTask(api, { target: "#general", taskNumber: 9 }), "NOT_FOUND");
});

test("actions.withdraw text is the CLI's `raft action withdraw` (withdrawn, already withdrawn, asked anyone, misses)", async () => {
  const id = "1a2b3c4d-1111-4222-8333-444455556666";
  const action = { type: "question:ask", ref: "deploy-1", addressee: { kind: "user", userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" }, questions: [{ id: "window", kind: "text", text: "Which window?" }] };
  const route = (data: Record<string, unknown>): FakeRoute[] => [{ method: "POST", path: /\/actions\/[^/]+\/withdraw$/, data: { messageId: id, metadata: { kind: "action-card", state: "withdrawn", action }, ...data } }];
  for (const routes of [route({}), route({ alreadyWithdrawn: true }), route({ metadata: { kind: "action-card", state: "withdrawn", action: { ...action, addressee: { kind: "anyone" } } } })]) {
    await expectSameText(["action", "withdraw", "--message", "1a2b3c4d"], routes, (api) => withdrawQuestionCard(api, { messageId: "1a2b3c4d" }));
  }
  const missing: FakeRoute[] = [{ method: "POST", path: /\/withdraw$/, response: { ok: false, status: 404, error: "No question card with that message id", errorCode: "NOT_FOUND", data: null } }];
  await expectSameMiss(["action", "withdraw", "--message", "ffffffff"], missing, (api) => withdrawQuestionCard(api, { messageId: "ffffffff" }), "NOT_FOUND");
});

test("artifacts.check text is the CLI's `raft artifact check` (none, pending, running, failed, skipped, done with no screenshots kept, misses)", async () => {
  const check = (status: string | null, over: Record<string, unknown> = {}) => ({
    artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 },
    version: 13,
    check: status === null ? null : {
      id: "5f0c2d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f", status, skipReason: null, errorClass: null, findings: null,
      createdAt: "2026-11-04T10:00:00.000Z", finishedAt: status === "pending" || status === "running" ? null : "2026-11-04T10:01:12.000Z", screenshots: [],
      ...over,
    },
  });
  // A done check with screenshots differs on purpose: the CLI saves them and lists the files, the operation saves none.
  for (const data of [
    check(null),
    check("pending"),
    check("running"),
    check("failed", { errorClass: "load_error:net_error" }),
    check("skipped", { skipReason: "unchanged" }),
    check("done", { findings: { consoleErrors: [{ message: "boom", source: "app.js", line: 3 }], blockedResources: [], blank: false, phoneOverflow: null } }),
  ]) {
    const routes: FakeRoute[] = [{ path: /\/artifacts\/pt_abc\/check$/, data }];
    await expectSameText(["artifact", "check", "pt_abc"], routes, (api) => artifactsCheck(api, { artifact: "pt_abc" }));
  }
  const hidden: FakeRoute[] = [{ path: /\/check/, response: { ok: false, status: 404, error: "not visible", errorCode: "NOT_VISIBLE", data: null } }];
  await expectSameMiss(["artifact", "check", "pt_zzz"], hidden, (api) => artifactsCheck(api, { artifact: "pt_zzz" }), "NOT_FOUND");
});
