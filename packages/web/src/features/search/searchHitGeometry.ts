/**
 * Where a hit's text column starts: the list cell's start, then the 27px
 * identity and 12px after it. Shared with SearchSkeleton.
 */
export const SEARCH_HIT_TEXT_INSET = "pl-[calc(var(--cell-inset-x)+var(--cell-pad-x)+39px)]";
/** The hit's identity, lifted into the left column, 12px from the row's top. Shared with SearchSkeleton. */
export const SEARCH_HIT_AVATAR_BOX = "absolute top-3 left-[calc(var(--cell-inset-x)+var(--cell-pad-x))] flex";
