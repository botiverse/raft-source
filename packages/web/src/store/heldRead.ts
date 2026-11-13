/**
 * Fetch-at-click (#triage:8c0d2318): a read sent at the click that opens a
 * view, held for the view's own loader to take instead of sending the same
 * read again. Network only: the loader applies the answer, with every store
 * side effect, when the view mounts, as before.
 *
 * One read per slot, taken once; keyed by the request (URL and params), who
 * it is read for and the server epoch, so another person's or another
 * server's read is never taken. In flight it can be joined for HOLD_MS; once
 * answered, only for ANSWER_HOLD_MS: an older answer could undo an edit,
 * reaction or delete made since, so the view reads again. A read that
 * failed is held the same way: its view reports that failure, as it would
 * its own read's, without reading again. A new send of the same read (the
 * thread or conversation opened again) does not reuse a failure: it reads
 * afresh.
 */
import type { AxiosResponse } from "axios";
import api from "../api/client";
import { captureReceiverPrivateIngressContext } from "./receiverPrivateIngress";
import type { ReceiverPrivateIngressContext } from "./receiverPrivateIngress";
import { useServerStore } from "./serverStore";

export interface HeldReadRequest {
  url: string;
  config?: { params: Record<string, unknown> };
}

// The answer is typed as its loader types its own api.get answer.
type Answer = AxiosResponse;

export interface TakenRead {
  request: Promise<Answer>;
  /** Who it was read for: the loader drops an answer read for someone else. */
  ingressContext: ReceiverPrivateIngressContext;
  /** What the sender noted at the send (a conversation's newest seq then). */
  seqAtSend: number;
}

interface Held extends TakenRead {
  key: string;
  sentAt: number;
  answeredAt: number | null;
  failed: boolean;
}

/** A read in flight its view has not joined by then is not joined. */
const HOLD_MS = 10_000;
/** An answered read its view has not taken by then is not taken: it may miss changes made since. */
const ANSWER_HOLD_MS = 2_000;

let clock: () => number = () => Date.now();

function usable(entry: Held): boolean {
  const now = clock();
  return entry.answeredAt === null ? now - entry.sentAt < HOLD_MS : now - entry.answeredAt < ANSWER_HOLD_MS;
}

function readKey(request: HeldReadRequest, userId: string | null): string {
  return `${useServerStore.getState().serverEpoch}|${userId ?? ""}|${request.url}|${JSON.stringify(request.config?.params ?? null)}`;
}

export interface HeldReadSlot {
  send(request: HeldReadRequest, userId: string | null, seqAtSend?: number): void;
  take(request: HeldReadRequest, userId: string | null): TakenRead | null;
  /** As take, only while it is unanswered: an answer already in may predate changes made since (it is dropped). */
  takeInFlight(request: HeldReadRequest, userId: string | null): TakenRead | null;
  reset(): void;
}

export function createHeldRead(): HeldReadSlot {
  let held: Held | null = null;
  return {
    send(request, userId, seqAtSend = 0) {
      try {
        const key = readKey(request, userId);
        if (held?.key === key && usable(held) && !held.failed) return;
        const ingressContext = captureReceiverPrivateIngressContext(userId);
        const sent = api.get(request.url, request.config);
        const entry: Held = { key, request: sent, ingressContext, seqAtSend, sentAt: clock(), answeredAt: null, failed: false };
        // Its failure is its taker's to report (and not an unhandled rejection).
        sent.then(() => {
          entry.answeredAt = clock();
        }, () => {
          entry.answeredAt = clock();
          entry.failed = true;
        });
        held = entry;
      } catch {
        held = null;
      }
    },
    take(request, userId) {
      const entry = held;
      if (!entry || entry.key !== readKey(request, userId)) return null;
      held = null;
      if (!usable(entry)) return null;
      return { request: entry.request, ingressContext: entry.ingressContext, seqAtSend: entry.seqAtSend };
    },
    takeInFlight(request, userId) {
      const entry = held;
      if (!entry || entry.key !== readKey(request, userId)) return null;
      held = null;
      if (entry.answeredAt !== null || !usable(entry)) return null;
      return { request: entry.request, ingressContext: entry.ingressContext, seqAtSend: entry.seqAtSend };
    },
    reset() {
      held = null;
    },
  };
}

export function __setHeldReadClockForTest(next?: () => number): void {
  clock = next ?? (() => Date.now());
}
