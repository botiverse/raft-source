#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createPool } from "./channels-task-conversation-indexes";
import { readSlackIngressRollout } from "../src/services/slackVerifiedIngressRollout";
import { SlackIngressRolloutUnavailable } from "../src/services/slackVerifiedIngressRolloutContracts";

/** This command is read-only. Use reviewed deployment configuration to change policy. */
export function parseSlackIngressOperatorRequest(args: readonly string[]): { action: "status" } {
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) return { action: "status" };
  throw new Error("Slack ingress rollout changes require reviewed deployment configuration");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: slack-ingress-rollout.ts [status]
Read-only status. DATABASE_URL selects the database; it is never printed.
Change the consumer state through reviewed deployment configuration after full-fleet verification.
Pausing retains raw receipt custody and the sticky writer protocol floor.`);
    return;
  }
  parseSlackIngressOperatorRequest(args);
  const pool = createPool();
  try {
    const db = drizzle(pool, { schema });
    const state = await readSlackIngressRollout(db);
    const [config] = await db.select({ configGeneration: schema.slackVerifiedIngressRollout.configGeneration,
      releaseRecord: schema.slackVerifiedIngressRollout.releaseRecord }).from(schema.slackVerifiedIngressRollout)
      .where(eq(schema.slackVerifiedIngressRollout.id, 1)).limit(1);
    if (!config) throw new Error("Slack ingress policy is missing");
    // Historical terminal rows cannot block new work. Report their aggregate
    // before cutover; do not erase or claim to reconstruct old lost payloads.
    const legacy = await db.execute<{ status: string; count: number }>(sql`
      SELECT e.status, count(*)::integer AS count FROM external_inbound_events e
      WHERE e.provider = 'slack' AND e.status IN ('dead', 'quarantined', 'revoked')
        AND NOT EXISTS (SELECT 1 FROM slack_verified_ingress_events r
          WHERE r.app_registration_id = e.app_registration_id AND r.provider_event_id = e.provider_event_id)
      GROUP BY e.status ORDER BY e.status`);
    console.log(JSON.stringify({ ...state, ...config, legacyTerminal: legacy.rows }));
  }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof SlackIngressRolloutUnavailable
      ? `Slack ingress rollout refused: ${error.reason}` : "Slack ingress rollout failed; check configuration and current generation");
    process.exitCode = 1;
  });
}
