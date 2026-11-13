/**
 * The heights a member's row and tile share, built from the line-height tokens
 * so they follow the type scale: a DS ListRow with a subtitle (the row's
 * padding, the title's body line, 2px, the subtitle's footnote line), 66px
 * with a mouse and 58px by touch (raft-design spacing.md › Heights: a row with
 * an avatar and a preview is at least 64 / 56). Every row and tile is that tall
 * whether it has a description or not, so a list or a grid row never changes
 * height with its content.
 */
export const MEMBER_ROW_MIN_H = "min-h-[calc(--spacing(6)+var(--text-body--line-height)+--spacing(0.5)+var(--text-footnote--line-height))] pointer-coarse:min-h-[calc(--spacing(4)+var(--text-body--line-height)+--spacing(0.5)+var(--text-footnote--line-height))]";

/** A tile: the same row, plus its card's hairline above and below (68 / 60). */
export const MEMBER_TILE_MIN_H = "min-h-[calc(--spacing(6)+var(--text-body--line-height)+--spacing(0.5)+var(--text-footnote--line-height)+2px)] pointer-coarse:min-h-[calc(--spacing(4)+var(--text-body--line-height)+--spacing(0.5)+var(--text-footnote--line-height)+2px)]";
