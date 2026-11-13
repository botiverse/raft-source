import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { TextLink } from "@botiverse/raft-ui";
import { useChannelStore } from "../../store/channelStore";

/**
 * A Lounge's archived banner action. A Lounge's sheet has no settings, so the
 * banner unarchives in place instead of opening that sheet, and only for
 * viewers whose server role may archive channels (the caller decides;
 * Warden, #proj-chat:#14). A refusal shows the server's words under the link.
 */
export function LoungeUnarchiveAction({ channelId }: { channelId: string }) {
  const { formatMessage } = useIntl();
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unarchive = useCallback(() => {
    setError("");
    setBusy(true);
    unarchiveChannel(channelId)
      .catch((err: unknown) => {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUnarchive" }));
      })
      .finally(() => setBusy(false));
  }, [channelId, unarchiveChannel, formatMessage]);
  return (
    <>
      <TextLink onClick={unarchive} disabled={busy} variant="strong" data-testid="lounge-unarchive-action">
        {formatMessage({ id: busy ? "channel.edit.unarchiving" : "message.chatPanel.unarchive" })}
      </TextLink>
      {error && <span className="block font-normal" role="alert">{error}</span>}
    </>
  );
}
