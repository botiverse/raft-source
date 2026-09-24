import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import CreateTaskDialog from "../src/components/task/CreateTaskDialog";
import TaskCard from "../src/components/task/TaskCard";
import LegacyTaskPanel from "../src/components/task/LegacyTaskPanel";
import { useLegacyTaskPanelStore } from "../src/store/legacyTaskPanelStore";
import TasksPanel from "../src/components/task/TasksPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const IDS = [
  "task.create.addAnother",
  "task.create.failed",
  "task.board.doneCount",
  "task.board.newTask",
  "task.badge.legacy",
  "task.item.deleteConfirm",
  "task.item.createdBy",
  "task.item.assignedTo",
  "task.item.doneAt",
  "task.panel.ofTotal",
  "task.panel.clearAll",
  "task.panel.createWithNewTask",
  "task.panel.serverWideExcluded",
] as const;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useTaskStore.setState({
    tasks: [],
    serverTasks: [],
    loading: false,
    serverLoading: false,
    serverTasksLoaded: false,
    loadTasks: async () => undefined,
    loadServerTasks: async () => undefined,
    registerServerTasksConsumer: () => undefined,
    unregisterServerTasksConsumer: () => undefined,
    createTasks: async () => undefined,
  } as never);
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    messageId: "task-1",
    channelId: "channel-1",
    channelName: "research",
    taskNumber: 7,
    title: "Ship",
    status: "todo",
    createdById: "user-1",
    createdByType: "user",
    createdByName: "alice",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

test("catalog pins tasks residue MessageIds with Chinese and ICU", () => {
  assert.equal(en["task.create.addAnother"], "Add Another");
  assert.equal(en["task.create.failed"], "Failed to create task");
  assert.equal(en["task.board.doneCount"], "{count} done");
  assert.equal(en["task.board.newTask"], "New Task");
  assert.equal(en["task.badge.legacy"], "LEGACY");
  assert.equal(
    en["task.item.deleteConfirm"],
    'Delete task #{taskNumber} "{title}"? This cannot be undone.',
  );
  assert.equal(en["task.item.createdBy"], "created by @{name} {when}");
  assert.equal(en["task.item.assignedTo"], "assigned to @{name} {when}");
  assert.equal(en["task.item.doneAt"], "done {when}");
  assert.equal(en["task.panel.ofTotal"], " of {total}");
  assert.equal(en["task.panel.clearAll"], "Clear All");
  assert.equal(en["task.panel.createWithNewTask"], "Create one with the New Task button.");
  assert.equal(
    en["task.panel.serverWideExcluded"],
    "DM and agent task boards are intentionally excluded from this server-wide view.",
  );
  for (const id of ["task.board.doneCount", "task.item.deleteConfirm", "task.item.createdBy", "task.panel.ofTotal"] as const) {
    assert.match(en[id], /\{/);
    assert.match(zh[id], /\{/);
  }
  for (const id of IDS) {
    if (id === "task.badge.legacy") {
      assert.equal(zh[id], "LEGACY", "legacy protocol badge intentionally stays untranslated");
      continue;
    }
    assert.match(zh[id], /\p{Script=Han}/u, `${id} missing Chinese`);
    assert.notEqual(zh[id], en[id], `${id} still English`);
  }
});

test("tasks residue ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "task.board.doneCount" }, { count: 3 }),
    zh["task.board.doneCount"].replace("{count}", "3"),
  );
  assert.equal(
    zhIntl.formatMessage(
      { id: "task.item.deleteConfirm" },
      { taskNumber: 7, title: "Ship" },
    ),
    zh["task.item.deleteConfirm"].replace("{taskNumber}", "7").replace("{title}", "Ship"),
  );
  assert.doesNotMatch(zhIntl.formatMessage({ id: "task.create.addAnother" }), /Add Another/);
});

test("mounted CreateTaskDialog add-another and generic-failure are Chinese", async () => {
  useTaskStore.setState({
    createTasks: async () => {
      throw { response: { data: {} } };
    },
  } as never);

  render(
    <TestIntlProvider locale="zh-cn">
      <CreateTaskDialog channelId="channel-1" onClose={() => undefined} />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByRole("button", { name: zh["task.create.addAnother"] }));
  assert.equal(screen.queryByRole("button", { name: "Add Another" }), null);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ship" } });
  fireEvent.click(screen.getByRole("button", { name: /创建/ }));

  assert.ok(await screen.findByText(zh["task.create.failed"]));
  assert.equal(screen.queryByText("Failed to create task"), null);
});

test("mounted TasksPanel channel empty-state and new-task chrome are Chinese", () => {
  useTaskStore.setState({
    tasks: [],
    loading: false,
    loadTasks: async () => undefined,
  } as never);

  render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <TasksPanel channelId="channel-1" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("button", { name: zh["task.board.newTask"] }));
  assert.ok(screen.getByText(zh["task.panel.createWithNewTask"]));
  assert.equal(screen.queryByRole("button", { name: "New Task" }), null);
  assert.equal(screen.queryByText("Create one with the New Task button."), null);
});

test("mounted TasksPanel server empty-state excludes DM boards in Chinese", () => {
  useTaskStore.setState({
    serverTasks: [],
    serverLoading: false,
    loadServerTasks: async () => undefined,
    registerServerTasksConsumer: () => undefined,
    unregisterServerTasksConsumer: () => undefined,
  } as never);

  render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <TasksPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByText(zh["task.panel.serverWideExcluded"]));
  assert.equal(
    screen.queryByText("DM and agent task boards are intentionally excluded from this server-wide view."),
    null,
  );
});

test("mounted TasksPanel preserves an explicit list choice across channel routes and remounts", (t) => {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  t.after(() => {
    window.matchMedia = previousMatchMedia;
  });

  useTaskStore.setState({
    tasks: [makeTask()],
    loading: false,
    loadTasks: async () => undefined,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <TestIntlProvider locale="en">
        <TasksPanel channelId="channel-1" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("channel-task-view-board").getAttribute("aria-checked"), "true");
  assert.ok(screen.getByTestId("channel-task-board-view"), "desktop default starts in board view");
  fireEvent.click(screen.getByTestId("channel-task-view-list"));
  assert.equal(window.localStorage.getItem("slock.tasks.viewMode"), "list");
  assert.equal(screen.getByTestId("channel-task-view-list").getAttribute("aria-checked"), "true");
  assert.equal(screen.queryByTestId("channel-task-board-view"), null, "the explicit list choice applies immediately");

  cleanup();
  render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-2"]}>
      <TestIntlProvider locale="en">
        <TasksPanel channelId="channel-2" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("channel-task-view-list").getAttribute("aria-checked"), "true");
  assert.equal(
    screen.queryByTestId("channel-task-board-view"),
    null,
    "a different channel route restores the persisted list view instead of the desktop board default",
  );
});

test("mounted TasksPanel applies a live transform while a board card is pointer-dragged", async (t) => {
  const previousMatchMedia = window.matchMedia;
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return this.hasAttribute("data-task-virtual-scroll") ? 1280 : 320;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.hasAttribute("data-task-virtual-scroll") ? 720 : 116;
    },
  });
  t.after(() => {
    window.matchMedia = previousMatchMedia;
    if (previousOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", previousOffsetWidth);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
    if (previousOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", previousOffsetHeight);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
  });

  useTaskStore.setState({
    tasks: [makeTask()],
    loading: false,
    loadTasks: async () => undefined,
  } as never);
  window.localStorage.setItem("slock.tasks.viewMode", "board");

  render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <TestIntlProvider locale="en">
        <TasksPanel channelId="channel-1" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByTestId("channel-task-view-board"));
  const card = await screen.findByTestId("task-board-draggable-card") as HTMLElement;
  assert.equal(card.style.transform, "");

  fireEvent.pointerDown(card, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 20,
    clientY: 20,
  });
  await act(async () => {
    fireEvent.pointerMove(document, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
      clientX: 80,
      clientY: 25,
    });
    await Promise.resolve();
    fireEvent.pointerMove(document, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
      clientX: 120,
      clientY: 25,
    });
    await Promise.resolve();
  });

  const liveTransform = card.style.transform;

  await act(async () => {
    fireEvent.pointerUp(document, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: 120,
      clientY: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  assert.match(
    liveTransform,
    /translate3d\((?:-?[1-9]\d*)px,/,
    "the mounted board card must visibly follow the pointer after drag activation",
  );
});

test("mounted TaskCard opens localized read-only legacy task details", () => {
  useAuthStore.setState({
    user: { id: "user-1", name: "alice" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: { id: "server-1", role: "owner" },
    members: [],
  } as never);

  render(
    <TestIntlProvider locale="zh-cn">
      <TaskCard
        onOpen={useLegacyTaskPanelStore.getState().openLegacyTask}
        task={makeTask({
          isLegacy: true,
          claimedByType: "user",
          claimedById: "user-2",
          claimedByName: "bob",
          claimedAt: "2026-06-30T01:00:00.000Z",
          completedAt: "2026-06-30T02:00:00.000Z",
        })}
      />
      <LegacyTaskPanel presentation="modal" />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText(zh["task.badge.legacy"]));
  fireEvent.click(screen.getByText("Ship"));
  assert.match(document.body.textContent ?? "", /alice/);
  assert.doesNotMatch(document.body.textContent ?? "", /created by @/);
  assert.doesNotMatch(document.body.textContent ?? "", /assigned to @/);

  assert.ok(screen.getByText(zh["task.legacyPanel.createdBy"]));
  assert.ok(screen.getByText(zh["task.legacyPanel.assignee"]));
  assert.ok(screen.getByText(zh["task.legacyPanel.readOnly"]));
  assert.equal(screen.queryByTitle(zh["task.action.delete"]), null);
  act(() => useLegacyTaskPanelStore.getState().closeLegacyTask());
});
