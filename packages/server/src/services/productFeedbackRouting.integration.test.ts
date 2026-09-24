import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { productFeedbackReporterId } from "./productFeedbackService.js";
import {
  ensureProductFeedbackRouteBinding,
  ProductFeedbackRouteBindingError,
  resetProductFeedbackRouteBindingCacheForTest,
} from "./productFeedbackRouteBindingService.js";


const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "22222222-2222-4222-8222-222222222223";
const ROOT = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex").toString("base64url");
const REPORTER_SECRET = "reporter-id-secret-for-test";
const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example",
  HANDS_FEEDBACK_APP_ID: APP_ID,
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "conversation-token",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "revision-1",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: INTEGRATION_ID,
  HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
  HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: ROOT,
  HANDS_FEEDBACK_REPORTER_ID_SECRET: REPORTER_SECRET,
} as NodeJS.ProcessEnv;

afterEach(async () => {
  resetProductFeedbackRouteBindingCacheForTest();
  await closeTestDatabase();
});

async function seed(): Promise<void> {
  await openTestDatabase("pglite://");
  await getDb().insert(users).values({
    id: USER_ID,
    email: "route-user@example.com",
    name: "route_user",
    passwordHash: "test",
    emailVerified: true,
  });
}

test("route binding pins the root, binds before upstream work, and caches only exact success", async () => {
  await seed();
  let calls = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.match(String(sent.route_subject), /^rfr_v1_/);
    assert.equal(new Headers(init?.headers).get("X-Hands-Reporter-Id"), productFeedbackReporterId(USER_ID, REPORTER_SECRET));
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  };
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 1);

  resetProductFeedbackRouteBindingCacheForTest();
  const swapped = { ...ENV, HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 9).toString("base64url") };
  await assert.rejects(
    ensureProductFeedbackRouteBinding({ userId: USER_ID, env: swapped, fetchImpl }),
    ProductFeedbackRouteBindingError,
  );
  assert.equal(calls, 1, "root swap must fail before Hands traffic");
});
