import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Request, Response } from "express";
import { shouldRecordRaftdevActivity, raftdevActivityMiddleware } from "./raftdevActivity.js";

test("raftdev activity records real user API requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "raftdev-activity-"));
  const file = join(dir, "last-activity");
  const previous = process.env.SLOCKDEV_LAST_ACTIVITY_FILE;
  process.env.SLOCKDEV_LAST_ACTIVITY_FILE = file;
  try {
    raftdevActivityMiddleware(
      { method: "GET", path: "/api/channels" } as Request,
      {} as Response,
      () => {},
    );
    assert.match(readFileSync(file, "utf8"), /^\d+\n$/);
  } finally {
    if (previous === undefined) delete process.env.SLOCKDEV_LAST_ACTIVITY_FILE;
    else process.env.SLOCKDEV_LAST_ACTIVITY_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raftdev activity skips probes and internal background traffic", () => {
  assert.equal(shouldRecordRaftdevActivity("GET", "/health"), false);
  assert.equal(shouldRecordRaftdevActivity("GET", "/metrics"), false);
  assert.equal(shouldRecordRaftdevActivity("GET", "/internal/agent/agent-1/receive"), false);
  assert.equal(shouldRecordRaftdevActivity("OPTIONS", "/api/channels"), false);
  assert.equal(shouldRecordRaftdevActivity("POST", "/api/messages"), true);
});
