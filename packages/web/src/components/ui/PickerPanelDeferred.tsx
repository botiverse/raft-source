import { Suspense } from "react";
import type { ComponentProps } from "react";
import { deferredPanel } from "../../boot/deferredUi";
import type EmojiPickerPanelComponent from "./EmojiPickerPanel";
import { useIntl } from "react-intl";

type EmojiPickerPanelProps = ComponentProps<typeof EmojiPickerPanelComponent>;

const DeferredPanel = deferredPanel<EmojiPickerPanelProps>(() => import("./EmojiPickerPanel"));

/**
 * The emoji picker (reactions, section emoji), off the first download
 * (boot/deferredUi): its code is fetched in the background after the first
 * screen, a failed download shows Try again in place. Every picker takes it
 * from here: one static import elsewhere would leave it no chunk of its own
 * and put it back in the preloaded graph (desktop frontendAssets check).
 * This module is tiny on purpose (it has no emoji code); the panel and its
 * library are separate chunks loaded on open.
 */
export function DeferredEmojiPickerPanel(props: EmojiPickerPanelProps) {
  return (
    <Suspense fallback={<EmojiPickerLoading />}>
      <DeferredPanel {...props} />
    </Suspense>
  );
}

/** "Loading emoji…" in the picker's place: while the library loads, and while the panel itself downloads (above). */
export function EmojiPickerLoading() {
  const { formatMessage } = useIntl();
  return (
    <div role="status" className="flex h-24 w-[min(340px,calc(100vw-48px))] items-center justify-center font-sans text-callout text-foreground-hint">
      {formatMessage({ id: "layout.sidebar.loadingEmoji" })}
    </div>
  );
}
