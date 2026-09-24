import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
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

function renderProperties(): string {
  useAuthStore.setState({
    user: {
      id: "human-1",
      email: "human@example.com",
      gravatarHash: "",
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
      createElement(TaskProperties, { task }),
    ),
  );
}

afterEach(() => {
  useAuthStore.setState({ user: null });
  useServerStore.setState({ current: null, members: [] });
});

test("real TaskProperties keeps its three facts in one wrapping row", () => {
  const html = renderProperties();
  const list = html.match(/<dl[^>]*data-testid="task-properties"[^>]*>[\s\S]*<\/dl>/)?.[0] ?? "";

  assert.match(
    list,
    /class="[^"]*\bflex\b[^"]*\bflex-wrap\b[^"]*\bitems-center\b[^"]*\bgap-x-6\b[^"]*\bgap-y-2\b/,
    "the real properties list should share one horizontal row and wrap only when needed",
  );

  const items = [...list.matchAll(/<div[^>]*data-slot="description-item"[^>]*>[\s\S]*?<\/div>/g)]
    .map((match) => match[0]);
  assert.equal(items.length, 3, "status, assignee, and creator are three facts in the shared row");
  for (const [index, label] of ["Status", "Assignee", "Created by"].entries()) {
    const item = items[index] ?? "";
    assert.match(
      item,
      /class="[^"]*\bflex\b[^"]*\bmin-w-0\b[^"]*\bitems-center\b[^"]*\bgap-2\b/,
      "each rendered fact should keep its term and details together",
    );
    assert.match(item, new RegExp(`<dt[^>]*>${label}</dt>[\\s\\S]*<dd[\\s\\S]*</dd>`));
  }
});
