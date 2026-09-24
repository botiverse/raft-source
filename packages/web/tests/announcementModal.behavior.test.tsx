import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import AnnouncementModal from "../src/components/AnnouncementModal";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { TestIntlProvider } from "./helpers/intl";

const originalApiPost = api.post;

const announcement = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Product update",
  pages: [
    { body: "First page" },
    { body: "Second page" },
  ],
  publishedAt: "2026-07-27T00:00:00.000Z",
  startsAt: "2026-07-27T00:00:00.000Z",
  endsAt: null,
  locale: "en" as const,
};

const keyboardAnnouncement = {
  ...announcement,
  id: "10000000-0000-4000-8000-000000000002",
  pages: [
    { body: "First page" },
    { body: "Second page" },
    { body: "Third page" },
  ],
};

function BackgroundComposer({ onEnter }: { onEnter: () => void }) {
  return (
    <>
      <textarea
        aria-label="Background composer"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          onEnter();
          event.preventDefault();
        }}
      />
      <AnnouncementModal />
    </>
  );
}

afterEach(() => {
  cleanup();
  api.post = originalApiPost;
  useAnnouncementStore.getState().reset();
});

test("onboarding suppression keeps a pending announcement out of the takeover layer", () => {
  useAnnouncementStore.setState({ pending: [announcement], loaded: true });

  render(
    <TestIntlProvider>
      <AnnouncementModal suppressed />
    </TestIntlProvider>,
  );

  assert.equal(screen.queryByTestId("announcement-modal"), null);
  assert.equal(
    useAnnouncementStore.getState().pending[0]?.id,
    announcement.id,
    "suppression does not discard the server-authoritative pending item",
  );
});

test("announcement actions render through the zh-cn catalog", () => {
  useAnnouncementStore.setState({ pending: [announcement], loaded: true });

  render(
    <TestIntlProvider locale="zh-cn">
      <AnnouncementModal />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByRole("button", { name: "关闭" }));
  assert.ok(screen.getByRole("button", { name: /下一步/ }));
  assert.doesNotMatch(document.body.textContent ?? "", /common\.announcement\./);
});

test("multi-page announcement keeps the numeric counter without dot pagination", () => {
  useAnnouncementStore.setState({ pending: [announcement], loaded: true });

  const { container } = render(
    <TestIntlProvider>
      <AnnouncementModal />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("announcement-page-indicator").textContent, "1 / 2");
  assert.equal(
    container.querySelectorAll(".rounded-full").length,
    0,
    "the announcement footer must not render pagination dots",
  );
});

test("modal capture owns Enter before a focused background composer can consume it", async () => {
  useAnnouncementStore.setState({ pending: [keyboardAnnouncement], loaded: true });
  let backgroundEnterCount = 0;

  render(
    <TestIntlProvider>
      <BackgroundComposer onEnter={() => { backgroundEnterCount += 1; }} />
    </TestIntlProvider>,
  );

  const composer = screen.getByRole("textbox", { name: "Background composer" });
  composer.focus();
  assert.equal(document.activeElement, composer);

  fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

  await waitFor(() => {
    assert.equal(screen.getByTestId("announcement-page-indicator").textContent, "2 / 3");
  });
  assert.equal(backgroundEnterCount, 0, "the background composer must not observe modal-owned Enter");
});

test("three Enter events in one act synchronously advance two pages and dismiss", async () => {
  useAnnouncementStore.setState({ pending: [keyboardAnnouncement], loaded: true });
  const dismissedPaths: string[] = [];
  api.post = (async (path: string) => {
    dismissedPaths.push(path);
    return { data: {} };
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <AnnouncementModal />
    </TestIntlProvider>,
  );

  const dispatchEnter = () => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  }));

  await act(async () => {
    dispatchEnter();
    dispatchEnter();
    dispatchEnter();
  });

  assert.equal(
    screen.queryByTestId("announcement-modal") === null,
    true,
    "three same-turn Enter events must dismiss the three-page announcement",
  );
  assert.deepEqual(dismissedPaths, [`/announcements/${keyboardAnnouncement.id}/dismiss`]);
});
