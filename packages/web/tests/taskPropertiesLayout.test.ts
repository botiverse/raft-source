import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { IntlProvider } from "react-intl";
import { renderToStaticMarkup } from "react-dom/server";

import { en } from "../src/i18n/messages/en";
import type { Task } from "../src/store/taskStore";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: dom.window.sessionStorage, configurable: true });

const { default: TaskProperties } = await import("../src/components/task/TaskProperties");
const { useAuthStore } = await import("../src/store/authStore");
const { useServerStore } = await import("../src/store/serverStore");

const task: Task = {
  id: "task-1",
  messageId: "message-1",
  channelId: "channel-1",
  taskNumber: 1,
  title: "Ship the properties row",
  status: "todo",
  claimedByType: null,
  claimedById: null,
  claimedByName: null,
  createdByType: "user",
  createdById: "human-1",
  createdByName: "creator",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function renderProperties(overrides: Partial<Task> = {}): string {
  useAuthStore.setState({
    user: {
      id: "human-1",
      email: "human@example.com",
      name: "human",
      displayName: "Human",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: "en",
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "off",
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
    },
  });
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "human-1",
      onboardingAgentId: null,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    members: [],
  });

  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "en", messages: en },
      createElement(TaskProperties, { task: { ...task, ...overrides } }),
    ),
  );
}

afterEach(() => {
  useAuthStore.setState({ user: null });
  useServerStore.setState({ current: null, members: [] });
});

function propertiesList(html: string): string {
  return html.match(/<dl[^>]*data-testid="task-properties"[^>]*>[\s\S]*<\/dl>/)?.[0] ?? "";
}

function classList(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").replaceAll("&gt;", ">").replaceAll("&amp;", "&").split(/\s+/).filter(Boolean);
}

/** The opening tag of the first element inside each `<dd>`. */
function firstValueTags(list: string): string[] {
  return [...list.matchAll(/<dd[^>]*>(<[a-z]+[^>]*>)/g)].map((match) => match[1] ?? "");
}

// Every module of raft-ui's build, in any folder: since 0.52.0 it ships one
// module per source file (components/<name>/…); before that some recipes
// (Badge) lived in a shared chunk beside index.mjs, where `tv` became `tv$1`.
const raftUiDistDir = dirname(createRequire(import.meta.url).resolve("@botiverse/raft-ui"));
const raftUiDist = (readdirSync(raftUiDistDir, { recursive: true }) as string[])
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => readFileSync(resolve(raftUiDistDir, file), "utf8"))
  .join("\n");

// @artin asked for one horizontal facts row (#proj-task:142b9b9a). The row is
// raft-ui's DescriptionList direction="inline" (0.9.0, #579): facts wrap in one
// row on a shared first baseline, values 12px after their label, 24px between
// facts, 8px between wrapped lines and no stacked-list gap. Slock adds no row
// classes of its own, so the measured layout is the library's.
test("real TaskProperties is raft-ui's inline DescriptionList with three facts", () => {
  const list = propertiesList(renderProperties());
  const dl = classList(/<dl[^>]*>/.exec(list)?.[0] ?? "");
  for (const cls of [
    "flex",
    "flex-wrap",
    "items-baseline",
    "gap-x-6",
    "gap-y-2",
    "*:data-[slot=description-item]:items-baseline",
    "*:data-[slot=description-item]:gap-3",
    "[&>[data-slot=description-item]+[data-slot=description-item]]:pt-0",
  ]) {
    assert.ok(dl.includes(cls), `the properties list should carry raft-ui's inline row class ${cls}; got "${dl.join(" ")}"`);
  }
  assert.ok(!dl.includes("items-center"), "facts align on their first baseline, not their box centres");

  const items = [...list.matchAll(/<div[^>]*data-slot="description-item"[^>]*>[\s\S]*?<\/dd><\/div>/g)].map((match) => match[0]);
  assert.equal(items.length, 3, "status, assignee, and creator are three facts in the shared row");
  for (const [index, label] of ["Status", "Assignee", "Created by"].entries()) {
    const item = items[index] ?? "";
    assert.match(item, new RegExp(`<dt[^>]*>${label}</dt>[\\s\\S]*<dd[\\s\\S]*</dd>`));
    const cls = classList(/<div[^>]*>/.exec(item)?.[0] ?? "");
    assert.ok(
      !cls.some((c) => /^(?:items-|gap-|-?m[lt]-|p[ty]?-|\[&\+&\]:pt-0$)/.test(c)),
      `a fact must not re-add local row layout on top of direction="inline"; got "${cls.join(" ")}"`,
    );
  }
});

// One flow for every fact (raft-design DescriptionList, Inline; tasks.md, Task
// details): the same 24px and 8px gaps, each fact at most 24rem or the row, so
// a long value such as Source ends in an ellipsis and shares its line. The cap
// is on the list, for every fact alike: no fact carries a width, basis or line
// rule of its own.
test("every property fact follows one flow: capped at 24rem, no fact with its own width or line", () => {
  const list = propertiesList(renderProperties());
  const dl = classList(/<dl[^>]*>/.exec(list)?.[0] ?? "");
  assert.ok(dl.includes("*:data-[slot=description-item]:max-w-[min(100%,24rem)]"), `every fact is capped; got "${dl.join(" ")}"`);
  assert.ok(dl.includes("[&>[data-slot=description-item]>[data-slot=description-details]]:min-w-0"), "a value can shrink below its text, to its ellipsis");
  const items = [...list.matchAll(/<div[^>]*data-slot="description-item"[^>]*>/g)].map((match) => classList(match[0]));
  assert.ok(items.length >= 3);
  for (const cls of items) {
    assert.ok(
      !cls.some((c) => /^(?:w-|basis-|flex-(?:\[|1|auto|none)|grow|max-w-|min-w-(?!0$))/.test(c)),
      `a fact must not size itself apart from the others; got "${cls.join(" ")}"`,
    );
  }
});

// Align what the eye sees (raft-design foundations/alignment.md): every value's
// first glyph/icon starts the same distance after its label. Plain text
// (Created by) starts at the gap; a value drawn in a shape (the status chip,
// the assignee trigger whose hover fill is a badge) hangs its own left padding
// outward. raft-ui does that for a first-child badge/task-chip/task-status-badge
// by data-slot, so the guard is: both triggers are that first child with that
// slot, the library's hang still equals the shapes' padding, and slock adds no
// local hang on top.
test("a shaped property value is a raft-ui hang target whose hang equals its padding", () => {
  // TaskChip (and TaskStatusBadge, which renders it) is 7px on both ends
  // since raft-ui 0.21.1; Badge keeps 6px. raft-ui 0.21.2 hangs each by its own.
  const chipPad = /const taskChip = tv(?:\$\d+)?\([\s\S]*?default: \{ root: \["[^"]*\bpx-\[(\d+(?:\.\d+)?)px\]/.exec(raftUiDist)?.[1];
  const badgePad = /const badge = tv(?:\$\d+)?\(\{\s*slots: \{ root: \[\s*"[^"]*\bpx-(\d+(?:\.\d+)?)\b/.exec(raftUiDist)?.[1];
  assert.ok(chipPad, "raft-ui's TaskStatusBadge still sets its padding in px on both ends");
  assert.ok(badgePad, "raft-ui's Badge still sets its horizontal padding on the spacing scale");

  const list = propertiesList(renderProperties());
  const dl = classList(/<dl[^>]*>/.exec(list)?.[0] ?? "");
  const details = "[&>[data-slot=description-item]>[data-slot=description-details]>";
  const badgePx = Number(badgePad) * 4;
  assert.ok(dl.includes(`${details}[data-slot=badge]:first-child]:-ml-${badgePad}`), `raft-ui's inline row should hang a first-child Badge by its ${badgePx}px padding`);
  assert.ok(dl.includes(`${details}[data-slot=badge]:first-child]:max-w-[calc(100%+${badgePx}px)]`), "the Badge hang must widen its max-width cap by the same amount");
  const chipSlots = ":is([data-slot=task-chip],[data-slot=task-status-badge]):first-child]";
  assert.ok(dl.includes(`${details}${chipSlots}:ml-[-${chipPad}px]`), `raft-ui's inline row should hang a first-child task chip by its ${chipPad}px padding`);
  assert.ok(dl.includes(`${details}${chipSlots}:max-w-[calc(100%+${chipPad}px)]`), "the task chip hang must widen its max-width cap by the same amount");

  const [status = "", assignee = "", createdBy = ""] = firstValueTags(list);
  assert.match(status, /data-testid="task-properties-status"/);
  assert.match(status, /data-slot="task-status-badge"/, "the status chip is the value's first child and a raft-ui hang target");
  assert.match(assignee, /data-testid="task-properties-assignee"/);
  assert.match(assignee, /data-slot="badge"/, "the assignee trigger is the value's first child and a raft-ui hang target");
  for (const [name, tag] of [["status", status], ["assignee", assignee]] as const) {
    assert.ok(!classList(tag).some((c) => /^-ml-|^max-w-\[calc/.test(c)), `the ${name} shape must not add a second, local hang`);
  }
  assert.match(createdBy, /^<span>$/, "Created by stays plain text with no padding or margin");
});

// The read-only branches (joint-task history, a done task's assignee) wrap the
// trigger in a Tooltip. TooltipTrigger only keeps a data-slot that the child element
// carries as a prop, so InlineBadgeEditor passes it explicitly; otherwise the
// trigger would become `tooltip-trigger` and silently lose the hang.
test("read-only and tooltip-wrapped property values stay raft-ui hang targets", () => {
  const joint = firstValueTags(propertiesList(renderProperties({ readOnlyReason: "historical_joint_task" })));
  assert.match(joint[0] ?? "", /data-slot="task-status-badge"/, "a tooltip-wrapped status chip keeps its hang slot");
  assert.match(joint[1] ?? "", /data-slot="badge"/, "a tooltip-wrapped assignee trigger keeps its hang slot");

  const done = firstValueTags(propertiesList(renderProperties({ status: "done", claimedByType: "user", claimedById: "someone-else", claimedByName: "other" })));
  assert.match(done[1] ?? "", /data-slot="badge"/, "a done task's read-only assignee keeps its hang slot");
});
