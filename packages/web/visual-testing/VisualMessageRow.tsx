import { useMemo } from "react";
import MessageItem from "../src/components/message/MessageItem";
import { useChannelStore } from "../src/store/channelStore";
import { VISUAL_MENTION_MAP, visualAgents } from "./VisualTestingCases";
import type { VisualMessageRowFixture } from "./VisualTestingCases";

/** One MessageItem row over the stores primed by the enclosing case view. */
export function VisualMessageRow({ fixture }: { fixture: VisualMessageRowFixture }) {
  const { extraChannel } = fixture;
  const channels = useMemo(() => {
    const primedChannels = useChannelStore.getState().channels;
    return extraChannel ? [...primedChannels, extraChannel] : primedChannels;
  }, [extraChannel]);

  return (
    <MessageItem
      message={fixture.message}
      mentionMap={VISUAL_MENTION_MAP}
      channels={channels}
      previewSenderAgent={fixture.previewSenderAgent ? visualAgents[0] : undefined}
      threadSummary={fixture.threadSummary}
      linkedTask={fixture.linkedTask}
      hideThreadActions={fixture.hideThreadActions}
    />
  );
}
