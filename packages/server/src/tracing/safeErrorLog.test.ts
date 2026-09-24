import assert from "node:assert/strict";
import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import { test } from "vitest";
import { serializeErrorForLog } from "./safeErrorLog.js";

test("real Drizzle query errors cannot put bound message content in console output", () => {
  const secret = "private-message-body-audit-sentinel";
  const driver = Object.assign(new Error(`Bad row: ${secret}`), { detail: secret });
  const queryError = new DrizzleQueryError("insert into messages(content) values ($1)", [secret], driver);
  assert.ok(inspect(queryError).includes(secret), "failure injection must actually carry the private content");
  for (const error of [queryError, new Error("send failed", { cause: queryError })]) {
    const output = inspect(serializeErrorForLog(error));
    assert.ok(!output.includes(secret));
    assert.match(output, /Database query failed/);
  }
});
