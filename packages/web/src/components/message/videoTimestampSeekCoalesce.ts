/**
 * Coalesce rapid video timestamp seeks onto the latest target.
 * Rapid currentTime writes thrash Chromium's media pipeline (Aw Snap / error code 11).
 */

export type VideoSeekTarget = {
  pause: () => void;
  setCurrentTime: (time: number) => void;
  paused?: boolean;
};

export type VideoSeekCoalesceSchedule = {
  requestAnimationFrame: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
};

export type VideoSeekCoalescer = {
  /** Queue a seek; multiple calls before the rAF fire collapse to the latest time. */
  seek: (time: number) => boolean;
  /** Cancel any pending rAF and clear the pending target. */
  cancel: () => void;
};

/**
 * Build a coalescer. One in-flight rAF at most; pending target is always the latest.
 * Deletes of the in-flight guard must make multi-seek tests RED.
 */
export function createVideoSeekCoalescer(
  getVideo: () => VideoSeekTarget | null,
  schedule: VideoSeekCoalesceSchedule = {
    requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
  },
): VideoSeekCoalescer {
  let pendingSeek: number | null = null;
  let seekRaf: number | null = null;

  const cancel = () => {
    if (seekRaf !== null) {
      schedule.cancelAnimationFrame(seekRaf);
      seekRaf = null;
    }
    pendingSeek = null;
  };

  const seek = (time: number): boolean => {
    if (!Number.isFinite(time)) return false;
    const video = getVideo();
    if (!video) return false;
    pendingSeek = Math.max(0, time);
    // In-flight guard: only one rAF. Removing this line re-exposes seek storms.
    if (seekRaf !== null) return true;
    seekRaf = schedule.requestAnimationFrame(() => {
      seekRaf = null;
      const target = pendingSeek;
      pendingSeek = null;
      const el = getVideo();
      if (el == null || target == null) return;
      try {
        if (el.paused === false) el.pause();
        el.setCurrentTime(target);
      } catch {
        // AbortError / invalid state during rapid teardown — ignore.
      }
    });
    return true;
  };

  return { seek, cancel };
}
