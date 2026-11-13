import type pg from "pg";

export { SLACK_INBOUND_HEAD_INDEX } from "../src/services/slackVerifiedIngressIndexContract";

export async function hasSlackVerifiedIngressSchema(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.slack_verified_ingress_partitions') IS NOT NULL AS exists",
  );
  return result.rows[0]?.exists === true;
}
