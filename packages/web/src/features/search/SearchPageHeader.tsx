import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import PanelHeader from "../../components/ui/PanelHeader";
import { TabRootBar } from "../../components/layout/TabRootBar";
import { SCOPED_SEARCH_BACK_PROPS, SEARCH_TAB_HEAD_PROPS } from "./searchConstants";

/**
 * The search page's head, by where the page is: the ⌘K overlay's slim
 * header, a conversation's own search (a pushed page with Back), the phone
 * Search tab's root, or the desktop page head. The query field is the head's
 * content in every case.
 */
export function SearchPageHeader({
  overlayChrome,
  scoped,
  isTouchSearchHome,
  onMobileBack,
  field,
}: {
  overlayChrome: boolean;
  scoped: boolean;
  isTouchSearchHome: boolean;
  onMobileBack: () => void;
  field: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return overlayChrome ? (
    /* Slim command-palette header (desktop ⌘K overlay): the input IS the top
       bar with the search icon inline — no PanelHeader, mobile-back, or icon
       badge. With a mouse on a desktop it is a 44px head like every other
       (the 32px field and the seam), not 12px above and below the field. */
    <div className="flex shrink-0 items-center border-b border-line-seam px-3 py-3 md:pointer-fine:h-(--header-height) md:pointer-fine:py-0">
      {field}
    </div>
  ) : scoped ? (
    // A conversation's own search is a pushed page: the white page head
    // with Back, and the field as its title. A head that is a field shows
    // no location tile (Raft DS › Page structure).
    <PanelHeader
      onMobileBack={onMobileBack}
      mobileBackProps={SCOPED_SEARCH_BACK_PROPS}
      titleSlot={
        <div className="flex min-w-0 flex-1 items-center">
          {field}
        </div>
      }
    />
  ) : isTouchSearchHome ? (
    // On a phone /search is the Search tab's root (design lead
    // 2026-10-21): the same 56px tab head as Home, Activity, Tasks and
    // More, on the frame, with the field where the page name goes, 16px
    // from both edges (the head's default end padding is cut for a 44px
    // icon button's overhang; a field has none). No Back: the tab bar is
    // how you leave it.
    <TabRootBar
      name={formatMessage({ id: "layout.mobileTabBar.search" })}
      content={field}
      containerProps={SEARCH_TAB_HEAD_PROPS}
    />
  ) : (
    <PanelHeader
      titleSlot={
        /* The field carries the search glyph itself (DS Search), so the
           header needs no separate icon tile at any viewport. */
        <div className="flex min-w-0 flex-1 items-center">
          {field}
        </div>
      }
    />
  );
}
