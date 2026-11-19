import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ProductFeedbackTicket, ProductFeedbackTicketListPage } from "./productFeedbackConversationService";
import {
  type ActivityKey,
  activityKey,
  compareByActivity,
  mergeSourcePages,
  productFeedbackClient,
  type SourcePageRead,
} from "./productFeedbackMergedList";

const T0 = 1_762_000_000_000;

/** `activity` orders the fixture: latest activity first. A reply moves the activity to `latest_comment_at`. */
function ticket(id: string, activity: number, extra: Partial<ProductFeedbackTicket> = {}): ProductFeedbackTicket {
  return {
    id: `${id.padStart(8, "0")}-0000-4000-8000-000000000000`,
    kind: "feedback",
    status: "open",
    closure_reason: null,
    duplicate_of_ticket_id: null,
    message: id,
    version_name: null,
    channel: null,
    created_at: T0 + activity,
    updated_at: T0 + activity,
    attachment_count: 0,
    comment_count: 0,
    latest_comment_at: null,
    unread: false,
    unread_count: 0,
    ...extra,
  };
}

function page(tickets: ProductFeedbackTicket[], next: string | null = null, unread = 0): ProductFeedbackTicketListPage {
  return { tickets, next_hands_cursor: next, unread_total: unread };
}

const names = (tickets: Array<{ message: string }>) => tickets.map((t) => t.message);

describe("productFeedbackClient", () => {
  test("Raft Desktop is the web client with a 'Raft Desktop' version; the web otherwise", () => {
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: "web", client_version: "Raft Desktop 1.22.0" }), "web"), "desktop");
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: "web", client_version: "1.25.0" }), "web"), "web");
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: null, client_version: "Raft Desktop" }), "web"), "desktop");
  });
  test("a mobile app's ticket is its platform; Hands' fields win when present, the app is the fallback", () => {
    assert.equal(productFeedbackClient(ticket("1", 1), "android"), "android");
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: null, client_version: null }), "ios"), "ios");
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: "ohos", client_version: "1.0" }), "ohos"), "ohos");
    // An unknown kind (a future client) falls back to the app rather than leaking a raw value.
    assert.equal(productFeedbackClient(ticket("1", 1, { client_kind: "visionos", client_version: "1" }), "ios"), "ios");
  });
});

describe("Hands' order", () => {
  test("latest public comment, else creation, newest first; ties by id descending", () => {
    const replied = ticket("a", 100, { latest_comment_at: T0 + 900 });
    const created = ticket("b", 500);
    const x = ticket("1", 300);
    const y = ticket("2", 300);
    assert.deepEqual(names([x, created, y, replied].sort(compareByActivity)), ["a", "b", "2", "1"]);
    assert.deepEqual(activityKey(replied), { a: T0 + 900, i: replied.id });
  });
});

describe("mergeSourcePages", () => {
  const fresh = (source: SourcePageRead["source"], p: ProductFeedbackTicketListPage, cursor: string | null = null): SourcePageRead =>
    ({ source, cursor, boundary: null, page: p });
  const at = (read: SourcePageRead, place: { c: string | null; b: ActivityKey | null } | undefined, p = read.page): SourcePageRead =>
    ({ ...read, cursor: place?.c ?? null, boundary: place?.b ?? null, page: p });

  test("orders across apps by latest activity and tags each ticket with its app and client", () => {
    const reads = [
      fresh("web", page([ticket("w1", 500), ticket("w2", 300, { client_kind: "web", client_version: "Raft Desktop 1.22.0" })])),
      fresh("android", page([ticket("a1", 400)])),
    ];
    const { tickets, next, advance } = mergeSourcePages(reads, 20);
    assert.deepEqual(tickets.map((t) => [t.message, t.source, t.client]), [["w1", "web", "web"], ["a1", "android", "android"], ["w2", "web", "desktop"]]);
    // Both pages read to their end: nothing to continue from.
    assert.deepEqual(next, {});
    assert.deepEqual(advance, []);
  });

  test("an app with unread pages holds the merge at its last fetched ticket, so no newer ticket of its is skipped", () => {
    // The reviewer's case: web has a4 (600) on its next page; android's b3 (100) must not come out before it.
    const web = fresh("web", page([ticket("a1", 900), ticket("a2", 800), ticket("a3", 700)], "web-c3"));
    const android = fresh("android", page([ticket("b1", 950), ticket("b2", 650), ticket("b3", 100)]));
    const first = mergeSourcePages([web, android], 3);
    assert.deepEqual(names(first.tickets), ["b1", "a1", "a2"]);
    assert.deepEqual(first.next, {
      web: { c: null, b: activityKey(ticket("a2", 800)) },
      android: { c: null, b: activityKey(ticket("b1", 950)) },
    }, "both pages have tickets left: re-read them from each app's boundary");

    const second = mergeSourcePages([at(web, first.next.web), at(android, first.next.android)], 3);
    // a3 is web's last fetched ticket (frontier): b2 and b3 wait for web's next page.
    assert.deepEqual(names(second.tickets), ["a3"]);
    assert.deepEqual(second.next, {
      web: { c: "web-c3", b: activityKey(ticket("a3", 700)) },
      android: { c: null, b: activityKey(ticket("b1", 950)) },
    });
    assert.deepEqual(second.advance, [], "web still showed a3 on this round");

    const third = mergeSourcePages([at(web, second.next.web, page([ticket("a4", 600)])), at(android, second.next.android)], 3);
    assert.deepEqual(names(third.tickets), ["b2", "a4", "b3"]);
    assert.deepEqual(third.next, {});
  });

  test("a page with nothing left to show but a next page asks to be advanced within the request", () => {
    const web = at(fresh("web", page([ticket("w1", 900), ticket("w2", 800)], "web-next")), { c: null, b: activityKey(ticket("w2", 800)) });
    const ios = fresh("ios", page([ticket("i1", 100)]));
    const result = mergeSourcePages([web, ios], 10);
    assert.deepEqual(result.advance, ["web"]);
    // Nothing is emitted until web's next page is read: i1 (100) could be older than what web still holds.
    assert.deepEqual(names(result.tickets), []);
    assert.deepEqual(result.next, { web: { c: "web-next", b: activityKey(ticket("w2", 800)) }, ios: { c: null, b: null } });
  });

  test("a changed limit or a page that shifted under a reply neither repeats nor skips: the app's boundary decides", () => {
    const boundary = activityKey(ticket("w2", 800));
    // The page is re-read with a smaller limit, and w3 got a reply in between (it moved to the top).
    const shifted = at(fresh("web", page([])), { c: null, b: boundary }, page([ticket("w3", 700, { latest_comment_at: T0 + 950 }), ticket("w1", 900)]));
    const result = mergeSourcePages([shifted], 1);
    // Both are newer than the boundary: already shown (w3 as it was), nothing repeats; the app is read to its end.
    assert.deepEqual(names(result.tickets), []);
    assert.deepEqual(result.next, {});
    const unshifted = at(fresh("web", page([])), { c: null, b: boundary }, page([ticket("w1", 900), ticket("w2", 800), ticket("w3", 700), ticket("w4", 600)]));
    const next = mergeSourcePages([unshifted], 1);
    assert.deepEqual(names(next.tickets), ["w3"]);
    assert.deepEqual(next.next, { web: { c: null, b: activityKey(ticket("w3", 700)) } }, "w4 is left: the same page is re-read");
  });

  test("an app that was out for a page loses nothing: its boundary did not move while the others were shown", () => {
    const web = fresh("web", page([ticket("w1", 900), ticket("w2", 500)]));
    const android = fresh("android", page([ticket("a1", 800)]));
    // Page 1 read web only (android unavailable): both web tickets shown.
    const alone = mergeSourcePages([web], 10);
    assert.deepEqual(names(alone.tickets), ["w1", "w2"]);
    // Page 2: android is back with its own, untouched place.
    const back = mergeSourcePages([android], 10);
    assert.deepEqual(names(back.tickets), ["a1"]);
  });
});
