import assert from "node:assert/strict";
import { formatMyTaskList } from "./_format";

// Task #108. The `--mine` renderer output an agent relies on to find work assigned to it:
// the listing is scoped to one server, and its completeness signal is `truncated=` rather
// than the `showing X of X` phrase, which cannot report a shortfall.

test("an absent pagination block renders unknown", () => {
  // `mode` and `truncated` come from the server; the renderer falls back to the string
  // "unknown". A reader who treats unknown as false believes a set is complete when this
  // run could not tell them. Deleting either `?? "unknown"` fallback turns this red.
  const rendered = formatMyTaskList({ tasks: [], scope: "mine" } as never);
  assert.match(rendered, /mode=unknown/, "missing pagination.mode must render as unknown");
  assert.match(rendered, /truncated=unknown/, "missing pagination.truncated must render as unknown");
});
