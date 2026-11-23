import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Socket } from "socket.io-client";
import { z } from "zod";
import { clearClockTimeout, currentRandomUnit, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { LINK_CARD_CHANGED_EVENT, linkCardObjectKeySha256Schema } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardChangedEvent, LinkCardObjectKeySha256 } from "@botiverse/raft-shared/src/appLinkPreview";
import { getSocket, onSocketCreated } from "../../api/socket";
import { linkCardViewKey, useLinkCardActionStore } from "./linkCardExecute";
import type { LinkCardMessageView } from "./linkCardExecute";

// Link cards that update themselves, web side (docs/development/app-link-previews.md,
// "Telling Raft a card changed" and "Web display"). An App tells Raft an
// object changed; Raft sends `link_card.changed { app, object_key_sha256 }`
// to the viewer's own room on this Server, with no content. A card whose read
// item carried the same `object_key_sha256` (declared with `card.changed.v1`,
// linkCardRead.ts) is read again here, as Refresh reads it
// (useAppLinkPreviews' message view), so every rule of that read stays. The
// digest names the App too (Raft hashes the App's id with its label), so the
// digest alone is compared, as the protocol asks.

/** A nudged card is read again after a random wait of up to this, so its readers don't all ask the App at once. */
export const LINK_CARD_CHANGED_JITTER_MS = 2_000;

const eventSchema = z.object({ app: z.string().min(1).max(200), object_key_sha256: linkCardObjectKeySha256Schema });
type Listener = (event: LinkCardChangedEvent) => void;
const listeners = new Set<Listener>();
let sockets: Socket[] = [];
let stopFollowingSockets: (() => void) | null = null;
let random: () => number = currentRandomUnit;

function onChanged(payload: unknown) {
  const event = eventSchema.safeParse(payload);
  if (!event.success) return;
  for (const listener of [...listeners]) listener(event.data);
}
/** Starts taking the nudges of this tab's sockets (the current one and any made later), once. */
export function listenForLinkCardChanged() {
  if (stopFollowingSockets) return;
  const attach = (socket: Socket) => {
    socket.on(LINK_CARD_CHANGED_EVENT, onChanged);
    sockets.push(socket);
  };
  attach(getSocket());
  stopFollowingSockets = onSocketCreated(attach);
}
/** Calls `listener` with each well-formed nudge taken (listenForLinkCardChanged), until the returned stop. */
export function onLinkCardChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Tests: detach from the sockets and forget the jitter's random source. */
export function resetLinkCardChangedForTests(nextRandom: (() => number) | null = null) {
  for (const socket of sockets) socket.off(LINK_CARD_CHANGED_EVENT, onChanged);
  sockets = [];
  stopFollowingSockets?.();
  stopFollowingSockets = null;
  random = nextRandom ?? currentRandomUnit;
}

const viewState = (view: LinkCardMessageView, url: string) => useLinkCardActionStore.getState().views[linkCardViewKey(view, url)];
/**
 * Whether the card's buttons are busy or one of its operations is open: that
 * work reads the card again when it ends. Raft's confirm dialog open on it
 * (`confirming`) is not: the re-read waits for it to close (`engaged`).
 */
export function linkCardViewBusy(view: LinkCardMessageView, url: string): boolean {
  const state = viewState(view, url);
  return (!!state?.busy && state.busy !== "confirming") || !!state?.operation;
}

/**
 * A nudged object is read again at most once per this per message view: a
 * nudge within it of the last re-read of that object waits for its end, and
 * every nudge meanwhile is that one read (Remy). Six reads of an object a
 * minute at most, with no budget to run out, so a card never stays old for good.
 */
export const LINK_CARD_CHANGED_MIN_INTERVAL_MS = 10_000;

/** Reports whether `element` is on screen (its IntersectionObserver's reports) until `report` returns false. Returns its cancel. */
function watchScreen(element: Element, report: (onScreen: boolean) => boolean): () => void {
  const observer = new IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (entry && !report(entry.isIntersecting)) observer.disconnect();
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/** Resolves once `start` calls its `done` (`start` returns its cancel); rejects when `signal` aborts first. */
function until(signal: AbortSignal, start: (done: () => void) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop = () => {};
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      stop();
      if (ok) resolve();
      else reject(new Error("cancelled"));
    };
    const onAbort = () => settle(false);
    if (signal.aborted) return settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    const cancel = start(() => settle(true));
    if (settled) cancel();
    else stop = cancel;
  });
}

/**
 * Whether the pointer is over `element`, as the browser answers it, where the
 * primary pointer hovers: a tap leaves `:hover` behind on touch screens.
 */
function hovered(element: Element): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(hover: hover)").matches && element.matches(":hover");
  } catch {
    return false;
  }
}

type Job = { controller: AbortController; reading: boolean; again: boolean };

/**
 * A mounted message's part of link_card.changed. On a nudge whose digest one
 * of its shown cards carries (`keyedUrls`):
 * 1. wait until the message is on screen (a mounted row off screen, in the
 *    list's overscan or scrolled away, waits rather than keeping the old card);
 * 2. wait a random 1 ms to 2 s, and at least until
 *    LINK_CARD_CHANGED_MIN_INTERVAL_MS after this object's last re-read here,
 *    then until the page's reads are no longer held (`afterHold`);
 * 3. wait while the person is on the message (`engaged`: the pointer over it,
 *    focus in it, a hover card, menu or popover of it open, Raft's confirm
 *    dialog open on one of those cards), so no card changes under them (Kirby);
 * 4. on screen again if it left meanwhile, read each of those links again
 *    (`reread`). A link answered rate_limited (`reread` says true: one of the
 *    view's rate-limited re-reads) goes again after the hold, from 3.
 * Nudges for an object while it waits are that read; one that comes while it
 * reads starts another after it (the interval applies). Unmounting cancels.
 */
export function useLinkCardChangedRereads({ enabled, target, view, keyedUrls, afterHold, reread }: {
  enabled: boolean;
  target: RefObject<Element | null>;
  /** The message view its cards act through (Raft's confirm dialog on one of them). */
  view: LinkCardMessageView;
  /** The links of the answer shown whose card carries this digest. */
  keyedUrls: (key: LinkCardObjectKeySha256) => string[];
  /** Runs `go` after `delayMs` once the page's reads are no longer held; returns its cancel. */
  afterHold: (delayMs: number, go: () => void) => () => void;
  /** Reads one link again as Refresh does; true when it was rate_limited and may go again. */
  reread: (url: string) => Promise<boolean>;
}) {
  // The latest render's, for nudges (which only come after a commit).
  const latest = useRef({ view, keyedUrls, afterHold, reread });
  useEffect(() => {
    latest.current = { view, keyedUrls, afterHold, reread };
  });
  useEffect(() => {
    const element = target.current;
    // No IntersectionObserver (old WebViews): its links are plain anyway.
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    listenForLinkCardChanged();
    const jobs = new Map<string, Job>();
    const lastRead = new Map<string, number>();
    // A mouse or pen over the message (a touch leaves nothing over it).
    let pointerInside = false;
    const enter = (event: Event) => {
      if (!("pointerType" in event) || event.pointerType !== "touch") pointerInside = true;
    };
    const leave = () => {
      pointerInside = false;
    };
    element.addEventListener("pointerover", enter);
    element.addEventListener("pointerleave", leave);

    const onScreen = (signal: AbortSignal) => until(signal, (done) => watchScreen(element, (on) => {
      if (on) done();
      return !on;
    }));
    const held = (signal: AbortSignal, delayMs: number) => until(signal, (done) => latest.current.afterHold(delayMs, done));
    const engaged = (key: LinkCardObjectKeySha256) => pointerInside || hovered(element) || element.contains(document.activeElement)
      || element.querySelector("[data-popup-open]") !== null
      || latest.current.keyedUrls(key).some((url) => viewState(latest.current.view, url)?.busy === "confirming");
    // Checked again as the pointer or focus leaves, a popup closes, or the dialog does.
    const idle = (signal: AbortSignal, key: LinkCardObjectKeySha256) => until(signal, (done) => {
      let timer: unknown = null;
      const check = () => {
        if (!engaged(key)) done();
      };
      // Focus has moved on only after focusout, `:hover` after pointerleave.
      const later = () => {
        if (timer !== null) clearClockTimeout(timer);
        timer = setClockTimeout(check, 0);
      };
      const popups = new MutationObserver(check);
      popups.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-popup-open"] });
      const unsubscribe = useLinkCardActionStore.subscribe(check);
      element.addEventListener("pointerleave", later);
      element.addEventListener("focusout", later);
      check();
      return () => {
        if (timer !== null) clearClockTimeout(timer);
        popups.disconnect();
        unsubscribe();
        element.removeEventListener("pointerleave", later);
        element.removeEventListener("focusout", later);
      };
    });

    const start = (key: LinkCardObjectKeySha256) => {
      const job: Job = { controller: new AbortController(), reading: false, again: false };
      jobs.set(key, job);
      const { signal } = job.controller;
      void (async () => {
        await onScreen(signal);
        const sinceLast = currentTimeMs() - (lastRead.get(key) ?? Number.NEGATIVE_INFINITY);
        let delayMs = Math.max(1 + Math.floor(random() * LINK_CARD_CHANGED_JITTER_MS), LINK_CARD_CHANGED_MIN_INTERVAL_MS - sinceLast);
        let urls = latest.current.keyedUrls(key);
        while (urls.length) {
          await held(signal, delayMs);
          await idle(signal, key);
          await onScreen(signal);
          job.reading = true;
          lastRead.set(key, currentTimeMs());
          const reading = latest.current.keyedUrls(key).filter((url) => urls.includes(url));
          const limited = await Promise.all(reading.map((url) => latest.current.reread(url)));
          if (signal.aborted) return;
          urls = reading.filter((_, index) => limited[index]);
          delayMs = 0;
        }
      })().catch(() => {}).finally(() => {
        if (jobs.get(key) !== job) return;
        jobs.delete(key);
        if (job.again && !signal.aborted) start(key);
      });
    };
    const stop = onLinkCardChanged(({ object_key_sha256: key }) => {
      const job = jobs.get(key);
      if (job) {
        if (job.reading) job.again = true;
        return;
      }
      if (latest.current.keyedUrls(key).length) start(key);
    });
    return () => {
      stop();
      for (const job of jobs.values()) job.controller.abort();
      jobs.clear();
      element.removeEventListener("pointerover", enter);
      element.removeEventListener("pointerleave", leave);
    };
  }, [enabled, target]);
}
