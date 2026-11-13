// Server entities (channels, people, agents, machines) are a ranked list: every
// reasonable match (up to MAX_ENTITY_RESULTS) is reachable. The section shows
// the first ENTITY_PREVIEW_COUNT and a "Show All N" link that lists the rest in
// place, so the messages below stay in reach without a nested scroller. The
// page's one scroller is its ScrollArea (Raft DS › Search): a fixed-height
// scroller inside it clipped the list on phones, leaving the rows past the
// sixth unreachable under a blank page.
export const MAX_ENTITY_RESULTS = 50;
export const ENTITY_PREVIEW_COUNT = 5;
// Desktop ⌘K overlay (task #102, Slack model): the overlay is a suggestion layer,
// not the results page — it previews a handful of message hits and hands
// "everything" to the full results page through the "view all results" row.
export const OVERLAY_MESSAGE_PREVIEW_LIMIT = 5;
export const OVERLAY_ALL_RESULTS_KEY = "action:view-all-results";
// Return-key glyph for the overlay's "view all results" row (not translatable copy).
export const RETURN_KEY_GLYPH = "↵";

export const PAGE_SIZE = 20;
export const SEARCH_HOME_TOUCH_QUERY = "(max-width: 767px)";
export const SEARCH_TAB_HEAD_PROPS = { "data-testid": "search-tab-head" };
export const SCOPED_SEARCH_BACK_PROPS = { "data-testid": "scoped-search-back" };

export const EMPTY_SEARCH_ENTITY_USAGE = {};
