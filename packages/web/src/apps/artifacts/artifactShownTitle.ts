import { useSyncExternalStore } from "react";

import { artifactCardSeed } from "./artifactOpenIntent";
import { useArtifactViewerStore } from "./artifactViewerStore";

/**
 * The title of the Artifact open beside a conversation, for something outside the viewer that names it while the
 * viewer itself is not on screen (the side window's switch chip, while the built-in browser is in front of it:
 * features/webPreview). The side card's viewer reports the title it shows (ArtifactViewer's `onShownTitle`) and the
 * last one is kept per Artifact here, outside React state: only a reader of this hook renders again when it changes.
 */
const titles = new Map<string, string>();
const listeners = new Set<() => void>();

/** The side card's viewer shows `title` for the Artifact `id` (null as it goes: the last title is kept). */
export function rememberArtifactShownTitle(id: string, title: string | null): void {
  if (title === null || titles.get(id) === title) return;
  titles.set(id, title);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The title of the Artifact open beside `channelId`: the one its viewer last showed, else its opener's card's
 * (artifactCardSeed); null where none is open there or nothing is known of it yet.
 */
export function useOpenArtifactTitle(channelId: string | null | undefined): string | null {
  const open = useArtifactViewerStore((s) => (channelId && s.open?.conversationId === channelId ? s.open : null));
  const id = open?.id ?? null;
  const shown = useSyncExternalStore(subscribe, () => (id ? titles.get(id) ?? null : null), () => null);
  if (!open) return null;
  return shown ?? artifactCardSeed({ id: open.id, version: open.version })?.title ?? null;
}
