/**
 * A settings card of stacked settings (a title, its description, a select or
 * segmented control), with a mouse on a desktop: 20px inside, 16px between
 * settings (inside a setting 4 and 8 < between 16 < padding 20). Touch keeps
 * 16px.
 *
 * A setting that applies at once has no reserved result line any more
 * (raft-ui 0.84: an empty SaveStatus takes no room), so the card no longer
 * pulls a last SaveStatus into the 16px below it (the 2026-11-04 rule): with a
 * failure shown, that line would overlap the next setting by 2px or run into
 * the card's padding. A failure now grows its setting by its line.
 */
export const SETTINGS_STACK_CARD_DESKTOP = "md:pointer-fine:p-5 md:pointer-fine:stack-y-4";
