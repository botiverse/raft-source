import { DescriptionItem, DescriptionTerm, DescriptionDetails } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

// Isolated info bar — role/model/reasoning editing state lives here,
// so keystroke re-renders don't cascade to ChatPanel / tabs below.
/** Profile tab: description, machine, model config, env vars, created date */
/**
 * One label | value row of the profile's property lists (Info, Runtime config):
 * the DS PropertyList (raft-ui DescriptionList, horizontal) — label column in
 * ink-3, value in ink; icons follow the label.
 */
export function InfoRow({ label, actions, children, testId }: { label: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <DescriptionItem data-testid={testId}>
      <DescriptionTerm>
        <span className="truncate">{label}</span>
        {actions}
      </DescriptionTerm>
      <DescriptionDetails>{children}</DescriptionDetails>
    </DescriptionItem>
  );
}
