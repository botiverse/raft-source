import { getDb } from "../../db/index";
import { sql } from "drizzle-orm";
import { SLACK_BOT_WAKE_INDEX } from "../../services/slackBotWakeIndexContract";
import { SLACK_INBOUND_HEAD_INDEX } from "../../services/slackVerifiedIngressIndexContract";
import { parseSlackIngressReleaseRecord } from "../../services/slackVerifiedIngressRolloutContracts";
import { applySlackVerifiedIngressDeployment } from "../../services/slackVerifiedIngressDeployment";
import { readSlackIngressRollout, setSlackIngressConsumption, withSlackIngressProtocol } from "../../services/slackVerifiedIngressRollout";

export const TEST_SLACK_RELEASE_RECORD = parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000001");

/** Small disposable fixtures build the same index; deployment uses the concurrent post-migration builder. */
export async function enableTestSlackIngress(): Promise<void> {
  await getDb().execute(sql.raw(SLACK_INBOUND_HEAD_INDEX.createSql.replace(" CONCURRENTLY", "")));
  const state = await readSlackIngressRollout(getDb());
  await setSlackIngressConsumption({ db: getDb(), enabled: true, expectedGeneration: state.generation,
    releaseRecord: TEST_SLACK_RELEASE_RECORD, now: new Date("2026-08-05T12:00:00Z") });
}

/** Seed legacy-shaped fixtures with a current writer, without leaking a session protocol setting. */
export async function writeSlackFixture<T>(run: () => PromiseLike<T>): Promise<T> {
  return withSlackIngressProtocol({ db: getDb(), purpose: "settle", run: async () => run() });
}

/** Isolated fixture for bot protocol 2; never run against a shared environment. */
export async function enableTestSlackBotProtocol(): Promise<void> {
  await getDb().execute(sql.raw(SLACK_BOT_WAKE_INDEX.createSql.replace(" CONCURRENTLY", "")));
  await applySlackVerifiedIngressDeployment({ db: getDb(), now: new Date("2026-08-05T12:00:00Z"),
    config: { generation: 1, enabled: true, releaseRecord: parseSlackIngressReleaseRecord("00000000-0000-4000-8000-000000000002"), minimumWriterProtocol: 2 } });
}
