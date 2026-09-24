/**
 * createEventStore — the L2 wiring machinery of RFC 037.
 *
 * Binds a pure domain reducer (store/events/*) to a zustand store and gives
 * the rest of the app exactly ONE way to change domain state: `dispatch`.
 * Every dispatch:
 *   1. runs the reducer (pure, unit-tested in isolation),
 *   2. preserves reference identity on no-op transitions (touched === 0
 *      never calls set() — the CLAUDE.md zustand identity contract),
 *   3. reports the reducer's transition summary to `onTransition` — the
 *      single tap point where RFC 037 I4 tracing attaches.
 *
 * Domain stores built on this helper hold ONLY reducer-owned state. UI
 * state (scroll positions, focus) stays in plain zustand next door; it is
 * not part of the event-sourced domain.
 */

import { create } from "zustand";

/** Minimal transition contract every RFC 037 reducer result must satisfy. */
export interface TransitionSummaryLike {
  event: string;
  touched: number;
  reconcileSuggested?: boolean;
}

export interface EventStoreConfig<TState extends object, TEvent, TTransition extends TransitionSummaryLike> {
  /** Domain name, used as the `domain` attr on transition traces. */
  name: string;
  initialState: TState;
  reduce: (state: TState, event: TEvent) => { state: TState; transition: TTransition };
  /**
   * Transition tap — the ONLY sanctioned side-channel out of a dispatch.
   * The default wiring emits a `slock.state.transition` web trace; tests
   * inject a recorder; callers may also use it to schedule a reconcile
   * when `transition.reconcileSuggested` is set (the reducer itself never
   * performs I/O — RFC 037 I1).
   */
  onTransition?: (transition: TTransition, event: TEvent) => void;
}

export interface EventStore<TState extends object, TEvent, TTransition extends TransitionSummaryLike> {
  /** Read the current domain state (for projections and tests). */
  getState: () => TState;
  /** Subscribe to domain state changes (zustand semantics). */
  subscribe: (listener: (state: TState, previous: TState) => void) => () => void;
  /** The single mutation entrypoint. Returns the transition summary. */
  dispatch: (event: TEvent) => TTransition;
  /** React hook — components select from domain state (L4 read path). */
  useStore: <TSelected>(selector: (state: TState) => TSelected) => TSelected;
}

export function createEventStore<
  TState extends object,
  TEvent,
  TTransition extends TransitionSummaryLike,
>(config: EventStoreConfig<TState, TEvent, TTransition>): EventStore<TState, TEvent, TTransition> {
  const useZustandStore = create<TState>(() => config.initialState);

  function dispatch(event: TEvent): TTransition {
    const { state, transition } = config.reduce(useZustandStore.getState(), event);
    // No-op transitions must not create new references — subscribed
    // components see the exact same snapshot and skip re-rendering.
    if (transition.touched > 0) {
      // Replace-mode set: reducers MUST return the complete next state
      // (RFC 037 reducers do — they spread the previous state). A partial
      // return here would silently drop fields.
      useZustandStore.setState(state, true);
    }
    config.onTransition?.(transition, event);
    return transition;
  }

  return {
    getState: useZustandStore.getState,
    subscribe: useZustandStore.subscribe,
    dispatch,
    useStore: <TSelected,>(selector: (state: TState) => TSelected) => useZustandStore(selector),
  };
}
