/** Read-only rollout status. Changes are applied from reviewed deployment configuration. */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema";
import { slackAttachmentPlanRollout } from "../src/db/schema";
import { isSlackAttachmentPlanningEnabled } from "../src/services/slackAttachmentFallbackProtocol";

if (process.argv.slice(2).some(value => value !== "status") || process.argv.slice(2).length > 1) {
  throw new Error("Usage: slack-attachment-plan-rollout.ts status (read-only)");
}
const connectionString = process.env.SLACK_ATTACHMENT_PLAN_CONTROL_DATABASE_URL;
if (!connectionString) throw new Error("SLACK_ATTACHMENT_PLAN_CONTROL_DATABASE_URL is required for status");
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const db = drizzle(pool, { schema });
  const [state] = await db.select().from(slackAttachmentPlanRollout)
    .where(eq(slackAttachmentPlanRollout.id, "slack-attachment-plan-v1"));
  console.log(JSON.stringify({ state: state ?? null, planningEnabled: await isSlackAttachmentPlanningEnabled(db) }));
} finally { await pool.end(); }
