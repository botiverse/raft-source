// One security-revoke cascade (a password change or reset, the account's
// retirement, an account deletion request, a device login's revoke link, or
// maintenance's hourly repair):
// what the revoked sessions approved through one-time grants
// (approverSessionGrants.ts) and what they issued themselves
// (webSessionIssuedKeys.ts), then one email per person for what this run
// revoked (securityRevokeNotice.ts); not for an account deletion request,
// whose own email (services/accountDeletion) says what was turned off, so the
// person gets one email, not two. One part failing doesn't stop the other or
// the email; the first error is thrown after both. Each run records one
// `security_revoke.cascade` trace event with what it revoked (counts only), so
// how often a password change or reset actually takes Computers and keys with
// it can be read from traces (#proj-o11y:#16).

import { currentDate } from "@botiverse/raft-shared";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { revokeWhatRevokedSessionsApproved, type ApproverSessionRevokeTrigger, type ApproverSessionScope } from "./approverSessionGrants";
import { SecurityRevokeTally, sendSecurityRevokeNotices } from "./securityRevokeNotice";
import { revokeWhatRevokedWebSessionsIssued } from "./webSessionIssuedKeys";

export async function runSecurityRevokeCascade(
  scope: ApproverSessionScope,
  trigger: ApproverSessionRevokeTrigger,
  now = currentDate(),
): Promise<void> {
  const tally = new SecurityRevokeTally();
  const failures: unknown[] = [];
  try {
    await revokeWhatRevokedSessionsApproved(scope, trigger, now, tally);
  } catch (err) {
    console.error(`[security-revoke] revoking what the sessions approved (${trigger}) failed:`, err);
    failures.push(err);
  }
  try {
    await revokeWhatRevokedWebSessionsIssued(scope, trigger, now, tally);
  } catch (err) {
    console.error(`[security-revoke] revoking what the sessions issued (${trigger}) failed:`, err);
    failures.push(err);
  }
  if (trigger !== "account_deletion_requested") await sendSecurityRevokeNotices(tally, trigger);
  recordTraceEvent("security_revoke.cascade", securityRevokeCascadeEventAttrs(tally, trigger, failures.length));
  if (failures.length > 0) throw failures[0];
}

/** The run's trace event attributes: the trigger and what it revoked, counts only. */
export function securityRevokeCascadeEventAttrs(
  tally: SecurityRevokeTally,
  trigger: ApproverSessionRevokeTrigger,
  failedParts: number,
): Record<string, string | number | boolean> {
  const totals = tally.totals();
  return {
    event_kind: "security_revoke_cascade",
    trigger,
    people: totals.people,
    computers: totals.computers,
    keys: totals.keys,
    servers: totals.servers,
    revoked_any: totals.computers + totals.keys > 0,
    failed_parts: failedParts,
  };
}
