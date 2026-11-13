import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import type { AppPromptText } from "./appPromptTextService";

/**
 * The login scopes and data groups an admin was shown when installing an app
 * or approving its update. The server records
 * exactly this set, and only when it still equals the app's declaration;
 * otherwise the admin reloads and confirms what they now see.
 */
/** Whether an installed App has added permissions this Server has not approved. */
export function hasUnapprovedAppPermissions(
  requested: { scopes: readonly string[]; groups: readonly string[] },
  approved: { scopes: readonly string[]; groups: readonly string[] },
): boolean {
  return requested.scopes.some((scope) => !approved.scopes.includes(scope))
    || requested.groups.some((group) => !approved.groups.includes(group));
}

export type AppPermissionSet = {
  scopes: string[];
  groups: string[];
};

/**
 * What the admin was shown, plus the prompt-text revision they read (task #4).
 * `textRevisionId` is null when the client did not send one: allowed only
 * while app_prompt_text_consent is off for the installing Server.
 */
export type ExpectedAppPermissions = AppPermissionSet & { textRevisionId?: string | null };

/** The app's current declaration, with its current prompt text when known. */
export type CurrentAppPermissions = AppPermissionSet & {
  textRevisionId?: string;
  text?: AppPromptText;
};

export const APP_PERMISSIONS_CHANGED = "APP_PERMISSIONS_CHANGED";
export const EXPECTED_PERMISSIONS_REQUIRED = "EXPECTED_PERMISSIONS_REQUIRED";

export class AppPermissionsChangedError extends Error {
  constructor(readonly current: CurrentAppPermissions) {
    super("The app's permissions changed after they were shown. Review the current permissions and confirm again.");
    this.name = "AppPermissionsChangedError";
  }
}

/** The request left out what the admin was shown; only a reload fixes it. */
export class ExpectedPermissionsRequiredError extends Error {
  constructor() {
    super("Send expected_scopes, expected_groups and expected_text_revision_id as shown to the admin. Reload the page and try again.");
    this.name = "ExpectedPermissionsRequiredError";
  }
}

export function currentAppPermissionSet(client: {
  allowedScopes: readonly string[] | null;
  outboundCurrentGroups: readonly string[];
}): AppPermissionSet {
  return {
    scopes: effectiveAllowedOAuthScopes(client.allowedScopes),
    groups: [...client.outboundCurrentGroups],
  };
}

function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 64) return null;
  if (!raw.every((value) => typeof value === "string" && value.length > 0 && value.length <= 120)) return null;
  return raw as string[];
}

const REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `{ expected_scopes, expected_groups, expected_text_revision_id? }` from a
 * request body, or null when either set is missing or malformed. A malformed
 * text revision id also returns null; an absent one is `textRevisionId: null`.
 */
export function parseExpectedAppPermissions(body: unknown): ExpectedAppPermissions | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const scopes = parseStringList(record.expected_scopes);
  const groups = parseStringList(record.expected_groups);
  if (!scopes || !groups) return null;
  const rawText = record.expected_text_revision_id;
  if (rawText === undefined || rawText === null) return { scopes, groups, textRevisionId: null };
  if (typeof rawText !== "string" || !REVISION_ID.test(rawText)) return null;
  return { scopes, groups, textRevisionId: rawText };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

/**
 * Only an exact match passes: an added or a removed scope or group both
 * reject, and so does a prompt-text revision other than the current one.
 * `requireText` (the installing Server has app_prompt_text_consent on) makes
 * a missing text revision a 400; a card, which can't be re-shown, passes
 * `missingTextIsChange` to turn it into the 409 instead.
 */
export function assertAppPermissionsMatch(
  expected: ExpectedAppPermissions,
  current: CurrentAppPermissions,
  options: { requireText?: boolean; missingTextIsChange?: boolean } = {},
): void {
  if (!sameStringSet(expected.scopes, current.scopes) || !sameStringSet(expected.groups, current.groups)) {
    throw new AppPermissionsChangedError(current);
  }
  const expectedText = expected.textRevisionId ?? null;
  if (expectedText === null) {
    if (!options.requireText) return;
    if (options.missingTextIsChange) throw new AppPermissionsChangedError(current);
    throw new ExpectedPermissionsRequiredError();
  }
  if (current.textRevisionId !== undefined && expectedText !== current.textRevisionId) {
    throw new AppPermissionsChangedError(current);
  }
}
