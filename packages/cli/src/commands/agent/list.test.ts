/**
 * Unit tests for `raft agent list`'s CLI-side mapping from the server's
 * stable `reason` enum to the next-action guidance copy.
 *
 * Contract pin: server `/api/agents/manageable` returns
 * `{ agents, reason, manageable_server_count }` — machine-readable only.
 * The CLI owns the `suggested_next_action` text via `describeListResult`.
 * This keeps the API contract free of CLI flag forms; future clients
 * (web / SDK) can supply their own mapping over the same `reason` enum.
 *
 * Source: @xxchan #wg-self-hosted-agent msg=4acca4ce ("suggested_next_action
 * 这种东西... 在 cli command 里做的啊") + @Hao msg=27f60c48 contract split
 * (server returns code/fields, client owns copy).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { describeListResult } from "./list.js";

const SERVER = "https://slock.example.com";

test("describeListResult: ok includes the next CLI command with serverUrl interpolated", () => {
  const copy = describeListResult("ok", SERVER);
  assert.ok(copy.includes("raft agent login"), `expected login command in copy, got: ${copy}`);
  assert.ok(copy.includes(SERVER), `expected serverUrl ${SERVER} interpolated, got: ${copy}`);
  assert.ok(copy.includes("--agent"), `expected --agent placeholder in copy, got: ${copy}`);
});

test("describeListResult: no_manageable_server points at credential authority recovery", () => {
  const copy = describeListResult("no_manageable_server", SERVER);
  assert.ok(copy.includes("issueAgentCredentials"), `expected issueAgentCredentials mention, got: ${copy}`);
  assert.ok(
    copy.includes("server owner") || copy.includes("admin"),
    `expected owner/admin grant recovery hint, got: ${copy}`,
  );
});

test("describeListResult: no_agents_on_manageable_servers tells the operator to create an agent", () => {
  const copy = describeListResult("no_agents_on_manageable_servers", SERVER);
  assert.ok(
    copy.includes("create an agent"),
    `expected agent-creation hint, got: ${copy}`,
  );
});

test("describeListResult: every reason returns non-empty copy (contract — CLI must always have a next step)", () => {
  for (const reason of ["ok", "no_manageable_server", "no_agents_on_manageable_servers"] as const) {
    const copy = describeListResult(reason, SERVER);
    assert.ok(copy.length > 0, `reason=${reason} returned empty copy`);
  }
});
