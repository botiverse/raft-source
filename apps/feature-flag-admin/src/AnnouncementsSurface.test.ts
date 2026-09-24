import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { announcementCatalog } from "./announcementCatalog";
import { AnnouncementsSurface, createLatestAuditLoader } from "./AnnouncementsSurface";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function auditEvent(id: string) {
  return {
    id,
    actorUserId: "operator-1",
    action: "created" as const,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

function keyShape(value: unknown): unknown {
  if (typeof value === "function") return "function";
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, keyShape(nested)]),
  );
}

test("announcement operator UI ships structurally complete en and zh-CN catalogs", () => {
  assert.deepEqual(
    keyShape(announcementCatalog["zh-cn"]),
    keyShape(announcementCatalog.en),
  );
  assert.equal(announcementCatalog["zh-cn"].scheduleUpdated, "排期已更新。");
  assert.equal(announcementCatalog["zh-cn"].status.scheduled, "已排期");
  assert.equal(announcementCatalog["zh-cn"].auditAction.schedule_cancelled, "排期已取消");
});

test("announcement surface renders the localized editor, schedule controls, preview, and audit shell", () => {
  const html = renderToStaticMarkup(createElement(AnnouncementsSurface));
  assert.match(html, /Admin language/);
  assert.match(html, /Locales/);
  assert.match(html, /Visibility window/);
  assert.match(html, /Live preview/);
  assert.match(html, /Preview updates as you type/);
  assert.doesNotMatch(html, /dismissal count/i);
});

test("a stale announcement audit response or failure cannot overwrite the current detail", async () => {
  const lateA = deferred<ReturnType<typeof auditEvent>[]>();
  const fastB = deferred<ReturnType<typeof auditEvent>[]>();
  const requests = new Map([
    ["announcement-a", lateA],
    ["announcement-b", fastB],
  ]);
  let visibleAudit: string[] = [];
  const loader = createLatestAuditLoader(
    async (id) => {
      const pending = requests.get(id);
      assert.ok(pending);
      return pending.promise;
    },
    (events) => {
      visibleAudit = events.map((event) => event.id);
    },
  );

  const loadA = loader.load("announcement-a");
  const loadB = loader.load("announcement-b");
  fastB.resolve([auditEvent("audit-b")]);
  await loadB;
  assert.deepEqual(visibleAudit, ["audit-b"]);
  lateA.resolve([auditEvent("audit-a")]);
  await loadA;
  assert.deepEqual(visibleAudit, ["audit-b"], "late A success cannot replace B audit");

  const failingA = deferred<ReturnType<typeof auditEvent>[]>();
  const secondB = deferred<ReturnType<typeof auditEvent>[]>();
  const secondRequests = new Map([
    ["announcement-a", failingA],
    ["announcement-b", secondB],
  ]);
  const secondLoader = createLatestAuditLoader(
    async (id) => {
      const pending = secondRequests.get(id);
      assert.ok(pending);
      return pending.promise;
    },
    (events) => {
      visibleAudit = events.map((event) => event.id);
    },
  );

  const failingLoadA = secondLoader.load("announcement-a");
  const secondLoadB = secondLoader.load("announcement-b");
  secondB.resolve([auditEvent("audit-b-2")]);
  await secondLoadB;
  assert.deepEqual(visibleAudit, ["audit-b-2"]);
  failingA.reject(new Error("late A failed"));
  await failingLoadA;
  assert.deepEqual(visibleAudit, ["audit-b-2"], "late A failure cannot clear B audit");
});
