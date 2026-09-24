/**
 * Client half of oldest-unread-first announcements.
 *
 * ⚠️ These tests deliberately pin the ABOLITION of the old "an older
 * announcement is never resurfaced" invariant (Cindy, 2026-08-07). A future
 * reader seeing an old announcement come back is looking at the product
 * decision, not a regression — do not "fix" this suite back to newest-only.
 *
 * Two contracts live here:
 *   §2 read-complete requires explicit confirmation on the LAST PAGE. Merely
 *      rendering a single-page announcement or navigating to the last page
 *      must never write account-level dismissal state.
 *   §4 a FAILED read-complete write is held in memory for the session so the
 *      queue keeps advancing (option B, Cindy, 2026-08-09) — but it is never
 *      persisted, so the row returns on the next load.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "raft-ui";
import api from "../src/api/client";
import AnnouncementModal from "../src/components/AnnouncementModal";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { TestIntlProvider } from "./helpers/intl";

const onePage = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Single",
  pages: [{ body: "Only page" }],
  publishedAt: "2026-07-01T00:00:00.000Z",
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: null,
  locale: "en" as const,
};

const threePages = {
  ...onePage,
  id: "10000000-0000-4000-8000-000000000002",
  title: "Triple",
  pages: [{ body: "Page one" }, { body: "Page two" }, { body: "Page three" }],
};

const newer = {
  ...onePage,
  id: "10000000-0000-4000-8000-000000000003",
  title: "Newer",
  publishedAt: "2026-07-09T00:00:00.000Z",
};

function renderModal() {
  return render(
    <TestIntlProvider>
      <AnnouncementModal />
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  useAnnouncementStore.getState().reset();
});

test("a single-page announcement is read-complete only after explicit confirmation", async (t) => {
  const posted: string[] = [];
  t.mock.method(api, "post", async (url: string) => {
    posted.push(url);
    return { data: {} };
  });
  useAnnouncementStore.setState({ pending: [onePage], loaded: true });

  renderModal();

  await waitFor(() => assert.ok(screen.getByTestId("announcement-ok")));
  assert.deepEqual(posted, [], "rendering must not dismiss an account-level announcement");

  fireEvent.click(screen.getByTestId("announcement-ok"));
  await waitFor(() => assert.equal(posted.length, 1));
  assert.match(posted[0], new RegExp(`${onePage.id}/dismiss$`));
  assert.equal(screen.queryByTestId("announcement-modal"), null);
});

test("a multi-page announcement parked on page 1 is NOT read-complete", async (t) => {
  const posted: string[] = [];
  t.mock.method(api, "post", async (url: string) => {
    posted.push(url);
    return { data: {} };
  });
  useAnnouncementStore.setState({ pending: [threePages], loaded: true });

  renderModal();
  await waitFor(() => assert.ok(screen.getByTestId("announcement-modal")));

  // The easiest cell to get wrong: rendering a page is not reading the row.
  assert.deepEqual(posted, [], "page 1 of 3 must not report the row as read");
  assert.deepEqual(useAnnouncementStore.getState().markedReadIds, []);
});

test("reaching the last page waits for explicit confirmation before read-complete", async (t) => {
  const posted: string[] = [];
  t.mock.method(api, "post", async (url: string) => {
    posted.push(url);
    return { data: {} };
  });
  useAnnouncementStore.setState({ pending: [threePages], loaded: true });

  renderModal();
  fireEvent.click(screen.getByTestId("announcement-next"));
  fireEvent.click(screen.getByTestId("announcement-next"));

  await waitFor(() => assert.ok(screen.getByTestId("announcement-ok")));
  assert.deepEqual(posted, [], "navigation alone must not dismiss the announcement");

  fireEvent.click(screen.getByTestId("announcement-ok"));
  await waitFor(() => assert.equal(posted.length, 1));
  assert.equal(screen.queryByTestId("announcement-modal"), null);
});

test("leaving the last page and returning still waits for one explicit confirmation", async (t) => {
  const posted: string[] = [];
  t.mock.method(api, "post", async (url: string) => {
    posted.push(url);
    return { data: {} };
  });
  useAnnouncementStore.setState({ pending: [threePages], loaded: true });

  renderModal();
  fireEvent.click(screen.getByTestId("announcement-next"));
  fireEvent.click(screen.getByTestId("announcement-next"));
  await waitFor(() => assert.ok(screen.getByTestId("announcement-ok")));

  fireEvent.click(screen.getByTestId("announcement-back"));
  fireEvent.click(screen.getByTestId("announcement-next"));

  await waitFor(() => assert.ok(screen.getByTestId("announcement-ok")));
  assert.equal(posted.length, 0, "re-entering the last page must remain read-only");

  fireEvent.click(screen.getByTestId("announcement-ok"));
  await waitFor(() => assert.equal(posted.length, 1));
});

test("closing before the last page does not record read-complete", async (t) => {
  const posted: string[] = [];
  t.mock.method(api, "post", async (url: string) => {
    posted.push(url);
    return { data: {} };
  });
  useAnnouncementStore.setState({ pending: [threePages], loaded: true });

  renderModal();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

  await waitFor(() => assert.equal(useAnnouncementStore.getState().pending.length, 0));
  // Closes locally, but the server keeps no record, so it comes back. If ✕
  // counted as read-complete, the "parked on page 1" rule above would be
  // bypassable with a single click.
  assert.deepEqual(posted, [], "closing early must not report the row as read");
});

test("a failed read-complete write skips the row for this session so the queue advances", async (t) => {
  t.mock.method(api, "post", async () => {
    throw new Error("network down");
  });
  const errors: string[] = [];
  t.mock.method(toast, "error", (msg: string) => {
    errors.push(msg);
  });
  useAnnouncementStore.setState({ pending: [onePage], loaded: true });

  renderModal();
  fireEvent.click(screen.getByTestId("announcement-ok"));
  await waitFor(() =>
    assert.deepEqual(useAnnouncementStore.getState().writeFailedIds, [onePage.id]),
  );

  // Silent failure is the thing option B trades away: the user believes they
  // have read it, so the failure must be visible somewhere.
  await waitFor(() => assert.equal(errors.length, 1));
  assert.match(errors[0], /show again next time/);

  // The real API returns at most one row. The client must pass its session-only
  // frontier back to the server so selection advances BEFORE LIMIT 1; a mock
  // returning [onePage, newer] would hide the production contract defect.
  t.mock.method(api, "get", async (url: string, config?: { params?: { after?: string } }) => {
    assert.equal(url, "/announcements/active");
    assert.equal(config?.params?.after, onePage.id);
    return { data: { announcements: [newer] } };
  });
  await useAnnouncementStore.getState().load();
  assert.deepEqual(
    useAnnouncementStore.getState().pending.map((a) => a.id),
    [newer.id],
    "a failed write must not block every later announcement",
  );
});

test("a failed read-complete write is never persisted, so a fresh session sees the row again", async (t) => {
  t.mock.method(api, "post", async () => {
    throw new Error("network down");
  });
  t.mock.method(toast, "error", () => undefined);
  useAnnouncementStore.setState({ pending: [onePage], loaded: true });

  renderModal();
  fireEvent.click(screen.getByTestId("announcement-ok"));
  await waitFor(() =>
    assert.deepEqual(useAnnouncementStore.getState().writeFailedIds, [onePage.id]),
  );

  // `reset()` is what logout / a fresh page does. The skip list is memory-only
  // on purpose: the server holds no dismissal, so the client must not be the
  // more authoritative of the two about what was read.
  useAnnouncementStore.getState().reset();
  t.mock.method(api, "get", async (_url: string, config?: { params?: { after?: string } }) => {
    assert.equal(config?.params?.after, undefined, "fresh sessions must not inherit a frontier");
    return { data: { announcements: [onePage] } };
  });
  await useAnnouncementStore.getState().load();

  assert.deepEqual(
    useAnnouncementStore.getState().pending.map((a) => a.id),
    [onePage.id],
    "the un-recorded row must come back once the session skip list is gone",
  );
});

test("101 failed writes still advance with one constant-size frontier", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(api, "post", async () => {
    throw new Error("write path unavailable");
  });
  const failedIds = Array.from({ length: 101 }, (_, index) =>
    `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
  );
  for (const id of failedIds) await useAnnouncementStore.getState().markRead(id);
  assert.equal(useAnnouncementStore.getState().writeFailedIds.length, 101);
  const rowAfterFrontier = {
    ...newer,
    id: "10000000-0000-4000-8000-999999999999",
  };

  t.mock.method(api, "get", async (url: string, config?: { params?: { after?: string } }) => {
    assert.equal(url, "/announcements/active");
    assert.deepEqual(
      config?.params,
      { after: failedIds.at(-1) },
      "the 101st failure must not grow the request or trigger the former >100 rejection",
    );
    return { data: { announcements: [rowAfterFrontier] } };
  });
  await useAnnouncementStore.getState().load();
  assert.deepEqual(useAnnouncementStore.getState().pending.map((item) => item.id), [rowAfterFrontier.id]);
});
