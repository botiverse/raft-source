import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Bot } from "lucide-react";
import {
  Combobox,
  ComboboxClear,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxHeader,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@botiverse/raft-ui";
import { FitToolbarPicker } from "@botiverse/raft-ui/wip";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { LIST_TOOLBAR_STEP } from "../../components/ui/listToolbar";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { agentRuntimeFacts } from "./memberEntryFacts";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { knownUsageFilterPicks } from "./membersAgentUsageFilterModel";
import type { UsageFilterOption, UsageFilterOptions } from "./membersAgentUsageFilterModel";

// The agent filter of Members › Agents › Usage (#proj-o11y:#36, v5 mock): a
// filter people change while they work, so a picker that shows its value
// (Raft DS › PickerTriggerButton), here as the list toolbar's FitToolbarPicker
// (its label gives way, the value stays). Many values with search: a
// Combobox, `multiple` (Raft DS › Combobox), Clear in its header. Runtime and
// Model are quick picks (each selects its agents), then every agent with its
// avatar. The items never change while it is open: they are the latest
// answer's agents (useMembersAgentUsage).

interface Choice extends UsageFilterOption {
  label: string;
}

interface ChoiceGroup {
  value: string;
  items: Choice[];
}

const FILTER_COLLISION_AVOIDANCE = { side: "none", align: "shift", fallbackAxisSide: "none" } as const;

export function MembersAgentUsageFilter({ options, value, onChange }: {
  options: UsageFilterOptions;
  /** The picks, as option ids. */
  value: readonly string[];
  onChange: (picks: string[]) => void;
}) {
  const { formatMessage, formatList, locale } = useIntl();
  const coarse = useMediaQuery("(pointer: coarse)");
  const name = formatMessage({ id: "layout.sidebar.agents" });
  const deprecatedHere = useRuntimeDeprecatedHere();

  const { groups, byId } = useMemo(() => {
    const labelOf = (option: UsageFilterOption): string => {
      if (option.kind === "agent") return option.agent.displayName || option.agent.name;
      const facts = agentRuntimeFacts(option.agent, formatMessage, deprecatedHere);
      return (option.kind === "runtime" ? facts.runtime : facts.model) ?? option.id;
    };
    const choices = (list: readonly UsageFilterOption[]) => list.map((option) => ({ ...option, label: labelOf(option) }));
    const agents = choices(options.agent).sort((a, b) => a.label.localeCompare(b.label, locale, { sensitivity: "base" }));
    const all: ChoiceGroup[] = [
      { value: formatMessage({ id: "members.page.column.runtime" }), items: choices(options.runtime) },
      { value: formatMessage({ id: "members.page.column.model" }), items: choices(options.model) },
      { value: name, items: agents },
    ];
    const list = all.filter((group) => group.items.length > 0);
    return { groups: list, byId: new Map(list.flatMap((group) => group.items).map((choice) => [choice.id, choice])) };
  }, [deprecatedHere, formatMessage, locale, name, options]);

  const picked = useMemo(
    () => knownUsageFilterPicks(value, options).map((option) => byId.get(option.id)!).filter(Boolean),
    [byId, options, value],
  );
  const change = useCallback((next: Choice[]) => onChange(next.map((choice) => choice.id)), [onChange]);
  const clear = useCallback(() => onChange([]), [onChange]);
  const sameChoice = useCallback((a: Choice, b: Choice) => a.id === b.id, []);
  const labelOfChoice = useCallback((choice: Choice) => choice.label, []);

  // One pick shows its name; several, how many (in Space Mono), as the
  // page's other many-value filters (Tasks, the migration log). The name says them all.
  const first = picked[0];
  const shown = picked.length > 1 ? picked.length : first?.label;
  const appliedName = first
    ? formatMessage({ id: "members.usage.filter.applied" }, { filter: name, value: formatList(picked.map((choice) => choice.label), { type: "conjunction" }) })
    : undefined;

  return (
    <Combobox<Choice, true>
      multiple
      autoHighlight
      items={groups}
      value={picked}
      isItemEqualToValue={sameChoice}
      itemToStringLabel={labelOfChoice}
      onValueChange={change}
    >
      <FitToolbarPicker
        trigger={<ComboboxTrigger />}
        icon={<Bot />}
        value={shown}
        labelOrder={LIST_TOOLBAR_STEP.filterLabels}
        aria-label={appliedName}
        data-active={first ? "" : undefined}
        data-testid="members-usage-filter"
      >
        {name}
      </FitToolbarPicker>
      <ComboboxContent
        align="start"
        side="bottom"
        collisionAvoidance={FILTER_COLLISION_AVOIDANCE}
        initialFocus={!coarse}
        finalFocus={false}
        className="w-[260px] max-w-[calc(100vw-2rem)]"
        data-testid="members-usage-filter-list"
      >
        <ComboboxHeader>
          <ComboboxLabel>{name}</ComboboxLabel>
          {picked.length > 0 ? (
            <ComboboxClear onClick={clear} data-testid="members-usage-filter-clear">{formatMessage({ id: "ui.selectionPopover.clear" })}</ComboboxClear>
          ) : null}
        </ComboboxHeader>
        <ComboboxSeparator />
        <ComboboxInputGroup>
          <ComboboxInput
            aria-label={formatMessage({ id: "members.usage.filter.search" })}
            placeholder={formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
            suppressPasswordManager
          />
        </ComboboxInputGroup>
        <ComboboxList className="max-h-[360px]">
          {(group: ChoiceGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(choice: Choice) => (
                  <ComboboxItem key={choice.id} value={choice} data-testid={`members-usage-filter-option-${choice.id}`}>
                    <span className="flex min-w-0 items-center gap-2">
                      {choice.kind === "agent" ? <AvatarSlot context="menu-item" type="agent" agentAvatarUrl={choice.agent.avatarUrl} /> : null}
                      <span className="truncate">{choice.label}</span>
                      {choice.kind === "agent" ? null : (
                        <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">{choice.agentIds.length}</span>
                      )}
                    </span>
                    <ComboboxItemIndicator />
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
