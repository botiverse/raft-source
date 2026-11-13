import { useIntl } from "react-intl";
import { Check } from "lucide-react";
import { Button, InboxItemActions } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { PHONE_DONE_ACTIONS_CLASS } from "./inboxRowShared";

/**
 * A row's Mark as Done, last in InboxItemContent. Revealed on hover it is ghost,
 * on the row's hover fill; on a touch screen it rests in the row and is outlined
 * (raft-design patterns/lists.md). CSS picks between the two, as raft-ui's
 * compositions do, so nothing flashes while a media query settles; only the
 * shown one is in the tab order and the accessibility tree.
 *
 * On a phone (`phone`) the row has no button at rest: Done is the left swipe and
 * the press-and-hold menu's item, and this one stays for screen readers and
 * keyboards, visually hidden (raft-design #776).
 */
export function InboxRowDone({ phone, label, describedBy, onDone }: {
  phone: boolean;
  /** Named after its row ("Mark #launch-week as Done", raft-design #777); the tooltip keeps the action's name. */
  label: string;
  describedBy?: string;
  onDone: () => void;
}) {
  const { formatMessage } = useIntl();
  const tooltip = formatMessage({ id: "thread.row.markAsDone" });
  if (phone) {
    return (
      <InboxItemActions className={PHONE_DONE_ACTIONS_CLASS} data-testid="conversation-card-actions">
        <Tooltip content={tooltip}>
          <Button variant="outline" size="icon-md" type="button" onClick={onDone} aria-label={label} aria-describedby={describedBy} data-testid="inbox-row-done">
            <Check aria-hidden />
          </Button>
        </Tooltip>
      </InboxItemActions>
    );
  }
  return (
    <InboxItemActions reveal="hover" data-testid="conversation-card-actions">
      <Tooltip content={tooltip}>
        <Button variant="ghost" size="icon-md" className="pointer-coarse:hidden md:pointer-fine:size-(--bar-button-size) md:pointer-fine:rounded-(--bar-button-radius)" type="button" onClick={onDone} aria-label={label} aria-describedby={describedBy} data-testid="inbox-row-done">
          <Check aria-hidden />
        </Button>
      </Tooltip>
      <Button variant="outline" size="icon-md" className="hidden pointer-coarse:inline-flex" type="button" onClick={onDone} aria-label={label} aria-describedby={describedBy} data-testid="inbox-row-done-touch">
        <Check aria-hidden />
      </Button>
    </InboxItemActions>
  );
}
