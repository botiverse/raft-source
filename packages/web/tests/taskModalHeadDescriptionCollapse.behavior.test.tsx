import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import { zhCn } from "../src/i18n/messages/zh-cn";
import type { User } from "../src/store/authStore";
import type { Server } from "../src/store/serverStore";
import type { Task } from "../src/store/taskStore";

const user: User = {
  id: "user-current",
  email: "current@example.test",
  gravatarHash: null,
  name: "current",
  displayName: "Current User",
  description: null,
  avatarUrl: null,
  emailVerified: true,
  preferredLanguage: null,
  preferredTimezone: null,
  autoTranslationEnabled: false,
  preferredTimeFormat: null,
  preferredMessageBodyFontSize: null,
  referralSource: null,
  referralSourceOther: null,
  referralSourceSkippedAt: null,
};

const server: Server = {
  id: "server-1",
  name: "Server",
  slug: "server",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-08-21T00:00:00.000Z",
};

let renderedDescriptionHeight = 40;
let originalScrollHeightDescriptor: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalWindowResizeObserver: typeof ResizeObserver | undefined;

function makeResizeObserverEntry(target: Element): ResizeObserverEntry {
  return {
    target,
    contentRect: { height: renderedDescriptionHeight } as DOMRectReadOnly,
  } as ResizeObserverEntry;
}

class TestResizeObserver implements ResizeObserver {
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.observed.add(target);
    this.callback([makeResizeObserverEntry(target)], this as unknown as ResizeObserver);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }
}

function taskWithDescription(description: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "task-947",
    messageId: "message-947",
    channelId: "",
    channelName: "proj-uiux",
    taskNumber: 947,
    title: "Task detail long body",
    description,
    status: "todo",
    createdById: "author-1",
    createdByType: "user",
    createdByName: "huxijin",
    createdAt: "2026-08-21T08:00:00.000Z",
    updatedAt: "2026-08-21T08:00:00.000Z",
    ...overrides,
  };
}

async function prepareStores() {
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");
  useAuthStore.setState({
    user,
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: server, members: [] });
}

beforeEach(() => {
  renderedDescriptionHeight = 40;
  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
  originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.dataset.testid === "task-modal-description") {
        return renderedDescriptionHeight;
      }
      return 0;
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  if (originalWindowResizeObserver) {
    window.ResizeObserver = originalWindowResizeObserver;
  } else {
    delete (window as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  if (originalScrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  }
});

test("short task descriptions keep the original uncollapsed detail shape", async () => {
  renderedDescriptionHeight = 40;
  await prepareStores();
  const { default: TaskModalHead } = await import("../src/components/task/TaskModalHead");

  render(
    <TestIntlProvider>
      <TaskModalHead task={taskWithDescription("Short description.")} />
    </TestIntlProvider>,
  );

  const description = screen.getByTestId("task-modal-description");
  assert.ok(description.className.includes("whitespace-pre-wrap"));
  assert.ok(!description.className.includes("line-clamp-3"));
  assert.equal(screen.queryByTestId("task-modal-description-toggle"), null);
});

test("long task descriptions default collapsed and can expand with localized copy", async () => {
  renderedDescriptionHeight = 140;
  await prepareStores();
  const { default: TaskModalHead } = await import("../src/components/task/TaskModalHead");
  const longDescription = Array.from({ length: 7 }, (_, index) =>
    `第 ${index + 1} 行：这是一段很长的任务详情，用来确认 Thread 不会被任务内容挤出首屏。`
  ).join("\n");

  render(
    <TestIntlProvider locale="zh-cn">
      <TaskModalHead task={taskWithDescription(longDescription)} />
    </TestIntlProvider>,
  );

  const description = screen.getByTestId("task-modal-description");
  const toggle = screen.getByTestId("task-modal-description-toggle");
  assert.ok(description.className.includes("line-clamp-3"));
  assert.equal(toggle.textContent, zhCn["message.content.showMore"]);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), description.id);

  fireEvent.click(toggle);
  assert.ok(!description.className.includes("line-clamp-3"));
  assert.equal(toggle.textContent, zhCn["message.content.collapse"]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  fireEvent.click(toggle);
  assert.ok(description.className.includes("line-clamp-3"));
  assert.equal(toggle.textContent, zhCn["message.content.showMore"]);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("single-paragraph descriptions collapse when narrow rendering wraps past three visual lines", async () => {
  renderedDescriptionHeight = 160;
  await prepareStores();
  const { default: TaskModalHead } = await import("../src/components/task/TaskModalHead");
  const narrowWrappedDescription = "这是一段没有手动换行的任务详情。".repeat(6);
  assert.ok(narrowWrappedDescription.length < 360);
  assert.equal(narrowWrappedDescription.split(/\r\n|\r|\n/).length, 1);

  render(
    <TestIntlProvider locale="zh-cn">
      <div style={{ width: 350 }}>
        <TaskModalHead task={taskWithDescription(narrowWrappedDescription)} />
      </div>
    </TestIntlProvider>,
  );

  const description = screen.getByTestId("task-modal-description");
  const toggle = screen.getByTestId("task-modal-description-toggle");
  assert.ok(description.className.includes("line-clamp-3"));
  assert.equal(toggle.textContent, zhCn["message.content.showMore"]);
});

test("expanded descriptions reset when the task description identity changes", async () => {
  renderedDescriptionHeight = 160;
  await prepareStores();
  const { default: TaskModalHead } = await import("../src/components/task/TaskModalHead");
  const firstDescription = "第一张任务的长描述。".repeat(12);
  const secondDescription = "第二张任务的长描述。".repeat(12);

  const view = render(
    <TestIntlProvider locale="zh-cn">
      <TaskModalHead task={taskWithDescription(firstDescription, { id: "task-a" })} />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByTestId("task-modal-description-toggle"));
  assert.equal(screen.getByTestId("task-modal-description-toggle").getAttribute("aria-expanded"), "true");

  view.rerender(
    <TestIntlProvider locale="zh-cn">
      <TaskModalHead task={taskWithDescription(secondDescription, { id: "task-b" })} />
    </TestIntlProvider>,
  );

  const description = screen.getByTestId("task-modal-description");
  const toggle = screen.getByTestId("task-modal-description-toggle");
  assert.ok(description.className.includes("line-clamp-3"));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), description.id);
});
