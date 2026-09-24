import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import api from "../src/api/client";
import { useAnnouncementStore } from "../src/store/announcementStore";

const announcement = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Owned by this tab",
  pages: [{ body: "Keep this open" }],
  publishedAt: "2026-09-01T00:00:00.000Z",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: null,
  locale: "en" as const,
};

afterEach(() => {
  useAnnouncementStore.getState().reset();
});

test("an open announcement prevents focus recovery from refetching or clearing this tab", async (t) => {
  let gets = 0;
  t.mock.method(api, "get", async () => {
    gets += 1;
    return { data: { announcements: [] } };
  });
  useAnnouncementStore.setState({ pending: [announcement], loaded: true });

  await useAnnouncementStore.getState().load();

  assert.equal(gets, 0, "a tab with an open modal must keep local presentation ownership");
  assert.deepEqual(useAnnouncementStore.getState().pending, [announcement]);
});

test("focus and visibility recovery share one request and cannot erase a modal opened before it resolves", async (t) => {
  let gets = 0;
  let resolveGet!: (value: { data: { announcements: never[] } }) => void;
  const response = new Promise<{ data: { announcements: never[] } }>((resolve) => {
    resolveGet = resolve;
  });
  t.mock.method(api, "get", () => {
    gets += 1;
    return response;
  });

  const focusLoad = useAnnouncementStore.getState().load();
  const visibilityLoad = useAnnouncementStore.getState().load();
  await Promise.resolve();
  assert.equal(gets, 1, "one foreground transition must be single-flight");

  useAnnouncementStore.setState({ pending: [announcement], loaded: true });
  resolveGet({ data: { announcements: [] } });
  await Promise.all([focusLoad, visibilityLoad]);

  assert.deepEqual(
    useAnnouncementStore.getState().pending,
    [announcement],
    "a late empty response must not close a modal that this tab has since opened",
  );
});

test("an idle focused tab still loads the current server-authoritative announcement", async (t) => {
  let gets = 0;
  t.mock.method(api, "get", async () => {
    gets += 1;
    return { data: { announcements: [announcement] } };
  });

  await useAnnouncementStore.getState().load();

  assert.equal(gets, 1);
  assert.deepEqual(useAnnouncementStore.getState().pending, [announcement]);
  assert.equal(useAnnouncementStore.getState().loaded, true);
});
