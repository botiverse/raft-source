// Marketplace review decisions for tests that need one made. Raft has no
// review routes (#proj-apps task #19): App Admin decides every publish,
// offline, card URL and permission update review through its gated
// app_admin_* entries. These call the decision bodies behind those entries
// directly, as the database owner, so a test needs no Botiverse owner or
// admin; the gate has its own tests (marketplaceReviewDecisions.db.test.ts).
// Nothing else follows a decision, as nothing follows App Admin's: no socket
// event, no credential revocation signal, no permission-update ping.

import { eq, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthClients } from "../db/schema";

type ReviewDecision = "approve" | "reject";

async function decisionResult<T>(db: DatabaseExecutor, query: ReturnType<typeof sql>): Promise<T> {
  const { rows } = await db.execute<{ result: T }>(query);
  return rows[0]!.result;
}

/** What public.marketplace_decide_publish_review returns (docs/raft-app/README.md#marketplace-review-decision). */
export type PublishReviewResult = {
  clientId: string;
  previousStatus: string;
  status: string;
  removedBots: Array<{ agentId: string; serverId: string }>;
};

/**
 * Decides the App's open publish or offline request as a human reviewer:
 * approve publishes a publish request and takes an offline request offline;
 * reject keeps the App as it was. Resolves with the function's result and the
 * App's row afterwards; a refusal rejects with its SQLSTATE (reviewRefusalCode).
 */
export async function decidePublishReview(input: {
  clientId: string;
  reviewerUserId: string;
  decision: ReviewDecision;
  reason?: string | null;
}, db: DatabaseExecutor = getDb()) {
  const [current] = await db.select({ publishStatus: oauthClients.publishStatus })
    .from(oauthClients).where(eq(oauthClients.id, input.clientId));
  const result = await decisionResult<PublishReviewResult>(db, sql`SELECT public.marketplace_decide_publish_review(
    ${input.clientId}::uuid, ${input.decision}::text, ${current?.publishStatus ?? null}::text,
    'human'::text, ${input.reviewerUserId}::uuid, ${input.reason ?? null}::text
  ) AS result`);
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, input.clientId));
  return { ...result, client: client! };
}

/**
 * Approves the App's pending permission update (public.marketplace_approve_permission_review).
 * Without expectedRevisionId it approves whatever is pending.
 */
export async function approvePermissionReview(input: {
  clientId: string;
  reviewerUserId: string;
  expectedRevisionId?: string | null;
}, db: DatabaseExecutor = getDb()) {
  return decisionResult<{ revisionId: string; revision: number; state: string; syncedInstallCount: number; revokedTokenCount: number }>(
    db,
    sql`SELECT public.marketplace_approve_permission_review(
      ${input.clientId}::uuid, ${input.expectedRevisionId ?? null}::uuid, ${input.reviewerUserId}::uuid
    ) AS result`,
  );
}

/** Approves or rejects the App's pending card URL (public.marketplace_decide_action_endpoint_review). */
export async function decideActionEndpointReview(input: {
  clientId: string;
  reviewerUserId: string;
  decision: ReviewDecision;
  expectedActionEndpoint: string;
  reason?: string | null;
}, db: DatabaseExecutor = getDb()) {
  return decisionResult<{ decision: ReviewDecision; actionEndpoint: string | null; revision: string }>(
    db,
    sql`SELECT public.marketplace_decide_action_endpoint_review(
      ${input.clientId}::uuid, ${input.decision}::text, ${input.expectedActionEndpoint}::text,
      ${input.reviewerUserId}::uuid, ${input.reason ?? null}::text
    ) AS result`,
  );
}

/** The SQLSTATE a review decision function refused with (RVWnn), or null for any other error. */
export function reviewRefusalCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return /^RVW\d\d$/.test(code) ? code : null;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
