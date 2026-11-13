import { useEffect, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import type { PickerProps } from "emoji-picker-react";
import { useIntl } from "react-intl";
import { EmojiPickerLoading } from "./PickerPanelDeferred";

const PICKER_PREVIEW_CONFIG: PickerProps["previewConfig"] = { showPreview: false };

// emoji-picker-react draws itself from --epr-* variables whose defaults are
// hex literals and a blue highlight. Point every colour at Raft's tokens, which
// already switch for dark mode, so the picker is the popover it sits in: one
// edge (the popover's), brand-soft hover and focus like every picker row, an
// ink outline on the search field, and Raft's text inks. Inline, because the
// library declares its own values on its root class.
const PICKER_TOKEN_STYLE = {
  "--epr-bg-color": "var(--layer-popover)",
  "--epr-picker-border-color": "transparent",
  "--epr-picker-border-radius": "0",
  "--epr-text-color": "var(--foreground-muted)",
  "--epr-highlight-color": "var(--foreground)",
  "--epr-hover-bg-color": "var(--brand-soft)",
  "--epr-hover-bg-color-reduced-opacity": "var(--brand-soft)",
  "--epr-focus-bg-color": "var(--brand-soft)",
  "--epr-search-input-bg-color": "var(--layer-card)",
  "--epr-search-input-bg-color-active": "var(--layer-card)",
  "--epr-search-border-color": "var(--line-strong)",
  "--epr-search-border-color-active": "var(--line-strong)",
  // With a mouse on a desktop a cell is the control height (34: a 26px emoji
  // and 4px around it) and the search field a field's; touch keeps the
  // library's 40px cell and the 44px field (stdrc, 2026-11-05).
  "--epr-emoji-size": "var(--raft-emoji-size, 30px)",
  "--epr-emoji-padding": "var(--raft-emoji-padding, 5px)",
  "--epr-search-input-height": "var(--raft-emoji-search-height, 44px)",
  "--epr-search-input-border-radius": "var(--radius-control)",
  "--epr-search-input-text-color": "var(--foreground)",
  "--epr-search-input-placeholder-color": "var(--foreground-hint)",
  "--epr-category-label-bg-color": "var(--layer-popover)",
  "--epr-category-label-text-color": "var(--foreground-hint)",
  "--epr-reactions-bg-color": "var(--layer-popover)",
  "--epr-emoji-variation-picker-bg-color": "var(--layer-popover)",
  "--epr-emoji-variation-indicator-color": "var(--line-seam)",
  "--epr-emoji-variation-indicator-color-hover": "var(--foreground-muted)",
  "--epr-skin-tone-picker-menu-color": "var(--layer-popover)",
  "--epr-skin-tone-outer-border-color": "var(--line-seam)",
  "--epr-skin-tone-inner-border-color": "var(--layer-popover)",
  "--epr-active-skin-tone-indicator-border-color": "var(--foreground)",
} as CSSProperties;

/**
 * Every emoji, from emoji-picker-react, in Raft's colours: the panel inside a
 * popover that offers the whole set (a sidebar section's emoji, a reaction
 * beyond the quick seven). It loads the library the first time it shows.
 */
export default function EmojiPickerPanel({
  onEmojiClick,
  focusSearch = false,
}: {
  onEmojiClick: NonNullable<PickerProps["onEmojiClick"]>;
  /** Move focus into the search field once the picker has loaded (opened from the keyboard). */
  focusSearch?: boolean;
}) {
  const { formatMessage } = useIntl();
  const [EmojiPicker, setEmojiPicker] = useState<ComponentType<PickerProps> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (EmojiPicker) return;
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
  }, [EmojiPicker]);

  useEffect(() => {
    if (!focusSearch || !EmojiPicker) return;
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [EmojiPicker, focusSearch]);

  return (
    <>
      {EmojiPicker ? (
        <div
          ref={panelRef}
          // The library sets `sans-serif` on everything inside it, writes
          // `outline: none` on its controls and draws its category icons
          // from a blue sprite. So: the search field is a Raft Input (44px,
          // 1.5px line-strong on layer-card, radius-control, the focus
          // ring); every emoji cell takes radius-control and the focus
          // ring; group labels are 13/18 700 like every group label; the
          // icons are grey, the current one at full ink.
          // These selectors (`.epr-emoji`, `.epr-emoji-category-label`,
          // `.epr-cat-btn`, `.epr-active`) are the library's internal class
          // names, pinned with it at emoji-picker-react 4.19.1. Re-check
          // them when it is upgraded.
          // The panel is 340px with no padding, not popover.md's 300px and
          // 16px: an emoji grid needs the width, and its cells carry their
          // own padding.
          className={[
            "md:pointer-fine:[--raft-emoji-size:calc(var(--control-height)-8px)] md:pointer-fine:[--raft-emoji-padding:4px] md:pointer-fine:[--raft-emoji-search-height:var(--control-height)]",
            "[&_input]:font-sans! [&_input]:text-callout! [&_input]:border!",
            "[&_input:focus-visible]:shadow-focus",
            "[&_.epr-emoji]:rounded-control! [&_.epr-emoji:focus-visible]:shadow-focus",
            "[&_.epr-emoji-category-label]:font-sans! [&_.epr-emoji-category-label]:text-footnote! [&_.epr-emoji-category-label]:font-bold!",
            "[&_.epr-cat-btn]:grayscale [&_.epr-cat-btn]:opacity-60 [&_.epr-cat-btn.epr-active]:opacity-100",
            "[&_.epr-cat-btn:focus-visible]:shadow-focus",
          ].join(" ")}
        >
          <EmojiPicker
            width="min(340px, calc(100vw - 48px))"
            height={360}
            // Light always: Raft's tokens above already carry the dark values,
            // and the library's dark theme would swap in its own palette.
            theme={"light" as PickerProps["theme"]}
            // A chosen emoji shows as native text (a sidebar section's emoji,
            // a reaction beyond the quick seven), so the picker shows the same
            // glyphs instead of images from a CDN.
            emojiStyle={"native" as PickerProps["emojiStyle"]}
            searchPlaceHolder={formatMessage({ id: "layout.sidebar.searchEmoji" })}
            lazyLoadEmojis
            previewConfig={PICKER_PREVIEW_CONFIG}
            style={PICKER_TOKEN_STYLE}
            onEmojiClick={onEmojiClick}
          />
        </div>
      ) : (
        <EmojiPickerLoading />
      )}
    </>
  );
}

