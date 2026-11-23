import assert from "node:assert/strict";
import { test } from "vitest";
import { asSearchCursor, isWebSearchCoreGroupId, WEB_SEARCH_CORE_GROUPS, webSearchPath } from "./webSearchContract";

test("the search path carries q, and app, cursor and limit only when given, encoded", () => {
  assert.equal(webSearchPath({ q: "budget" }), "/api/search?q=budget");
  assert.equal(webSearchPath({ q: "财务 报告&x" }), "/api/search?q=%E8%B4%A2%E5%8A%A1+%E6%8A%A5%E5%91%8A%26x");
  assert.equal(webSearchPath({ q: "plan", app: "artifacts", cursor: asSearchCursor("a+b/c="), limit: 5 }), "/api/search?q=plan&app=artifacts&cursor=a%2Bb%2Fc%3D&limit=5");
  assert.equal(new URL(webSearchPath({ q: "a b+c" }), "https://x.test").searchParams.get("q"), "a b+c");
});

test("core groups: `include` joins the asked groups with commas and is left out when empty; `app` takes a core group id", () => {
  assert.equal(webSearchPath({ q: "infra", include: ["channels", "people"] }), "/api/search?q=infra&include=channels%2Cpeople");
  assert.equal(webSearchPath({ q: "infra", include: [] }), "/api/search?q=infra");
  assert.equal(webSearchPath({ q: "infra", app: "people", cursor: asSearchCursor("people.10.abc"), limit: 10 }), "/api/search?q=infra&app=people&cursor=people.10.abc&limit=10");
  assert.deepEqual([...WEB_SEARCH_CORE_GROUPS], ["channels", "people"]);
  assert.ok(isWebSearchCoreGroupId("channels"));
  assert.ok(!isWebSearchCoreGroupId("artifacts"));
});
