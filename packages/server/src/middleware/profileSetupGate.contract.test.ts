import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

test("verified human business surfaces inherit the account-global profile setup gate", async () => {
  const [authSource, appSource, authRoutesSource] = await Promise.all([
    readFile(new URL("./auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/auth.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    authSource,
    /export async function requireVerified[\s\S]*await requireProfileSetupComplete\(req, res, next\);/,
  );

  for (const route of [
    "/api/servers",
    "/api/agents",
    "/api/tasks",
    "/api/attachments",
  ]) {
    const escaped = route.replaceAll("/", "\\/");
    assert.match(
      appSource,
      new RegExp(`app\\.use\\("${escaped}", requireAuth, requireVerified`),
      `${route} must remain behind requireVerified -> requireProfileSetupComplete`,
    );
  }

  assert.match(
    appSource,
    /app\.use\(\s*"\/api\/messages",\s*forwardAdmissionTraceMiddleware,\s*requireAuth,\s*markForwardAdmissionStage\("verified"\),\s*requireVerified,/,
    "/api/messages must observe Forward admission without bypassing requireAuth -> requireVerified -> requireProfileSetupComplete",
  );

  assert.match(
    appSource,
    /app\.use\(\s*"\/api\/channels",\s*inboxRouteBackpressureMiddleware,\s*requireAuth,\s*requireVerified,\s*requireServer,/,
    "/api/channels must admit before authentication and all DB-backed profile/server gates",
  );

  assert.match(
    authRoutesSource,
    /authRouter\.post\("\/accept-invite", requireAuth, requireProfileSetupComplete,/,
    "invite acceptance must fail before membership side effects",
  );
});
