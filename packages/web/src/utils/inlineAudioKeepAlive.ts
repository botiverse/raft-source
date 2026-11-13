import { createContext, useLayoutEffect, useState } from "react";

// Keeps an inline audio player playing when the virtual timeline recycles its
// message row (it mounts only the rows near the view, so scrolling a playing
// voice note out of view unmounts it) while the timeline itself stays.
//
// A media element removed from the document is paused only once the task that
// removed it ends, and only if it is not back in a document by then. So the
// player, as it unmounts (before React removes its row), moves its playing
// <audio> into a hidden holder: it plays on. When the player mounts again it
// takes the playback over (position, volume) and the kept element is dropped.
// A kept element that pauses or ends is dropped too.
//
// Kept elements belong to the timeline that rendered them (a scope, from
// `useInlineAudioKeepAliveScope`). When that timeline unmounts (another
// channel, the thread closes, another server, another page) or moves to
// another conversation, its kept elements are stopped and removed: leaving a
// conversation stops its voice notes, as removing the player always did.
// Without a scope (outside a virtual timeline) nothing is kept.

export type InlineAudioKeepAliveScope = {
  readonly kept: Map<string, HTMLAudioElement>;
  /** False once its timeline unmounted or left the conversation. */
  active: boolean;
};

export const InlineAudioKeepAliveContext = createContext<InlineAudioKeepAliveScope | null>(null);

export function createInlineAudioKeepAliveScope(): InlineAudioKeepAliveScope {
  return { kept: new Map(), active: true };
}

/** Stops and removes every element kept in `scope`; nothing is kept after. */
export function releaseInlineAudioKeepAliveScope(scope: InlineAudioKeepAliveScope): void {
  scope.active = false;
  for (const [key, audio] of [...scope.kept]) drop(scope, key, audio);
}

/**
 * The keep-alive scope of a timeline: active while it is mounted on
 * `conversationKey`; released when it unmounts or the key changes.
 */
export function useInlineAudioKeepAliveScope(conversationKey: string | undefined): InlineAudioKeepAliveScope {
  const [scope] = useState(createInlineAudioKeepAliveScope);
  useLayoutEffect(() => {
    scope.active = true;
    return () => releaseInlineAudioKeepAliveScope(scope);
  }, [scope, conversationKey]);
  return scope;
}

let holder: HTMLDivElement | null = null;

function holderElement(): HTMLDivElement {
  if (holder?.isConnected) return holder;
  holder = document.createElement("div");
  holder.hidden = true;
  holder.dataset.inlineAudioKeepAlive = "";
  document.body.appendChild(holder);
  return holder;
}

function drop(scope: InlineAudioKeepAliveScope, key: string, audio: HTMLAudioElement) {
  if (scope.kept.get(key) === audio) scope.kept.delete(key);
  audio.pause();
  audio.remove();
}

/** The player of `key` unmounts: keep its audio playing if it is. */
export function keepInlineAudioPlaying(
  scope: InlineAudioKeepAliveScope | null,
  key: string,
  audio: HTMLAudioElement | null,
): void {
  if (!scope || !audio || audio.paused || audio.ended || typeof document === "undefined") return;
  // The timeline is going away (React runs its cleanup before its rows'):
  // the player goes with it.
  if (!scope.active) {
    audio.pause();
    return;
  }
  const previous = scope.kept.get(key);
  if (previous && previous !== audio) drop(scope, key, previous);
  scope.kept.set(key, audio);
  holderElement().appendChild(audio);
  const onStop = () => {
    audio.removeEventListener("pause", onStop);
    audio.removeEventListener("ended", onStop);
    if (scope.kept.get(key) === audio) drop(scope, key, audio);
  };
  audio.addEventListener("pause", onStop);
  audio.addEventListener("ended", onStop);
}

/**
 * The player of `key` mounted with `audio`: if a kept element of the same key
 * is still playing, carry its position and volume over and play on with
 * `audio`. Returns whether it took playback over.
 */
export function resumeKeptInlineAudio(
  scope: InlineAudioKeepAliveScope | null,
  key: string,
  audio: HTMLAudioElement,
): boolean {
  const previous = scope?.kept.get(key);
  if (!scope || !previous) return false;
  scope.kept.delete(key);
  const at = previous.currentTime;
  const volume = previous.volume;
  const handOver = () => {
    audio.removeEventListener("playing", handOver);
    previous.pause();
    previous.remove();
  };
  audio.volume = volume;
  try {
    audio.currentTime = at;
  } catch {
    /* not seekable yet: from the start */
  }
  audio.addEventListener("playing", handOver);
  try {
    void audio.play().catch(handOver);
  } catch {
    handOver();
    return false;
  }
  return true;
}
