import { forwardRef } from "react";
import type { TextareaHTMLAttributes, ReactNode } from "react";

/**
 * Canonical brutal-style textarea primitive with error + counter support.
 *
 * Replaces bare `<textarea className="input-brutal" />` + ad-hoc error
 * state + character-counter spans that drift across forms (SettingsPanel,
 * CreateChannelDialog, ReportIssueDialog, PreJoinAgreementSection, etc).
 *
 * cindyz 2026-05-12 #engineering:89667b54 msg=dcb9d29b asked for this
 * after cross's pre-join agreement PR introduced a feature-local
 * red-border textarea error state that didn't exist anywhere else in the
 * app. This primitive locks the error visual so future callsites don't
 * re-invent it.
 *
 * **Visual contract:**
 *   - Default: `input-brutal` (border-2 black, white bg, shadow-brutal-sm, focus shadow-brutal)
 *   - Error:   red border + red ring + coral-tinted bg (bg-brutal-red/5)
 *   - Counter: bottom-right, red when over limit
 *   - Message: below the field, red when error
 *
 * **Why not just a CSS variant on `.input-brutal`?**
 * Textarea callsites almost always need counter + error message together;
 * coordinating those through className alone means every callsite
 * re-writes the counter/error layout. Wrapping in a component is cheaper.
 *
 * Inputs (not textarea) follow the same error visual but are usually
 * small enough that a dedicated `BrutalInput` wrapper is overkill — use
 * `className={error ? "input-brutal !border-brutal-red ring-2 ring-brutal-red/60" : "input-brutal"}`
 * inline, or extend this primitive if a second form-field callsite
 * emerges.
 *
 * @example
 * ```tsx
 * <Textarea
 *   value={body}
 *   onChange={(e) => setBody(e.target.value)}
 *   maxLength={500}
 *   error={body.length > 500 ? "Agreement body must be 500 characters or fewer" : undefined}
 *   rows={6}
 *   placeholder="Type your server's join agreement…"
 * />
 * ```
 */

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> {
  /** Error message — renders red border + ring + message below. When
   *  empty string or undefined, field is in normal state. */
  error?: string | null;
  /** Show a character counter at the bottom-right. Uses `maxLength` if
   *  not explicitly set. Counter turns red once current length exceeds
   *  maxLength (or when `error` is set). */
  showCounter?: boolean;
  /** Optional hint / helper text shown below field when not in error
   *  state. */
  hint?: ReactNode;
  /** Additional classes — appended to the `<textarea>` element. Use for
   *  layout tweaks (e.g. `!min-h-32`). */
  className?: string;
  /** Additional classes on the outer wrapper `<div>`. Use for margin /
   *  width tweaks. */
  wrapperClassName?: string;
  /** Custom length function — defaults to `value.length` (UTF-16 code
   *  units). Pass `(v) => Array.from(v).length` for Unicode code-point
   *  counting (correct for emoji / surrogate pairs). */
  getLength?: (value: string) => number;
  /** Override the displayed count directly (e.g. when the parent already
   *  computes a code-point count). Takes precedence over `getLength`. */
  count?: number;
  /** Counter display limit — falls back to native `maxLength` when not
   *  set. Use when you want soft validation (counter turns red over
   *  limit, but no native browser truncation). Common with
   *  `getLength`/`count` for Unicode-correct enforcement. */
  limit?: number;
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    error,
    showCounter,
    hint,
    className = "",
    wrapperClassName = "",
    maxLength,
    value,
    defaultValue,
    getLength,
    count,
    limit,
    ...rest
  },
  ref,
) {
  const hasError = !!error;
  const rawValue =
    typeof value === "string" ? value : typeof defaultValue === "string" ? defaultValue : "";
  const length =
    count !== undefined
      ? count
      : getLength
        ? getLength(rawValue)
        : rawValue.length;
  const counterLimit = limit ?? maxLength;
  const overLimit = counterLimit !== undefined && length > counterLimit;

  const stateClass = hasError
    ? "!border-brutal-red ring-2 ring-brutal-red/60 bg-brutal-red/5"
    : "";

  return (
    <div className={`flex flex-col gap-1 ${wrapperClassName}`.trim()}>
      <textarea
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        maxLength={maxLength}
        aria-invalid={hasError || undefined}
        className={`input-brutal w-full ${stateClass} ${className}`.trim()}
        {...rest}
      />
      <div className="flex items-start justify-between gap-3 text-xs">
        <div className={`flex-1 min-w-0 ${hasError ? "text-brutal-red font-bold" : "text-black/60"}`}>
          {hasError ? error : hint}
        </div>
        {showCounter && counterLimit !== undefined && (
          <div
            className={`shrink-0 font-mono tabular-nums ${
              overLimit || hasError ? "text-brutal-red font-bold" : "text-black/50"
            }`}
          >
            {length}/{counterLimit}
          </div>
        )}
      </div>
    </div>
  );
});

export default Textarea;
