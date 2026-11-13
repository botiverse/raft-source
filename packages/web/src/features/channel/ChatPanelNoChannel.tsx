import { Button } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { ArrowLeft } from "lucide-react";
import { useIntl } from "react-intl";
import EmptyState from "../../components/ui/EmptyState";

/**
 * ChatPanel with no channel: the DS empty state, under the back button a
 * phone (or a content slot that can go back) needs.
 */
export function ChatPanelNoChannel({ onBack, backAlwaysVisible }: { onBack: () => void; backAlwaysVisible: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-1 flex-col items-center justify-center">
      <Button onClick={onBack} size="icon-md" variant="outline" aria-label={formatMessage({ id: "common.announcement.back" })} className={backAlwaysVisible ? "mb-4" : "mb-4 md:hidden"}>
        <ArrowLeft size={14} />
      </Button>
      <EmptyState
        icon={<MessageIcon />}
        title={formatMessage({ id: "message.chatPanel.selectChannel" })}
        // The main area's only content, so its title is a heading (Raft DS › EmptyState).
        titleHeading="h2"
        data-testid="chat-no-channel"
      />
    </div>
  );
}
