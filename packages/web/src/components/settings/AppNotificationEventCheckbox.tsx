import { useCallback } from "react";
import type { AppNotificationEvent } from "@botiverse/raft-shared";
import { Checkbox } from "@botiverse/raft-ui";
import { toggleAppNotificationEvent } from "./appNotificationSelection";
import type { AppNotificationSelection } from "./appNotificationSelection";

export function AppNotificationEventCheckbox({
  event,
  value,
  checked,
  disabled,
  onChange,
}: {
  event: AppNotificationEvent;
  value: AppNotificationSelection;
  checked: boolean;
  disabled: boolean;
  onChange: (next: AppNotificationSelection) => void;
}) {
  const handleCheckedChange = useCallback(
    (nextChecked: boolean) => onChange(toggleAppNotificationEvent(value, event, nextChecked)),
    [event, onChange, value],
  );
  return <Checkbox checked={checked} disabled={disabled} onCheckedChange={handleCheckedChange} />;
}
