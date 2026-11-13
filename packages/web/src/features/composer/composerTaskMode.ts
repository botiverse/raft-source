import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Task v2: creating a task is sending a message (design "新建任务 = 发一条消息").
 * The "+" on a channel's Tasks card writes the task in that channel's own
 * composer: As task on, the input focused. Each composer that offers As task
 * says so here for its channel; a request reaches the one that said so last.
 */
type TurnOnTaskMode = () => void;

const targets = new Map<string, TurnOnTaskMode[]>();

/**
 * Turns on As task in `channelId`'s composer and focuses it. False when no
 * composer of that channel offering As task is mounted (the caller falls back
 * to the New task dialog).
 */
export function requestComposerTaskMode(channelId: string): boolean {
  const list = targets.get(channelId);
  const target = list?.[list.length - 1];
  if (!target) return false;
  target();
  return true;
}

/** A composer offering As task for `channelId` (null: it offers none). */
export function useComposerTaskModeTarget(channelId: string | null, turnOn: TurnOnTaskMode): void {
  const latest = useRef(turnOn);
  useLayoutEffect(() => {
    latest.current = turnOn;
  }, [turnOn]);
  useEffect(() => {
    if (!channelId) return;
    const target = () => latest.current();
    targets.set(channelId, [...(targets.get(channelId) ?? []), target]);
    return () => {
      const rest = (targets.get(channelId) ?? []).filter((t) => t !== target);
      if (rest.length > 0) targets.set(channelId, rest);
      else targets.delete(channelId);
    };
  }, [channelId]);
}
