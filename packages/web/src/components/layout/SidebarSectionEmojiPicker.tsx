import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
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
  const [EmojiPicker, setEmojiPicker] = useState<ComponentType<PickerProps> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || EmojiPicker) return;
    let cancelled = false;

    void import("emoji-picker-react").then((module) => {
      // Vite unwraps the package's CommonJS compatibility wrapper, while the
      // repository's direct Node DOM runner exposes another `.default` layer.
      const candidate = module.default as unknown;
      const component = (
        (candidate as { default?: ComponentType<PickerProps> }).default
        ?? candidate
      ) as ComponentType<PickerProps>;
      if (!cancelled) setEmojiPicker(() => component);
    });

    return () => {
      cancelled = true;
    };
  }, [EmojiPicker, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0 self-stretch"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={value
          ? formatMessage({ id: "layout.sidebar.changeSectionEmojiAria" }, { emoji: value })
          : formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={formatMessage({ id: value ? "layout.sidebar.changeEmoji" : "layout.sidebar.chooseEmoji" })}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-full min-h-10 w-11 items-center justify-center border-r-2 border-black bg-white p-0 text-xl focus:outline-none ${
          value ? "text-black" : "text-black/40"
        }`}
      >
        {value || <SmilePlus size={18} aria-hidden />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={formatMessage({ id: "layout.sidebar.chooseSectionEmoji" })}
          className="absolute left-0 top-[calc(100%+8px)] z-[70] border-2 border-black bg-white shadow-brutal"
        >
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="flex h-9 w-full items-center justify-center gap-2 border-b-2 border-black bg-white px-3 text-xs font-bold hover:bg-soft-signal/30"
            >
              <X size={14} aria-hidden />
              {formatMessage({ id: "layout.sidebar.noEmoji" })}
            </button>
          )}
          {EmojiPicker ? (
            <EmojiPicker
              width="min(340px, calc(100vw - 48px))"
              height={360}
              lazyLoadEmojis
              previewConfig={{ showPreview: false }}
              onEmojiClick={(emojiData) => {
                onChange(emojiData.emoji);
                setOpen(false);
              }}
            />
          ) : (
            <div role="status" className="flex h-24 w-[min(340px,calc(100vw-48px))] items-center justify-center text-sm text-black/60">
              {formatMessage({ id: "layout.sidebar.loadingEmoji" })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
