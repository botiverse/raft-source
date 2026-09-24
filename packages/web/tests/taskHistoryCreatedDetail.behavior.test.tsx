import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import type { Task } from "../src/store/taskStore";

const { default: TaskProperties } = await import("../src/components/task/TaskProperties");
const { default: api } = await import("../src/api/client");
const { useAuthStore } = await import("../src/store/authStore");
const { useServerStore } = await import("../src/store/serverStore");
const { useTaskStore } = await import("../src/store/taskStore");

// The created event is the one timeline row whose detail is assembled in code
// rather than coming straight from a catalog string, so it has repeatedly
// regressed in ways every static gate passes: an untranslated raw status, a
// dangling "Source:" label with nothing after it, and a silently dropped
// segment. The row now carries only the task number and a localized status —
// where the task came from is deliberately not shown — so pin both locales.
const task: Task = {
  id: "task-1", messageId: "message-1", channelId: "channel-1", taskNumber: 1,
  title: "Ship the history timeline", status: "todo",
  claimedByType: null, claimedById: null, claimedByName: null,
  createdByType: "user", createdById: "human-1", createdByName: "creator",
  createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
};

const originalGet = api.get;

function primeStores() {
  useAuthStore.setState({
    user: {
      id: "human-1", email: "human@example.com", gravatarHash: "", name: "human",
      displayName: "Human", description: null, avatarUrl: null, emailVerified: true,
      preferredLanguage: null, displayLanguage: "en", preferredTimezone: null,
      autoTranslationEnabled: false, preferredTranslationMode: "off",
      preferredTranslationDisplay: "original", preferredTimeFormat: null,
      preferredMessageBodyFontSize: null, referralSource: null, referralSourceOther: null,
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1", name: "Server", slug: "server", ownerId: "human-1",
      onboardingAgentId: null, plan: "free", planDowngradedAt: null, role: "owner",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    members: [],
  } as never);
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    tasksByChannelId: {},
    taskHistoryByTaskId: {},
    taskHistoryLoadingByTaskId: {},
    taskHistoryErrorByTaskId: {},
    taskHistoryConsumersByTaskId: {},
  });
}

/** Render the properties panel with one `created` event and expand History. */
async function historyText(payload: Record<string, unknown>, locale: "en" | "zh-cn"): Promise<string> {
  cleanup();
  primeStores();
  api.get = (async () => ({
    data: {
      events: [{
        id: "event-1", eventType: "created", actorType: "user", actorName: "creator",
        createdAt: "2026-08-20T00:00:00.000Z", payload,
      }],
    },
  })) as typeof api.get;

  render(
    <TestIntlProvider locale={locale}>
      <TaskProperties task={task} />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: locale === "zh-cn" ? "历史" : "History" }));
  const timeline = await waitFor(() => {
    const node = document.querySelector("[data-testid='task-properties']")?.parentElement;
    const text = node?.textContent ?? "";
    // Key on the created row's own detail. A looser probe such as /创建/ also
    // matches the "Created by" property label, which is present before the
    // history request resolves and would let waitFor return on an empty list.
    assert.ok(/任务号：|Task #\d/.test(text), "the created row's detail should have rendered");
    return text;
  });
  return timeline;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    tasksByChannelId: {},
    taskHistoryByTaskId: {},
    taskHistoryLoadingByTaskId: {},
    taskHistoryErrorByTaskId: {},
    taskHistoryConsumersByTaskId: {},
  });
});

test("a directly-created task shows a localized status and no source segment", async () => {
  // Matches the seeded task #1 payload: no convertedFromMessage key at all.
  const zh = await historyText({ taskNumber: 1, status: "todo", requiresResourceReceipt: false }, "zh-cn");
  assert.match(zh, /任务号：1/);
  assert.match(zh, /状态：待办/, "status must be translated, never the raw `todo`");
  assert.doesNotMatch(zh, /状态：todo/);
  assert.doesNotMatch(zh, /来源/, "the source segment is gone entirely, never left dangling");

  const en = await historyText({ taskNumber: 1, status: "todo", requiresResourceReceipt: false }, "en");
  assert.match(en, /Task #1 · Status: Todo/);
  assert.doesNotMatch(en, /Source/);
});

test("a task converted from a message still shows no source", async () => {
  const zh = await historyText({ taskNumber: 17, status: "todo", convertedFromMessage: true }, "zh-cn");
  assert.match(zh, /任务号：17 · 状态：待办/);
  assert.doesNotMatch(zh, /来源/, "source is not surfaced on any task, converted or not");

  const en = await historyText({ taskNumber: 17, status: "todo", convertedFromMessage: true }, "en");
  assert.match(en, /Task #17 · Status: Todo/);
  assert.doesNotMatch(en, /Source/);
});

test("internal resource-receipt fields stay out of the created row", async () => {
  const zh = await historyText({ taskNumber: 1, status: "todo", requiresResourceReceipt: false }, "zh-cn");
  assert.doesNotMatch(zh, /requiresResourceReceipt|expiryFollowupId|receipt/);
});

test("an in-place task projection update refreshes the mounted history timeline", async () => {
  cleanup();
  primeStores();
  let historyRequests = 0;
  useTaskStore.setState({
    tasks: [task],
    serverTasks: [task],
    tasksByChannelId: { [task.channelId]: [task] },
  });
  api.get = (async (url: string) => {
    if (url === "/channels/channel-1/members") {
      return { data: { agents: [], humans: [], externalMembers: [] } };
    }
    assert.equal(url, "/tasks/task-1/history");
    historyRequests += 1;
    return {
      data: {
        events: historyRequests === 1
          ? [{
              id: "event-created", eventType: "created", actorType: "user", actorName: "creator",
              createdAt: "2026-08-20T00:00:00.000Z", payload: { taskNumber: 1, status: "todo" },
            }]
          : [{
              id: "event-assignee", eventType: "assignee_changed", actorType: "user", actorName: "creator",
              createdAt: "2026-08-20T00:01:00.000Z", payload: {
                assigneeType: "user", assigneeId: "human-2", previousAssigneeType: null, previousAssigneeId: null,
              },
            }],
      },
    };
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="en">
      <TaskProperties task={task} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  await waitFor(() => assert.match(document.body.textContent ?? "", /Task #1/));
  assert.equal(historyRequests, 1, "initial mount should read history once");

  act(() => {
    useTaskStore.getState().upsertTask({
      ...task,
      claimedByType: "user",
      claimedById: "human-2",
      claimedByName: "second-owner",
      revision: 1,
      updatedAt: "2026-08-20T00:01:00.000Z",
    });
  });

  await waitFor(() => {
    assert.equal(historyRequests, 2, "an in-place task update should fetch the latest history");
    assert.match(document.body.textContent ?? "", /Changed assignee/);
    assert.match(document.body.textContent ?? "", /Assigned to Human 2|Assigned to user/);
  });
});
