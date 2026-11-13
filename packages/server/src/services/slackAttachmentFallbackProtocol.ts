import { eq, sql } from "drizzle-orm";
import type { DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { slackAttachmentPlanRollout, SLACK_ATTACHMENT_FALLBACK_MARKER } from "../db/schema";

export { SLACK_ATTACHMENT_FALLBACK_MARKER } from "../db/schema";
export function renderSlackAttachmentFallback(text: string): string {
  return text ? `${text}\n\n${SLACK_ATTACHMENT_FALLBACK_MARKER}` : SLACK_ATTACHMENT_FALLBACK_MARKER;
}

/** Transaction-local compatibility marker, not an authorization credential. */
export async function markSlackAttachmentPlanWriter(tx: DatabaseExecutor): Promise<void> {
  await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
}

/** Missing row means disabled. Existing plans remain readable after pausing new plans. */
export async function isSlackAttachmentPlanningEnabled(tx: DatabaseExecutor, lock = false): Promise<boolean> {
  const query = tx.select().from(slackAttachmentPlanRollout)
    .where(eq(slackAttachmentPlanRollout.id, "slack-attachment-plan-v1"));
  const [state] = await (lock ? query.for("share") : query).limit(1);
  if (!state?.enabled || state.minimumWriterVersion !== 1 || !state.verifiedAt
    || !state.verifiedRelease || !/^[0-9a-f]{40}$/.test(state.verifiedRelease) || !state.verifiedBy) return false;
  const result = await tx.execute(sql`select count(*)::int as n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and t.tgenabled = 'O' and ns.nspname = 'public'
      and ((t.tgname = 'slack_attachment_plan_write_fence' and c.relname = 'external_outbound_deliveries'
        and p.proname = 'slack_attachment_plan_write_fence')
      or (t.tgname = 'slack_attachment_plan_job_write_fence' and c.relname = 'external_attachment_transfer_jobs'
        and p.proname = 'slack_attachment_plan_job_write_fence')
      or (t.tgname = 'slack_attachment_plan_immutable' and c.relname = 'slack_attachment_fallback_plans'
        and p.proname = 'slack_attachment_plan_immutable')
      or (t.tgname = 'slack_attachment_plan_rollback_floor' and c.relname = 'slack_attachment_plan_rollout'
        and p.proname = 'slack_attachment_plan_rollback_floor'))`);
  return Number((result.rows[0] as { n?: number } | undefined)?.n) === 4;
}

export async function assertSlackAttachmentPlanningEnabled(tx: DatabaseTransaction): Promise<boolean> {
  return isSlackAttachmentPlanningEnabled(tx, true);
}
