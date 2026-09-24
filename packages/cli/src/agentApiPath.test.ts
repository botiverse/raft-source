import assert from "node:assert/strict";
import test from "node:test";

import { asChannelId, asMessageId } from "@botiverse/raft-shared";
import {
  buildAgentApiRoutePath,
  buildContractAgentPathForRoute,
  createAgentApiClient,
  createAgentApiSurfaceClient,
  requestContractAgentRoute,
} from "./agentApiPath.js";
import type { ApiResponse, BinaryResponse } from "./client.js";
import { CliError } from "./core/errors.js";

test("contract path helpers encode typed query objects through route schemas", () => {
  assert.equal(
    buildContractAgentPathForRoute("agent/with spaces", "historyRead", undefined, {
      channel: "#proj-runtime:abcd1234",
      before: "10",
      after: "3",
      around: "msg-1",
      limit: "20",
    }),
    "/internal/agent/agent%2Fwith%20spaces/history?channel=%23proj-runtime%3Aabcd1234&before=10&after=3&around=msg-1&limit=20",
  );

  assert.equal(
    buildAgentApiRoutePath("events", undefined, { since: "latest", limit: "50" }),
    "/internal/agent-api/events?since=latest&limit=50",
  );

  assert.equal(
    buildContractAgentPathForRoute("agent-1", "messageResolve", { msgId: asMessageId("msg/with spaces") }),
    "/internal/agent/agent-1/messages/msg%2Fwith%20spaces/resolve",
  );

  assert.equal(
    buildAgentApiRoutePath("messageResolve", { msgId: asMessageId("abcd1234") }),
    "/internal/agent-api/messages/abcd1234/resolve",
  );
});

test("requestContractAgentRoute decodes successful responses with the route response schema", async () => {
  const response = await requestContractAgentRoute(
    {
      request: async <T>(method: string, path: string) => {
        assert.equal(method, "GET");
        assert.equal(path, "/internal/agent/agent-1/history?channel=%23all");
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            messages: [],
            has_more: false,
            has_older: false,
            has_newer: false,
          },
        } as ApiResponse<T>;
      },
    },
    "agent-1",
    "historyRead",
    { query: { channel: "#all" } },
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.data?.messages, []);
});

test("contract agent API client exposes resource methods over route-key implementation", async () => {
  const agentApi = createAgentApiClient(
    {
      request: async <T>(method: string, path: string) => {
        assert.equal(method, "GET");
        assert.equal(path, "/internal/agent/agent-1/history?channel=%23all");
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            messages: [],
            has_more: false,
            has_older: false,
            has_newer: false,
          },
        } as ApiResponse<T>;
      },
    },
    "agent-1",
  );

  const response = await agentApi.history.read({ channel: "#all" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data?.messages, []);
});

test("contract agent-api surface client exposes task list/create/unclaim/amend/history methods over id-less paths", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentApi = createAgentApiSurfaceClient({
    request: async <T>(method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      if (path.endsWith("/tasks?channel=%23proj-runtime&status=in_progress")) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: { tasks: [] },
        } as ApiResponse<T>;
      }
      if (path.endsWith("/tasks") && method === "POST") {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            tasks: [{
              taskNumber: 9,
              messageId: "abcdef123456",
              title: "Ship typed surface",
              status: "todo",
              claimedByType: null,
              claimedById: null,
              claimedAt: null,
              requiresResourceReceipt: false,
            }],
          },
        } as ApiResponse<T>;
      }
      if (path.endsWith("/tasks/unclaim")) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        } as ApiResponse<T>;
      }
      if (path.endsWith("/tasks/amend")) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            task: { taskNumber: 9, title: "Current typed surface", description: null, revision: 2 },
            event: {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 12,
              eventType: "amended",
              actorType: "agent",
              actorName: "cross",
              payload: { revision: 2 },
              createdAt: "2026-08-05T00:00:00.000Z",
            },
          },
        } as ApiResponse<T>;
      }
      if (path.endsWith("/tasks/history?channel=%23proj-runtime&task_number=9")) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            task: { taskNumber: 9, title: "Current typed surface", description: null, revision: 2 },
            events: [],
          },
        } as ApiResponse<T>;
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });

  const list = await agentApi.tasks.list({ channel: "#proj-runtime", status: "in_progress" });
  const created = await agentApi.tasks.create({ channel: "#proj-runtime", tasks: [{ title: "Ship typed surface" }] });
  const unclaimed = await agentApi.tasks.unclaim({ channel: "#proj-runtime", task_number: 9 });
  const amended = await agentApi.tasks.amend({ channel: "#proj-runtime", task_number: 9, title: "Current typed surface" });
  const history = await agentApi.tasks.history({ channel: "#proj-runtime", task_number: 9 });

  assert.equal(list.ok, true);
  assert.deepEqual(list.data?.tasks, []);
  assert.equal(created.ok, true);
  assert.equal(created.data?.tasks[0]?.taskNumber, 9);
  assert.equal(unclaimed.ok, true);
  assert.ok(amended.data && "task" in amended.data);
  assert.equal((amended.data.task as { revision: number }).revision, 2);
  assert.deepEqual(history.data?.events, []);
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/tasks?channel=%23proj-runtime&status=in_progress",
      body: undefined,
    },
    {
      method: "POST",
      path: "/internal/agent-api/tasks",
      body: { channel: "#proj-runtime", tasks: [{ title: "Ship typed surface" }] },
    },
    {
      method: "POST",
      path: "/internal/agent-api/tasks/unclaim",
      body: { channel: "#proj-runtime", task_number: 9 },
    },
    {
      method: "POST",
      path: "/internal/agent-api/tasks/amend",
      body: { channel: "#proj-runtime", task_number: 9, title: "Current typed surface" },
    },
    {
      method: "GET",
      path: "/internal/agent-api/tasks/history?channel=%23proj-runtime&task_number=9",
      body: undefined,
    },
  ]);
});

test("contract agent API client exposes channel and reaction methods", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentApi = createAgentApiClient(
    {
      request: async <T>(method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body });
        if (path.includes("/messages/")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { message_id: "msg-1", reactions: [] },
          } as ApiResponse<T>;
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        } as ApiResponse<T>;
      },
    },
    "agent-1",
  );

  const joined = await agentApi.channels.join({ channelId: asChannelId("chan/with spaces") });
  const left = await agentApi.channels.leave({ channelId: asChannelId("chan-1") });
  const added = await agentApi.messages.addReaction({ msgId: asMessageId("msg/with spaces") }, { emoji: "👀" });
  const removed = await agentApi.messages.removeReaction({ msgId: asMessageId("msg-1") }, { emoji: "👀" });

  assert.equal(joined.ok, true);
  assert.equal(left.ok, true);
  assert.equal(added.ok, true);
  assert.equal(removed.ok, true);
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent/agent-1/channels/chan%2Fwith%20spaces/join",
      body: undefined,
    },
    {
      method: "POST",
      path: "/internal/agent/agent-1/channels/chan-1/leave",
      body: undefined,
    },
    {
      method: "POST",
      path: "/internal/agent/agent-1/messages/msg%2Fwith%20spaces/reactions",
      body: { emoji: "👀" },
    },
    {
      method: "DELETE",
      path: "/internal/agent/agent-1/messages/msg-1/reactions",
      body: { emoji: "👀" },
    },
  ]);
});

test("contract agent-api surface client exposes remaining command methods over id-less paths", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentApi = createAgentApiSurfaceClient({
    request: async <T>(method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      if (path === "/internal/agent-api/server") {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            runtimeContext: { agentId: "agent-1", serverId: "server-1" },
            channels: [],
            agents: [],
            humans: [],
          },
        } as ApiResponse<T>;
      }
      if (path.startsWith("/internal/agent-api/history?")) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            messages: [],
            has_more: false,
            has_older: false,
            has_newer: false,
          },
        } as ApiResponse<T>;
      }
      if (path === "/internal/agent-api/send" || path === "/internal/agent-api/v2/send") {
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true, state: "sent", messageId: "msg-1" },
        } as ApiResponse<T>;
      }
      if (path.includes("/messages/") || path === "/internal/agent-api/mention-actions/pending") {
        const data = path.endsWith("/resolve")
          ? { message: { message_id: "msg-1" } }
          : path.includes("/reactions")
            ? { message_id: "msg-1" }
            : { pendingMentionActions: [] };
        return {
          ok: true,
          status: 200,
          error: null,
          data,
        } as ApiResponse<T>;
      }
      if (path === "/internal/agent-api/mention-actions/execute") {
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true, action: "notify", results: [] },
        } as ApiResponse<T>;
      }
      if (path === "/internal/agent-api/channels/archive" || path === "/internal/agent-api/channels/unarchive") {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            id: "chan-1",
            name: "engineering",
            type: "channel",
            archivedAt: path.endsWith("/archive") ? "2026-07-11T00:00:00.000Z" : null,
            archivedByUserId: null,
          },
        } as ApiResponse<T>;
      }
      return {
        ok: true,
        status: 200,
        error: null,
        data: { ok: true },
      } as ApiResponse<T>;
    },
  });

  const server = await agentApi.server.info();
  const history = await agentApi.history.read({ channel: "#all" });
  const sent = await agentApi.messages.send({ target: "#all", content: "hi" });
  const sentV2 = await agentApi.messages.sendV2({
    target: "#all",
    content: "hi @alice",
    mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "alice" }],
  });
  const resolved = await agentApi.messages.resolve({ msgId: asMessageId("msg/with spaces") });
  const added = await agentApi.messages.addReaction({ msgId: asMessageId("msg-1") }, { emoji: "👀" });
  const removed = await agentApi.messages.removeReaction({ msgId: asMessageId("msg-1") }, { emoji: "👀" });
  const joined = await agentApi.channels.join({ channelId: asChannelId("chan/with spaces") });
  const left = await agentApi.channels.leave({ channelId: asChannelId("chan-1") });
  const muted = await agentApi.channels.mute({ channelId: asChannelId("chan-1") });
  const unmuted = await agentApi.channels.unmute({ channelId: asChannelId("chan-1") });
  const archived = await agentApi.channels.archive({ target: "#engineering" });
  const unarchived = await agentApi.channels.unarchive({ target: "#engineering" });
  const pending = await agentApi.mentions.pendingActions();
  const executed = await agentApi.mentions.executeAction({ action: "notify", resolutionIds: ["r-1"] });

  assert.equal(server.ok, true);
  assert.equal(history.ok, true);
  assert.equal(sent.ok, true);
  assert.equal(sentV2.ok, true);
  assert.equal(resolved.ok, true);
  assert.equal(added.ok, true);
  assert.equal(removed.ok, true);
  assert.equal(joined.ok, true);
  assert.equal(left.ok, true);
  assert.equal(muted.ok, true);
  assert.equal(unmuted.ok, true);
  assert.equal(archived.ok, true);
  assert.equal(unarchived.ok, true);
  assert.equal(pending.ok, true);
  assert.equal(executed.ok, true);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server", body: undefined },
    { method: "GET", path: "/internal/agent-api/history?channel=%23all", body: undefined },
    { method: "POST", path: "/internal/agent-api/send", body: { target: "#all", content: "hi" } },
    {
      method: "POST",
      path: "/internal/agent-api/v2/send",
      body: {
        target: "#all",
        content: "hi @alice",
        mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "alice" }],
      },
    },
    { method: "GET", path: "/internal/agent-api/messages/msg%2Fwith%20spaces/resolve", body: undefined },
    { method: "POST", path: "/internal/agent-api/messages/msg-1/reactions", body: { emoji: "👀" } },
    { method: "DELETE", path: "/internal/agent-api/messages/msg-1/reactions", body: { emoji: "👀" } },
    { method: "POST", path: "/internal/agent-api/channels/chan%2Fwith%20spaces/join", body: undefined },
    { method: "POST", path: "/internal/agent-api/channels/chan-1/leave", body: undefined },
    { method: "POST", path: "/internal/agent-api/channels/chan-1/mute", body: {} },
    { method: "POST", path: "/internal/agent-api/channels/chan-1/unmute", body: undefined },
    { method: "POST", path: "/internal/agent-api/channels/archive", body: { target: "#engineering" } },
    { method: "POST", path: "/internal/agent-api/channels/unarchive", body: { target: "#engineering" } },
    { method: "GET", path: "/internal/agent-api/mention-actions/pending", body: undefined },
    { method: "POST", path: "/internal/agent-api/mention-actions/execute", body: { action: "notify", resolutionIds: ["r-1"] } },
  ]);
});

test("contract agent-api surface client exposes migrated JSON route methods", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const multipartRequests: Array<{ method: string; path: string; hasFile: boolean; hasAvatar: boolean }> = [];
  const downloads: string[] = [];
  const agentApi = createAgentApiSurfaceClient(
    {
      request: async <T>(method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body });
        if (path.startsWith("/internal/agent-api/search?")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { results: [], hasMore: false },
          } as ApiResponse<T>;
        }
        if (path.startsWith("/internal/agent-api/channel-members?")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { channel: { ref: "#wg-raft-cli", type: "channel" }, agents: [], humans: [] },
          } as ApiResponse<T>;
        }
        if (path === "/internal/agent-api/prepare-action") {
          return {
            ok: true,
            status: 201,
            error: null,
            data: { messageId: "msg-action-1", metadata: { kind: "action-card" } },
          } as ApiResponse<T>;
        }
        if (path === "/internal/agent-api/integrations") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              services: [{
                id: "client-1",
                clientId: "drive9",
                name: "Drive9",
                description: null,
                homepageUrl: null,
                returnUrl: null,
                agentManifestUrl: null,
                createdAt: "2026-06-28T02:00:00.000Z",
                updatedAt: "2026-06-28T02:00:00.000Z",
              }],
              activeLogins: [],
            },
          } as ApiResponse<T>;
        }
        if (path === "/internal/agent-api/integrations/login") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              status: "logged_in",
              service: {
                id: "client-1",
                clientId: "drive9",
                name: "Drive9",
                description: null,
                homepageUrl: null,
                returnUrl: null,
                agentManifestUrl: null,
                createdAt: "2026-06-28T02:00:00.000Z",
                updatedAt: "2026-06-28T02:00:00.000Z",
              },
              scopes: ["openid", "profile"],
              requestId: "request-1",
            },
          } as ApiResponse<T>;
        }
        if (path === "/internal/agent-api/integrations/app/prepare") {
          return {
            ok: true,
            status: 201,
            error: null,
            data: {
              status: "prepared",
              mode: "register",
              target: "#wg-raft-cli",
              actionCardMessageId: "msg-action-1",
              action: {
                type: "integration:register_app",
                name: "Drive9",
                clientKey: "drive9",
                returnUrl: "https://drive9.example/auth/raft/callback",
                scopes: ["openid", "profile"],
              },
            },
          } as ApiResponse<T>;
        }
        if (path === "/internal/agent-api/integrations/app/manage") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              action: "request_publish",
              clientId: "client-1",
              clientKey: "drive9",
              clientName: "Drive9",
              publishStatus: "publish_requested",
            },
          } as ApiResponse<T>;
        }
        if (path.startsWith("/internal/agent-api/attachments/") && path.endsWith("/comments?limit=25")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              comments: [{
                id: "msg-comment-1",
                channelId: "thread-channel-1",
                senderId: "user-1",
                senderType: "user",
                senderName: "xxchan",
                senderAvatarUrl: null,
                senderGravatarHash: null,
                content: "looks good",
                createdAt: "2026-06-29T04:00:00.000Z",
                reactions: [],
                anchor: null,
                resolved: false,
                resolvedBy: null,
                resolvedAt: null,
              }],
              threadChannelId: "thread-channel-1",
              viewer: {
                canComment: false,
                reason: "agent_descoped",
                canResolve: false,
              },
            },
          } as ApiResponse<T>;
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        } as ApiResponse<T>;
      },
      requestBinary: async (method: string, path: string): Promise<BinaryResponse> => {
        downloads.push(`${method} ${path}`);
        return {
          ok: true,
          status: 200,
          body: new Uint8Array([1, 2, 3]),
          error: null,
        };
      },
      requestMultipart: async <T>(method: string, path: string, form: FormData) => {
        multipartRequests.push({
          method,
          path,
          hasFile: form.get("file") instanceof Blob,
          hasAvatar: form.get("avatar") instanceof Blob,
        });
        return {
          ok: true,
          status: 200,
          error: null,
          data: path.endsWith("/integrations/app/logo")
            ? {
              clientId: "client-1",
              clientKey: "drive9",
              clientName: "Drive9",
              logoUrl: "/api/integration-logos/client-1/logo.webp",
            }
            : path.endsWith("/profile/avatar")
            ? {
              kind: "agent",
              id: "agent-1",
              isSelf: true,
              name: "Stone",
              displayName: "Stone",
              description: null,
              avatarUrl: "https://cdn.example/avatar.png",
              status: "active",
              serverRole: null,
              runtime: "claude",
              model: "sonnet",
              reasoningEffort: null,
              executionMode: null,
              computerId: null,
              computerName: null,
              computerHostname: null,
              daemonVersion: null,
              creator: null,
              createdAgents: [],
              createdAt: "2026-06-29T04:00:00.000Z",
              deletedAt: null,
            }
            : {
              id: "attachment-1",
              filename: "log.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
              thumbnailUrl: null,
            },
        } as ApiResponse<T>;
      },
    },
  );

  const search = await agentApi.messages.search({ q: "review status", channel: "#wg-raft-cli", sender: "xxchan", sort: "recent", limit: "20" });
  const members = await agentApi.channels.members({ channel: "#wg-raft-cli" });
  const unfollow = await agentApi.threads.unfollow({ thread: "#wg-raft-cli:abcd1234" });
  const prepared = await agentApi.actions.prepare({
    target: "#wg-raft-cli",
    action: { type: "channel:create", name: "sdk-test", visibility: "public" },
  });
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "log.txt");
  uploadForm.append("channelId", "channel-1");
  const uploaded = await agentApi.attachments.upload(uploadForm);
  const viewed = await agentApi.attachments.view({ attachmentId: "attachment/with spaces" });
  const comments = await agentApi.attachments.comments({ attachmentId: "attachment/with spaces" }, { limit: "25" });
  const avatarForm = new FormData();
  avatarForm.append("avatar", new Blob([Buffer.from("avatar")], { type: "image/png" }), "avatar.png");
  const avatar = await agentApi.profile.updateAvatar(avatarForm);
  const integrations = await agentApi.integrations.list();
  const login = await agentApi.integrations.login({ service: "drive9", scopes: ["openid", "profile"], target: "#wg-raft-cli" });
  const appPrepare = await agentApi.integrations.prepareApp({
    mode: "register",
    target: "#wg-raft-cli",
    clientKey: "drive9",
    name: "Drive9",
    returnUrl: "https://drive9.example/auth/raft/callback",
    scopes: ["openid", "profile"],
  });
  const appManage = await agentApi.integrations.manageApp({
    clientKey: "drive9",
    action: "request_publish",
  });
  const appLogoForm = new FormData();
  appLogoForm.append("clientKey", "drive9");
  appLogoForm.append("avatar", new Blob([Buffer.from("logo")], { type: "image/png" }), "logo.png");
  const appLogo = await agentApi.integrations.updateAppLogo(appLogoForm);

  assert.equal(search.ok, true);
  assert.equal(members.ok, true);
  assert.equal(unfollow.ok, true);
  assert.equal(prepared.ok, true);
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.data?.id, "attachment-1");
  assert.equal(viewed.ok, true);
  assert.equal(comments.ok, true);
  assert.equal(comments.data?.comments[0]?.id, "msg-comment-1");
  assert.equal(avatar.ok, true);
  assert.equal(integrations.ok, true);
  assert.equal(login.ok, true);
  assert.equal(appPrepare.ok, true);
  assert.equal(appManage.ok, true);
  assert.equal(appLogo.ok, true);
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?q=review+status&channel=%23wg-raft-cli&sender=xxchan&sort=recent&limit=20",
      body: undefined,
    },
    {
      method: "GET",
      path: "/internal/agent-api/channel-members?channel=%23wg-raft-cli",
      body: undefined,
    },
    {
      method: "POST",
      path: "/internal/agent-api/threads/unfollow",
      body: { thread: "#wg-raft-cli:abcd1234" },
    },
    {
      method: "POST",
      path: "/internal/agent-api/prepare-action",
      body: {
        target: "#wg-raft-cli",
        action: { type: "channel:create", name: "sdk-test", visibility: "public" },
      },
    },
    {
      method: "GET",
      path: "/internal/agent-api/attachments/attachment%2Fwith%20spaces/comments?limit=25",
      body: undefined,
    },
    {
      method: "GET",
      path: "/internal/agent-api/integrations",
      body: undefined,
    },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/login",
      body: { service: "drive9", scopes: ["openid", "profile"], target: "#wg-raft-cli" },
    },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/prepare",
      body: {
        mode: "register",
        target: "#wg-raft-cli",
        clientKey: "drive9",
        name: "Drive9",
        returnUrl: "https://drive9.example/auth/raft/callback",
        scopes: ["openid", "profile"],
      },
    },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/manage",
      body: {
        clientKey: "drive9",
        action: "request_publish",
      },
    },
  ]);
  assert.deepEqual(multipartRequests, [
    {
      method: "POST",
      path: "/internal/agent-api/upload",
      hasFile: true,
      hasAvatar: false,
    },
    {
      method: "POST",
      path: "/internal/agent-api/profile/avatar",
      hasFile: false,
      hasAvatar: true,
    },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/app/logo",
      hasFile: false,
      hasAvatar: true,
    },
  ]);
  assert.deepEqual(downloads, ["GET /internal/agent-api/attachments/attachment%2Fwith%20spaces"]);
});

test("contract agent-api surface client uses id-less agent-api paths", async () => {
  const agentApi = createAgentApiSurfaceClient({
    request: async <T>(method: string, path: string) => {
      assert.equal(method, "GET");
      assert.equal(path, "/internal/agent-api/events?since=latest");
      return {
        ok: true,
        status: 200,
        error: null,
        data: {
          events: [],
          last_seen_msgId: null,
          last_seen_seq: null,
          reply_target: null,
          pending_notice_ids: [],
          wake_reason: null,
          has_more: false,
        },
      } as ApiResponse<T>;
    },
  });

  const response = await agentApi.events.get({ since: "latest" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data?.events, []);
});

test("contract agent-api surface client exposes direct attachment session methods", async () => {
  const uploadId = "33333333-3333-4333-8333-333333333333";
  const attachmentId = "44444444-4444-4444-8444-444444444444";
  const requests: string[] = [];
  const agentApi = createAgentApiSurfaceClient({
    request: async <T>(method: string, path: string) => {
      requests.push(`${method} ${path}`);
      const data = path.endsWith("attachment-upload-capabilities")
        ? { directUploadEnabled: true, directUploadThresholdBytes: 1, maxBytes: 209715200, sessionExpiresInSeconds: 900 }
        : path.endsWith("/complete")
          ? { uploadId, state: "completed", attachment: { id: attachmentId, filename: "log.txt", mimeType: "text/plain", sizeBytes: 5, thumbnailUrl: null } }
          : method === "POST"
            ? { uploadId, attachmentId, state: "pending", expiresAt: "2026-07-27T08:00:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/presigned", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } }
            : { uploadId, state: method === "DELETE" ? "canceled" : "pending", expiresAt: "2026-07-27T08:00:00.000Z", attachment: null, terminalReason: method === "DELETE" ? "Canceled." : null };
      return { ok: true, status: method === "POST" && path.endsWith("upload-sessions") ? 201 : 200, error: null, data } as ApiResponse<T>;
    },
  });

  assert.equal((await agentApi.attachments.uploadCapabilities()).ok, true);
  assert.equal((await agentApi.attachments.createUploadSession({ channelId: "11111111-1111-4111-8111-111111111111", filename: "log.txt", mimeType: "text/plain", sizeBytes: 5, clientRequestId: "22222222-2222-4222-8222-222222222222" })).ok, true);
  assert.equal((await agentApi.attachments.completeUploadSession({ uploadId })).ok, true);
  assert.equal((await agentApi.attachments.cancelUploadSession({ uploadId })).ok, true);
  assert.equal((await agentApi.attachments.uploadSessionStatus({ uploadId })).ok, true);
  assert.deepEqual(requests, [
    "GET /internal/agent-api/attachment-upload-capabilities",
    "POST /internal/agent-api/attachment-upload-sessions",
    `POST /internal/agent-api/attachment-upload-sessions/${uploadId}/complete`,
    `DELETE /internal/agent-api/attachment-upload-sessions/${uploadId}`,
    `GET /internal/agent-api/attachment-upload-sessions/${uploadId}`,
  ]);
});

test("requestContractAgentRoute parses request bodies before dispatch", async () => {
  let sentBody: unknown;
  const response = await requestContractAgentRoute(
    {
      request: async <T>(method: string, path: string, body?: unknown) => {
        assert.equal(method, "POST");
        assert.equal(path, "/internal/agent/agent-1/tasks/update-status");
        sentBody = body;
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        } as ApiResponse<T>;
      },
    },
    "agent-1",
    "taskUpdateStatus",
    {
      body: {
        channel: "#proj-runtime",
        task_number: 15,
        status: "in_review",
      },
    },
  );

  assert.equal(response.ok, true);
  assert.deepEqual(sentBody, {
    channel: "#proj-runtime",
    task_number: 15,
    status: "in_review",
  });
});

test("requestContractAgentRoute rejects invalid request bodies before dispatch", async () => {
  let called = false;
  await assert.rejects(
    () => requestContractAgentRoute(
      {
        request: async <T>() => {
          called = true;
          return {
            ok: true,
            status: 200,
            error: null,
            data: { ok: true },
          } as ApiResponse<T>;
        },
      },
      "agent-1",
      "taskUpdateStatus",
      {
        body: {
          channel: "#proj-runtime",
          task_number: 15,
          status: "not-a-status",
        } as any,
      },
    ),
  );
  assert.equal(called, false);
});

test("requestContractAgentRoute fails closed on response contract drift", async () => {
  await assert.rejects(
    () => requestContractAgentRoute(
      {
        request: async <T>() => ({
          ok: true,
          status: 200,
          error: null,
          data: { messages: [] },
        }) as ApiResponse<T>,
      },
      "agent-1",
      "historyRead",
      { query: { channel: "#all" } },
    ),
    (err) => err instanceof CliError && err.code === "INVALID_JSON_RESPONSE",
  );
});

test("requestContractAgentRoute preserves a typed known-response proxy failure", async () => {
  const proxyFailure = new CliError({
    code: "PROXY_5XX",
    message: "failed to proxy local agent request",
    layer: "local_daemon_proxy",
    correlationId: "corr-known-response",
    proxyFailureClass: "pre_response_transport",
    proxyCauseCode: "UND_ERR_CONNECT_TIMEOUT",
    proxyRouteFamily: "agent-api/history",
    proxyUpstreamLayer: "tcp",
    proxyUpstreamStatus: 502,
    proxyResponseStarted: false,
    proxyResponseComplete: false,
  });

  await assert.rejects(
    () => requestContractAgentRoute(
      {
        request: async () => {
          throw proxyFailure;
        },
      },
      "agent-1",
      "historyRead",
      { query: { channel: "#all" } },
    ),
    (err: unknown) => {
      assert.equal(err, proxyFailure);
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "PROXY_5XX");
      assert.equal(err.layer, "local_daemon_proxy");
      assert.equal(err.correlationId, "corr-known-response");
      assert.equal(err.proxyFailureClass, "pre_response_transport");
      assert.equal(err.proxyCauseCode, "UND_ERR_CONNECT_TIMEOUT");
      assert.equal(err.proxyRouteFamily, "agent-api/history");
      assert.equal(err.proxyUpstreamLayer, "tcp");
      assert.equal(err.proxyUpstreamStatus, 502);
      assert.equal(err.proxyResponseStarted, false);
      assert.equal(err.proxyResponseComplete, false);
      return true;
    },
  );
});
