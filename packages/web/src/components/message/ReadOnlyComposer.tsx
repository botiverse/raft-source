// The composer's stand-in where nobody can write: a disabled field that reads
// "Chat is unavailable", with no typing, attachments or send. ChatPanel shows
// it for a read-only conversation, and ChatPanel and ThreadPanel both show it
// in a removed App Bot's DM and its threads, with that notice above it.

import type { ReactNode } from "react";
import { useIntl } from "react-intl";

export default function ReadOnlyComposer({ notice }: { notice?: ReactNode }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-col gap-2 bg-layer-canvas px-3 pt-2 pb-3">
      {notice}
      <div className="flex min-h-11 cursor-not-allowed items-center rounded-container border border-line-hairline bg-fill-muted px-3">
        <span className="text-body text-foreground-disabled">{formatMessage({ id: "message.chatPanel.unavailable" })}</span>
      </div>
    </div>
  );
}
