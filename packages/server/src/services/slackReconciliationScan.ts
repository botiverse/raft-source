/** Opaque Slack pagination handle. Constructed only by the provider/DB parser. */
declare const slackHistoryCursorBrand: unique symbol;
export type SlackHistoryCursor = string & { readonly [slackHistoryCursorBrand]: true };

export type SlackReconciliationUnconfirmableReason =
  | "reconciliation_history_limited"
  | "reconciliation_bridge_metadata_missing"
  | "reconciliation_marker_unconfirmed";

export interface SlackReconciliationScan {
  schema: "slack-reconciliation-scan.v3";
  providerAttempt: number;
  scopeKey: string;
  oldest: string;
  latest: string;
  cursor: SlackHistoryCursor | null;
  match: { providerMessageId: string; providerThreadId: string | null } | null;
  metadataMissing: boolean;
  markerUnconfirmed: boolean;
  historyLimited: boolean;
  conclusion?: { reason: SlackReconciliationUnconfirmableReason; recheckAt: string };

}

const timestamp = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,20}\.[0-9]{1,20}$/.test(value);

export function parseSlackHistoryCursor(value: unknown): SlackHistoryCursor | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096
    ? value as SlackHistoryCursor : null;
}

/** Parse persisted scan metadata; it contains no message body or credential.
 * v2 matches did not verify the publishing app. Restart the scan while retaining
 * a previous match as uncertainty, never as acceptance or evidence of absence. */
export function parseSlackReconciliationScan(value: unknown): SlackReconciliationScan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.schema !== "slack-reconciliation-scan.v3" && row.schema !== "slack-reconciliation-scan.v2") || !Number.isSafeInteger(row.providerAttempt)
    || typeof row.providerAttempt !== "number" || row.providerAttempt < 1
    || typeof row.scopeKey !== "string" || !/^[0-9a-f]{64}$/.test(row.scopeKey)
    || !timestamp(row.oldest) || !timestamp(row.latest) || typeof row.metadataMissing !== "boolean" || (row.schema === "slack-reconciliation-scan.v3" && typeof row.markerUnconfirmed !== "boolean") || typeof row.historyLimited !== "boolean") return null;
  let conclusion: SlackReconciliationScan["conclusion"];
  if (row.conclusion !== undefined) {
    if (!row.conclusion || typeof row.conclusion !== "object" || Array.isArray(row.conclusion)) return null;
    const value = row.conclusion as Record<string, unknown>;
    if ((value.reason !== "reconciliation_history_limited" && value.reason !== "reconciliation_bridge_metadata_missing" && value.reason !== "reconciliation_marker_unconfirmed")
      || typeof value.recheckAt !== "string" || !Number.isFinite(Date.parse(value.recheckAt))) return null;
    conclusion = { reason: value.reason, recheckAt: value.recheckAt };
  }
  const cursor = row.cursor === null ? null : parseSlackHistoryCursor(row.cursor);
  if (row.cursor !== null && !cursor) return null;
  let match: SlackReconciliationScan["match"] = null;
  if (row.match !== null) {
    if (!row.match || typeof row.match !== "object" || Array.isArray(row.match)) return null;
    const receipt = row.match as Record<string, unknown>;
    if (!timestamp(receipt.providerMessageId) || !(receipt.providerThreadId === null || timestamp(receipt.providerThreadId))) return null;
    match = { providerMessageId: receipt.providerMessageId, providerThreadId: receipt.providerThreadId };
  }
  if (conclusion && (cursor !== null || match !== null)) return null;
  const legacy = row.schema === "slack-reconciliation-scan.v2";
  return { schema: "slack-reconciliation-scan.v3", providerAttempt: row.providerAttempt, scopeKey: row.scopeKey,
    oldest: row.oldest, latest: row.latest, cursor: legacy ? null : cursor, match: legacy ? null : match,
    metadataMissing: row.metadataMissing, markerUnconfirmed: legacy ? match !== null : row.markerUnconfirmed === true,
    historyLimited: row.historyLimited, ...(conclusion ? { conclusion } : {}) };
}
