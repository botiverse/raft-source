import { createContext } from "react";

/** A search started inside a conversation (its header's Search button on a
 *  phone): only that conversation, on a page of its own with Back. The route
 *  that shows such a page provides it; the Search tab and the ⌘K overlay have
 *  none. */
export type SearchScopeTarget = { kind: "channel" | "dm"; id: string };
export const SearchScopeContext = createContext<SearchScopeTarget | null>(null);
