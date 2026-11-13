/**
 * The trigger around a FaceStack and its count (Working now's `count`
 * summary): a control-rounded ghost button, the medium fill on hover, press
 * and while its popup is open, the focus shadow (the caller sets the count in mono type). The
 * height is the caller's (Working now: min-h-8; an Artifact's meta line: its
 * 27px row).
 */
export function faceStackTriggerClass({ onFrame = false }: { onFrame?: boolean } = {}): string {
  return [
    "relative inline-flex shrink-0 items-center gap-1.5 rounded-control px-1.5",
    onFrame
      ? "text-foreground-on-frame transition-colors hover:bg-fill-frame-medium active:bg-fill-frame-medium data-popup-open:bg-fill-frame-medium"
      : "text-foreground transition-colors hover:bg-fill-medium active:bg-fill-medium data-popup-open:bg-fill-medium",
    "outline-none focus-visible:shadow-focus",
  ].join(" ");
}
