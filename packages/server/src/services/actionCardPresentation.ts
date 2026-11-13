// `presentation` on an action card's metadata: the legacy fields
// (buildActionCardPresentation, unchanged) plus `card`, the card as data
// (`action-card.v1`, built by @botiverse/raft-shared's actionCardSpecBuilder).
//
// The server always builds the card and does not read the `action_card_spec`
// flag. The web renders every card from its spec; the App and older desktop
// builds ask that flag whether to, so its row stays on for them. Building
// never breaks a write: a card the builder or the emit parse refuses is left
// out (logged once per type) and the legacy fields go alone, which every
// client already renders.
//
// Agents never read `card` (spec §3.2): it is copy for human clients, every
// agent-facing message view drops it (withoutAgentHiddenActionCardSpec).
//
// A form card (a type with a form handler, actionCardForms.ts) carries the
// handler's forms, its button opens the first one (shared
// withActionCardForms, the same assembly measureQuestionCard measures), and its legacy fields
// refuse a generic approve (genericApprovalAllowed: false, plus a note), so a
// client that does not know forms never executes it without its values. A
// type that also completes by its own path (completesWithoutForm) keeps its
// own card when its forms do not fit.

import {
  actionCardSpecNames,
  actionCardSpecWithoutComputerNames,
  buildActionCardPresentation,
  buildActionCardSpec,
  buildParsedActionCardSpec,
  type ActionCardPresentation,
  type ActionCardResult,
  type ActionCardSpecBuildContext,
  type ActionCardSpecCard,
  type ActionCardSpecNames,
  type StoredActionCardAction,
  withActionCardForms,
} from "@botiverse/raft-shared";
import { ACTION_CARD_FORM_LEGACY_WARNING, actionCardFormHandlerFor } from "./actionCardForms";

type Builder = (action: StoredActionCardAction, ctx: ActionCardSpecBuildContext) => ActionCardSpecCard;
let builderForTest: Builder | null = null;

/** Replace the card builder (null restores it), e.g. with one that throws. Test only. */
export function setActionCardSpecBuilderForTest(builder: Builder | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("action-card builder hooks are test-only");
  builderForTest = builder;
}

const loggedTypes = new Set<string>();
const loggedFormlessTypes = new Set<string>();

function logLeftOut(logged: Set<string>, what: string, type: string, outcome: { issues: { path: (string | number)[]; message: string }[]; error: unknown }): void {
  if (logged.has(type)) return;
  logged.add(type);
  console.warn(`[actionCards] ${what} left out`, {
    type,
    // Paths and schema messages only: never the card's text.
    issues: outcome.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    error: outcome.error instanceof Error ? outcome.error.message : outcome.error ? String(outcome.error) : undefined,
  });
}

/** The card for `action`, as the emit parse returns it; null (logged once per type) when it cannot be built. */
export function actionCardSpecFor(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext = {}): ActionCardSpecCard | null {
  const build: Builder = builderForTest ?? buildActionCardSpec;
  // Form handlers: agent types and server-built ones (a person's seats:add has none).
  const handler = actionCardFormHandlerFor(action?.type ?? "");
  const outcome = buildParsedActionCardSpec(action, ctx, handler
    ? (built, builtCtx) => withActionCardForms(build(built, builtCtx), handler.buildForm(built, builtCtx))
    : build);
  if (outcome.ok) return outcome.card;
  const type = typeof action?.type === "string" ? action.type : "unknown";
  if (handler?.completesWithoutForm) {
    // The type's own card, whose button completes it by the type's own path
    // (feedback:submit: the dialog). Its forms are left out: a submission is
    // then refused as naming no form the card has.
    const formless = buildParsedActionCardSpec(action, ctx, build);
    if (formless.ok) {
      logLeftOut(loggedFormlessTypes, "presentation.card forms", type, outcome);
      return formless.card;
    }
  }
  logLeftOut(loggedTypes, "presentation.card", type, outcome);
  return null;
}

/** The presentation to write with a card's metadata: the legacy fields, and `card` when it builds. */
export function actionCardPresentationFor(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext = {}): ActionCardPresentation {
  const legacy = buildActionCardPresentation(action);
  const presentation = actionCardFormHandlerFor(action.type)
    ? { ...legacy, genericApprovalAllowed: false, warning: legacy.warning ? `${legacy.warning} ${ACTION_CARD_FORM_LEGACY_WARNING}` : ACTION_CARD_FORM_LEGACY_WARNING }
    : legacy;
  const card = actionCardSpecFor(action, ctx);
  return card ? { ...presentation, card } : presentation;
}

/** The names a stored presentation's card shows, for a card rebuilt on a state change. */
export function storedActionCardSpecNames(presentation: unknown): ActionCardSpecNames {
  const card = presentation && typeof presentation === "object" ? (presentation as { card?: unknown }).card : undefined;
  return card ? actionCardSpecNames(card) : {};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Action-card metadata as read from storage, with `presentation.card` built
 * when the card was stored without one (before cards carried it). Pure: the
 * names are short ids and the server name is the one stored on the card.
 *
 * A card stored with no presentation at all (May to July 2026: 12k cards in
 * production, #proj-apps:#40) gets the whole envelope, the legacy fields and
 * the card together, as a card written today has, or nothing: half an
 * envelope would break older clients, which read the legacy fields. Without
 * this, those cards would draw view only: the web runs a card only from its
 * spec.
 *
 * A card with a presentation.card included is served with no computer's
 * name in it (actionCardSpecWithoutComputerNames): cards stored before cards
 * stopped writing them keep the name in their row, which this never
 * changes (no backfill; Tenny, #14234). Every exit that serves a card to a
 * client goes through here: the message reads (enrichWithSenderNames: a
 * channel, a thread, around a message, by activity, sync, by ids, and the
 * socket payloads built from them) and the card routes' answers.
 */
export function withStoredActionCardSpec<T>(metadata: T): T {
  if (!isRecord(metadata) || metadata.kind !== "action-card") return metadata;
  const presentation = metadata.presentation;
  if (isRecord(presentation) && presentation.card !== undefined) {
    const card = actionCardSpecWithoutComputerNames(presentation.card);
    return card === presentation.card ? metadata : { ...metadata, presentation: { ...presentation, card } };
  }
  const action = metadata.action;
  if (!isRecord(action) || typeof action.type !== "string") return metadata;
  const ctx: ActionCardSpecBuildContext = {
    result: (isRecord(metadata.result) ? metadata.result : null) as ActionCardResult | null,
    ...(typeof metadata.targetServerName === "string" ? { serverName: metadata.targetServerName } : {}),
    // A person's card names who asked (seats:add's note).
    ...(typeof metadata.requesterUserId === "string" ? { requesterUserId: metadata.requesterUserId } : {}),
  };
  if (!isRecord(presentation)) {
    const envelope = wholeActionCardPresentation(action as StoredActionCardAction, ctx);
    return envelope ? { ...metadata, presentation: envelope } : metadata;
  }
  const card = actionCardSpecFor(action as StoredActionCardAction, ctx);
  return card ? { ...metadata, presentation: { ...presentation, card } } : metadata;
}

/** The legacy fields and the card for a card stored with no presentation; null unless the card builds. */
function wholeActionCardPresentation(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext): ActionCardPresentation | null {
  let envelope: ActionCardPresentation | undefined;
  try {
    envelope = actionCardPresentationFor(action, ctx);
  } catch {
    // The legacy fields of a row this old may not build; it keeps no presentation, as before.
    return null;
  }
  // A type with no legacy builder (migration:export) has no envelope at all.
  return isRecord(envelope) && envelope.card ? envelope : null;
}

/** Action-card metadata as an agent may read it: without `presentation.card`. */
export function withoutAgentHiddenActionCardSpec<T>(metadata: T): T {
  if (!isRecord(metadata) || metadata.kind !== "action-card") return metadata;
  const presentation = metadata.presentation;
  if (!isRecord(presentation) || !Object.hasOwn(presentation, "card")) return metadata;
  const { card: _card, ...legacy } = presentation;
  return { ...metadata, presentation: legacy };
}

/** A message row as an agent may read it: its action-card metadata without `presentation.card`. */
export function messageWithoutAgentHiddenActionCardSpec<T>(message: T): T {
  if (!isRecord(message) || !Object.hasOwn(message, "actionMetadata")) return message;
  const actionMetadata = withoutAgentHiddenActionCardSpec(message.actionMetadata);
  return actionMetadata === message.actionMetadata ? message : { ...message, actionMetadata };
}
