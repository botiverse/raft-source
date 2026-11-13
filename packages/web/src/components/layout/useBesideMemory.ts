import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

import { getEmbedMode } from "../../embed";
import { signedInPersonId, useAuthStore } from "../../store/authStore";
import {
  BESIDE_KINDS,
  besideKindsOf,
  isBesideEmpty,
  nextBesideState,
  normalizeBeside,
  onlyBesideKinds,
  planBesideRestore,
  recallBeside,
  rememberBeside,
  sameBeside,
  withoutBesideKinds,
} from "../../store/besideMemory";
import type { BesideKind, BesideState } from "../../store/besideMemory";
import { useServerStore } from "../../store/serverStore";
import { besideConversationOf, isBesideThreadTaken, readBesideAddress, withBesideAddress } from "./besideAddress";
import { checkBesideVisibility, peekBesideVisibility } from "./besideVisibility";
import type { BesideVisibilityAnswers, BesideVisibilityCheck } from "./besideVisibility";
import { isMessageLinkLanding } from "../../utils/messageLinkLanding";
import { syncRightPanelStoresFromSearch } from "./rightPanelUrlSync";
import { unitOf } from "./rowPlan";
import { pickRowTab, useRowPlanStore } from "./rowPlanStore";
import { useIsDesktopShell } from "./ShellFrame";

// Switching channels keeps what was open beside the conversation
// (docs/frontend/beside-memory.md). The address already is what is open
// beside a conversation (besideAddress.ts), so this hook only:
//
// - remembers, each time the address of a conversation's page changes, what
//   it names (besideMemory.ts: per person, server and conversation, on this
//   device), so a reload or a crash loses nothing;
// - on entering a conversation, adds what was remembered to the address, in
//   place of the entry (replace: no history entry, Back is unchanged). The
//   address wins: what it names is kept and in front, the remembered rest
//   opens behind it. Each remembered thing is first checked to be visible
//   still (besideVisibility.ts); one that is gone is forgotten, never shown.
//
// What is forgotten is only what the person closed (the address had it
// during this visit, then no longer) and what is gone. A remembered thing
// the address doesn't show because it was not restored (Back or Forward onto
// an entry without it, no answer about its visibility, a message link in the
// thread's place) is `held`: left in the memory as it was.
//
// Not on a phone (no column beside the conversation: a thread is a page
// there) nor in an embed or the host shell; not on Back or Forward, whose
// entry already says what it showed.

interface Visit {
  /** Person, server and conversation. */
  key: string;
  /** What the address showed last, with what is in front. */
  shown: BesideState;
  /** Remembered things the address has not shown in this visit: kept as they were. */
  held: BesideState;
  /** What was remembered in front on entering. */
  heldFront: BesideKind | undefined;
  /** What a restore puts in front, for the write that follows its navigation. */
  pick: BesideKind | null;
}

/**
 * The document's load, as this hook sees it: the router has not left the
 * location the hook first rendered on (a load on another page, then a move
 * here, counts that first location as the load; harmless, since only the
 * memory decides what such a POP restores). A load is a POP to the router (and a reloaded entry has its
 * old key, so the key says nothing); it restores, a later Back or Forward
 * doesn't.
 */
let loadKey: string | undefined;
let navigatedSinceLoad = false;

/** Tests only: the next render is the document's load again. */
export function resetBesideMemoryForTest(): void {
  loadKey = undefined;
  navigatedSinceLoad = false;
}

/** The unit `kind` shows in, and the tab group's key where its column holds tabs. */
function tabOf(kind: BesideKind): { present: boolean; group: string | null; unit: string | null } {
  const { plan } = useRowPlanStore.getState();
  const index = plan ? unitOf(plan.units, kind) : -1;
  if (!plan || index < 0) return { present: false, group: null, unit: null };
  const group = plan.groups.find((units) => units.includes(index));
  if (!group || group.length < 2) return { present: true, group: null, unit: null };
  return { present: true, group: plan.units[group[0]!]!.key, unit: plan.units[index]!.key };
}

export function useBesideMemory(check: BesideVisibilityCheck = checkBesideVisibility): void {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const desktop = useIsDesktopShell();
  const userId = useAuthStore((s) => signedInPersonId(s));
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const conversation = besideConversationOf(location.pathname);
  // The server in the store is the address's (a switch in flight is not yet).
  const conversationId = desktop && !getEmbedMode().embedded && userId && serverId && conversation?.serverSlug === serverSlug ? conversation.conversationId : null;
  const key = conversationId ? `${userId}:${serverId}:${conversationId}` : null;

  const visit = useRef<Visit | null>(null);
  /** What to bring in front once the restored things are in the row, and the tab this hook picked for it. */
  const front = useRef<{ kind: BesideKind; kinds: BesideKind[] } | null>(null);
  const ownPick = useRef(false);
  const latest = useRef({ navigationType, locationKey: location.key, check });
  latest.current = { navigationType, locationKey: location.key, check };

  const phoneAt = useRef<string | null>(null);
  // Layout effects, this one and the entry's below: a restore answered by
  // what the page already holds is in the first frame that shows the
  // conversation (a passive effect runs after that frame was painted).
  useLayoutEffect(() => {
    if (!desktop) phoneAt.current = location.key;
    if (loadKey === undefined) loadKey = location.key;
    else if (location.key !== loadKey) navigatedSinceLoad = true;
  });

  /** Remembers what the address shows now, with what is held. */
  const commit = useRef<(pick?: BesideKind | null) => void>(() => {});
  commit.current = (pick = null) => {
    const current = visit.current;
    if (!current || current.key !== key || !conversationId) return;
    const named = readBesideAddress(window.location.search, conversationId);
    current.shown = nextBesideState(current.shown, named, pick ?? current.pick);
    current.pick = null;
    current.held = withoutBesideKinds(current.held, besideKindsOf(named));
    const next = normalizeBeside({ ...current.held, ...current.shown, front: current.shown.front ?? current.heldFront });
    if (!sameBeside(recallBeside(userId, serverId, conversationId), next)) rememberBeside(userId, serverId, conversationId, next);
  };

  useLayoutEffect(() => {
    if (!key || !conversationId) {
      visit.current = null;
      front.current = null;
      return;
    }
    // A stale commit: the browser is already on another address, whose own run follows.
    if (location.pathname !== window.location.pathname || location.search !== window.location.search) return;
    if (visit.current?.key === key) {
      commit.current();
      return;
    }

    // Entering the conversation. What the address names is shown; the remembered rest is held.
    const { pathname, search } = location;
    const named = readBesideAddress(search, conversationId);
    const remembered = recallBeside(userId, serverId, conversationId);
    const entered: Visit = {
      key,
      shown: onlyBesideKinds(remembered, besideKindsOf(named)),
      held: withoutBesideKinds(remembered ?? {}, besideKindsOf(named)),
      heldFront: remembered?.front,
      pick: null,
    };
    visit.current = entered;
    front.current = null;
    commit.current();

    // Back and Forward land on an entry that says what it showed (the load is a POP too, and restores);
    // a window widened from a phone's layout entered nothing.
    const traversal = (latest.current.navigationType === "POP" && navigatedSinceLoad) || phoneAt.current === latest.current.locationKey;
    if (traversal) return;
    const plan = planBesideRestore({ ...entered.held, front: entered.heldFront }, named, { threadTaken: isBesideThreadTaken(search) });
    if (isBesideEmpty(plan.restore)) return;

    const restore = (answers: BesideVisibilityAnswers) => {
      // The person may have moved on, or opened and closed things by hand, while the answers were on their way.
      if (visit.current !== entered || window.location.pathname !== pathname) return;
      const live = window.location.search;
      const now = readBesideAddress(live, conversationId);
      const waiting = besideKindsOf(plan.restore).filter((kind) => sameBeside(onlyBesideKinds(entered.held, [kind]), onlyBesideKinds(plan.restore, [kind])));
      const gone = waiting.filter((kind) => answers[kind] === "gone");
      entered.held = withoutBesideKinds(entered.held, gone);
      const opening = waiting.filter((kind) => answers[kind] === "visible" && now[kind] === undefined && !(kind === "thread" && isBesideThreadTaken(live)));
      const next = withBesideAddress(live, conversationId, onlyBesideKinds(plan.restore, opening));
      if (opening.length === 0 || next === live) {
        commit.current();
        return;
      }
      const named = besideKindsOf(now);
      const inFront = named[0] ?? (plan.front && opening.includes(plan.front) ? plan.front : opening[0]!);
      entered.pick = inFront;
      front.current = { kind: inFront, kinds: [...named, ...opening] };
      // In place of the entry: the address then opens them as it opens anything, and the next run remembers it.
      void navigate({ pathname, search: next }, { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr });
      // The router renders the new address in a transition, a whole pass of
      // the conversation later (about 0.2 s of the conversation alone). The
      // address is already the new one (the replace above is synchronous), so
      // its panels are opened now, as the address's own sync would open them
      // after that pass; it then finds them open and does nothing.
      // Not on a message link the app landed on: the layout may reject that
      // link whole (its thread another conversation's), and only the
      // address's own sync applies that rule; it opens them a pass later.
      if (!isMessageLinkLanding(pathname, live) && window.location.pathname === pathname && window.location.search === next) syncRightPanelStoresFromSearch(next);
    };

    // Answered by what the page already holds: restored at once, in this same pass. Else once the answers are in.
    const known = peekBesideVisibility(conversationId, plan.restore);
    if (known && latest.current.check === checkBesideVisibility) restore(known);
    else void latest.current.check(conversationId, plan.restore).then(restore, () => {});
  }, [key, conversationId, userId, serverId, location, navigate]);

  useEffect(() => () => {
    visit.current = null;
  }, []);

  // Which one is in front: a tab the person picks is remembered, and a restore picks the remembered one's tab.
  useEffect(() => useRowPlanStore.subscribe((state, previous) => {
    if (state.active !== previous.active) {
      if (ownPick.current) return;
      front.current = null;
      const unit = Object.entries(state.active).find(([group, picked]) => previous.active[group] !== picked)?.[1];
      const regions = state.plan?.units.find((candidate) => candidate.key === unit)?.regions ?? [];
      const picked = BESIDE_KINDS.find((kind) => regions.includes(kind));
      if (picked) commit.current(picked);
      return;
    }
    const wanted = front.current;
    if (state.plan === previous.plan || !wanted || !wanted.kinds.every((kind) => tabOf(kind).present)) return;
    front.current = null;
    const { group, unit } = tabOf(wanted.kind);
    if (!group || !unit || state.active[group] === unit) return;
    ownPick.current = true;
    try {
      pickRowTab(group, unit);
    } finally {
      ownPick.current = false;
    }
  }), []);
}
