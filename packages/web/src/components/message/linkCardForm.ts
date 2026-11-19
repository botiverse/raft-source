// A form on an App-sent card's acting button (RFC 086 §5.1), as Raft's
// dialog fills it (LinkCardFormFields.tsx) and execute sends it
// (linkCardExecute.tsx). Pure. The values live only in the dialog's inputs
// and in the one execute request built from them (a SecretInput's sealed
// first, linkCardSeal.ts): never in a store, the query cache, local records,
// drafts or a trace.
// docs/development/app-link-previews.md, "Card messages with acting buttons".

import { MESSAGE_CARD_FORM_LIMITS, messageCardFormSubmissionFits } from "@botiverse/raft-shared";
import type { MessageCardExecuteAction, MessageCardForm, MessageCardFormField } from "@botiverse/raft-shared";
import type { LinkCardElement } from "@botiverse/raft-shared/src/appLinkPreview";

type LinkCardButtonProps = Extract<LinkCardElement, { type: "Button" }>["props"];
/**
 * A button a press hands to linkCardExecute.tsx: a link card's Button, or an
 * App-sent card's acting button (messageCardActionResult, the one adapter
 * that casts the stored action to it), whose execute action may carry its
 * form (RFC 086 §5.1). Typed here so the form is read without a cast.
 */
export type LinkCardButton = Omit<LinkCardButtonProps, "action"> & { action: LinkCardButtonProps["action"] | MessageCardExecuteAction };

/** What is wrong with one value: empty but required, too long, or more than one line. */
export type LinkCardFormProblem = "required" | "tooLong" | "oneLine";

/**
 * The form on a pressed button's action, or undefined. Only a card
 * message's acting button has one (messageCardActionResult hands its action
 * over as stored, already read by the shared schema); a link card's has none.
 */
export function linkCardButtonForm(action: LinkCardButton["action"]): MessageCardForm | undefined {
  return "form" in action ? action.form : undefined;
}

/**
 * Whether the form asks for a secret. Its values are sealed to the App
 * (RFC 086 §5.3), which only a prepared action's execute carries: Raft refuses
 * a SecretInput on an undo-window button at send.
 */
export function linkCardFormHasSecretInput(form: MessageCardForm | undefined): boolean {
  return !!form?.fields.some((field) => field.type === "SecretInput");
}

const utf8 = new TextEncoder();

/**
 * One value against its field, as Raft checks it (shared
 * messageCardFormSubmissionFits): a TextInput is one line of at most its
 * maxLength code points; a SecretInput at most 4096 UTF-8 bytes (bytes, not
 * characters, MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes). Empty is fine
 * unless the field is required.
 */
export function linkCardFormProblem(field: MessageCardFormField, value: string): LinkCardFormProblem | null {
  if (value === "") return field.required ? "required" : null;
  if (field.type === "SecretInput") return utf8.encode(value).length > MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes ? "tooLong" : null;
  if (messageCardFormSubmissionFits({ fields: [{ ...field, required: false }] }, { sealedInputs: null, inputs: { [field.id]: value } })) return null;
  // Code points, as the shared cardCodePoints counts them (a string iterates by code point).
  return [...value].length > (field.maxLength ?? MESSAGE_CARD_FORM_LIMITS.textInputMaxLength) ? "tooLong" : "oneLine";
}

/** Every field's problem, by field id; empty when the form can be sent. */
export function linkCardFormProblems(form: MessageCardForm, values: ReadonlyMap<string, string>): Record<string, LinkCardFormProblem> {
  return Object.fromEntries(form.fields.flatMap((field) => {
    const problem = linkCardFormProblem(field, values.get(field.id) ?? "");
    return problem ? [[field.id, problem] as const] : [];
  }));
}

/**
 * Execute's `inputs` (RFC 086 §5.4): each TextInput's value by field id, as
 * typed; an empty one is left out (a required one never is empty here:
 * linkCardFormProblems stops the confirm first); never a SecretInput's. Null
 * when none is left. Sent only in the execute request, never in prepare.
 */
export function linkCardFormInputs(form: MessageCardForm, values: ReadonlyMap<string, string>): Record<string, string> | null {
  const filled = form.fields.flatMap((field) => {
    const value = values.get(field.id) ?? "";
    return field.type === "TextInput" && value !== "" ? [[field.id, value] as const] : [];
  });
  return filled.length ? Object.fromEntries(filled) : null;
}

/**
 * The SecretInput values to seal (RFC 086 §5.3), by field id, an empty
 * optional one left out as for `inputs`; null when the form has none (a form
 * with one is always sealed, even with every value left empty). A Map, so
 * whoever seals it can clear it once sealed.
 */
export function linkCardFormSecrets(form: MessageCardForm, values: ReadonlyMap<string, string>): Map<string, string> | null {
  if (!linkCardFormHasSecretInput(form)) return null;
  return new Map(form.fields.flatMap((field) => {
    const value = values.get(field.id) ?? "";
    return field.type === "SecretInput" && value !== "" ? [[field.id, value] as const] : [];
  }));
}

/**
 * Whether typing or pasting `data` over the selection keeps a SecretInput
 * within its 4096 UTF-8 bytes, so the field stops at the limit as it is
 * filled. A paste that would cross it is refused whole, never cut short: a
 * truncated key would be sealed without anyone noticing.
 */
export function linkCardSecretInsertFits(value: string, start: number | null, end: number | null, data: string): boolean {
  const next = value.slice(0, start ?? value.length) + data + value.slice(end ?? value.length);
  return utf8.encode(next).length <= MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes;
}

/** The most a field's value may be, in its unit: code points for a TextInput, UTF-8 bytes for a SecretInput. */
export function linkCardFormFieldMax(field: MessageCardFormField): number {
  return field.type === "SecretInput" ? MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes : field.maxLength ?? MESSAGE_CARD_FORM_LIMITS.textInputMaxLength;
}
