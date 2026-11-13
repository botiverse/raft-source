import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/index";
import { slackVerifiedIngressRollout } from "../db/schema";
import { assertSlackIngressFenceInstalled, assertSlackIngressIndexReady, assertSlackBotWakeIndexReady } from "./slackVerifiedIngressRollout";
import { parseSlackIngressReleaseRecord, SLACK_VERIFIED_INGRESS_FENCE_KEY, SLACK_VERIFIED_INGRESS_PROTOCOL, SLACK_VERIFIED_INGRESS_BASE_PROTOCOL,
  type SlackIngressReleaseRecord } from "./slackVerifiedIngressRolloutContracts";

export type SlackVerifiedIngressDeployment =
  | { generation: number; enabled: false }
  | { generation: number; enabled: true; releaseRecord: SlackIngressReleaseRecord; minimumWriterProtocol?: 2 | 3 };

export const SLACK_VERIFIED_INGRESS_DEPLOYMENT_KEYS = ["SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED",
  "SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION", "SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD",
  "SLACK_BRIDGE_VERIFIED_INGRESS_MINIMUM_WRITER_PROTOCOL"] as const;

/** Deployment config, not a product feature flag; absent config changes nothing. */
export function parseSlackVerifiedIngressDeployment(env: NodeJS.ProcessEnv): SlackVerifiedIngressDeployment | undefined {
  const [enabled, generation, release, protocol] = SLACK_VERIFIED_INGRESS_DEPLOYMENT_KEYS.map(key => env[key]?.trim());
  if (!enabled && !generation && !release && !protocol) return undefined;
  if ((enabled !== "true" && enabled !== "false") || !/^[1-9][0-9]*$/u.test(generation ?? "")
    || Number(generation) > 2_147_483_647) throw new Error("Slack ingress deployment needs a positive generation and true/false");
  if (protocol && ((protocol !== "2" && protocol !== "3") || enabled !== "true")) throw new Error("Slack ingress protocol elevation requires enabled=true and protocol 2 or 3");
  if (enabled === "false") {
    return { generation: Number(generation), enabled: false };
  }
  if (!release) throw new Error("Slack ingress enablement requires a verified fleet release record");
  return { generation: Number(generation), enabled: true, releaseRecord: parseSlackIngressReleaseRecord(release),
    ...(protocol === "2" ? { minimumWriterProtocol: 2 as const } : protocol === "3" ? { minimumWriterProtocol: 3 as const } : {}) };
}

/** A newer reviewed config wins once. The protocol floor never moves backward. */
export async function applySlackVerifiedIngressDeployment(input: {
  db: Database; config: SlackVerifiedIngressDeployment; now: Date;
}): Promise<"applied" | "unchanged" | "older_config" | "conflict"> {
  const { db, config, now } = input;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(config.generation)
    || config.generation < 1 || config.generation > 2_147_483_647) throw new Error("Invalid Slack ingress deployment authority");
  if (config.enabled && parseSlackIngressReleaseRecord(config.releaseRecord) !== config.releaseRecord) {
    throw new Error("Invalid Slack ingress deployment release record");
  }
  const digest = createHash("sha256").update(JSON.stringify({ generation: config.generation, enabled: config.enabled,
    releaseRecord: config.enabled ? config.releaseRecord : null,
    ...(config.enabled && config.minimumWriterProtocol ? { minimumWriterProtocol: config.minimumWriterProtocol } : {}) })).digest("hex");
  // Routine restarts and stale-config replicas must not repeatedly drain the
  // inbox tables. A concurrent newer change is harmless here: workers always
  // read the canonical DB policy, never this process's cached config.
  const [observed] = await db.select().from(slackVerifiedIngressRollout)
    .where(eq(slackVerifiedIngressRollout.id, 1)).limit(1);
  if (!observed || observed.minimumWriterProtocol > SLACK_VERIFIED_INGRESS_PROTOCOL) throw new Error("Slack ingress rollout policy is unavailable");
  if (config.generation <= observed.configGeneration) {
    await assertSlackIngressFenceInstalled(db);
    return config.generation < observed.configGeneration ? "older_config"
      : observed.configDigest === digest ? "unchanged" : "conflict";
  }
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '1s', true)`);
    await tx.execute(sql`SELECT set_config('statement_timeout', '5s', true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SLACK_VERIFIED_INGRESS_FENCE_KEY.toString()}::bigint)`);
    // A sibling replica may have applied this generation while we waited for
    // the advisory lock. Recheck before taking disruptive table locks. This
    // read is deliberately not FOR UPDATE: an old writer can hold a table
    // lock while its fence requests a shared lock on the policy row.
    const [afterFence] = await tx.select().from(slackVerifiedIngressRollout)
      .where(eq(slackVerifiedIngressRollout.id, 1)).limit(1);
    if (!afterFence || afterFence.minimumWriterProtocol > SLACK_VERIFIED_INGRESS_PROTOCOL) throw new Error("Slack ingress rollout policy is unavailable");
    if (config.generation <= afterFence.configGeneration) {
      await assertSlackIngressFenceInstalled(tx);
      return config.generation < afterFence.configGeneration ? "older_config"
        : afterFence.configDigest === digest ? "unchanged" : "conflict";
    }
    await tx.execute(sql`LOCK TABLE external_inbound_events, slack_verified_ingress_events IN ACCESS EXCLUSIVE MODE`);
    const [current] = await tx.select().from(slackVerifiedIngressRollout)
      .where(eq(slackVerifiedIngressRollout.id, 1)).limit(1).for("update");
    if (!current || current.minimumWriterProtocol > SLACK_VERIFIED_INGRESS_PROTOCOL) throw new Error("Slack ingress rollout policy is unavailable");
    if (config.generation < current.configGeneration) return "older_config";
    if (config.generation === current.configGeneration) return current.configDigest === digest ? "unchanged" : "conflict";
    // Protocol 2 is a separately reviewed, one-way operation after normal W4
    // is already active; it may never be combined with first activation.
    if (config.enabled && config.minimumWriterProtocol === 2 && current.minimumWriterProtocol < 2
      && (current.minimumWriterProtocol !== SLACK_VERIFIED_INGRESS_BASE_PROTOCOL || !current.consumersEnabled)) {
      throw new Error("Slack bot protocol elevation requires active protocol-1 ingress");
    }
    if (config.enabled && config.minimumWriterProtocol === 2 && current.minimumWriterProtocol < 2
      && config.releaseRecord === current.releaseRecord) {
      throw new Error("Slack bot protocol elevation requires a new verified release record");
    }
    // Protocol 3 is a distinct irreversible transition, not initial activation
    // or a way to skip the protocol-2 observation period.
    if (config.enabled && config.minimumWriterProtocol === 3 && current.minimumWriterProtocol < 3
      && (current.minimumWriterProtocol !== 2 || !current.consumersEnabled)) {
      throw new Error("Slack bot protocol 3 requires active protocol-2 ingress");
    }
    if (config.enabled && config.minimumWriterProtocol === 3 && current.minimumWriterProtocol < 3
      && config.releaseRecord === current.releaseRecord) {
      throw new Error("Slack bot protocol 3 requires a new verified release record");
    }
    await assertSlackIngressFenceInstalled(tx);
    if (config.enabled) {
      await assertSlackIngressIndexReady(tx);
      if (config.minimumWriterProtocol === 2 || config.minimumWriterProtocol === 3) await assertSlackBotWakeIndexReady(tx);
    }
    await tx.update(slackVerifiedIngressRollout).set({
      minimumWriterProtocol: config.enabled ? Math.max(config.minimumWriterProtocol ?? SLACK_VERIFIED_INGRESS_BASE_PROTOCOL, current.minimumWriterProtocol) : current.minimumWriterProtocol,
      consumersEnabled: config.enabled, generation: current.generation + 1,
      configGeneration: config.generation, configDigest: digest,
      releaseRecord: config.enabled ? config.releaseRecord : current.releaseRecord, updatedAt: now,
    }).where(eq(slackVerifiedIngressRollout.id, 1));
    return "applied";
  });
}
