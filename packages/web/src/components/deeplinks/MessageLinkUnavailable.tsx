import { useCallback, useLayoutEffect } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { SearchX } from "lucide-react";
import { Button, TextLink } from "@botiverse/raft-ui";
import AppEmptyState from "../ui/EmptyState";
import { spendPageLanding } from "../../utils/pageLanding";

/**
 * Deep links v1, item d: the one state for a message link that can't be
 * shown, whatever the reason (deleted, not a member, private, a wrong id, a
 * `thread` naming another conversation). Same words every time, so a link
 * never tells someone whether a message they can't see exists. Back leaves
 * the link for `backTo`; on a public server the caller adds Join to View.
 *
 * In the workspace the link has nothing to open, so the open-in-app offers
 * about this landing go for good (before the first paint, and after Back
 * too). A public server's preview keeps the landing: after Join to View the
 * message shows, and the offer with it.
 */
export default function MessageLinkUnavailable({
  backTo,
  onJoin,
  joining = false,
}: {
  backTo: string;
  onJoin?: () => void;
  joining?: boolean;
}) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const goBack = useCallback(() => {
    navigate(backTo, { replace: true });
  }, [backTo, navigate]);
  const inWorkspace = onJoin === undefined;
  useLayoutEffect(() => {
    if (inWorkspace) spendPageLanding();
  }, [inWorkspace]);

  return (
    <AppEmptyState
      className="flex h-full flex-1 flex-col items-center justify-center p-6"
      data-testid="message-link-unavailable"
      titleHeading="h2"
      icon={<SearchX size={36} />}
      title={formatMessage({ id: "messageLink.unavailable.title" })}
      description={formatMessage({ id: "messageLink.unavailable.body" })}
      // Raft DS › EmptyState: one ink-bordered button, never pink. On a
      // public server that button is Join to View, and Back steps down to a
      // text link under it.
      action={onJoin ? (
        <div className="flex flex-col items-center gap-3">
          <Button variant="default" size="md" onClick={onJoin} disabled={joining} data-testid="message-link-unavailable-join">
            {formatMessage({ id: "messageLink.unavailable.join" })}
          </Button>
          <TextLink onClick={goBack} data-testid="message-link-unavailable-back">
            {formatMessage({ id: "messageLink.unavailable.back" })}
          </TextLink>
        </div>
      ) : (
        <Button variant="default" size="md" onClick={goBack} data-testid="message-link-unavailable-back">
          {formatMessage({ id: "messageLink.unavailable.back" })}
        </Button>
      )}
    />
  );
}
