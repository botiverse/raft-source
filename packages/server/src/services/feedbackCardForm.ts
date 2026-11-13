// `feedback:submit` as a form card (form.v1, F1: the first production form
// card, spec §6 Q3). The card's button opens the dialog's form (the Idea /
// Problem choice and the message, prefilled with the agent's draft; shared
// buildFeedbackSubmitForms), and its submission files the feedback exactly as
// the dialog does: sendFeedbackCard (productFeedbackSendService.ts), the same
// ticket, attribution, Hands app and submission_id, and the same result on
// the card. Only the way in differs: POST /api/actions/:messageId/execute with
// `form` instead of POST /api/product-feedback, so the S2 rules apply
// (actionCardForms.ts): 422 FORM_INVALID, 409 ALREADY_EXECUTED unless it is
// the sender's exact retry, FORM_REQUIRED for a generic approve, the values
// only in action_cards.submitted_input.
//
// Hands is called in `deliver`, before execute's transaction (that
// transaction locks the card's channel). The dialog still completes the card
// by its own path, so a client without form.v1 keeps working (the web until
// its form sheet ships), and a draft the form cannot carry keeps the dialog's
// button (completesWithoutForm).

import { eq } from "drizzle-orm";
import {
  actionCardFormIssue,
  buildFeedbackSubmitForms,
  displayLocaleTag,
  FEEDBACK_SUBMIT_FORM_MESSAGE_MAX_LENGTH,
  normalizeDisplayLocale,
} from "@botiverse/raft-shared";
import { users } from "../db/schema";
import type { ActionCardFormHandler } from "./actionCardForms";
import type { RequestClient } from "./productEventContext";
import {
  normalizeProductFeedbackMetadata,
  type ProductFeedbackKind,
  type ProductFeedbackNormalizedMetadata,
} from "./productFeedbackService";
import {
  FeedbackCardSenderNotMemberError,
  productFeedbackMessage,
  productFeedbackSendFailure,
  sendFeedbackCard,
  type ProductFeedbackCardResult,
} from "./productFeedbackSendService";

/** What the form's values become; `result` once Hands filed it (deliver). */
export interface FeedbackCardFormInput {
  kind: ProductFeedbackKind;
  message: string;
  result?: ProductFeedbackCardResult;
}

/**
 * A send refused before or by Hands: the execute route answers with its
 * status and code (as `{ error, errorCode }`), like the dialog's refusals.
 */
export class FeedbackCardFormSendError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FeedbackCardFormSendError";
  }
}

/**
 * A form send's client facts: the normalizeProductFeedbackMetadata input the
 * dialog's send from the same client builds, read by the server from the
 * execute request's headers (ctx.client) and the account, never its body.
 * - The App (`android`, `ios`), as its feedback page sends: that kind (so the
 *   App's Hands app, and its own Settings › Feedback), the version its
 *   User-Agent names (none if it names none), and the BCP 47 tag of the
 *   account's display language (none if unset).
 * - The desktop app (`desktop_app`), as its dialog sends: web, with
 *   `Raft Desktop <version>` (desktopFeedbackMetadata; the dialog's os_version
 *   is not in the request).
 * - Anything else is web and nothing more, as a browser's dialog send: a
 *   browser, the installed web app, no header, and HarmonyOS (`harmonyos`),
 *   whose User-Agent and Hands app this was not checked against.
 */
export function feedbackFormMetadata(client: RequestClient, displayLanguage: string | null): ProductFeedbackNormalizedMetadata {
  switch (client.platform) {
    case "android":
    case "ios": {
      const locale = normalizeDisplayLocale(displayLanguage);
      return normalizeProductFeedbackMetadata({
        trustedClientKind: client.platform,
        clientKind: client.platform,
        platform: client.platform,
        clientVersion: client.raftVersion,
        locale: locale ? displayLocaleTag(locale) : undefined,
      }, { nativeVersionOptional: true });
    }
    case "desktop_app":
      return normalizeProductFeedbackMetadata({
        clientVersion: client.raftVersion ? `Raft Desktop ${client.raftVersion}` : "Raft Desktop",
      });
    default:
      return normalizeProductFeedbackMetadata({});
  }
}

export const feedbackCardFormHandler: ActionCardFormHandler<"feedback:submit", FeedbackCardFormInput> = {
  completesWithoutForm: true,

  buildForm(action) {
    return buildFeedbackSubmitForms(action);
  },

  async validate(values) {
    // The shared checks passed: `type` is idea or problem, `message` is not
    // blank and has at most the form's code points. The dialog's own rule
    // also bounds the trimmed text in UTF-16 units, which a text heavy in
    // astral characters can pass the first and fail.
    const message = productFeedbackMessage(values.message);
    if (!message) return { issues: [actionCardFormIssue("message", "too_long", { max: FEEDBACK_SUBMIT_FORM_MESSAGE_MAX_LENGTH })] };
    return { input: { kind: values.type === "problem" ? "problem" : "idea", message } };
  },

  async deliver(input, ctx) {
    const [user] = await ctx.executor.select({
      name: users.name,
      email: users.email,
      displayName: users.displayName,
      displayLanguage: users.displayLanguage,
    }).from(users).where(eq(users.id, ctx.userId));
    if (!user) throw new FeedbackCardFormSendError(401, "auth_required", "Unauthorized");
    try {
      const sent = await sendFeedbackCard({
        card: { messageId: ctx.messageId, targetServerId: ctx.serverId, requesterAgentId: ctx.requesterAgentId },
        user: { id: ctx.userId, name: user.name, email: user.email, displayName: user.displayName },
        kind: input.kind,
        message: input.message,
        // As the dialog: no contact details, no attachments.
        mayContact: false,
        metadata: feedbackFormMetadata(ctx.client, user.displayLanguage),
        attachments: [],
      });
      return { ...input, result: sent.result };
    } catch (error) {
      if (error instanceof FeedbackCardSenderNotMemberError) throw error;
      const failure = productFeedbackSendFailure(error);
      if (failure) throw new FeedbackCardFormSendError(failure.status, failure.code, failure.error);
      throw error;
    }
  },

  async execute(input) {
    // Only records what deliver filed (in execute's transaction, under its lock).
    if (!input.result) throw new Error("A feedback card's form is recorded only once it was sent");
    return input.result;
  },
};
