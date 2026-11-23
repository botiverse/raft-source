// Settled (#334): the home page's Working and Other as useArtifactHomeGroups keeps them while the page is open. The
// tab's cached page decides only until the page's own first read answers; after that a row stays in its group
// whatever its news says (opening it clears them) and whatever others do; the reader's own settle or unsettle moves
// it at once, from the row's menu or from the viewer over the page (reportOwnSettle), with its answer on the row; a
// second press waits for the first.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createIntl } from "react-intl";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactDashboardAllNews, ArtifactSettled, ArtifactWebDashboardAll, ArtifactWebSettlement, ObjectInboxItem } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { artifactActivityRowParts } from "../src/apps/artifacts/artifactActivityRow";
import { allItems } from "../src/apps/artifacts/artifactDashboardItems";
import { reportOwnSettle } from "../src/apps/artifacts/artifactOwnSettles";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import { fakeArtifactSource } from "../src/apps/artifacts/fakeArtifactSource";
import { useArtifactHomeGroups } from "../src/apps/artifacts/useArtifactHomeGroups";
import { mergedMessages } from "../src/i18n/messages";

const NOW = Date.now();
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const IDLE = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
const REMY = { type: "agent" as const, id: "a1", name: "remy", displayName: "Remy", avatarUrl: null };
const SETTLED: ArtifactSettled = { by: REMY, at: new Date(NOW - 1000).toISOString(), version: 2 };
const NO_NEWS: ArtifactDashboardAllNews = { mentions: 0, versions: 0, comments: 0 };

function card(id: string, updatedAt: string, settled: ArtifactSettled | null): ArtifactCard {
  return {
    id: asArtifactId(id), url: `https://app.raft.build/artifacts/${id}`, title: id, description: null, kind: "markdown",
    facts: { sizeBytes: 1, fileCount: 1 }, preview: { kind: "none" }, version: 2, pinned: false, latestVersion: 2,
    author: REMY, createdAt: IDLE, updatedAt, commentCount: 0, home: { kind: "server" }, settled, reopened: null,
  };
}

type Row = [id: string, updatedAt: string, settled: ArtifactSettled | null, news?: Partial<ArtifactDashboardAllNews>];
const pageOf = (rows: Row[]): ArtifactWebDashboardAll => ({
  rows: rows.map(([id, updatedAt, settled, news]) => ({ card: card(id, updatedAt, settled), openedAt: null, news: { ...NO_NEWS, ...news } })),
  nextCursor: null,
});

/** The page's row `id`'s card. */
function cardIn(page: ArtifactWebDashboardAll, id: string): ArtifactCard {
  const row = page.rows.find((candidate) => candidate.card.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row.card;
}

interface Props { page: ArtifactWebDashboardAll; fresh: boolean }

function mount(initial: Props, reads: boolean[] = []) {
  const wrapper = ({ children }: { children: ReactNode }) => <TestIntlProvider>{children}</TestIntlProvider>;
  return renderHook(({ page, fresh }: Props) => useArtifactHomeGroups({
    items: allItems(page.rows, false),
    page,
    fresh,
    serverId: "s1",
    searching: false,
    extended: false,
    read: async (keepRows) => {
      reads.push(keepRows);
    },
  }), { initialProps: initial, wrapper });
}

const working = (result: { current: ReturnType<typeof useArtifactHomeGroups> }) => result.current.groups?.working?.map((item) => item.card.id) ?? [];
const other = (result: { current: ReturnType<typeof useArtifactHomeGroups> }) => result.current.groups?.other.map((item) => item.card.id) ?? [];

describe("the home page's groups while it is open", () => {
  afterEach(() => {
    cleanup();
    setArtifactSourceForTests(null);
  });

  it("decides on the first fresh page, not the tab's cached one, then holds", () => {
    // The cache: `a` idle with nothing new; `b` had new comments then.
    const { result, rerender } = mount({ page: pageOf([["a", IDLE, null], ["b", IDLE, null, { comments: 2 }]]), fresh: false });
    assert.deepEqual(working(result), ["b"]);
    // The page's own read: `a` mentions the reader now, `b` was read since.
    rerender({ page: pageOf([["a", IDLE, null, { mentions: 1 }], ["b", IDLE, null]]), fresh: true });
    assert.deepEqual(working(result), ["a"]);
    assert.deepEqual(other(result), ["b"]);
    // Opened (its mention read) and read again, someone else settled it meanwhile, `b` has a new comment: nothing moves.
    rerender({ page: pageOf([["a", IDLE, SETTLED], ["b", IDLE, null, { comments: 1 }]]), fresh: true });
    assert.deepEqual(working(result), ["a"]);
    assert.deepEqual(other(result), ["b"]);
  });

  it("moves a row at once on the reader's own settle from its menu, its answer on the row, and reads the list again", async () => {
    const asked: Array<[string, boolean]> = [];
    let answer: (value: ArtifactWebSettlement) => void = () => {};
    setArtifactSourceForTests({
      ...fakeArtifactSource,
      setSettled: (id, settled) => {
        asked.push([id, settled]);
        return new Promise<ArtifactWebSettlement>((resolve) => {
          answer = resolve;
        });
      },
    });
    const reads: boolean[] = [];
    const page = pageOf([["w", RECENT, null], ["x", RECENT, null]]);
    const { result } = mount({ page, fresh: true }, reads);
    assert.deepEqual(working(result), ["w", "x"]);
    const w = cardIn(page, "w");
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.settle.setSettled(w, true);
    });
    assert.ok(result.current.settle.pending.has("w"));
    // A second press while the first is asked: no second request.
    await act(async () => {
      await result.current.settle.setSettled(w, true);
    });
    assert.deepEqual(asked, [["w", true]]);
    await act(async () => {
      answer({ settled: SETTLED, changed: true });
      await first;
    });
    assert.deepEqual(working(result), ["x"]);
    assert.deepEqual(other(result), ["w"]);
    assert.deepEqual(result.current.items.find((item) => item.card.id === "w")?.card.settled, SETTLED);
    assert.equal(result.current.settle.pending.size, 0);
    assert.deepEqual(reads, [true]);
  });

  it("moves a row on the reader's own unsettle in the viewer over the page", () => {
    const page = pageOf([["s", RECENT, SETTLED], ["t", RECENT, SETTLED]]);
    const { result, rerender } = mount({ page, fresh: true });
    assert.deepEqual(other(result), ["s", "t"]);
    act(() => reportOwnSettle(asArtifactId("s"), null));
    assert.deepEqual(working(result), ["s"]);
    assert.equal(result.current.items.find((item) => item.card.id === "s")?.card.settled, null);
    // The list read again when the viewer closes: the server's rows agree, and `s` stays where the act put it.
    rerender({ page: pageOf([["s", RECENT, null], ["t", RECENT, SETTLED]]), fresh: true });
    assert.deepEqual(working(result), ["s"]);
    assert.deepEqual(other(result), ["t"]);
  });

  it("refuses with a toast and moves nothing when the server says no", async () => {
    setArtifactSourceForTests({ ...fakeArtifactSource, setSettled: () => Promise.reject({ status: 403, code: "FORBIDDEN" }) });
    const reads: boolean[] = [];
    const page = pageOf([["w", RECENT, null]]);
    const { result } = mount({ page, fresh: true }, reads);
    await act(async () => {
      await result.current.settle.setSettled(cardIn(page, "w"), true);
    });
    assert.deepEqual(working(result), ["w"]);
    assert.deepEqual(reads, []);
  });

  it("draws no groups where the rows say nothing of Settled (the flag off)", () => {
    const { settled: _settled, reopened: _reopened, ...off } = card("f", RECENT, null);
    const page: ArtifactWebDashboardAll = { rows: [{ card: off, openedAt: null, news: NO_NEWS }], nextCursor: null };
    const { result } = mount({ page, fresh: true });
    assert.equal(result.current.groups, null);
  });
});

// The Activity row reads the card parts, which reach the signed-in store (localStorage): a DOM test.
function activityItem(eventKind: string, target: ObjectInboxItem<"artifact">["target"]): ObjectInboxItem<"artifact"> {
  return {
    kind: "object",
    objectKind: "artifact",
    objectId: asArtifactId("pt_settled"),
    summary: card("pt_settled"),
    home: { kind: "server" },
    latestEvent: { eventKind, reason: "following", actor: { type: "agent", id: "a1", name: "remy" }, at: "2026-11-19T10:00:00.000Z" },
    preview: null,
    target,
    unreadCount: 0,
    hasMention: false,
    isFollowing: true,
    lastActivityAt: "2026-11-19T10:00:00.000Z",
    doneFrontierSeq: "1",
  } as ObjectInboxItem<"artifact">;
}

test("Activity: a settle, an unsettle, and a new version since it was settled", () => {
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const line = (eventKind: string, target: ObjectInboxItem<"artifact">["target"]) => String(artifactActivityRowParts(activityItem(eventKind, target), "Remy", (name) => name, intl).event);
  assert.equal(line("settled", { version: 3 }), "Remy settled it");
  assert.equal(line("unsettled", { version: 3 }), "Remy unsettled it");
  assert.equal(line("version", { version: 4, wasSettled: 3 }), "Remy published v4, a new version since it was settled");
  assert.equal(line("version", { version: 4 }), "Remy published v4");
  const zh = createIntl({ locale: "zh-CN", defaultLocale: "en", messages: mergedMessages("zh-cn") });
  assert.equal(String(artifactActivityRowParts(activityItem("settled", { version: 3 }), "Remy", (name) => name, zh).event), "Remy 标为定稿");
});
