import { Separator, IconTile, ScrollArea } from "@botiverse/raft-ui";
import { Hash } from "lucide-react";
import { useIntl } from "react-intl";
import type { PublicVisibilityReadback } from "./publicVisibilityUiReducer";

export function PublicChannelList({ channels }: { channels: PublicVisibilityReadback["exposedChannels"] }) {
  const { formatMessage } = useIntl();
  // Keep the exposure inventory compact in both the settings page and the
  // confirmation drawer. A row has a fixed 3.625rem detail height; the 7.5rem
  // border-box therefore shows exactly two rows (plus the list borders), with
  // any third row reached inside this list instead of growing its parent.
  // The frame is a raft-ui ScrollArea whose scrollbar always shows while
  // there is more (trigger "none", as the old always-on overflow-y-scroll).
  const scrollFrameClass = "max-h-[7.5rem]";
  if (channels.length === 0) {
    return (
      <ScrollArea
        trigger="none"
        className={`rounded-container border border-dashed border-line-hairline ${scrollFrameClass}`}
        contentClassName="px-3 py-4 text-center text-footnote text-foreground-hint"
      >
        {formatMessage({ id: "settings.publicVisibility.emptyChannels" })}
      </ScrollArea>
    );
  }
  return (
    <ScrollArea trigger="none" className={`rounded-container border border-line-hairline bg-layer-card ${scrollFrameClass}`}>
    <ul data-testid="public-visibility-channel-list">
      {channels.map((channel, index) => (
        <li key={channel.id} className="flex h-[3.625rem] flex-col">
          {index > 0 ? <Separator className="shrink-0" /> : null}
          <div className="flex min-h-0 flex-1 items-start gap-3 px-3 py-2.5">
          <IconTile size="sm" className="mt-0.5">
            <Hash strokeWidth={2} />
          </IconTile>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-subhead font-semibold text-foreground">{channel.name}</span>
            {channel.description ? <span className="mt-0.5 block truncate text-footnote text-foreground-muted">{channel.description}</span> : null}
          </span>
          </div>
        </li>
      ))}
    </ul>
    </ScrollArea>
  );
}
