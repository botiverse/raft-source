import assert from "node:assert/strict";
import test from "node:test";
import { getHistoryTopState } from "../src/utils/historyTopState";

test("load_older wins when more history is available", () => {
  assert.equal(
    getHistoryTopState({ hasMore: true, historyLimited: true }),
    "load_older",
  );
});

test("history_limited is shown after accessible history is exhausted", () => {
  assert.equal(
    getHistoryTopState({ hasMore: false, historyLimited: true }),
    "history_limited",
  );
});

test("beginning is shown only when there is no more history and no limit cutoff", () => {
  assert.equal(
    getHistoryTopState({ hasMore: false, historyLimited: false }),
    "beginning",
  );
});
