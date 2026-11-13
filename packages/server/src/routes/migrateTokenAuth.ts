/**
 * A computer_migrate grant's `dvmt_*` token as the caller of the two routes
 * `raft-computer setup`'s legacy-daemon migration needs (device-auth design
 * v2, deviceLoginGrantService): GET /api/computer/legacy-machines and
 * POST /api/computer/adopt-legacy. Nothing else accepts it: every other route
 * reads a session (requireAuth), and a `dvmt_*` bearer is not one.
 *
 * With the token the request runs as the person who approved the grant, for
 * the server they picked only (the route checks `serverSlug` against it). The
 * token is not consumed here: the roster may be read more than once until
 * the grant expires; the adoption consumes it in its own transaction.
 */
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { refuse, type RefusalStatus } from "../lib/refusal";
import { findPendingAccountDeletion } from "../services/accountDeletion/requests";
import {
  findMigrateTokenGrant,
  looksLikeMigrateToken,
  type FindMigrateTokenGrantResult,
  type ServerTokenGrant,
} from "../services/deviceLoginGrantService";
import { getDb } from "../db/index";
import { addTraceEvent } from "../tracing/semanticTrace";

const migrateGrants = new WeakMap<Request, ServerTokenGrant>();

const MIGRATE_TOKEN_FAILURE: Record<Exclude<FindMigrateTokenGrantResult, { ok: true }>["error"], { status: RefusalStatus; error: string }> = {
  migrate_token_invalid: { status: 401, error: "This migrate token is not valid: approve moving the old daemon over again." },
  migrate_token_expired: { status: 410, error: "This migrate token has expired: approve moving the old daemon over again." },
  migrate_token_consumed: { status: 410, error: "This migrate token was already used to adopt a legacy machine." },
};

export function respondMigrateTokenFailure(res: Response, error: keyof typeof MIGRATE_TOKEN_FAILURE): void {
  const failure = MIGRATE_TOKEN_FAILURE[error];
  refuse(res, failure.status, { code: error, error: failure.error });
}

export function isMigrateTokenFailure(code: string): code is keyof typeof MIGRATE_TOKEN_FAILURE {
  return code in MIGRATE_TOKEN_FAILURE;
}

/** The migrate grant this request authenticated with, or null (a session). */
export function migrateGrantOf(req: Request): ServerTokenGrant | null {
  return migrateGrants.get(req) ?? null;
}

/**
 * A migrate token's server must be the one the request names: 403
 * `migrate_token_server_mismatch` otherwise (already answered when false).
 */
export function migrateGrantAllowsServer(res: Response, grant: ServerTokenGrant, serverSlug: unknown): boolean {
  if (serverSlug === grant.serverSlug) return true;
  addTraceEvent("auth.device.grant.migrate_rejected", { reason: "migrate_token_server_mismatch", grant_id: grant.id });
  refuse(res, 403, { code: "migrate_token_server_mismatch", error: "This migrate token is for another server: approve it for the server you name." });
  return false;
}

/** A `dvmt_*` migrate token, or else the person's session (requireAuth). */
export function migrateTokenOrUserAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!raw || !looksLikeMigrateToken(raw)) { requireAuth(req, res, next); return; }
  void (async () => {
    const found = await findMigrateTokenGrant(raw);
    if (!found.ok) {
      addTraceEvent("auth.device.grant.migrate_rejected", { reason: found.error });
      respondMigrateTokenFailure(res, found.error);
      return;
    }
    // An account scheduled for deletion moves nothing over: its security
    // revoke cascade expires the grant, refused here in case that has not
    // run yet (as for an attach token).
    const pending = await findPendingAccountDeletion(getDb(), found.grant.approverUserId);
    if (pending) {
      refuse(res, 403, {
        code: "account_deletion_pending",
        error: "This account is scheduled for deletion. Cancel the deletion to use it again.",
        details: { scheduledFor: pending.scheduledFor.toISOString() },
      });
      return;
    }
    migrateGrants.set(req, found.grant);
    next();
  })().catch(next);
}
