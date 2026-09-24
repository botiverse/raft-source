const DOM_CAPTURE_SNAPSHOT_ATTRIBUTE = "data-dom-capture-snapshot";

export interface DomCaptureSnapshot {
  element: HTMLElement;
  dispose?: () => void;
}

export type DomCaptureSnapshotProvider = () =>
  | DomCaptureSnapshot
  | Promise<DomCaptureSnapshot>;

const providers = new WeakMap<HTMLElement, DomCaptureSnapshotProvider>();

/**
 * Registers a component-owned static representation for DOM capture.
 *
 * The live component keeps its interactive/security boundary. A capture
 * consumer only knows how to ask marked elements for a temporary, inert DOM
 * replacement; it never needs to import the component that owns the surface.
 */
export function registerDomCaptureSnapshot(
  element: HTMLElement,
  provider: DomCaptureSnapshotProvider,
): () => void {
  providers.set(element, provider);
  element.setAttribute(DOM_CAPTURE_SNAPSHOT_ATTRIBUTE, "");

  return () => {
    if (providers.get(element) !== provider) return;
    providers.delete(element);
    element.removeAttribute(DOM_CAPTURE_SNAPSHOT_ATTRIBUTE);
  };
}

function captureBoundaries(root: HTMLElement): HTMLElement[] {
  const candidates = [
    ...(root.hasAttribute(DOM_CAPTURE_SNAPSHOT_ATTRIBUTE) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(`[${DOM_CAPTURE_SNAPSHOT_ATTRIBUTE}]`),
  ];

  // An outer registered boundary owns its complete static representation.
  // Ignore nested boundaries that would otherwise be created and immediately
  // discarded when their registered ancestor replaces the cloned subtree.
  return candidates.filter((candidate) => !candidates.some(
    (other) => other !== candidate && other.contains(candidate),
  ));
}

/**
 * Replaces registered component boundaries in a deep clone with the static
 * snapshots supplied by their corresponding live elements.
 *
 * Source and clone are paired in document order. Missing providers or a clone
 * shape mismatch fail visibly instead of allowing a plausibly successful but
 * blank export.
 */
export async function materializeDomCaptureSnapshots(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
): Promise<() => void> {
  const sourceBoundaries = captureBoundaries(sourceRoot);
  const cloneBoundaries = captureBoundaries(cloneRoot);
  if (sourceBoundaries.length !== cloneBoundaries.length) {
    throw new Error("DOM capture snapshot boundary mismatch");
  }

  const disposers: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of disposers.reverse()) cleanup();
  };

  try {
    for (let index = 0; index < sourceBoundaries.length; index += 1) {
      const source = sourceBoundaries[index];
      const clone = cloneBoundaries[index];
      const provider = providers.get(source);
      if (!provider) throw new Error("DOM capture snapshot provider is unavailable");

      const snapshot = await provider();
      if (!(snapshot.element instanceof HTMLElement)) {
        snapshot.dispose?.();
        throw new Error("DOM capture snapshot provider returned an invalid element");
      }
      if (snapshot.dispose) disposers.push(snapshot.dispose);
      clone.replaceWith(snapshot.element);
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
