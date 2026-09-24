import { Pin, PinOff } from "lucide-react";
import { useIntl } from "react-intl";
import MenuItem from "../ui/MenuItem";

export default function ChannelPinMenuItem({
  isPinned,
  onToggle,
  pinLabel,
  unpinLabel,
}: {
  isPinned: boolean;
  onToggle: () => void;
  pinLabel?: string;
  unpinLabel?: string;
}) {
  const { formatMessage } = useIntl();
  const resolvedPinLabel = pinLabel ?? formatMessage({ id: "layout.sidebar.pin" });
  const resolvedUnpinLabel = unpinLabel ?? formatMessage({ id: "layout.sidebar.unpin" });

  return (
    <MenuItem
      icon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
      onClick={onToggle}
    >
      {isPinned ? resolvedUnpinLabel : resolvedPinLabel}
    </MenuItem>
  );
}
