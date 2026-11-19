/**
 * A runtime choice's id line (RuntimeChoiceCombobox) shows a real model or
 * provider id only. The v2 form's "Default" row (`__runtime_form_v2_default__`)
 * and a saved Provider connection (`connection:<id>`, the server's
 * SAVED_CONNECTION_VALUE_PREFIX) are internal values, never shown; neither is
 * an id that only repeats the label.
 */
export function shownOptionId(value: string, label: string): string | null {
  if (label === value) return null;
  if (value.startsWith("__") || value.startsWith("connection:")) return null;
  return value;
}

/**
 * Whether a field's value is one the person typed: the field takes a typed
 * value and this one is not in its list. Shown as custom, not as a saved value
 * the list no longer has.
 */
export function isTypedCustomValue(allowCustom: boolean, value: string, options: ReadonlyArray<{ value: string }>): boolean {
  return allowCustom && value !== "" && !options.some((option) => option.value === value);
}
