// Selection rules shared by the controlled pickers (MemberPicker,
// ChannelPicker). A picker value is an ordered list of uuids.

/** An unselected option is blocked once the value has reached `maxItems`.
 *  The cap applies in single mode too, so omit `maxItems` there. */
export function isPickerOptionBlocked(
  value: readonly string[],
  id: string,
  maxItems: number | undefined,
): boolean {
  return maxItems !== undefined && !value.includes(id) && value.length >= maxItems;
}

/** Toggling a selected id removes it; an unselected id is appended
 *  (multiple) or replaces the value (single). Callers check
 *  `isPickerOptionBlocked` first. */
export function togglePickerValue(
  value: readonly string[],
  id: string,
  multiple: boolean,
): string[] {
  if (value.includes(id)) return value.filter((selectedId) => selectedId !== id);
  return multiple ? [...value, id] : [id];
}
