import type { ArtifactId, ArtifactSettled } from "@botiverse/raft-shared";

/**
 * The reader's own settles and unsettles (#334), as they are answered, wherever they were made: the home page's menu
 * (useArtifactHomeGroups) or the viewer's ⋯ and details (useArtifactSettle). The home page listens, so its row moves
 * at once even when the act was made in the viewer over it (the prototype's rule: the reader's own act moves it;
 * nothing else does while the page is open). `seq` orders them (decideHomeGroups' `acts`).
 */
export interface ArtifactOwnSettle {
  id: ArtifactId;
  /** The answer's state: who settled it, or null (Working). */
  settled: ArtifactSettled | null;
  seq: number;
}

type Listener = (act: ArtifactOwnSettle) => void;

const listeners = new Set<Listener>();
let lastSeq = 0;

/** A settle or unsettle of the reader's was answered: everyone listening hears it. */
export function reportOwnSettle(id: ArtifactId, settled: ArtifactSettled | null): void {
  lastSeq += 1;
  const act = { id, settled, seq: lastSeq };
  for (const listener of [...listeners]) listener(act);
}

/** Hear the reader's own settles and unsettles; returns the unsubscribe. */
export function onOwnSettle(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
