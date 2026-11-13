import { useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type { RuntimeUsageLine } from "../machine/runtimeUsageText";
import { RuntimeUsageLineText } from "../machine/RuntimeUsageLineText";

export interface TargetOption {
  value: string;
  label: string;
  /** What is left of the agent's runtime account on that computer. */
  usage?: RuntimeUsageLine;
  /** The computer itself: free disk and how many agents it has, or that it is offline. */
  info?: string;
  /** Can't be chosen: an offline computer (a move needs both computers online; its info line says Offline). */
  disabled?: boolean;
}

/**
 * The target picker is raft-ui's ChoiceList (DS › Choosing a control: when
 * choosing is the dialog's job, an open list at any count). Each computer is
 * a radio row with up to two lines: what is left of the agent's account
 * there, then the computer itself. Its info button is the row's action,
 * outside the radio and after the group in Tab order. People pick a target
 * by comparing those lines, so the search is "auto": it shows above 5
 * targets, and the chosen one stays in view while it filters.
 */
export function TargetComputerList({
  options,
  value,
  onValueChange,
  disabled,
  labelledBy,
  renderDetails,
}: {
  options: TargetOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
  labelledBy: string;
  /** The info button for a row, or null (the cloud). */
  renderDetails: (option: TargetOption) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const items = useMemo<ChoiceListItem[]>(() => options.map((option) => ({
    value: option.value,
    label: option.label,
    description: [
      option.usage ? <RuntimeUsageLineText key="usage" line={option.usage} /> : null,
      option.info ? <span key="info" data-testid={`agent-migration-target-info-${option.value}`}>{option.info}</span> : null,
    ],
    action: renderDetails(option),
    ...(option.disabled ? { disabled: true } : {}),
  })), [options, renderDetails]);

  // A preselected target (Try Again, or a drop on the Computers overview) may
  // sit below the list's fold: bring the checked row into view once, when the
  // list opens. ChoiceList keeps it in view while filtering, not on open
  // (raft-ui follow-up).
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const checked = rootRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    checked?.scrollIntoView?.({ block: "center" });
  }, []);

  return (
    <div ref={rootRef} className="contents">
    <ChoiceList
      aria-labelledby={labelledBy}
      items={items}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      searchLabel={formatMessage({ id: "agent.detail.targetComputerSearch" })}
      searchPlaceholder={formatMessage({ id: "agent.detail.targetComputerSearch" })}
      clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
      noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
      empty={<span data-testid="agent-migration-target-empty">{formatMessage({ id: "agent.detail.noOtherAttachedComputer" })}</span>}
    />
    </div>
  );
}
