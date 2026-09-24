import assert from "node:assert/strict";
import { test } from "vitest";

import { scopeDbReadOptionsFor } from "./scopeDbSdkPolicy.js";

test("ScopeDB bounded counts opt into JSON-safe number conversion", () => {
  assert.deepEqual(scopeDbReadOptionsFor("bounded_count"), { integerMode: "number" });
});

test("ScopeDB unbounded I64 values opt into precision-safe string conversion", () => {
  assert.deepEqual(scopeDbReadOptionsFor("unbounded_i64"), { integerMode: "string" });
});
