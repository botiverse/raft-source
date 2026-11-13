import { Button, Popover, PopoverTrigger, PopoverContent } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { DeferredEmojiPickerPanel as EmojiPickerPanel } from "../ui/PickerPanelDeferred";
import { useCallback, useState } from "react";
import type { PickerProps } from "emoji-picker-react";
import { SmilePlus, X } from "lucide-react";
import { useIntl } from "react-intl";

export default function SidebarSectionEmojiPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const handleEmojiClick = useCallback<NonNullable<PickerProps["onEmojiClick"]>>((emojiData) => {
    onChange(emojiData.emoji);
    setOpen(false);
  }, [onChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={formatMessage({ id: value ? "layout.sidebar.changeEmoji" : "layout.sidebar.chooseEmoji" })}>
        <PopoverTrigger
          render={(
            <Button type="button" variant="ghost" size="icon-md"
              aria-label={value
                ? formatMessage({ id: "layout.sidebar.changeSectionEmojiAria" }, { emoji: value })
                : formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
              className="text-xl"
            >
              {value || <SmilePlus size={18} aria-hidden className="text-foreground-muted" />}
            </Button>
          )}
        />
      </Tooltip>
      {open && (
        <PopoverContent
          align="start"
          role="dialog"
          aria-label={formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
          className="p-0"
        >
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="flex h-option w-full items-center justify-center gap-2 border-b border-line-hairline bg-layer-popover px-3 font-sans text-callout font-medium text-foreground outline-none transition-colors hover:bg-brand-soft focus-visible:bg-brand-soft"
            >
              <X size={14} aria-hidden />
              {formatMessage({ id: "layout.sidebar.removeEmoji" })}
            </button>
          )}
          <EmojiPickerPanel onEmojiClick={handleEmojiClick} />
        </PopoverContent>
      )}
    </Popover>
  );
}
