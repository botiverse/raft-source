import assert from "node:assert/strict";
import { test } from "vitest";
import { dbTest } from "../test/integration/dbTest.js";
import { requireFlexAuth, respondInvalidOrExpiredToken, signAccessToken } from "./auth.js";

dbTest("requireFlexAuth accepts access token from query string fallback", async ({ seed }) => {
  process.env.JWT_SECRET = "test-secret";

  const human = await seed.human();
  const token = signAccessToken(human.id);
  const req: any = {
    headers: {},
    query: { token },
  };

  let statusCode: number | null = null;
  let jsonBody: unknown = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  };

  let nextCalled = false;
  await requireFlexAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.userId, human.id);
  assert.equal(statusCode, null);
  assert.equal(jsonBody, null);
});

test("respondInvalidOrExpiredToken standardizes phantom-user auth failures as 401", () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  respondInvalidOrExpiredToken(res as any);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid or expired token", code: "auth_required" });
});
