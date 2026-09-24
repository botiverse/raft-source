import { test } from "vitest";
import assert from "node:assert/strict";
import type { Response } from "express";
import { asMachineId, asServerId } from "@botiverse/raft-shared";
import { parseBrandedUuidFromBody } from "./brandedParse.js";

function fakeRes(): { res: Response; calls: { status?: number; json?: unknown } } {
  const calls: { status?: number; json?: unknown } = {};
  const res = {
    status(code: number) { calls.status = code; return res; },
    json(body: unknown) { calls.json = body; return res; },
  } as unknown as Response;
  return { res, calls };
}

test("parseBrandedUuidFromBody accepts a valid UUID and brands it", () => {
  const { res, calls } = fakeRes();
  const id = parseBrandedUuidFromBody("00000000-0000-4000-8000-000000000000", asMachineId, "machineId", res);
  assert.equal(id, "00000000-0000-4000-8000-000000000000");
  assert.equal(calls.status, undefined); // no 400 written on success
});

test("parseBrandedUuidFromBody rejects non-UUID / non-string with a 400", () => {
  for (const bad of ["not-a-uuid", "", 42, null, undefined, { id: "x" }, ["00000000-0000-4000-8000-000000000000"]]) {
    const { res, calls } = fakeRes();
    const id = parseBrandedUuidFromBody(bad, asMachineId, "machineId", res);
    assert.equal(id, null, `expected null for ${JSON.stringify(bad)}`);
    assert.equal(calls.status, 400);
    assert.deepEqual(calls.json, { error: "Invalid machineId: must be a UUID" });
  }
});

test("the factory is generic over the brand (serverId reuses the same parser)", () => {
  const { res } = fakeRes();
  const id = parseBrandedUuidFromBody("11111111-1111-4111-8111-111111111111", asServerId, "serverId", res);
  assert.equal(id, "11111111-1111-4111-8111-111111111111");
});
