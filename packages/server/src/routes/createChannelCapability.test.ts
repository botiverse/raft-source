import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { asServerId } from "@botiverse/raft-shared";
import { afterEach, beforeEach, vi } from "vitest";

// Both create paths pick the capability from the requested visibility:
// private takes createPrivateChannels, anything else createPublicChannels.
// The capability check is stubbed to refuse and record what it was asked, so
// this pins the choice itself, apart from the matrix (where every role today
// holds both). The refusal also comes before body validation, as it did.
const asked = vi.hoisted(() => [] as string[]);

vi.mock("../lib/actorPermissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/actorPermissions")>()),
  actorHasServerCapabilityInServer: vi.fn(async (_serverId: string, _actorType: string, _actorId: string, capability: string) => {
    asked.push(capability);
    return false;
  }),
}));

vi.mock("../lib/agentServerRoleRequired", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agentServerRoleRequired")>()),
  agentServerRoleRequiredBody: vi.fn(async (input: { capabilities: readonly string[] }) => ({ code: "server_role_required", error: `Agent requires ${input.capabilities.join(" or ")} capability` })),
}));

const { channelRouter } = await import("./channels");
const { createChannelForAgent } = await import("./agentChannelCreate");

let routeServer: HttpServer | undefined;
let baseUrl = "";

beforeEach(async () => {
  asked.length = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "00000000-0000-4000-8000-000000000001";
    req.serverId = asServerId("00000000-0000-4000-8000-000000000002");
    next();
  });
  app.use("/api/channels", channelRouter);
  routeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    routeServer!.once("listening", resolve);
    routeServer!.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(routeServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => routeServer?.close(() => resolve()));
  routeServer = undefined;
});

const CASES: Array<[unknown, string]> = [
  ["private", "createPrivateChannels"],
  ["public", "createPublicChannels"],
  [undefined, "createPublicChannels"],
];

test("POST /api/channels checks the capability of the requested visibility", async () => {
  for (const [visibility, capability] of CASES) {
    asked.length = 0;
    const response = await fetch(`${baseUrl}/api/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cap-check", ...(visibility === undefined ? {} : { visibility }) }),
    });
    assert.equal(response.status, 403, String(visibility));
    assert.deepEqual(asked, [capability], String(visibility));
  }
});

test("an agent's channel create checks the capability of the requested visibility", async () => {
  const actor = { id: "agent-1", name: "agent", serverId: "server-1" };
  for (const [visibility, capability] of CASES) {
    asked.length = 0;
    const result = await createChannelForAgent({
      actor,
      serverId: "server-1",
      body: { name: "cap-check", ...(visibility === undefined ? {} : { visibility }) },
    });
    assert.equal(result.status, 403, String(visibility));
    assert.deepEqual(asked, [capability], String(visibility));
    assert.equal("refusal" in result ? result.refusal.error : undefined, `Agent requires ${capability} capability`);
  }
});
