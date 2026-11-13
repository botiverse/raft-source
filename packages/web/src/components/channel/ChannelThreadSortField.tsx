import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import type { ChannelThreadSort } from "@botiverse/raft-shared";
import { ImmediateRowSwitch, ImmediateSaveStatus, apiErrorText, useImmediateSave } from "../settings/ImmediateSetting";
import { useChannelStore } from "../../store/channelStore";

/**
 * Forum-style channels (#proj-chat:#24, flag channel_thread_sort_v0): the
 * channel's message order, one switch that applies at once (DS Forms,
 * "Settings that apply at once"). On: top-level messages are ordered by their
 * latest activity, so a message that gets a reply moves to the bottom. The
 * same order for everyone in the channel, so only someone who can edit the
 * channel's info sees it (EditChannelDialog decides). A failed save puts the
 * switch back and says why under it. A settings row of the channel details'
 * Channel settings group (the caller draws the ListRowGroup).
 */
export function ChannelThreadSortField({
  channelId,
  threadSort,
  disabled = false,
}: {
  channelId: string;
  threadSort: ChannelThreadSort | undefined;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const save = useImmediateSave();
  // What the switch shows while a save is in flight; null = the stored value.
  const [pending, setPending] = useState<boolean | null>(null);
  const stored = threadSort === "activity";
  const checked = pending ?? stored;

  const handleChange = useCallback((next: boolean) => {
    setPending(next);
    void save.run(
      () => updateChannel(channelId, { threadSort: next ? "activity" : "time" }),
      (error) => apiErrorText(error, formatMessage({ id: "channel.edit.threadSortSaveFailed" })),
    ).finally(() => setPending(null));
  }, [channelId, formatMessage, save, updateChannel]);

  return (
    <ListRow variant="plain" interactive={false} data-testid="channel-settings-thread-sort">
      <ListRowBody>
        <ListRowTitle id="channel-settings-thread-sort-label">
          {formatMessage({ id: "channel.edit.threadSortTitle" })}
        </ListRowTitle>
        <ListRowDescription id="channel-settings-thread-sort-description" wrap>
          {formatMessage({ id: "channel.edit.threadSortDescription" })}
        </ListRowDescription>
        <ImmediateSaveStatus
          id="channel-settings-thread-sort-status"
          feedback={save.feedback}
          testId="channel-settings-thread-sort-status"
        />
      </ListRowBody>
      <ImmediateRowSwitch
        checked={checked}
        disabled={disabled || save.saving}
        onCheckedChange={handleChange}
        aria-labelledby="channel-settings-thread-sort-label"
        aria-describedby="channel-settings-thread-sort-description channel-settings-thread-sort-status"
        data-testid="channel-settings-thread-sort-switch"
      />
    </ListRow>
  );
}
