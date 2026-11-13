// App text added to agent prompts needs an admin's confirmation (#proj-apps
// task #4). An app's name, description and When to use go into the system
// prompt of every agent on a Server that has it, so a published app's edit
// waits for Raft review, then for each Server's admins; until then agents keep
// the last confirmed text.
//
// The UI reads the API only through the readers below. The flag key
// (APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY) and the install card's bound text
// come from packages/shared; the REST shapes the server doesn't share are read
// here. The rendering is shared too: appPromptTextLines from packages/shared.

import type { ActionCardMetadata } from "@botiverse/raft-shared";

/** The three fields an app adds to agent prompts. Raw publisher text. */
export type AppPromptTextFields = {
  name: string;
  description: string | null;
  whenToUse: string | null;
};

export type AppPromptTextRevisionState = "active" | "pending_review" | "superseded" | "rejected";

/** A revision: `{ id, revision, state, name, description, when_to_use, created_at, reviewed_at, reject_reason }`. */
export type AppPromptTextRevision = AppPromptTextFields & {
  id: string;
  revision: number | null;
  state: AppPromptTextRevisionState;
  createdAt: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
};

const REVISION_STATES = new Set<AppPromptTextRevisionState>(["active", "pending_review", "superseded", "rejected"]);

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `{ name, description, when_to_use }` (API) → fields. */
function readFields(raw: unknown): AppPromptTextFields | null {
  if (!isRecord(raw)) return null;
  const name = stringOrNull(raw.name);
  if (name === null) return null;
  return {
    name,
    description: stringOrNull(raw.description),
    whenToUse: stringOrNull(raw.when_to_use !== undefined ? raw.when_to_use : raw.whenToUse),
  };
}

export function readAppPromptTextRevision(raw: unknown): AppPromptTextRevision | null {
  const fields = readFields(raw);
  if (!fields || !isRecord(raw)) return null;
  const id = stringOrNull(raw.id);
  if (!id) return null;
  const state = raw.state;
  return {
    ...fields,
    id,
    revision: typeof raw.revision === "number" ? raw.revision : null,
    state: typeof state === "string" && REVISION_STATES.has(state as AppPromptTextRevisionState)
      ? state as AppPromptTextRevisionState
      : "active",
    createdAt: stringOrNull(raw.created_at),
    reviewedAt: stringOrNull(raw.reviewed_at),
    rejectReason: stringOrNull(raw.reject_reason),
  };
}

// ── Install entry points ─────────────────────────────────────────────────

/**
 * Marketplace rows, `/oauth/clients/lookup` and the invite GET add only
 * `promptTextRevisionId`: their own name / description / whenToUse ARE that
 * revision (still the old text while an edit is in review). Null when the
 * server sent none (the flag off, or an older server).
 */
export function readPromptTextRevisionId(record: unknown): string | null {
  return isRecord(record) ? stringOrNull(record.promptTextRevisionId) : null;
}

/** The fields an install entry point shows: the record's own. */
export function installEntryPromptText(record: { name: string; description?: string | null; whenToUse?: string | null }): AppPromptTextFields {
  return { name: record.name, description: record.description ?? null, whenToUse: record.whenToUse ?? null };
}

/** Install entry points add this beside `expected_scopes` / `expected_groups`. */
export function expectedTextRevisionBody(revisionId: string | null | undefined) {
  return revisionId ? { expected_text_revision_id: revisionId } : {};
}

type InstallCardAction = Extract<ActionCardMetadata["action"], { type: "integration:install_marketplace_app" }>;

/**
 * The install card's bound text (shared action-card schema):
 * `installTextRevisionId`, written when the server prepared the card, and
 * `installText`, that revision's raw fields.
 */
export function readInstallCardPromptText(
  action: Partial<Pick<InstallCardAction, "installTextRevisionId" | "installText">>,
): { revisionId: string; fields: AppPromptTextFields } | null {
  const { installTextRevisionId: revisionId, installText } = action;
  if (!revisionId || !installText) return null;
  return {
    revisionId,
    fields: { name: installText.name, description: installText.description ?? null, whenToUse: installText.whenToUse ?? null },
  };
}

// ── Installed app (GET .../install/app-notifications) ────────────────────

export type InstalledAppPromptTextState = {
  /** What this Server confirmed; agents use it. Null before any confirmation. */
  confirmed: AppPromptTextRevision | null;
  /** The app's current text, which Approve Update would confirm. */
  current: AppPromptTextRevision | null;
  confirmationRequired: boolean;
};

/**
 * `prompt_text: { confirmed, current, confirmation_required }`. Separate from
 * `approval_required`, which stays about data permissions.
 */
export function readInstalledAppPromptTextState(state: unknown): InstalledAppPromptTextState | null {
  if (!isRecord(state) || !isRecord(state.prompt_text)) return null;
  const raw = state.prompt_text;
  return {
    confirmed: readAppPromptTextRevision(raw.confirmed),
    current: readAppPromptTextRevision(raw.current),
    confirmationRequired: raw.confirmation_required === true,
  };
}

// ── Developer and reviewer (GET /integrations/clients/:id/prompt-text) ────

export type ClientPromptTextState = {
  current: AppPromptTextRevision | null;
  /** The developer's edit while Raft reviews it. */
  pending: AppPromptTextRevision | null;
  /** The latest edit Raft rejected. */
  rejected: AppPromptTextRevision | null;
  localConfirmedRevisionId: string | null;
  canReview: boolean;
  /** A self-built app's current text that this (source) Server hasn't confirmed. */
  localConfirmationRequired: boolean;
};

export function clientPromptTextPath(clientId: string): string {
  return `/integrations/clients/${clientId}/prompt-text`;
}

export function readClientPromptTextState(data: unknown): ClientPromptTextState | null {
  if (!isRecord(data)) return null;
  const current = readAppPromptTextRevision(data.current);
  const localConfirmedRevisionId = stringOrNull(data.local_confirmed_revision_id);
  return {
    current,
    pending: readAppPromptTextRevision(data.pending),
    rejected: readAppPromptTextRevision(data.rejected),
    localConfirmedRevisionId,
    canReview: data.can_review === true,
    localConfirmationRequired: Boolean(current) && localConfirmedRevisionId !== current!.id,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────

type ApiErrorShape = {
  response?: {
    status?: number;
    data?: { code?: unknown; current_text_revision_id?: unknown; current_text?: unknown };
  };
} | null;

function responseOf(error: unknown) {
  return (error as ApiErrorShape)?.response;
}

/**
 * Install, grant and self-built confirm refuse a stale text with 409
 * APP_PERMISSIONS_CHANGED carrying `current_text_revision_id` and
 * `current_text`. Returns the app's current text when it moved past the
 * revision the page showed, so the page can show it in place; null for a
 * permissions-only change or any other error.
 */
export function appTextChangedCurrent(
  error: unknown,
  shownRevisionId: string | null | undefined,
): { revisionId: string; fields: AppPromptTextFields | null } | null {
  const response = responseOf(error);
  if (response?.status !== 409 || response.data?.code !== "APP_PERMISSIONS_CHANGED") return null;
  const revisionId = stringOrNull(response.data.current_text_revision_id);
  if (!revisionId || revisionId === shownRevisionId) return null;
  return { revisionId, fields: readFields(response.data.current_text) };
}

/** The review endpoint: the pending revision the reviewer saw was replaced. */
export function isPromptTextReviewStaleError(error: unknown): boolean {
  const response = responseOf(error);
  return response?.status === 409 && response.data?.code === "PROMPT_TEXT_REVIEW_STALE";
}

/** The review endpoint: nothing is pending any more. */
export function isPromptTextReviewGoneError(error: unknown): boolean {
  return responseOf(error)?.status === 404;
}
