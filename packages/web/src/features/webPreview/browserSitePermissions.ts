import type { DesktopWebPreviewMediaKind } from "@botiverse/raft-shared";

// What the built-in browser's site permission parts share (the prompt bar, the site settings, the tab's indicator).

/** No device in use (one array, so a tab without any keeps the same props). */
export const NO_MEDIA: readonly DesktopWebPreviewMediaKind[] = [];

/** A site as the browser names it to the person: its host (`deck.raft.build`, `localhost:5173`). */
export function siteName(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** The message id for a sentence about the microphone, the camera, or both. */
export function mediaMessageId<P extends string>(prefix: P, kinds: readonly DesktopWebPreviewMediaKind[]): `${P}.microphone` | `${P}.camera` | `${P}.both` {
  const mic = kinds.includes("microphone");
  const camera = kinds.includes("camera");
  return mic && camera ? `${prefix}.both` : camera ? `${prefix}.camera` : `${prefix}.microphone`;
}
