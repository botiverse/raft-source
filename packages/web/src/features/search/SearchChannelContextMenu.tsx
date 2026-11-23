import { useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { FolderOpen } from "lucide-react";
import { AnchoredMenuPopover } from "../../components/ui/AnchoredMenuPopover";
import DismissBackdrop from "../../components/ui/DismissBackdrop";
import MenuItem from "../../components/ui/MenuItem";
import { focusFirstMenuButton, stopMouseDownPropagation } from "./searchMenuEvents";
import type { SearchChannelContextMenuState } from "./useSearchResultActions";

/** A channel result's context menu (right click): Open, in the conversation. */
export function SearchChannelContextMenu({
  menu,
  onClose,
  onOpen,
}: {
  menu: SearchChannelContextMenuState;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { formatMessage } = useIntl();
  const handleChannelContextMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }, [onClose]);
  return (
    <>
      <DismissBackdrop onDismiss={onClose} trapContextMenu />
      <AnchoredMenuPopover
        open
        anchor={menu.anchor}
        onAnchorHidden={onClose}
        ref={focusFirstMenuButton}
        role="menu"
        aria-label={formatMessage({ id: "search.channelMenuAria" }, { title: menu.result.title })}
        className="min-w-0 w-48"
        onMouseDown={stopMouseDownPropagation}
        onKeyDown={handleChannelContextMenuKeyDown}
      >
        <MenuItem
          icon={<FolderOpen size={14} />}
          onClick={onOpen}
        >
          {formatMessage({ id: "search.open" })}
        </MenuItem>
      </AnchoredMenuPopover>
    </>
  );
}
