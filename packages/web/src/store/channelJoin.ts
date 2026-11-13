import { isAxiosError } from "axios";
import { startWebSpan } from "../utils/webAuthTrace";
import { whenIdle } from "../utils/whenIdle";
import { holdJoinDeferred, releaseJoinDeferred } from "./joinDeferred";

/** Where a join started: low-cardinality, recorded on the span. */
export type ChannelJoinSource = "channel_panel" | "thread_panel" | "forward";

export interface ChannelJoinSteps {
  /** POST the join. */
  post: (channelId: string) => Promise<unknown>;
  /** Apply the membership locally once the server has accepted it. */
  onJoined: (channelId: string) => void;
  /** Show or clear the Join button's joining state. */
  setJoining: (channelId: string, joining: boolean) => void;
  /** Load what opening the joined channel needs; settles when it is back, failed or not. Default: loadJoinedEssentials. */
  loadEssentials?: (channelId: string) => Promise<unknown>;
  /** Hold the channel's secondary loads; returns the hold's token. Default: the joinDeferred store. */
  holdSecondary?: (channelId: string) => number;
  /** End the hold with that token (a newer hold stays). Default: the joinDeferred store. */
  releaseSecondary?: (channelId: string, token: number) => void;
  /** Re-read the channel row after a failed join. Default: rereadChannelRow. */
  rereadRow?: (channelId: string) => Promise<unknown>;
}

/** The channel row again (channel info); the stores are imported lazily, as channelStore imports this module. */
function rereadChannelRow(channelId: string): Promise<unknown> {
  return import("./channelStore").then(({ useChannelStore }) => useChannelStore.getState().ensureChannel(channelId, { refresh: true }));
}

/**
 * What opening a just-joined channel needs: its row (channel info) and, when
 * it is the one on screen at its latest messages, that page again (what was
 * posted before the socket room was joined). That load's auto read follows,
 * so the channel does not show as unread now that it counts.
 */
export function loadJoinedEssentials(channelId: string): Promise<unknown> {
  return Promise.allSettled([
    rereadChannelRow(channelId),
    import("./messageStore").then(({ selectChannelWindowMeta, useMessageStore }) => {
      const messages = useMessageStore.getState();
      if (messages.currentChannelId !== channelId || selectChannelWindowMeta(messages, channelId).hasNewer) return;
      return messages.loadMessages(channelId);
    }),
  ]);
}

/** How long the span waits for the joined channel to be painted. Hidden tabs paint nothing. */
const PAINT_WAIT_MS = 1000;
/**
 * Longest the secondary loads stay held after a join is accepted, whatever
 * the essentials, the paint and the idle moment do; also how long after
 * acceptance the span waits for the essentials before it goes without
 * `essentials_ms`.
 */
export const SECONDARY_MAX_HOLD_MS = 3000;

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Resolves true after the next frame is painted, or false when the tab is
 * hidden or no frame comes within PAINT_WAIT_MS. Only the span waits on this,
 * never the join itself.
 */
function nextPaint(): Promise<boolean> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve(true);
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), PAINT_WAIT_MS);
    requestAnimationFrame(() => setTimeout(() => {
      clearTimeout(timer);
      resolve(true);
    }, 0));
  });
}

/** Adds or removes one channel id from the joining set. */
export function withJoining(ids: Record<string, true>, channelId: string, joining: boolean): Record<string, true> {
  if (joining) return { ...ids, [channelId]: true };
  const { [channelId]: _done, ...rest } = ids;
  return rest;
}

/**
 * One join per channel at a time (#proj-frontend:#23): a second click while the
 * first is in flight shares its request instead of sending another. Each join
 * is timed until the joined channel is painted as the `slock.channel.join`
 * span (#proj-frontend:#25), with `essentials_ms`: click to messages and
 * channel info both back. A joined channel fetches only those first; its
 * other loads wait for the paint and an idle moment (#proj-frontend:#24).
 */
export function joinChannelOnce(steps: ChannelJoinSteps) {
  const loadEssentials = steps.loadEssentials ?? loadJoinedEssentials;
  const holdSecondary = steps.holdSecondary ?? holdJoinDeferred;
  const releaseSecondary = steps.releaseSecondary ?? releaseJoinDeferred;
  const rereadRow = steps.rereadRow ?? rereadChannelRow;
  let inFlight = new Map<string, { request: Promise<boolean>; extraClicks: number }>();

  async function run(channelId: string, source: ChannelJoinSource, entry: { extraClicks: number }, holdToken: number): Promise<boolean> {
    const span = startWebSpan("slock.channel.join");
    const clickedAt = Date.now();
    let accepted = false;
    try {
      await steps.post(channelId);
      accepted = true;
      // Messages and channel info first; everything else waits (#proj-frontend:#24).
      steps.onJoined(channelId);
      const releaseBy = Date.now() + SECONDARY_MAX_HOLD_MS;
      const release = () => releaseSecondary(channelId, holdToken);
      const essentials = loadEssentials(channelId).then(() => Date.now() - clickedAt, () => Date.now() - clickedAt);
      const paint = nextPaint().then((painted) => ({ painted, at: Date.now() }));
      // Released at the first idle moment after both, within the cap; at the cap, at once.
      void within(Promise.all([essentials, paint]).then(() => true), SECONDARY_MAX_HOLD_MS, false).then((inTime) => {
        const left = releaseBy - Date.now();
        if (inTime && left > 0) whenIdle(release, left);
        else release();
      });
      // The span still ends at the paint; it only waits (up to the cap) to record when the essentials were back.
      void Promise.all([paint, within<number | undefined>(essentials, SECONDARY_MAX_HOLD_MS, undefined)])
        .then(([{ painted, at }, essentialsMs]) => span.end(
          "ok",
          { outcome: "joined", source, painted, extra_clicks: entry.extraClicks, essentials_ms: essentialsMs },
          at,
        ));
      return true;
    } catch (err) {
      releaseSecondary(channelId, holdToken);
      // A members-updated event dropped while the join was in flight (channelRealtimeSync) is not lost.
      void rereadRow(channelId).catch(() => {});
      console.error("Failed to join channel:", err);
      span.end("error", {
        outcome: accepted ? "apply_failed" : "failed",
        source,
        extra_clicks: entry.extraClicks,
        http_status: !accepted && isAxiosError(err) ? err.response?.status : undefined,
      });
      return false;
    }
  }

  function join(channelId: string, source: ChannelJoinSource = "channel_panel"): Promise<boolean> {
    const pending = inFlight.get(channelId);
    if (pending) {
      pending.extraClicks += 1;
      return pending.request;
    }
    const map = inFlight;
    const entry = { extraClicks: 0 } as { request: Promise<boolean>; extraClicks: number };
    map.set(channelId, entry);
    steps.setJoining(channelId, true);
    // From the click: a membership event the join itself causes must not start them either.
    const holdToken = holdSecondary(channelId);
    entry.request = run(channelId, source, entry, holdToken).finally(() => {
      if (map.get(channelId) === entry) map.delete(channelId);
      steps.setJoining(channelId, false);
    });
    return entry.request;
  }

  /** Forget joins in flight (server switch): a new click sends a new request. */
  function reset(): void {
    inFlight = new Map();
  }

  return { join, reset };
}

/** Joins the channel's socket room, which delivers its real-time messages. */
export function joinRealtimeChannel(channelId: string): void {
  void import("../api/socket")
    .then(({ getSocket }) => {
      getSocket().emit("join:channel", channelId);
    })
    .catch((err) => {
      console.error("Failed to join socket channel:", err);
    });
}
