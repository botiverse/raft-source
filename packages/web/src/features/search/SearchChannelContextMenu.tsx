import { useCallback, useMemo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { FolderOpen } from "lucide-react";
import { ContextMenuPopup } from "@botiverse/raft-ui";
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
  const channelContextMenuStyle = useMemo(
    () => ({ left: menu.x, top: menu.y }),
    [menu],
  );
  const handleChannelContextMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }, [onClose]);
  return createPortal(
    <>
      <DismissBackdrop onDismiss={onClose} trapContextMenu />
      <ContextMenuPopup
        ref={focusFirstMenuButton}
        role="menu"
        aria-label={formatMessage({ id: "search.channelMenuAria" }, { title: menu.result.title })}
        className="fixed z-popup w-48 select-none"
        style={channelContextMenuStyle}
        onMouseDown={stopMouseDownPropagation}
        onKeyDown={handleChannelContextMenuKeyDown}
      >
        <MenuItem
          icon={<FolderOpen size={14} />}
          onClick={onOpen}
        >
          {formatMessage({ id: "search.open" })}
        </MenuItem>
      </ContextMenuPopup>
    </>,
    document.body,
  );
}
