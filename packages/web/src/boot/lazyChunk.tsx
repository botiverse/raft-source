import { Component, lazy, useCallback, useState } from "react";
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import { isDynamicImportFailure, reloadIfReleaseSuperseded } from "../utils/dynamicImportRecovery";

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

/** Where a lazy chunk lives, module-wide: a retry that loads replaces a failed one for every later open. */
export type LazyChunkSlot<P extends object> = { current: LazyExoticComponent<ComponentType<P>> };

/**
 * A lazily loaded chunk (a deferred dialog or panel, the Artifact viewer and
 * frame) that can be retried. React.lazy keeps a failed load, so every later
 * render of the same component fails again: a retry renders a new lazy
 * component over the same import, and puts it in the slot once it loads, so
 * the next open starts from the working one rather than the failed one.
 */
export function useRetryableLazy<P extends object>(
  slot: LazyChunkSlot<P>,
  factory: Loader<P>,
): { Chunk: LazyExoticComponent<ComponentType<P>>; attempt: number; retry: () => void; forgetFailed: () => void } {
  // The new lazy component is made in the retry itself, not during render: a
  // render that suspends can be thrown away and run again (this hook inside
  // the Suspense boundary it suspends, as deferredPanel's and deferredDialog's
  // are), and a lazy component made there would be a new one, suspending, each
  // time, forever.
  const [{ Chunk, attempt }, setState] = useState(() => ({ Chunk: slot.current, attempt: 0 }));
  const retry = useCallback(() => {
    // The file may be gone with the release this page came from: onto the kept one.
    if (reloadIfReleaseSuperseded()) return;
    const next = lazy(() => factory().then((module) => {
      slot.current = next;
      return module;
    }));
    setState((current) => ({ Chunk: next, attempt: current.attempt + 1 }));
  }, [slot, factory]);
  // After a failure the slot gets a fresh lazy component (not rendered now),
  // so the next open asks the network again instead of the kept failure.
  const forgetFailed = useCallback(() => {
    slot.current = lazy(factory);
  }, [slot, factory]);
  return { Chunk, attempt, retry, forgetFailed };
}

/**
 * Catches a chunk that failed to download (offline before the background
 * fetch, a deploy that removed it) so it shows its own failed state instead of
 * reaching the app's RootErrorBoundary. Any other error (a render bug in the
 * chunk) is not a download failure: it goes on up as before. `resetKey`
 * changes on a retry.
 */
export class LazyChunkBoundary extends Component<
  { resetKey: unknown; failed: ReactNode; children: ReactNode; onFailed?: (error: unknown) => void },
  { error: unknown; resetKey: unknown }
> {
  state: { error: unknown; resetKey: unknown } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("chunk failed") };
  }

  componentDidCatch(error: unknown) {
    if (isDynamicImportFailure(error)) this.props.onFailed?.(error);
  }

  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { error: unknown; resetKey: unknown }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isDynamicImportFailure(error)) throw error;
    return this.props.failed;
  }
}
