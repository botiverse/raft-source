import { memo } from "react";
import type { ChangeEvent, RefObject } from "react";

const MEDIA_PICKER_ACCEPT = "image/*,video/*";
/**
 * The composer's two hidden file pickers, kept out of the composer's
 * re-renders: React 19 rewrites an `<input>`'s `name` and `type` on every
 * update of the element, so inline inputs churned DOM attributes on each
 * composer render (keystrokes, and every chat-panel render above it).
 * Memoized with stable props, they are committed once.
 */
export const ComposerFilePickers = memo(function ComposerFilePickers({
  imageInputRef,
  fileInputRef,
  onChange,
}: {
  imageInputRef: RefObject<HTMLInputElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <input
        ref={imageInputRef}
        data-testid="composer-media-input"
        type="file"
        accept={MEDIA_PICKER_ACCEPT}
        multiple
        className="hidden"
        onChange={onChange}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onChange}
      />
    </>
  );
});
