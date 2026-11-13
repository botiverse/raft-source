// The Artifacts home's kept first pages (artifactDashboardCache.ts): one per reader, server and sort; the least
// recently used go past eight; another reader in the tab starts with none; a server's pages can be forgotten.
import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import type { ArtifactWebDashboardAll } from "@botiverse/raft-shared";

import { cacheDashboardPage, cachedDashboardPage, clearDashboardPages, forgetDashboardPages } from "../src/apps/artifacts/artifactDashboardCache";

const page = (title: string) => ({ rows: [{ card: { id: title, title } }], nextCursor: null }) as unknown as ArtifactWebDashboardAll;
const titleOf = (hit: ReturnType<typeof cachedDashboardPage>) => (hit?.page.rows[0]?.card.title ?? null);

beforeEach(() => clearDashboardPages());

test("a page is kept per server and sort; the other sort or server has none", () => {
  cacheDashboardPage("u1", "s1", "opened", { page: page("a"), byOpened: true });
  assert.equal(titleOf(cachedDashboardPage("u1", "s1", "opened")), "a");
  assert.equal(cachedDashboardPage("u1", "s1", "updated"), null);
  assert.equal(cachedDashboardPage("u1", "s2", "opened"), null);
});

test("another reader starts with none, and the first reader's pages are gone (reverse: kept across sign-ins)", () => {
  cacheDashboardPage("u1", "s1", "opened", { page: page("a"), byOpened: true });
  assert.equal(cachedDashboardPage("u2", "s1", "opened"), null);
  assert.equal(cachedDashboardPage("u1", "s1", "opened"), null);
});

test("past eight, the least recently used goes; reading one keeps it", () => {
  for (let i = 0; i < 8; i++) cacheDashboardPage("u1", `s${i}`, "opened", { page: page(`p${i}`), byOpened: true });
  assert.equal(titleOf(cachedDashboardPage("u1", "s0", "opened")), "p0");
  cacheDashboardPage("u1", "s8", "opened", { page: page("p8"), byOpened: true });
  assert.equal(titleOf(cachedDashboardPage("u1", "s0", "opened")), "p0");
  assert.equal(cachedDashboardPage("u1", "s1", "opened"), null);
});

test("forgetting a server drops its pages in every sort and no other server's", () => {
  cacheDashboardPage("u1", "s1", "opened", { page: page("a"), byOpened: true });
  cacheDashboardPage("u1", "s1", "updated", { page: page("b"), byOpened: false });
  cacheDashboardPage("u1", "s10", "opened", { page: page("c"), byOpened: true });
  forgetDashboardPages("s1");
  assert.equal(cachedDashboardPage("u1", "s1", "opened"), null);
  assert.equal(cachedDashboardPage("u1", "s1", "updated"), null);
  assert.equal(titleOf(cachedDashboardPage("u1", "s10", "opened")), "c");
});
