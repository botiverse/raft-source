/**
 * UI that only an interaction opens (a dialog, a tab, a page off the default
 * route) stays out of the first download (docs/frontend/boot-bundle.md). It is
 * fetched in the background once the first screen is done, so it is usually
 * there before anyone opens it; opened earlier, it loads then.
 */
import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { FileX, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@botiverse/raft-ui";
import EmptyState from "../components/ui/EmptyState";
import { importHandledLocally, noteChunkFailureShownInPlace } from "../utils/dynamicImportRecovery";
import { LazyChunkBoundary, useRetryableLazy } from "./lazyChunk";
import type { LazyChunkSlot } from "./lazyChunk";
import { whenIdle } from "../utils/whenIdle";
import { loadedModule, sharedModule } from "./sharedModule";
import { restCatalogReady } from "../i18n/messages";

type Loader = () => Promise<unknown>;
type ComponentModule<P> = { default: ComponentType<P> };

const pending = new Set<Loader>();
let fetching = false;

function prefetch(load: Loader): void {
  // A failed prefetch is retried on first use, where the error can surface.
  whenIdle(() => void load().catch(() => {}));
}

/** The loaders deferredModule made: a deferredPanel or deferredDialog given one shares it, not wraps it. */
const backgroundLoaders = new WeakSet<() => Promise<unknown>>();

/**
 * A deferred module's loader: fetched in the background after the first
 * screen (fetchDeferredUi), and one promise for every caller (sharedModule),
 * so a load started early (the route the page opens on, a hover) is the one
 * the lazy component later reuses. A failed load is forgotten: the next call
 * fetches again.
 */
export function deferredModule<M>(factory: () => Promise<M>): () => Promise<M> {
  if (backgroundLoaders.has(factory)) return factory;
  const load = sharedModule(factory);
  if (fetching) prefetch(load);
  else pending.add(load);
  backgroundLoaders.add(load);
  return load;
}

/**
 * React.lazy, also fetched in the background after the first screen
 * (fetchDeferredUi). No boundary of its own: the caller shows a failed
 * download (the Artifact viewer's placeholder); a panel takes deferredPanel.
 */
export function lazyDeferred<P extends object>(
  factory: () => Promise<ComponentModule<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(deferredModule(factory));
}

/**
 * A component whose download failure stays in place: `failed` with Try again
 * (a new lazy component, boot/lazyChunk) instead of RootErrorBoundary. The
 * load someone is waiting on is importHandledLocally (no app-wide prompt);
 * the background prefetch and an early start are not, so a page whose
 * release was replaced still reloads onto the kept one (main.tsx), and Try
 * again does the same before asking again. After a failure the next open
 * starts from a fresh lazy component, so it asks the network again.
 */
function retryableDeferred<P extends object>(
  factory: () => Promise<ComponentModule<P>>,
  failed: (retry: () => void, props: P) => ReactNode,
  background = true,
): ComponentType<P> {
  const shared = background ? deferredModule(factory) : sharedModule(factory);
  const load = () => importHandledLocally(shared);
  const slot: LazyChunkSlot<P> = { current: lazy(load) };
  return function DeferredChunk(props: P) {
    const { Chunk, attempt, retry, forgetFailed } = useRetryableLazy(slot, load);
    // Code already in (prefetched, preloaded, opened before): rendered at once.
    // Through React.lazy it would suspend this first render anyway, and the
    // call site's fallback would show for React's reveal throttle (~300 ms).
    // Every lazy load goes through `shared`, so the module is recorded before
    // a lazy component resolves: a mounted chunk never changes type.
    const ChunkComponent = loadedModule(shared)?.default ?? (Chunk as unknown as ComponentType<P>);
    // Try again stays; a release gone from the server also gets the app's update strip.
    const onFailed = useCallback((error: unknown) => {
      forgetFailed();
      noteChunkFailureShownInPlace(error);
    }, [forgetFailed]);
    return (
      <LazyChunkBoundary resetKey={attempt} failed={failed(retry, props)} onFailed={onFailed}>
        <ChunkComponent {...props} />
      </LazyChunkBoundary>
    );
  };
}

/** A deferred panel's download failed: in its place, with Try again. */
function DeferredPanelFailed({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <div role="status" className="flex flex-1 items-center justify-center p-6" data-testid="deferred-panel-failed">
      <EmptyState
        icon={<FileX size={36} />}
        title={formatMessage({ id: "common.deferred.failedTitle" })}
        description={formatMessage({ id: "common.deferred.failedDescription" })}
        action={(
          <Button variant="outline" size="md" onClick={onRetry} data-testid="deferred-panel-retry">
            <RefreshCw />
            {formatMessage({ id: "common.deferred.retry" })}
          </Button>
        )}
      />
    </div>
  );
}

/**
 * A deferred panel or tab (lazyDeferred plus its own failed state). The call
 * site wraps it in Suspense with the fallback its place needs, as for any
 * lazy component; a failed download shows an inline failed state with Try
 * again there, not the app's error screen.
 */
export function deferredPanel<P extends object>(factory: () => Promise<ComponentModule<P>>): ComponentType<P> {
  return retryableDeferred(factory, (retry) => <DeferredPanelFailed onRetry={retry} />);
}

/**
 * deferredPanel without the background fetch: a page or panel that stays out
 * of the first download and loads only when it is opened (a page someone
 * lands on, a rare or dev-only page), as plain `React.lazy` does, but whose
 * failed download shows Try again in its place, not the app's error screen.
 * Under the call site's Suspense, as any lazy component.
 */
export function lazyPanel<P extends object>(factory: () => Promise<ComponentModule<P>>): ComponentType<P> {
  return retryableDeferred(factory, (retry) => <DeferredPanelFailed onRetry={retry} />, false);
}

/** A deferred dialog's download failed: a small dialog of its own, Try again or Close. */
function DeferredDialogFailed<P>({ onRetry, close, dialogProps }: { onRetry: () => void; close: (props: P) => void; dialogProps: P }) {
  const { formatMessage } = useIntl();
  const openChange = useCallback((open: boolean) => {
    if (!open) close(dialogProps);
  }, [close, dialogProps]);
  return (
    <AlertDialog open onOpenChange={openChange}>
      <AlertDialogContent data-testid="deferred-dialog-failed">
        <AlertDialogHeader>
          <AlertDialogTitle>{formatMessage({ id: "common.deferred.failedTitle" })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{formatMessage({ id: "common.deferred.failedDescription" })}</AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="lg" data-testid="deferred-dialog-close">{formatMessage({ id: "common.close" })}</AlertDialogCancel>
          <AlertDialogAction variant="primary" size="lg" onClick={onRetry} data-testid="deferred-dialog-retry">
            {formatMessage({ id: "common.deferred.retry" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface DeferredDialogOptions<P> {
  /**
   * Closes the dialog from its failed state (Close, Escape). Default: the
   * props' `onClose`, which every deferred dialog here takes.
   */
  close?: (props: P) => void;
}

function closeWithOnClose(props: object): void {
  const onClose = (props as { onClose?: unknown }).onClose;
  if (typeof onClose === "function") (onClose as () => void)();
}

/**
 * A deferred dialog: renders nothing until its code is in. A dialog has no
 * place on the page to hold a placeholder, and its code is normally already
 * fetched by the time it opens. A failed download opens a small dialog that
 * says so, with Try again and Close (`options.close`).
 */
export function deferredDialog<P extends object>(
  factory: () => Promise<ComponentModule<P>>,
  options: DeferredDialogOptions<P> = {},
): ComponentType<P> {
  return retryableDialog(factory, options, true);
}

/** deferredDialog without the background fetch: loaded only when it opens (a dialog few people ever see). */
export function lazyDialog<P extends object>(
  factory: () => Promise<ComponentModule<P>>,
  options: DeferredDialogOptions<P> = {},
): ComponentType<P> {
  return retryableDialog(factory, options, false);
}

function retryableDialog<P extends object>(
  factory: () => Promise<ComponentModule<P>>,
  options: DeferredDialogOptions<P>,
  background: boolean,
): ComponentType<P> {
  const close = options.close ?? closeWithOnClose;
  const Dialog = retryableDeferred(factory, (retry, props) => (
    <DeferredDialogFailed onRetry={retry} close={close} dialogProps={props} />
  ), background);
  return function DeferredDialog(props: P) {
    return (
      <Suspense fallback={null}>
        <Dialog {...props} />
      </Suspense>
    );
  };
}

/**
 * Fetch a module in the background once the first screen is done (the same
 * moment as the lazyDeferred modules), for code a lazy component loads but
 * which can't be declared with lazyDeferred itself. Safe at module top level.
 */
export function prefetchAfterFirstScreen(load: Loader): void {
  if (fetching) prefetch(load);
  else pending.add(load);
}

/**
 * Requests the first screen doesn't need (notification centre, saved,
 * announcements, ...) wait for it, so a heavy account's first conversation
 * isn't queued behind them (web perf, #proj-workspace:f07141a9). Only the app
 * entry arms the gate (main.tsx); anywhere else (tests, embeds) it is open.
 */
let firstScreenGateArmed = false;
let firstScreenDone = false;
const afterFirstScreenQueue = new Map<string | (() => void), () => void>();
const firstScreenListeners = new Set<() => void>();

/** main.tsx, before the app renders: hold first-screen-optional work until fetchDeferredUi. */
export function armFirstScreenGate(): void {
  if (!firstScreenDone) firstScreenGateArmed = true;
}

function isFirstScreenDone(): boolean {
  return !firstScreenGateArmed || firstScreenDone;
}

/**
 * Run `run` once the first screen is done (in idle time), or at once if it
 * already is. Work queued twice under one `key` runs once.
 */
export function afterFirstScreen(run: () => void, key?: string): void {
  if (isFirstScreenDone()) {
    run();
    return;
  }
  afterFirstScreenQueue.set(key ?? run, run);
}

/** Whether the first screen is done; re-renders when it becomes so. */
export function useFirstScreenDone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      firstScreenListeners.add(onChange);
      return () => firstScreenListeners.delete(onChange);
    },
    isFirstScreenDone,
    () => true,
  );
}

/** The first screen is done (main.tsx): fetch the deferred UI in the background, once. */
export function fetchDeferredUi(): void {
  if (fetching) return;
  fetching = true;
  // The rest of the shown locale's catalog first: every chunk below waits for it (i18n/messages/index.ts).
  prefetch(restCatalogReady);
  for (const load of pending) prefetch(load);
  pending.clear();
  openFirstScreenGate();
}

/**
 * Let the held work go (fetchDeferredUi, or main.tsx's fallback for a load
 * that shows no conversation). Once.
 */
let firstScreenOpening = false;
export function openFirstScreenGate(): void {
  if (firstScreenDone || firstScreenOpening) return;
  firstScreenOpening = true;
  // Flip, run and notify together, so every reader sees the same moment.
  whenIdle(() => {
    firstScreenDone = true;
    const queued = [...afterFirstScreenQueue.values()];
    afterFirstScreenQueue.clear();
    for (const run of queued) run();
    for (const listener of firstScreenListeners) listener();
  });
}

/** Test seam. */
export function __resetDeferredUiForTest(): void {
  pending.clear();
  fetching = false;
  firstScreenGateArmed = false;
  firstScreenDone = false;
  firstScreenOpening = false;
  afterFirstScreenQueue.clear();
  firstScreenListeners.clear();
}
