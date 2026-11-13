import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index";
import { slackAttachmentPlanRollout } from "../db/schema";
import { isSlackAttachmentPlanningEnabled } from "./slackAttachmentFallbackProtocol";

declare const fleetReleaseBrand: unique symbol;
export type SlackAttachmentPlanFleetRelease = string & { readonly [fleetReleaseBrand]: true };
declare const verifierBrand: unique symbol;
export type SlackAttachmentPlanVerifier = string & { readonly [verifierBrand]: true };
export type SlackAttachmentFallbackDeployment = Readonly<
  | { generation: number; enabled: true; verifiedRelease: SlackAttachmentPlanFleetRelease; verifiedBy: SlackAttachmentPlanVerifier }
  | { generation: number; enabled: false }
>;

export const SLACK_ATTACHMENT_FALLBACK_ENV_KEYS = [
  "SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED",
  "SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION",
  "SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE",
  "SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY",
] as const;

/** Deployment configuration only; no client or product feature-flag input. */
export function parseSlackAttachmentFallbackDeployment(env: NodeJS.ProcessEnv): SlackAttachmentFallbackDeployment | undefined {
  const [enabled, generation, release, verifier] = SLACK_ATTACHMENT_FALLBACK_ENV_KEYS.map(key => env[key]?.trim());
  if (!enabled && !generation && !release && !verifier) return undefined;
  if (!/^[1-9][0-9]*$/.test(generation ?? "") || Number(generation) > 2_147_483_647
    || (enabled !== "true" && enabled !== "false")) {
    throw new Error("Slack attachment rollout requires true/false and a positive configuration generation");
  }
  if (enabled === "false") return { enabled: false, generation: Number(generation) };
  if (!release || !/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("Slack attachment rollout enablement requires a verified full-fleet release SHA");
  }
  if (!verifier || verifier.length > 160 || /[\p{Cc}\p{Cf}]/u.test(verifier)) {
    throw new Error("Slack attachment rollout enablement requires the accountable fleet verifier");
  }
  return { enabled: true, generation: Number(generation), verifiedRelease: release as SlackAttachmentPlanFleetRelease,
    verifiedBy: verifier as SlackAttachmentPlanVerifier };
}

/** Higher configuration generations win across rolling/restarted instances. */
export async function applySlackAttachmentFallbackDeployment(input: {
  db: Database; config: SlackAttachmentFallbackDeployment; now: Date;
}): Promise<"applied" | "unchanged" | "older_config" | "conflict"> {
  const { db, config, now } = input;
  if (!Number.isFinite(now.getTime())) throw new Error("Slack attachment deployment clock is invalid");
  const digest = createHash("sha256").update(JSON.stringify({ generation: config.generation,
    enabled: config.enabled, verifiedRelease: config.enabled ? config.verifiedRelease : null, verifiedBy: config.enabled ? config.verifiedBy : null })).digest("hex");
  return db.transaction(async tx => {
    const id = "slack-attachment-plan-v1";
    await tx.insert(slackAttachmentPlanRollout).values({ id }).onConflictDoNothing();
    const [current] = await tx.select().from(slackAttachmentPlanRollout)
      .where(eq(slackAttachmentPlanRollout.id, id)).for("update");
    if (!current) throw new Error("Slack attachment rollout control is unavailable");
    if (config.generation < current.configGeneration) {
      console.warn("[SlackBridge] older attachment deployment configuration ignored", {
        requestedGeneration: config.generation, currentGeneration: current.configGeneration,
      });
      return "older_config";
    }
    if (config.generation === current.configGeneration) return current.configDigest === digest ? "unchanged" : "conflict";
    await tx.update(slackAttachmentPlanRollout).set({ enabled: config.enabled,
      configGeneration: config.generation, configDigest: digest, updatedAt: now,
      ...(config.enabled ? { minimumWriterVersion: 1, verifiedRelease: config.verifiedRelease,
        verifiedBy: config.verifiedBy, verifiedAt: now } : {}),
    }).where(eq(slackAttachmentPlanRollout.id, id));
    if (config.enabled && !await isSlackAttachmentPlanningEnabled(tx)) {
      throw new Error("Slack attachment rollout database protocol is not installed and enabled");
    }
    return "applied";
  });
}
