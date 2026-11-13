/**
 * Two marks per channel id, both this person's (cleared on sign-out or an
 * account switch, resetChannelAccessLoss):
 *
 * - `lost`: channels this person can no longer read (removed from a private
 *   or shared channel while it was open). Marked only by an answer about that
 *   channel: the open channel stops asking `GET /messages/sync` for it (the
 *   heartbeat asked every 15 s, forever, after a removal) and shows "You're no
 *   longer in this channel" instead of an empty "Select a channel".
 * - `unavailable`: conversations a link or URL opened that `GET /channels/:id`
 *   refused (missing, deleted or not readable: one 404 for all), shown as
 *   "This conversation isn't available to you" (noteChannelOpenResult, from
 *   ensureChannel). It changes no request; a later answer that isn't a
 *   denial clears it.
 *
 * clearChannelAccessLost clears both: when the channel comes back (re-added:
 * `channel:updated` with joined, or a sync `scope` added) or when a check
 * answers it can be read.
 */
import { isAxiosError } from "axios";
import { create } from "zustand";

import api from "../api/client";
import { channelDetailRequestConfig } from "./channelDetailReason";

/**
 * The server's answers that mean "this channel, for this person": the bodies
 * of `denyChannelAccess` (403 for an ex-member, 404 otherwise, routes/
 * channelAccessDenial.ts) and `GET /channels/:id`'s 404. They carry no code,
 * so the body tells them from every other 403/404 (not a member of the
 * server, email verification, device sessions, an unknown server), which
 * must not say the person left this channel.
 */
const CHANNEL_ACCESS_DENIALS: Readonly<Record<number, readonly string[]>> = {
  403: ["Access denied", "You do not have access to this channel"],
  404: ["Channel not found or not visible", "Channel not found"],
};

export function isChannelAccessDenial(error: unknown): boolean {
  if (!isAxiosError(error) || !error.response) return false;
  const body = error.response.data as { error?: unknown; code?: unknown } | undefined;
  if (typeof body?.error !== "string" || body.code !== undefined) return false;
  return CHANNEL_ACCESS_DENIALS[error.response.status]?.includes(body.error) ?? false;
}

type ChannelAccessLossState = {
  lost: Readonly<Record<string, true>>;
  /**
   * Conversations a link or URL opened that the server refused to show
   * (`GET /channels/:id` answered with a denial): it doesn't exist, was
   * deleted, or this person can't read it. One answer for all of them, so the
   * page says one thing ("This conversation isn't available to you") instead
   * of an empty "Select a channel". A failed load that isn't a denial
   * (offline, a 500) is not one.
   */
  unavailable: Readonly<Record<string, true>>;
};

export const useChannelAccessLossStore = create<ChannelAccessLossState>(() => ({ lost: {}, unavailable: {} }));

export function useChannelAccessLost(channelId: string): boolean {
  return useChannelAccessLossStore((state) => state.lost[channelId] === true);
}

export function isChannelAccessLost(channelId: string | null | undefined): boolean {
  return Boolean(channelId && useChannelAccessLossStore.getState().lost[channelId]);
}

/** The marks are this person's: followSignedInUser clears them when the signed-in person changes, so they tell the next one nothing. */
export function resetChannelAccessLoss(): void {
  useChannelAccessLossStore.setState({ lost: {}, unavailable: {} });
}

export function clearChannelAccessLost(channelId: string): void {
  clearChannelUnavailable(channelId);
  if (!isChannelAccessLost(channelId)) return;
  useChannelAccessLossStore.setState(({ lost }) => {
    const rest = { ...lost };
    delete rest[channelId];
    return { lost: rest };
  });
}

export function useChannelUnavailable(channelId: string): boolean {
  return useChannelAccessLossStore((state) => state.unavailable[channelId] === true);
}

function clearChannelUnavailable(channelId: string): void {
  if (!useChannelAccessLossStore.getState().unavailable[channelId]) return;
  useChannelAccessLossStore.setState(({ unavailable }) => {
    const rest = { ...unavailable };
    delete rest[channelId];
    return { unavailable: rest };
  });
}

/**
 * Opening `channelId` (ensureChannel's `GET /channels/:id`) answered: `null`
 * when it could be read, else the error. Marks it unavailable only for a
 * denial; any other answer clears an earlier mark, so a later offline retry
 * doesn't keep saying it isn't available.
 */
export function noteChannelOpenResult(channelId: string, error: unknown): void {
  if (error === null || !isChannelAccessDenial(error)) {
    clearChannelUnavailable(channelId);
    return;
  }
  if (useChannelAccessLossStore.getState().unavailable[channelId]) return;
  useChannelAccessLossStore.setState(({ unavailable }) => ({ unavailable: { ...unavailable, [channelId]: true } }));
}

/** A read about `channelId` failed: mark it lost when the answer says so. */
export function noteChannelReadError(channelId: string | null | undefined, error: unknown): void {
  if (!channelId || isChannelAccessLost(channelId) || !isChannelAccessDenial(error)) return;
  useChannelAccessLossStore.setState(({ lost }) => ({ lost: { ...lost, [channelId]: true } }));
}

/**
 * A sync `scope` change for one channel. Removed is a membership change, not
 * always lost access (a public channel stays readable after leaving it), so
 * the channel is read once and marked only if that read is refused.
 */
export function applyChannelScopeChange(channelId: string, op: "added" | "removed"): void {
  if (op === "added") {
    clearChannelAccessLost(channelId);
    return;
  }
  api.get(`/channels/${channelId}`, channelDetailRequestConfig("refresh")).then(
    () => clearChannelAccessLost(channelId),
    (error: unknown) => noteChannelReadError(channelId, error),
  );
}
