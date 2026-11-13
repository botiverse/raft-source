import assert from "node:assert/strict";
import { signToken, verifyToken } from "./auth";
import { HttpError } from "./http";

const SECRET = "auth-secret-for-tests";

async function refused(token: string): Promise<number | null> {
  try {
    await verifyToken(token, SECRET);
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
}

test("a token without a purpose verifies", async () => {
  const token = await signToken({ serverId: "s", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const claims = await verifyToken<{ serverId: string; exp: number }>(token, SECRET);
  assert.equal(claims.serverId, "s");
});

test("a correctly signed token carrying a purpose is refused (retired feedback report read token)", async () => {
  const token = await signToken(
    { purpose: "feedback_report_read", exp: Math.floor(Date.now() / 1000) + 60 },
    SECRET,
  );
  assert.equal(await refused(token), 401);
});

test("correctly signed non-object claims are refused", async () => {
  for (const payload of [[1, 2], "x" as unknown as object]) {
    const token = await signToken(payload, SECRET);
    assert.equal(await refused(token), 401);
  }
});
