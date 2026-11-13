import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";

type SearchParamsPair = ReturnType<typeof useLiveSearchParams>;

/** A panel that doesn't own the URL sees none of its params and changes none. */
const NO_SEARCH_PARAMS = new URLSearchParams();
const IGNORE_SEARCH_PARAMS: SearchParamsPair[1] = () => {};

/**
 * The URL's search params as a conversation panel reads them: the page's own
 * conversation owns them (`msg`, `thread`, its tab). A conversation shown over
 * another page (the assistant's DM in the otter's popover) does not: those
 * params name the page's messages, not its own.
 */
export function useConversationSearchParams(ownsUrl: boolean): SearchParamsPair {
  const [searchParams, setSearchParams] = useLiveSearchParams();
  return ownsUrl ? [searchParams, setSearchParams] : [NO_SEARCH_PARAMS, IGNORE_SEARCH_PARAMS];
}
