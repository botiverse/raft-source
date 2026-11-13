/** How the prompt fits the bar: labelled, a square icon, or not at all (the banner instead). */
export type UpdateButtonForm = "label" | "icon" | "banner";

/** The trailing region's gap between items (AppTopBar `gap-1`). */
const ITEM_GAP_PX = 4;
/** The air the trailing region keeps before the search field (AppTopBar `pl-2`). */
const FIELD_GUTTER_PX = 8;

/**
 * How the button fits, from the trailing region's room with the search field
 * at its base (`room`, TopBarTrailingRoomContext; negative when its items run
 * over the field's base) and the button's own width now. Each step down
 * happens where the next measure cannot undo it, and each step back up only
 * once the room holds what it gives back:
 *
 * - Labelled, it gives the label up once the items take the region's room
 *   (room < 0), and takes it back as an icon once the room holds the label's
 *   extra width (`labelledPx`, its width when it last had the label).
 * - As an icon it gives the bar up only where it would run into the field
 *   itself, past the region's 8px air (the installed app's window controls on
 *   a narrow window, with the moon and several faces); the prompt is then the
 *   banner, as on a page without the bar. It comes back once the icon
 *   (`iconPx`) and its gap fit again.
 *
 * Without a measure (`room` undefined) it is labelled.
 */
export function updateButtonForm(
  form: UpdateButtonForm,
  room: number | undefined,
  widthPx: number,
  labelledPx: number | null,
  iconPx: number | null,
): UpdateButtonForm {
  if (room === undefined) return "label";
  if (form === "label") return room >= 0 ? "label" : "icon";
  if (form === "icon") {
    if (labelledPx !== null && room >= labelledPx - widthPx) return "label";
    return room < -FIELD_GUTTER_PX ? "banner" : "icon";
  }
  return room - (iconPx ?? 0) - ITEM_GAP_PX >= -FIELD_GUTTER_PX ? "icon" : "banner";
}
