// `paywall_hit` from a route, where the server refuses (or cuts) something for
// a person (or, for an app's write, an agent) because of the server's plan
// (#proj-analytics:8fc671a3; Nova owns the registry). recordPaywallHit keeps
// it to once per person, server, gate (and via) and day, and never fails the
// request.
import type { Request } from "express";
import { asServerId, type PaywallGate, type PaywallLimitSide } from "@botiverse/raft-shared";
import type { AppPaywallHit } from "../platform/apps";
import { AttributedJointChannelLimitError, ExternalChannelLimitError } from "../services/externalChannelLimitService";
import { getServerPlan } from "../services/planService";
import { getProductEventSink } from "../services/productEventIngest";
import { recordPaywallHit, type PaywallHitUsage } from "../services/serverProductEvents";
import { isMember } from "../services/serverService";

/** `usage`: a monthly-quota refusal's numbers (the bytes asked for, the month's used bytes). */
export function notePaywallHit(req: Request, gate: PaywallGate, usage?: PaywallHitUsage): void {
  if (!req.userId || !req.serverId) return;
  void recordPaywallHit(getProductEventSink(req.app), {
    gate,
    userId: req.userId,
    serverId: asServerId(req.serverId),
    ...(usage ? { usage } : {}),
  });
}

/**
 * For a refusal that is a paywall only on Free (a file over the per-file
 * limit: Pro's own cap is not an upgrade prompt). Reads the plan, so call it
 * on the refusal path only, without awaiting.
 */
export async function noteFreePlanPaywallHit(req: Request, gate: PaywallGate): Promise<void> {
  if (!req.userId || !req.serverId) return;
  try {
    if (await getServerPlan(req.serverId) === "free") notePaywallHit(req, gate);
  } catch {
    // analytics never fails the request
  }
}

/**
 * An app's refusal that is a paywall (AppError.paywallHit: today the monthly
 * file upload quota of an Artifacts write), as core writes the answer: a
 * person's (`userId`) or an agent's (null: no person). A paywall on Free
 * only, as noteFreePlanPaywallHit and the upload sessions decide: the plan is
 * the one the quota read, so nothing more is read here (an AppSumo limit is
 * the Pro plan's, not an upgrade prompt).
 */
export function noteAppPaywallHit(req: Request, hit: AppPaywallHit | undefined, userId: string | null): void {
  if (!hit || hit.plan !== "free") return;
  void recordPaywallHit(getProductEventSink(req.app), {
    gate: hit.gate,
    userId,
    serverId: hit.serverId,
    via: hit.via,
    usage: { requestedBytes: hit.requestedBytes, monthUsedBytes: hit.monthUsedBytes },
  });
}

/**
 * The paywall a limit refusal that names whose limit it is stands for, and
 * the server it is counted for: the Free plan's one external channel
 * (`free_external_limit`), or a joint's Free-server cap refusing an external
 * invite's connection. Null for a refusal that is no plan's (a full channel),
 * for one that names no server (a connecting server not created yet) and for
 * anything else. A joint's hosting limits are not counted from here (the
 * host's own routes do, sendJointLimitError).
 */
function limitRefusalPaywall(err: unknown): { gate: PaywallGate; serverId: string; limitSide?: PaywallLimitSide } | null {
  if (err instanceof ExternalChannelLimitError) {
    return err.code === "free_external_limit" ? { gate: "external_channel_free_limit", serverId: err.limitServerId, limitSide: err.limitSide } : null;
  }
  if (err instanceof AttributedJointChannelLimitError && err.code === "joint_free_server_limit" && err.limitServerId) {
    return { gate: "joint_channel_free_cap", serverId: err.limitServerId };
  }
  return null;
}

/**
 * `paywall_hit` for a limit refusal between two servers (#wg-rbac:#60; Nova's
 * contract). Counted for the server whose limit it is (the refusal's
 * `limitServerId`, which need not be the request's server and on the invite
 * routes is the only one known), and only when the person refused is a member
 * of that server: someone stopped by another organisation's limit records
 * nothing, and the other side's server is never written. An agent's refusal
 * (no `req.userId`) records nothing, as notePaywallHit.
 */
export function noteLimitPaywallHit(req: Request, err: unknown): void {
  const hit = limitRefusalPaywall(err);
  const userId = req.userId;
  if (!hit || !userId) return;
  void (async () => {
    try {
      if (!await isMember(hit.serverId, userId)) return;
      await recordPaywallHit(getProductEventSink(req.app), {
        gate: hit.gate,
        userId,
        serverId: asServerId(hit.serverId),
        ...(hit.limitSide ? { limitSide: hit.limitSide } : {}),
      });
    } catch {
      // analytics never fails the request
    }
  })();
}
