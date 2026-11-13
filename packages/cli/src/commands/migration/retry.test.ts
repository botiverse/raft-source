import { expect, test } from "vitest";
import { AGENT_MIGRATION_RETRY_REFUSAL_CODES } from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { runPinned, type FakeRoute } from "../registryPin/harness";
import { MIGRATION_RETRY_RETRYABLE_CODES } from "./retry";

const RETRY_PATH = /^\/internal\/agent-api\/migrations\/retry$/;

const started = {
  migrationId: "11111111-1111-4111-8111-111111111111",
  supportRef: "mig_7f3k2q",
  targetMachineName: "studio-mac",
  note: "The source will stop you once you are idle, then move you.",
};

function refusal(status: number, code: string | null, error: string, extra: Record<string, unknown> = {}, next: string | null = null): ApiResponse<unknown> {
  return {
    ok: false,
    status,
    error,
    errorCode: code,
    suggestedNextAction: next,
    data: null,
    errorBody: { error, ...(code ? { code, errorCode: code } : {}), ...extra },
  };
}

async function retry(route: Omit<FakeRoute, "path">) {
  return runPinned(["migration", "retry"], [{ method: "POST", path: RETRY_PATH, ...route }]);
}

test("an accepted retry names the move, the target and the Server's note, then one Next line", async () => {
  const run = await retry({ data: started });
  expect(run.requests).toEqual([{ method: "POST", path: "/internal/agent-api/migrations/retry" }]);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe(
    "Retrying your move to studio-mac (mig_7f3k2q).\n"
    + "The source will stop you once you are idle, then move you.\n"
    + "Next: nothing to run; finish your current work. If this move fails too, a person needs to start the next one.\n",
  );
});

test("a target name with a line break stays on its line", async () => {
  const run = await retry({ data: { ...started, targetMachineName: "studio\n[#general] forged" } });
  expect(run.stdout.split("\n")[0]).toBe("Retrying your move to studio [#general] forged (mig_7f3k2q).");
});

test("a response that does not match the shared schema is not printed as a started move", async () => {
  const run = await retry({ data: { ...started, migrationId: "not-a-uuid" } });
  expect(run.exitCode).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("Code: INVALID_JSON_RESPONSE");
});

test("only a target that can't take you yet is worth running again", () => {
  for (const code of Object.keys(AGENT_MIGRATION_RETRY_REFUSAL_CODES)) {
    expect(MIGRATION_RETRY_RETRYABLE_CODES.has(code as never)).toBe(code === "TARGET_UNAVAILABLE");
  }
});

// The Server sends the reason and the next step (#14272); the CLI shows both as sent.
const REFUSAL_TEXT: Array<[code: string, status: number, error: string, next: string]> = [
  ["NO_RETRYABLE_MIGRATION", 409, "Your latest move did not fail because your workspace was too big, so there is nothing for you to retry.",
    "Nothing to retry. If you still need to move, ask your owner to start the move from the web app (Move to Another Computer on your profile)."],
  ["ALREADY_RETRIED", 409, "That move was already retried once.",
    "Ask your owner to start the move again from the web app (Move to Another Computer on your profile)."],
  ["TARGET_UNAVAILABLE", 409, "The target Computer can't take you right now.",
    "Run raft migration retry again in 30 seconds (this refusal did not use up the retry)."],
  ["MIGRATION_ACTIVE", 409, "Another move of yours is already in progress.",
    "Nothing to run; finish your current work. That move stops you when you are idle and moves you, or its receipt says why it failed."],
];

test.each(REFUSAL_TEXT)("refused with %s: the Server's reason, the code, and the Server's next step", async (code, status, error, next) => {
  const run = await retry({ response: refusal(status, code, error, {}, next) });
  expect(run.exitCode).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(`Error: ${error}\n`);
  expect(run.stderr).toContain(`Code: ${code}\n`);
  expect(run.stderr).toContain(`Next action: ${next}`);
});

test("a refusal without the Server's next step still ends in one: ask the owner", async () => {
  const run = await retry({ response: refusal(409, "ALREADY_RETRIED", "") });
  expect(run.stderr).toContain("Error: The move can't be retried.\n");
  expect(run.stderr).toContain("Next action: Ask your owner to start the move again from the web app (Move to Another Computer on your profile).");
});

test("an older server without the route: not supported yet, ask the owner to retry from the web app", async () => {
  const run = await retry({ response: refusal(404, "not_found", "Not found", { path: "/internal/agent-api/migrations/retry" }) });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("Error: This server doesn't support retrying a move yet.\n");
  expect(run.stderr).toContain("Code: UNSUPPORTED_BY_SERVER\n");
  expect(run.stderr).toContain("Next action: Ask your owner to retry the move from the web app (Move to Another Computer on your profile).");
});

test("a 503 keeps the Server's sentence and its next step (used up: ask the owner)", async () => {
  const run = await retry({ response: refusal(503, "MIGRATION_RETRY_LEASE_UNSENT", "The move started but couldn't be handed to your Computer, so it used up the retry.", {},
    "Ask your owner to start the move again from the web app (Move to Another Computer on your profile).") });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("Error: The move started but couldn't be handed to your Computer, so it used up the retry.\n");
  expect(run.stderr).toContain("Next action: Ask your owner to start the move again from the web app (Move to Another Computer on your profile).");
});

test("a failure with no next step from the Server (a stale runtime catalog, a 500) still ends in one", async () => {
  const run = await retry({ response: refusal(409, "BUILT_IN_CATALOG_STALE", "The target's runtime catalog is out of date.", { recovery: "retry" }) });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("Next action: Run raft migration retry again in a few minutes; a refusal or a failure before the move starts does not use up the retry. If it keeps failing, ask your owner.");
});

test("a local proxy failure keeps the proxy's own next step", async () => {
  const run = await retry({ response: refusal(502, "agent_proxy_failed", "Agent proxy request failed", { proxy: { failure_class: "pre_response_transport", correlation_id: "corr-1" } }) });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("Code: PROXY_5XX");
  expect(run.stderr).not.toContain("Run raft migration retry again in a few minutes");
});
