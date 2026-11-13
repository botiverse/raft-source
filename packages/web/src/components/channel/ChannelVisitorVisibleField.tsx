import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import { ImmediateRowSwitch, ImmediateSaveStatus, useImmediateSave } from "../settings/ImmediateSetting";
import { useChannelStore } from "../../store/channelStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import type { MessageId } from "../../i18n/messages";

/** The PATCH /channels/:id refusals of `visitorVisible` (#wg-rbac:#51), each with its copy. */
const REFUSAL_MESSAGE_IDS: Partial<Record<string, MessageId>> = {
  visitor_visibility_forbidden: "channel.edit.visitorVisibleForbidden",
  visitor_visibility_requires_public_server: "channel.edit.visitorVisibleRequiresPublicServer",
  visitor_visibility_requires_public_channel: "channel.edit.visitorVisibleRequiresPublicChannel",
  visitor_visibility_unsupported_channel: "channel.edit.visitorVisibleUnsupportedChannel",
};

/**
 * "Visible to visitors" (#wg-rbac:#51): whether signed-out people can read the
 * channel on its server's public page. One switch that applies at once (DS
 * Forms, "A setting's row" and "Settings that apply at once"); a refusal puts
 * the switch back and says why under the row's description. A row of the
 * channel details' Channel settings group (the caller draws the group).
 *
 * EditChannelDialog decides whether the row is offered at all (owners and
 * admins, and only while it is on or could be turned on). `canTurnOn` false
 * still keeps a row that was shown in this mount, so turning it off doesn't
 * make the row vanish under the pointer.
 */
export function ChannelVisitorVisibleField({
  channelId,
  visitorVisible,
  canTurnOn,
  disabled = false,
}: {
  channelId: string;
  visitorVisible: boolean;
  canTurnOn: boolean;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const save = useImmediateSave();
  // What the switch shows while a save is in flight; null = the stored value.
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? visitorVisible;
  const offered = visitorVisible || canTurnOn;
  const [shown, setShown] = useState(offered);
  if (offered && !shown) setShown(true);

  const handleChange = useCallback((next: boolean) => {
    setPending(next);
    void save.run(
      () => updateChannel(channelId, { visitorVisible: next }),
      (error) => {
        const id = REFUSAL_MESSAGE_IDS[getApiErrorResponse(error)?.code ?? ""];
        return formatMessage({ id: id ?? "channel.edit.visitorVisibleSaveFailed" });
      },
    ).finally(() => setPending(null));
  }, [channelId, formatMessage, save, updateChannel]);

  if (!offered && !shown) return null;

  return (
    <ListRow variant="plain" interactive={false} data-testid="channel-settings-visitor-visible">
      <ListRowBody>
        <ListRowTitle id="channel-settings-visitor-visible-label">
          {formatMessage({ id: "channel.edit.visitorVisibleTitle" })}
        </ListRowTitle>
        <ListRowDescription id="channel-settings-visitor-visible-description" wrap>
          {formatMessage({ id: "channel.edit.visitorVisibleDescription" })}
        </ListRowDescription>
        <ImmediateSaveStatus id="channel-settings-visitor-visible-status" feedback={save.feedback} testId="channel-settings-visitor-visible-status" />
      </ListRowBody>
      <ImmediateRowSwitch
        checked={checked}
        disabled={disabled || save.saving}
        onCheckedChange={handleChange}
        aria-labelledby="channel-settings-visitor-visible-label"
        aria-describedby="channel-settings-visitor-visible-description channel-settings-visitor-visible-status"
        data-testid="channel-settings-visitor-visible-switch"
      />
    </ListRow>
  );
}
