import { SelectItem, SelectItemIndicator, SelectItemText } from "@botiverse/raft-ui";
import type { SelectOption } from "./selectOptions";

export function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText lang={option.lang}>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}
