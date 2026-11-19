import { SelectItem, SelectItemIndicator, SelectItemText } from "@botiverse/raft-ui";

type SelectOption = {
  value: string;
  label: string;
};

/** The setup page's Server picker rows (raft-ui Select items). */
export function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}
