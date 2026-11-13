import { useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { RefreshCw, ScanText } from "lucide-react";
import { Spinner } from "@botiverse/raft-ui";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import { reportContextViewClicked, reportContextViewMenuOpened } from "../../utils/contextViewTrace";
import type { ContextViewMenuStatus } from "../../utils/contextViewTrace";
import { loadAgentContextViewStatus, useAgentContextViewStatus } from "./agentContextViewStatus";
import type { AgentContextViewStatusEntry } from "./agentContextViewStatus";

/** The check's state as the trace names it (`undefined` entry: not asked yet, so still pending). */
function menuStatus(entry: AgentContextViewStatusEntry | undefined): ContextViewMenuStatus {
  if (entry?.status) return "allowed";
  if (entry?.status === null) return "not_allowed";
  if (entry?.failed && !entry.pending) return "failed";
  return "pending";
}

/**
 * View Context in an agent message's menu (⋯, right-click, a phone's
 * long-press): its own last group. Mounted only while the menu is open, so the
 * status is asked when a menu opens, never per rendered message (and kept a
 * while: agentContextViewStatus).
 *
 * Shown once the Server answers, whatever the state: why a context can't be
 * shown is said in the panel, never by a greyed item. The exception is
 * `unsupported_runtime`: the agent's runtime can't be read at all, so there is
 * nothing to open and the item is left out (#proj-raft-ui:#245). Nothing while asking or
 * on the 404 every refusal is (the flag off, a person who may not inspect the
 * agent): most people get that 404, so a placeholder while asking would flash
 * for them. A check that failed (network, 5xx) is no answer: it says so with a
 * Retry instead of hiding View Context (#wg-ax:#28).
 *
 * Reports `slock.context_view` once per opening: the check's state when it
 * settled (or `pending` if the menu closed first) and how long the menu waited.
 */
export function ViewContextMenuGroup({ agentId, onOpen }: { agentId: string; onOpen: () => void }) {
  const { formatMessage } = useIntl();
  const entry = useAgentContextViewStatus(agentId);
  const openedAt = useRef(Date.now());
  const reported = useRef(false);
  const latest = useRef<ContextViewMenuStatus>("pending");
  latest.current = menuStatus(entry);

  useEffect(() => {
    void loadAgentContextViewStatus(agentId);
  }, [agentId]);

  useEffect(() => {
    if (reported.current || latest.current === "pending") return;
    reported.current = true;
    reportContextViewMenuOpened(latest.current, Date.now() - openedAt.current);
  });

  useEffect(() => () => {
    if (!reported.current) reportContextViewMenuOpened("pending", Date.now() - openedAt.current);
  }, []);

  const handleOpen = useCallback(() => {
    reportContextViewClicked();
    onOpen();
  }, [onOpen]);
  const handleRetry = useCallback(() => {
    void loadAgentContextViewStatus(agentId, { force: true });
  }, [agentId]);

  if (entry?.status?.state === "unavailable" && entry.status.reason === "unsupported_runtime") return null;
  if (entry?.status) {
    return (
      <>
        <ContextMenuDivider />
        <MenuItem
          icon={<ScanText size={14} />}
          onClick={handleOpen}
          data-testid="message-context-view-context"
        >
          {formatMessage({ id: "message.messageItem.viewContext" })}
        </MenuItem>
      </>
    );
  }
  if (entry?.failed) {
    const retrying = entry.pending === true;
    return (
      <>
        <ContextMenuDivider />
        <MenuItem
          icon={<RefreshCw size={14} />}
          trailing={retrying ? <Spinner size="sm" aria-hidden="true" /> : undefined}
          disabled={retrying}
          onClick={handleRetry}
          data-testid="message-context-view-retry"
        >
          <span className="block truncate">{formatMessage({ id: "message.messageItem.viewContextRetry" })}</span>
          <span className="block truncate text-xs text-foreground-muted">{formatMessage({ id: "message.messageItem.viewContextCheckFailed" })}</span>
        </MenuItem>
      </>
    );
  }
  return null;
}
