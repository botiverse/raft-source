/**
 * Which tool call an agent is stuck on (task #25). The daemon counts open tool
 * calls for steering, but a count cannot say which call has been running, for
 * how long, or with no output at all; a hung command then only shows as
 * "busy". This keeps each open call's name and start, and reports the oldest
 * one once per quiet episode: no runtime event at all for the threshold since
 * both the call's start and the last runtime event. Any runtime event (tool
 * output, text, a subagent's work) starts a new episode, so a long command
 * that keeps printing is never stuck.
 *
 * Observation only: nothing here stops or restarts anything. The report only
 * feeds the agent's status in the web; nobody is sent a DM or notification.
 */

export const DEFAULT_TOOL_STUCK_THRESHOLD_MS = 10 * 60_000;

/** Calls still open; a runtime that never ends a call must not grow this forever. */
const MAX_OPEN_TOOL_CALLS = 256;

export interface StuckToolCall {
  toolName: string;
  callId: string | null;
  startedAtMs: number;
  /** When the quiet episode began: the later of the call's start and the last runtime event. */
  quietSinceMs: number;
  openToolCalls: number;
}

interface OpenToolCall {
  toolName: string;
  callId: string | null;
  startedAtMs: number;
}

export class ToolStuckWatch {
  private readonly open = new Map<string, OpenToolCall>();
  private anonymous = 0;
  private reportedQuietSinceMs: number | null = null;

  noteToolStart(callId: string | undefined, toolName: string, nowMs: number): void {
    const key = callId ? `id:${callId}` : `anon:${++this.anonymous}`;
    this.open.delete(key);
    this.open.set(key, { toolName, callId: callId ?? null, startedAtMs: nowMs });
    while (this.open.size > MAX_OPEN_TOOL_CALLS) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.open.delete(oldest);
    }
  }

  /** A result without an id closes the oldest call that had none. */
  noteToolEnd(callId: string | undefined): void {
    if (callId) {
      this.open.delete(`id:${callId}`);
      return;
    }
    for (const key of this.open.keys()) {
      if (key.startsWith("anon:")) {
        this.open.delete(key);
        return;
      }
    }
  }

  /** Turn end, process exit or a new launch: nothing is open any more. */
  clear(): void {
    this.open.clear();
    this.reportedQuietSinceMs = null;
  }

  get openCount(): number {
    return this.open.size;
  }

  /** The oldest call still open, if any. */
  oldestOpenCall(): { toolName: string; startedAtMs: number } | undefined {
    const oldest = this.open.values().next().value;
    return oldest ? { toolName: oldest.toolName, startedAtMs: oldest.startedAtMs } : undefined;
  }

  /**
   * The episode already reported, while it lasts: the same quiet stretch is
   * still going (no runtime event since) and the call is still open. Read on
   * every activity frame, so the stuck state goes away with the first sign of
   * life instead of needing every progress path to clear it.
   */
  current(nowMs: number, lastRuntimeEventAtMs: number, thresholdMs: number): StuckToolCall | null {
    if (thresholdMs <= 0 || this.reportedQuietSinceMs === null) return null;
    const oldest = this.open.values().next().value;
    if (!oldest) return null;
    const quietSinceMs = Math.max(oldest.startedAtMs, lastRuntimeEventAtMs);
    if (quietSinceMs !== this.reportedQuietSinceMs || nowMs - quietSinceMs < thresholdMs) return null;
    return {
      toolName: oldest.toolName,
      callId: oldest.callId,
      startedAtMs: oldest.startedAtMs,
      quietSinceMs,
      openToolCalls: this.open.size,
    };
  }

  /**
   * The oldest open call when it has been quiet for `thresholdMs`, once per
   * quiet episode; null otherwise. A threshold of 0 or less turns the watch off.
   */
  takeStuck(nowMs: number, lastRuntimeEventAtMs: number, thresholdMs: number): StuckToolCall | null {
    if (thresholdMs <= 0) return null;
    const oldest = this.open.values().next().value;
    if (!oldest) return null;
    const quietSinceMs = Math.max(oldest.startedAtMs, lastRuntimeEventAtMs);
    if (nowMs - quietSinceMs < thresholdMs) return null;
    if (this.reportedQuietSinceMs === quietSinceMs) return null;
    this.reportedQuietSinceMs = quietSinceMs;
    return {
      toolName: oldest.toolName,
      callId: oldest.callId,
      startedAtMs: oldest.startedAtMs,
      quietSinceMs,
      openToolCalls: this.open.size,
    };
  }
}

/** The activity detail while stuck, from the tool's activity label ("Running command…"). */
export function stuckToolActivityDetail(activityLabel: string, thresholdMs: number): string {
  const action = activityLabel.replace(/…$/, "");
  const minutes = Math.max(1, Math.round(thresholdMs / 60_000));
  return `Stuck: ${action.charAt(0).toLowerCase()}${action.slice(1)}, no output for ${minutes}+ min`;
}
