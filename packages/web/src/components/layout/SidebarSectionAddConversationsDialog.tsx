import { Button, Checkbox, InputGroup, InputGroupAddon, InputGroupInput, ScrollArea } from "@botiverse/raft-ui";
import { Search, User } from "lucide-react";
import { ChannelIcon } from "../channel/channelKindIcon";
import { useCallback, useId, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import AppBadge from "../agent/AppBadge";
import DialogCard from "../ui/DialogCard";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

/** The card pads the dialog already, so its footer adds no padding of its own. */

export type SidebarSectionCandidate = {
  /** `${kind}:${id}`, unique across the list. */
  key: string;
  kind: "channel" | "agent";
  id: string;
  label: string;
  icon: "channel" | "dm";
  /** A DM with an App bot: its row shows the App badge after the name. */
  appBot?: { appName: string | null } | null;
};

export type SidebarSectionConversationChange = {
  added: SidebarSectionCandidate[];
  removed: SidebarSectionCandidate[];
};

/**
 * Which conversations a section should hold, starting from the ones it holds
 * now (`initialSelectedKeys`): checking adds one, unchecking removes one.
 */
export function useSectionConversationSelection(candidates: SidebarSectionCandidate[], initialSelectedKeys: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedKeys));
  const toggle = useCallback((key: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const change: SidebarSectionConversationChange = useMemo(() => ({
    added: candidates.filter((candidate) => selected.has(candidate.key) && !initialSelectedKeys.includes(candidate.key)),
    removed: candidates.filter((candidate) => !selected.has(candidate.key) && initialSelectedKeys.includes(candidate.key)),
  }), [candidates, initialSelectedKeys, selected]);
  return { selected, toggle, change, changed: change.added.length + change.removed.length > 0 };
}

function SectionCandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: SidebarSectionCandidate;
  checked: boolean;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const handleCheckedChange = useCallback((next: boolean) => onToggle(candidate.key, next === true), [candidate.key, onToggle]);
  return (
    <label
      className="flex items-center gap-3 px-3 py-2 hover:bg-fill-subtle"
      data-testid={`sidebar-section-add-option-${candidate.key}`}
    >
      <Checkbox checked={checked} onCheckedChange={handleCheckedChange} aria-label={candidate.label} />
      {candidate.icon === "channel"
        ? <ChannelIcon channelId={candidate.id} size={14} className="shrink-0 text-foreground-muted" />
        : <User size={14} aria-hidden="true" className="shrink-0 text-foreground-muted" />}
      <span className="min-w-0 truncate font-sans text-subhead text-foreground">{candidate.label}</span>
      {candidate.appBot ? <AppBadge className="shrink-0" appName={candidate.appBot.appName} botName={candidate.label} /> : null}
    </label>
  );
}

/** The filter field and checklist of a section's conversations. */
export function SectionConversationPicker({
  candidates,
  selected,
  onToggle,
  autoFocus = false,
}: {
  candidates: SidebarSectionCandidate[];
  selected: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
  autoFocus?: boolean;
}) {
  const { formatMessage } = useIntl();
  const [query, setQuery] = useState("");
  const handleQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), []);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? candidates.filter((candidate) => candidate.label.toLowerCase().includes(needle)) : candidates;
  }, [candidates, query]);
  return (
    <div className="flex flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <Search size={16} aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus={autoFocus}
          aria-label={formatMessage({ id: "layout.sidebar.addToSectionFilter" })}
          placeholder={formatMessage({ id: "layout.sidebar.addToSectionFilter" })}
          value={query}
          onChange={handleQueryChange}
          className="min-w-0 flex-1"
        />
      </InputGroup>
      <ScrollArea tabIndex={-1} className="max-h-72 rounded-md border border-line-hairline" data-testid="sidebar-section-add-list">
        {visible.length === 0 ? (
          <div className="px-3 py-6 text-center font-sans text-footnote text-foreground-hint">
            {formatMessage({ id: "layout.sidebar.addToSectionEmpty" })}
          </div>
        ) : visible.map((candidate) => (
          <SectionCandidateRow
            key={candidate.key}
            candidate={candidate}
            checked={selected.has(candidate.key)}
            onToggle={onToggle}
          />
        ))}
      </ScrollArea>
    </div>
  );
}

/**
 * Step 2 of creating a sidebar section (task #34): the section already
 * exists, so this only picks conversations to move into it. Skip keeps the
 * section as it is. Raft Design System › Dialog: a ghost action on the left,
 * the pink primary on the right.
 */
export default function SidebarSectionAddConversationsDialog({
  sectionName,
  candidates,
  initialSelectedKeys,
  onSubmit,
  onClose,
}: {
  sectionName: string;
  candidates: SidebarSectionCandidate[];
  initialSelectedKeys: string[];
  onSubmit: (change: SidebarSectionConversationChange) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const { selected, toggle, change, changed } = useSectionConversationSelection(candidates, initialSelectedKeys);

  return (
    <DialogCard
      title={formatMessage({ id: "layout.sidebar.addToSectionTitle" }, { name: sectionName })}
      titleId={titleId}
      description={formatMessage({ id: "layout.sidebar.addToSectionStep" })}
      onClose={onClose}
      closeOnBackdrop
      maxWidthClass="max-w-[448px]"
      narrow="sheet"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) onSubmit(change);
        }}
        className="flex flex-col gap-4"
        data-testid="sidebar-section-add-conversations"
      >
        <SectionConversationPicker candidates={candidates} selected={selected} onToggle={toggle} autoFocus />
        <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={onClose} data-testid="sidebar-section-add-skip">
            {formatMessage({ id: "layout.sidebar.addToSectionSkip" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant="primary" type="submit" disabled={!changed} data-testid="sidebar-section-add-submit">
                {formatMessage({ id: "layout.sidebar.addToSectionSubmit" }, { count: change.added.length })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}
