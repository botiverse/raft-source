import assert from "node:assert/strict";
import { test } from "vitest";
import type { AppId } from "./rapRegistry.js";
import {
  MentionValidationError,
  validateStructuredResourceReferences,
} from "./messageService.js";

const COMPUTER_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeDeps(input: { enabled?: boolean; computers?: string[]; apps?: string[] } = {}) {
  const gateCalls: string[] = [];
  const computerCalls: string[] = [];
  const appCalls: Array<{ serverId: string; appId: string }> = [];
  return {
    computerCalls,
    appCalls,
    gateCalls,
    deps: {
      isResourceReferencesEnabled: async (serverId: string) => {
        gateCalls.push(serverId);
        return input.enabled ?? true;
      },
      getComputerLinkedMachineIds: async (serverId: string) => {
        computerCalls.push(serverId);
        return new Set(input.computers ?? []);
      },
      getInstalledApp: async (serverId: string, appId: AppId) => {
        appCalls.push({ serverId, appId });
        return input.apps?.includes(appId) ? { appId } : null;
      },
    },
  };
}

test("resource refs validate against the authoring server without entering mention semantics", async () => {
  const fixture = makeDeps({ computers: [COMPUTER_ID], apps: ["system.reminder"] });
  await validateStructuredResourceReferences(
    `Use [@Desk](<computer:${COMPUTER_ID}>) and [@Reminder](<app:system.reminder>)`,
    "server-1",
    fixture.deps,
  );

  assert.deepEqual(fixture.computerCalls, ["server-1"]);
  assert.deepEqual(fixture.appCalls, [{ serverId: "server-1", appId: "system.reminder" }]);
  assert.deepEqual(fixture.gateCalls, ["server-1"]);
});

test("resource refs fail closed when the server feature gate is disabled", async () => {
  const fixture = makeDeps({ enabled: false, computers: [COMPUTER_ID], apps: ["system.reminder"] });
  await assert.rejects(
    validateStructuredResourceReferences(`[@Desk](<computer:${COMPUTER_ID}>)`, "server-1", fixture.deps),
    (error: unknown) => error instanceof MentionValidationError
      && error.message === "Computer and App references are not enabled in this server",
  );
  assert.deepEqual(fixture.gateCalls, ["server-1"]);
  assert.deepEqual(fixture.computerCalls, []);
  assert.deepEqual(fixture.appCalls, []);
});

test("forged Computer and uninstalled App refs fail closed", async () => {
  const fixture = makeDeps();
  await assert.rejects(
    validateStructuredResourceReferences(`[@Desk](<computer:${COMPUTER_ID}>)`, "server-1", fixture.deps),
    (error: unknown) => error instanceof MentionValidationError
      && error.message === "Computer reference is not available in this server",
  );
  await assert.rejects(
    validateStructuredResourceReferences("[@Reminder](<app:system.reminder>)", "server-1", fixture.deps),
    (error: unknown) => error instanceof MentionValidationError
      && error.message === "App reference is not installed in this server",
  );
});

test("ordinary prose and human mentions do not query resource authorities", async () => {
  const fixture = makeDeps();
  await validateStructuredResourceReferences("hello @Alice in #general", "server-1", fixture.deps);
  assert.deepEqual(fixture.computerCalls, []);
  assert.deepEqual(fixture.appCalls, []);
  assert.deepEqual(fixture.gateCalls, []);
});

test("malformed typed angle refs are rejected while escaped literals stay inert", async () => {
  const fixture = makeDeps();
  await assert.rejects(
    validateStructuredResourceReferences("bad [@Desk](<computer:not-a-uuid>)", "server-1", fixture.deps),
    (error: unknown) => error instanceof MentionValidationError
      && error.message === "Computer reference is malformed",
  );
  await validateStructuredResourceReferences("literal \\<app:not-valid>", "server-1", fixture.deps);
});
