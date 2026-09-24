/**
 * The Create Agent dialog's field, composed from raft-ui's Field family.
 *
 * Two things this has to do that the primitives do not do on their own:
 *
 * 1. **Reserve the message row.** A field's height must not depend on whether
 *    it currently has something to say, or a hint appearing, an error
 *    appearing, or a counter existing each moves everything below it — the
 *    Description counter alone made its gap to the next field 36px where every
 *    other gap is 16px, and toggling help text changed the dialog's height.
 *    `Field` supplies the internal rhythm (`gap-1.5`) but not a held-open row,
 *    so the row is rendered always and merely made `invisible` when empty
 *    (not unmounted — nothing shifts, and the live region survives).
 *    Reserved at two lines because the inline name error already wraps to two
 *    at 390px; one line still let the error state push the dialog 16px taller.
 *
 * 2. **Keep the dialog's uppercase label convention**, which is page styling
 *    rather than anything the library should know about.
 *
 * `FieldControl` adopts the control passed as `children` via `render`, so id,
 * `aria-describedby` and `aria-invalid` are wired by the library instead of by
 * hand at each callsite — which is the class of bug that produced the dropped
 * `data-invalid=""` earlier in this ticket.
 *
 * Error and hint share one row and never stack, so a field cannot grow by
 * showing both; error wins and replaces in place. The counter is persistent and
 * holds the right side whether or not a message occupies the left.
 *
 * This wrapper is the shape that should graduate into the shared base as a
 * typed slot, rather than being reinvented per page.
 */
import { Children, createContext, isValidElement, useContext, useId, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import { Field, FieldControl, FieldLabel, SelectTrigger } from "raft-ui";

/**
 * required XOR optional, mirroring raft-ui's own `LabelMarker`. The shared
 * `FormField` types both as plain optional booleans and only *documents* that
 * they are mutually exclusive, so `<FormField required optional>` compiles and
 * renders both markers. Here it is a compile error, as it is in the library.
 */
type LabelMarker =
  | { required?: boolean; optional?: never }
  | { optional?: boolean; required?: never };

export type StableFieldProps = LabelMarker & {
  label: ReactNode;
  /** Helper text. Shares the reserved row with `error`; `error` wins. */
  hint?: ReactNode;
  /** Error text. Takes the reserved row, replacing `hint` in place. */
  error?: ReactNode;
  /** Persistent right-aligned auxiliary text (e.g. a character counter). */
  counter?: ReactNode;
  /** Small control rendered beside the label (e.g. a rescan action). */
  labelAccessory?: ReactNode;
  /** Composite fields (a repeating list of rows, say) have no single
   *  interactive control to adopt. Set `adopt={false}` for those: they keep the
   *  Field structure, label and reserved message row, but skip FieldControl
   *  rather than being forced through it. This is a deliberate, per-callsite
   *  declaration — not a silent fallback, which is what previously let four
   *  fields lose their wiring unnoticed. */
  adopt?: boolean;
  /** `row` puts the label and the control on one line, label left and control
   *  right, with the reserved message row underneath. For BOOLEAN fields: a
   *  checkbox is not a full-width control, so the stacked shape leaves it
   *  stranded on a line of its own with nothing beside it. Everything else stays
   *  stacked, which is what a full-width input or select wants. */
  layout?: "stacked" | "row";
  /** Nodes rendered after the control, inside the field but outside
   *  `FieldControl` — status lines, inline retry actions, and the like.
   *  They must not go through `FieldControl`, which adopts exactly one
   *  interactive control. */
  belowControl?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
};

/**
 * The field's message id and invalid state, for controls that cannot receive them
 * as props.
 *
 * raft-ui's `Select` ROOT renders no DOM of its own — it spreads onto Base UI's
 * Select.Root — so `aria-describedby` and `data-invalid` handed to it simply
 * vanish. The focusable element is the trigger, several levels down. Adoption can
 * reach the element it is given; it cannot reach inside it, and `cloneElement` is
 * banned here.
 *
 * A context lets the trigger pick both up itself. `FieldSelectTrigger` below is
 * the one-line opt-in for a select-shaped field.
 */
const FieldMessageContext = createContext<{ messageId: string; invalid: boolean } | null>(null);

/**
 * `SelectTrigger` that wires itself to the enclosing StableField.
 *
 * Use this instead of a bare `SelectTrigger` whenever a Select is a field's
 * control. Without it the trigger is described by nothing and styled by nothing,
 * while the field looks perfectly well-formed — the failure is silent, which is
 * why the visual suite's "every field's control is wired" check caught it and the
 * unit teeth did not.
 */
export function FieldSelectTrigger({ children, ...props }: React.ComponentProps<typeof SelectTrigger>) {
  const ctx = useContext(FieldMessageContext);
  return (
    <SelectTrigger
      aria-describedby={ctx?.messageId}
      data-invalid={ctx?.invalid ? "true" : undefined}
      {...props}
    >
      {children}
    </SelectTrigger>
  );
}

const LABEL_CLS = "text-sm font-bold text-black uppercase tracking-wide";

export default function StableField({
  label, required, optional, hint, error, counter, labelAccessory, belowControl, adopt = true, layout = "stacked", htmlFor, className, children,
}: StableFieldProps) {

  // Exactly one interactive control per field, or fail closed. `Children.toArray`
  // drops JSX comments and conditional nulls, which is what previously made a
  // single-control field look like a multi-node one and silently skipped
  // adoption — the field then lost the library's id / aria-describedby /
  // aria-invalid wiring with nothing to show for it. A field that reaches here
  // with none or several controls is a construction error, not something to
  // render half-wired.
  // Exactly one interactive control per field. `Children.toArray` drops JSX
  // comments and conditional nulls, which is what previously made a
  // single-control field look multi-node and silently skipped adoption.
  const message = error ?? hint;
  /*
   * The message row is associated with the ADOPTED CONTROL ONLY, by hand.
   *
   * `FieldDescription` (Base UI's Field.Description) registers itself on the
   * field context, so every field-aware control underneath picks it up in its
   * `aria-describedby`. In the Model field that meant the mode Select — holding a
   * valid "Custom…" — was described as "Custom model name is required." Clearing
   * its `aria-invalid` did not make that description true; focusing the Select
   * still read out the Input's required-error (@Dozy, task #22).
   *
   * Name and description are INDEPENDENT associations, which I had wrongly
   * assumed were coupled: `aria-labelledby` comes from FieldLabel and is
   * unaffected, so the Select keeps its accessible name ("Model") while no longer
   * claiming the value control's error. Rendering the row as a plain element with
   * an id, and pointing only the adopted control at it, is what separates them.
   */
  const messageId = useId();
  /** Memoised so a keystroke in a sibling control does not re-render every select
   *  trigger under this field. */
  const fieldMessage = useMemo(
    () => ({ messageId, invalid: Boolean(error) }),
    [messageId, error],
  );
  // Only *interactive* children count as the control. Counting every element
  // meant a legitimate field — one control plus a non-interactive notice or
  // status line — looked misconfigured and silently lost its wiring, which is
  // the opposite of what the check exists for (found in review by @Dozy).
  //
  // Non-interactive intrinsics are excluded by tag; anything else (a component,
  // or an interactive intrinsic) is treated as a candidate control. That is a
  // heuristic with a stated boundary: a component that renders only text will
  // still be counted. `belowControl` is the explicit escape for such content,
  // and 0-or-many interactive children still fails closed.
  const NON_INTERACTIVE = new Set(["p", "span", "div", "small", "em", "strong", "label", "ul", "ol", "li"]);
  // ONE `Children.toArray` call, reused below. It returns freshly-keyed copies, so
  // calling it twice yields two sets of objects that are never `===` each other —
  // which silently defeated the sibling filter and rendered the adopted control a
  // SECOND time. Every select field was drawing two stacked triggers, and because
  // both looked correct in isolation it read as a spacing bug, not a duplication one.
  const allChildren = Children.toArray(children);
  const interactive = allChildren
    .filter(isValidElement)
    .filter((el) => typeof el.type !== "string" || !NON_INTERACTIVE.has(el.type));
  /*
   * A field with genuinely TWO interactive children needs the callsite to say
   * which one is the value control — the heuristic cannot know.
   *
   * Model in custom mode is the case: a Select that chooses the MODE and an Input
   * that holds the VALUE. The heuristic adopted the Select (the Input was nested
   * in a spacing `<div>`, so it was not even a candidate), which meant the error
   * marked the mode picker while the box the user actually had to fill announced
   * itself as perfectly fine. Marking the intended child is explicit and survives
   * reordering, which an index would not.
   *
   * The same marker repairs the built-in-gateway shape, where the Select renders
   * as `null` and only the wrapped Input remains: that field saw ZERO controls and
   * silently failed closed as misconfigured — permanently invalid and unwired —
   * which is what `data-field-config-error="0"` was reporting to nobody.
   */
  const declared = allChildren
    .filter(isValidElement)
    .filter((el) => (el.props as Record<string, unknown>)["data-field-adopt"] !== undefined);
  const controls = declared.length === 1 ? declared : interactive;
  const adoptable = adopt && controls.length === 1;
  const misconfigured = adopt && !adoptable;

  // Fails closed without introducing copy: the field renders as invalid and
  // carries `data-field-config-error` with the number of controls found, which
  // is what the contract tests assert on. Deliberately no message string —
  // a developer-facing literal here is still a literal in source, and it would
  // register as new copy in the i18n corpus audit for something no user should
  // ever read. The attribute says everything a developer needs.
  const control = adoptable ? controls[0] : null;

  return (
    <Field
      className={className}
      /*
       * `data-invalid` as a plain ATTRIBUTE, deliberately NOT Base UI's `invalid`
       * prop.
       *
       * `invalid` is a CONTEXT value: it reaches every field-aware control under
       * this root, not just the adopted one. In a two-control field that is
       * actively wrong — the Model field's mode Select holds a perfectly valid
       * value ("Custom…"), and marking it `aria-invalid` tells a screen-reader
       * user that a correct choice is a mistake. Fixing the wrong-control bug
       * this way had merely widened it: instead of the Select alone being marked,
       * the Input AND the Select were (found by @Dozy driving both branches on
       * H=fceaff28).
       *
       * As an attribute it still hangs the `group/field` styling hook on the
       * root, but propagates to nothing. The adopted control gets its own
       * `data-invalid` below, and raft-ui's controls derive `aria-invalid` from
       * that — so exactly one control announces itself invalid.
       */
      {...((error || misconfigured) ? { "data-invalid": "true" } : {})}
      data-field-config-error={misconfigured ? String(controls.length) : undefined}
    >
      <FieldMessageContext.Provider value={fieldMessage}>
      {/* `row` keeps the label and control on one line. The two are ordinary
          siblings in the stacked shape, so the only difference is whether a flex
          row wraps them; everything below — belowControl and the reserved
          message row — is unchanged either way. */}
      <div className={layout === "row" ? "flex items-center justify-between gap-3" : "contents"}>
      {labelAccessory ? (
        <div className="flex items-center gap-2">
          <FieldLabel {...(optional ? { optional } : { required })} className={LABEL_CLS} htmlFor={htmlFor}>{label}</FieldLabel>
          {labelAccessory}
        </div>
      ) : (
        <FieldLabel {...(optional ? { optional } : { required })} className={LABEL_CLS} htmlFor={htmlFor}>{label}</FieldLabel>
      )}

      {control ? (
        <>
          {/*
            * `data-invalid` goes on the CONTROL, not just the root.
            *
            * Base UI marks only the root, while raft-ui's Input and Select style
            * their invalid state from `data-invalid:` variants on the control
            * itself — so a root-only marker announces the error correctly and
            * leaves the input looking perfectly normal. raft-ui's Input derives
            * `aria-invalid` from this same prop, so one prop carries both.
            *
            * Passed through FieldControl (which merges it onto whatever it
            * adopts) rather than by cloning the element: same result, and
            * cloneElement is banned by `react-doctor(no-clone-element)`.
            *
            * This is what the single hand-written `data-invalid` on the Name
            * input used to do. Doing it here is the fix — that callsite covered
            * one control, and the eight field errors in RuntimeConfigFields had
            * no equivalent at all.
            */}
          <FieldControl
            {...(error ? { "data-invalid": "true" } : {})}
            /* Always, not only when there is a message. The row is reserved
               and always rendered, so this matches what FieldDescription did:
               with nothing to say it resolves to empty text and announces
               nothing. Making it conditional dropped the association from every
               quiet field, which is what `createAgentFieldContract` pins as
               "still wired". */
            aria-describedby={messageId}
            render={control as ReactElement}
          />
          {/* Non-control children (notices, action-card hints, status lines) still
              render, after the control. Rendering only the adopted control silently
              dropped them — the Computer field's "Required by the action card" text
              disappeared with no error, which is the same failure shape as the
              `belowControl` prop being swallowed on the FormField path. Adopting one
              child must not mean discarding its siblings. */}
          {allChildren.filter((c) => c !== control)}
        </>
      ) : (
        children
      )}
      </div>
      {belowControl}

      {/* A plain element, deliberately not `FieldDescription` — see `messageId`
          above. `data-slot="field-description"` is kept so the slot still names
          what this row is for anything selecting on it. */}
      <div id={messageId} data-slot="field-description" className="text-xs">
        {/* One line reserved, not two. Per cindyz: reserve a single line and let
            the dialog grow when a message genuinely wraps, rather than paying two
            lines of empty space on every field to keep the height pinned. */}
        <span className="flex min-h-4 items-start gap-2">
          <span
            className={`flex-1 ${message ? "" : "invisible"} ${error ? "font-bold text-brutal-red" : "text-black/50"}`}
            role={error ? "alert" : undefined}
          >
            {/* Holds the line box open when empty, so the row keeps its height
                without a magic min-height on the text itself. */}
            {message ?? " "}
          </span>
          {counter ? (
            <span className="shrink-0 font-mono tabular-nums text-black/50">{counter}</span>
          ) : null}
        </span>
      </div>
      </FieldMessageContext.Provider>
    </Field>
  );
}
