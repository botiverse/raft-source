/**
 * Inbox domain assembly — where RFC 037's layers meet for the inbox.
 *
 *   transport (L1) ─┐
 *                   ├─→ dispatch → applyInboxEvent (L2) → projections (L3)
 *   socket bridge ──┘         │
 *                             └─→ transition trace (I4) + reconcile scheduling
 *
 * This module builds the machine but does NOT turn it on: nothing imports
 * it in production yet. The S1 wiring PR replaces useInboxStore's internals
 * with this domain store behind a feature flag. Keeping assembly separate
 * from the reducer keeps the reducer pure and the wiring swappable.
 */

import { createEventStore } from "./createEventStore";
import type { EventStore } from "./createEventStore";
import {
  applyInboxEvent,
} from "./events/inboxEvents";
import type {
  InboxDomainState,
  InboxEvent,
  InboxTransition,
} from "./events/inboxEvents";
import {
  fetchInboxHydrate,
  fetchInboxReconcile,
  inboxPatchFromMessageNew,
} from "./transport/inboxTransport";
import type {
  InboxChannelContext,
  InboxSocketMessage,
  InboxWindowFetcher,
} from "./transport/inboxTransport";
import { installSocketBridge } from "./socketBridge";
import type { SocketLike } from "./socketBridge";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import type { InboxFilter } from "./inboxStore";

const INITIAL_STATE: InboxDomainState = {
  filter: "all",
  items: [],
  hasMore: true,
  totalCount: 0,
  totalUnreadCount: 0,
};

export interface InboxDomain {
  store: EventStore<InboxDomainState, InboxEvent, InboxTransition>;
  /** Intent: initial load or pagination. */
  loadWindow(args: { filter: InboxFilter; reset: boolean }): Promise<void>;
  /** Intent: server-truth re-pull (reconnect / visibility / patch-miss). */
  reconcile(): Promise<void>;
  /** Install the socket → dispatch bridge. Returns uninstall. */
  bindSocket(socket: SocketLike, resolveChannelContext: (msg: InboxSocketMessage) => InboxChannelContext | null): () => void;
}

export function createInboxDomain(options: {
  fetcher?: InboxWindowFetcher;
  /** Trace tap override for tests; production default emits a web trace. */
  onTransition?: (transition: InboxTransition, event: InboxEvent) => void;
} = {}): InboxDomain {
  let reconcileScheduled = false;

  // Coalesced server-truth pull: reducer reconcile suggestions AND transport
  // gaps (e.g. a message:new whose channel context is not resolvable yet)
  // funnel here; bursts collapse into one pull per microtask queue.
  function scheduleReconcile() {
    if (reconcileScheduled) return;
    reconcileScheduled = true;
    void Promise.resolve().then(() => {
      reconcileScheduled = false;
      return domain.reconcile();
    });
  }

  const store = createEventStore<InboxDomainState, InboxEvent, InboxTransition>({
    name: "inbox",
    initialState: INITIAL_STATE,
    reduce: applyInboxEvent,
    onTransition: (transition, event) => {
      (options.onTransition ?? defaultTransitionTap)(transition, event);
      // The reducer never does I/O (I1); the wiring answers its suggestions.
      if (transition.reconcileSuggested) scheduleReconcile();
    },
  });

  function defaultTransitionTap(transition: InboxTransition, _event: InboxEvent): void {
    emitStateTransitionTrace({
      domain: "inbox",
      event: transition.event,
      entityId: "inbox",
      touched: transition.touched,
      outcomeDetail: transition.totalUnreadDelta === 0 ? "unread_stable" : "unread_changed",
      reconcileSuggested: transition.reconcileSuggested,
    });
  }

  const domain: InboxDomain = {
    store,

    async loadWindow(args) {
      const state = store.getState();
      const event = await fetchInboxHydrate(
        { filter: args.filter, offset: state.items.length, reset: args.reset },
        options.fetcher,
      );
      store.dispatch(event);
    },

    async reconcile() {
      const event = await fetchInboxReconcile(store.getState().filter, options.fetcher);
      store.dispatch(event);
    },

    bindSocket(socket, resolveChannelContext) {
      return installSocketBridge(socket, "inbox-domain", [
        {
          event: "message:new",
          handler: (payload) => {
            const msg = payload as InboxSocketMessage;
            const context = resolveChannelContext(msg);
            if (!context) {
              // Guardrail (S1 design Q2): context unresolvable (e.g. dm:new
              // registration race) — never drop the row silently; fall back
              // to one coalesced server-truth pull.
              scheduleReconcile();
              return;
            }
            const patch = inboxPatchFromMessageNew(msg, context);
            if (patch) store.dispatch(patch);
          },
        },
        // S1 wiring extends this binding list: thread:updated, dm:new,
        // read-state sync. Each is payload → adapter → dispatch, nothing else.
      ]);
    },
  };

  return domain;
}
