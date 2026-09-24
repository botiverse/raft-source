import type { ReactNode } from "react";
import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import { useIntl } from "react-intl";

import type { MessageId } from "../../i18n/messages";

export type ExternalSetupTab = "claude-code" | "hermes" | "other-agents";

type SegmentedControlOption<T extends string> =
  | { value: T; labelId: MessageId }
  | { value: T; label: ReactNode };

const CLAUDE_EXTERNAL_SETUP_TAB: SegmentedControlOption<ExternalSetupTab> = {
  value: "claude-code",
  labelId: "brand.claudeCode",
};
const HERMES_EXTERNAL_SETUP_TAB: SegmentedControlOption<ExternalSetupTab> = {
  value: "hermes",
  labelId: "brand.hermes",
};
const OTHER_AGENTS_EXTERNAL_SETUP_TAB: SegmentedControlOption<ExternalSetupTab> = {
  value: "other-agents",
  labelId: "agent.externalSetup.otherAgents",
};
const EXTERNAL_SETUP_TABS: SegmentedControlOption<ExternalSetupTab>[] = [
  HERMES_EXTERNAL_SETUP_TAB,
  CLAUDE_EXTERNAL_SETUP_TAB,
  OTHER_AGENTS_EXTERNAL_SETUP_TAB,
];

export function ExternalSetupTabSegmentedControl({
  value,
  onValueChange,
}: {
  value: ExternalSetupTab;
  onValueChange: (value: ExternalSetupTab) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <SegmentedControl
      value={value}
      onValueChange={onValueChange}
      aria-label={formatMessage({ id: "agent.externalSetup.ariaLabel" })}
    >
      {EXTERNAL_SETUP_TABS.map((tab) => (
        <SegmentedControlItem key={tab.value} value={tab.value}>
          <SegmentedControlLabel>
            {"labelId" in tab ? formatMessage({ id: tab.labelId }) : tab.label}
          </SegmentedControlLabel>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
