import { useCallback } from "react";
import type { AppNotificationGroup } from "@botiverse/raft-shared";
import { Checkbox } from "@botiverse/raft-ui";
import { toggleAppNotificationGroup } from "./appNotificationSelection";
import type { AppNotificationSelection } from "./appNotificationSelection";

export function AppNotificationGroupCheckbox({
  group,
  value,
  checked,
  disabled,
  onChange,
}: {
  group: AppNotificationGroup;
  value: AppNotificationSelection;
  checked: boolean;
  disabled: boolean;
  onChange: (next: AppNotificationSelection) => void;
}) {
  const handleCheckedChange = useCallback(
    (nextChecked: boolean) => onChange(toggleAppNotificationGroup(value, group, nextChecked)),
    [group, onChange, value],
  );
  return <Checkbox checked={checked} disabled={disabled} onCheckedChange={handleCheckedChange} />;
}
