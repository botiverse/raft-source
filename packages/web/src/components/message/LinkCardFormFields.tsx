import { useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { Field, FieldDescription, FieldError, FieldLabel, Input } from "@botiverse/raft-ui";
import type { MessageCardForm, MessageCardFormField } from "@botiverse/raft-shared";
import { isImeComposing } from "../../features/shortcuts/match";
import { linkCardFormFieldMax, linkCardSecretInsertFits } from "./linkCardForm";
import type { LinkCardFormProblem } from "./linkCardForm";

// The fields of a form on an App-sent card's acting button (RFC 086 §5.1), in
// Raft's dialog (LinkCardConfirmDialog), from raft-ui Field and Input (DS
// Forms › Fields; Field; Input).
//
// The inputs are uncontrolled: a value lives only in its <input>, read once
// when the dialog is confirmed, so it is never in React state, a store or a
// `value` attribute, and closing the dialog (Cancel, Esc, ×, the message
// going away) unmounts it and drops it.
//
// - TextInput: an ordinary text field that always shows what is typed (never
//   masked, so it never looks like a protected field), prefilled with the
//   App's `default`.
// - SecretInput: one masked line, never prefilled or echoed, with
//   autocomplete, spellcheck, autocapitalize, autocorrect (IME suggestions)
//   and page translation off and password managers told to ignore it, and
//   Raft's line saying where the value goes, always shown: an error goes
//   under it, not in its place (AppFather). A TextInput's error replaces
//   nothing but its own line (DS Field). It stops at its 4096 UTF-8 bytes as
//   it is filled: typing or a paste that would cross them is refused, a paste
//   whole, and the field says why (`onTooLong`) at once rather than on
//   confirm, since what was refused never shows in the field.
//
// No <form> element, submit or navigation anywhere around the fields: the
// dialog is portaled to the body, Enter and the confirm button call
// `onSubmit` directly (password managers key on form submits; Chrome may
// still offer to save, an accepted residual risk).

/** Raft's dialog reads the values through this: field id to its input. */
export type LinkCardFormInputs = RefObject<Map<string, HTMLInputElement>>;

export function LinkCardFormFields({ form, app, problems, inputs, disabled, onSubmit, onTooLong }: {
  form: MessageCardForm;
  app: string;
  problems: Readonly<Record<string, LinkCardFormProblem>>;
  inputs: LinkCardFormInputs;
  disabled: boolean;
  onSubmit: () => void;
  /** A SecretInput refused input that would cross its byte limit. */
  onTooLong: (fieldId: string) => void;
}) {
  return (
    <div className="grid gap-3" data-link-card-form="">
      {form.fields.map((field) => (
        <FormField key={field.id} field={field} app={app} problem={problems[field.id]} inputs={inputs} disabled={disabled} onSubmit={onSubmit} onTooLong={onTooLong} />
      ))}
    </div>
  );
}

function FormField({ field, app, problem, inputs, disabled, onSubmit, onTooLong }: {
  field: MessageCardFormField;
  app: string;
  problem: LinkCardFormProblem | undefined;
  inputs: LinkCardFormInputs;
  disabled: boolean;
  onSubmit: () => void;
  onTooLong: (fieldId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const optionalMarker = formatMessage({ id: "ui.formField.optional" });
  const id = useId();
  const secret = field.type === "SecretInput";
  const own = useRef<HTMLInputElement | null>(null);
  const ref = useCallback((node: HTMLInputElement | null) => {
    own.current = node;
    if (node) inputs.current.set(field.id, node);
    else inputs.current.delete(field.id);
  }, [inputs, field.id]);
  // The native beforeinput (React's onBeforeInput misses paste): an insertion past the byte limit never lands.
  useEffect(() => {
    const input = own.current;
    if (!secret || !input) return;
    const guard = (event: Event) => {
      const { data, inputType } = event as InputEvent;
      if (!inputType?.startsWith("insert") || !data || linkCardSecretInsertFits(input.value, input.selectionStart, input.selectionEnd, data)) return;
      event.preventDefault();
      onTooLong(field.id);
    };
    input.addEventListener("beforeinput", guard);
    return () => input.removeEventListener("beforeinput", guard);
  }, [secret, field.id, onTooLong]);
  // Enter confirms, as in any small form; not while an IME is composing (Safari's late Enter too).
  const keyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isImeComposing(event.nativeEvent)) return;
    event.preventDefault();
    onSubmit();
  }, [onSubmit]);
  const error = problem === "required" ? formatMessage({ id: "message.appLink.action.form.required" })
    : problem === "oneLine" ? formatMessage({ id: "message.appLink.action.form.oneLine" })
    : problem === "tooLong" ? formatMessage({ id: secret ? "message.appLink.action.form.tooManyBytes" : "message.appLink.action.form.tooLong" }, { max: linkCardFormFieldMax(field) })
    : null;
  const common = {
    id,
    ref,
    placeholder: field.placeholder,
    "aria-required": field.required || undefined,
    "data-invalid": problem ? true : undefined,
    onKeyDown: keyDown,
    suppressPasswordManager: true,
    autoComplete: "off",
    "data-link-card-form-field": field.type,
    "data-link-card-form-field-id": field.id,
  } as const;
  return (
    <Field invalid={!!problem} disabled={disabled}>
      <FieldLabel htmlFor={id} {...(field.required ? {} : { optional: optionalMarker })} className="break-words [overflow-wrap:anywhere]">
        {field.label}
      </FieldLabel>
      {secret ? (
        <Input
          {...common}
          type="password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          translate="no"
          className="notranslate"
        />
      ) : (
        <Input {...common} type="text" defaultValue={field.default} />
      )}
      {secret ? (
        <FieldDescription data-link-card-form-secret-notice="">
          {formatMessage({ id: "message.appLink.action.form.secretNotice" }, { app })}
        </FieldDescription>
      ) : null}
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}
