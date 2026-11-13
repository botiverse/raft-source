// MemberPicker — controlled picker over humans and agents, rendered on the
// channel member-list surface (Agents section, then Humans).
//
// Two presentations:
//   - "removable": only selected candidates are listed, each with a remove
//     control (AddMembersDialog's review-and-trim list).
//   - "selectable": every candidate is listed with a checkbox (`multiple`,
//     capped by `maxItems`) or a radio (single: one id; `noneLabel` adds a
//     leading row that clears it, for an optional field).
//
// Candidates are passed in. `useMemberPickerCandidates` derives them from the
// local stores (server scope) or the channel roster hook (channel scope).

import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Checkbox, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import type { Agent } from "../../store/agentStore";
import { isAgentInMemberLists, useAgentStore } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import { useServerStore } from "../../store/serverStore";
import { useStoredChannel } from "../../store/useStoredChannel";
import type { ChannelHuman } from "../../hooks/useChannelMembers";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { isLocalProjectionMember } from "../../utils/channelLocalMembership";
import {
  ChannelMemberListShell,
  ChannelMemberRow,
  ChannelMemberSectionHeader,
} from "../channel/ChannelMemberList";
import { CandidateRemoveButton } from "../channel/CandidateRemoveButton";
import { isPickerOptionBlocked, togglePickerValue } from "./pickerSelection";

export type MemberKind = "human" | "agent";

export interface MemberPickerCandidate {
  kind: MemberKind;
  /** Human: user id. Agent: agent id. */
  id: string;
  name: string;
  secondary: string | null;
  avatarUrl: string | null;
}

export function agentCandidate(agent: Agent): MemberPickerCandidate {
  return {
    kind: "agent",
    id: agent.id,
    name: agent.displayName ?? agent.name,
    secondary: agent.description,
    avatarUrl: agent.avatarUrl,
  };
}

function humanSecondary(human: { name: string; displayName: string | null; description: string | null }) {
  return human.description ?? (human.displayName && human.displayName !== human.name ? `@${human.name}` : null);
}

export function serverMemberCandidate(member: ServerMember): MemberPickerCandidate {
  return {
    kind: "human",
    id: member.userId,
    name: member.displayName ?? member.name,
    secondary: humanSecondary(member),
    avatarUrl: member.avatarUrl,
  };
}

function channelHumanCandidate(human: ChannelHuman): MemberPickerCandidate {
  return {
    kind: "human",
    id: human.id,
    name: human.displayName ?? human.name,
    secondary: humanSecondary(human),
    avatarUrl: human.avatarUrl,
  };
}

export type MemberPickerSource = { scope: "server" } | { scope: "channel"; channelId: string };

/** Candidates for the picker. Server scope reads only the local stores; channel
 *  scope reads the roster through the existing `useChannelMembers` hook, which
 *  fetches it on mount (shared with any read already in flight). */
export function useMemberPickerCandidates(source: MemberPickerSource): MemberPickerCandidate[] {
  const channelId = source.scope === "channel" ? source.channelId : "";
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);
  const channel = useStoredChannel(channelId) ?? null;
  const { channelAgents, channelHumans } = useChannelMembers(channelId, { enabled: source.scope === "channel" });

  return useMemo(() => {
    if (source.scope === "channel") {
      return [
        ...channelAgents.map(agentCandidate),
        ...channelHumans.filter((m) => isLocalProjectionMember(m, channel)).map(channelHumanCandidate),
      ];
    }
    return [
      ...agents.filter((a) => isAgentInMemberLists(a) && !a.raftbenchService).map(agentCandidate),
      ...members.map(serverMemberCandidate),
    ];
  }, [source.scope, channelAgents, channelHumans, channel, agents, members]);
}

/** Several ids, capped by `maxItems` (unselected candidates are blocked at
 *  the cap), or one: a single picker has no cap to set. */
export type PickerMultiplicity =
  | { multiple: true; maxItems?: number; noneLabel?: never }
  | { multiple: false; maxItems?: never; noneLabel?: string };

type MemberPickerProps = {
  candidates: readonly MemberPickerCandidate[];
  kinds: readonly MemberKind[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Every row's checkbox or radio is disabled (a form that is submitting). */
  disabled?: boolean;
  className?: string;
  /** Names the list (its checkbox group or radio group). */
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
} & PickerMultiplicity & (
  | { presentation: "selectable" }
  | { presentation: "removable"; removeLabel: (name: string) => string }
);

function CandidateCheckbox({
  id,
  label,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const handleChange = useCallback(() => onToggle(id), [onToggle, id]);
  return <Checkbox checked={checked} disabled={disabled} onCheckedChange={handleChange} aria-label={label} />;
}

/** The None row's value: no member id is empty. */
const NONE = "";
// A plain row on the member list's padding, the radio at its end like every row's.
const NONE_ROW_CLASS = "flex min-h-11 items-center gap-3 px-4 py-2 text-subhead font-semibold text-foreground hover:bg-fill-subtle";

export default function MemberPicker(props: MemberPickerProps) {
  const { candidates, kinds, value, onChange, multiple, maxItems, disabled = false, className, "data-testid": dataTestId } = props;
  const labelledBy = props["aria-labelledby"];
  const describedBy = props["aria-describedby"];
  // A single selectable picker is a radio group: one answer, chosen by its row's radio.
  const radio = !multiple && props.presentation === "selectable";
  const { formatMessage } = useIntl();
  const selected = useMemo(() => new Set(value), [value]);
  const agentCandidates = useMemo(
    () => (kinds.includes("agent") ? candidates.filter((c) => c.kind === "agent") : []),
    [candidates, kinds],
  );
  const humanCandidates = useMemo(
    () => (kinds.includes("human") ? candidates.filter((c) => c.kind === "human") : []),
    [candidates, kinds],
  );

  const choose = useCallback((id: string) => onChange(id === NONE ? [] : [id]), [onChange]);
  const toggle = useCallback((id: string) => {
    if (disabled || isPickerOptionBlocked(value, id, maxItems)) return;
    onChange(togglePickerValue(value, id, multiple));
  }, [disabled, value, maxItems, multiple, onChange]);

  const renderCandidate = (candidate: MemberPickerCandidate) => {
    const isSelected = selected.has(candidate.id);
    let trailing;
    if (props.presentation === "removable") {
      if (!isSelected) return null;
      trailing = (
        <CandidateRemoveButton id={candidate.id} label={props.removeLabel(candidate.name)} onRemove={toggle} />
      );
    } else if (radio) {
      trailing = <RadioGroupItem value={candidate.id} aria-label={candidate.name} />;
    } else {
      trailing = (
        <CandidateCheckbox
          id={candidate.id}
          label={candidate.name}
          checked={isSelected}
          disabled={disabled || isPickerOptionBlocked(value, candidate.id, maxItems)}
          onToggle={toggle}
        />
      );
    }
    return (
      <li key={candidate.id}>
        {candidate.kind === "agent" ? (
          <ChannelMemberRow
            type="agent"
            agentId={candidate.id}
            agentAvatarUrl={candidate.avatarUrl}
            name={candidate.name}
            secondary={candidate.secondary}
            trailing={trailing}
          />
        ) : (
          <ChannelMemberRow
            type="human"
            humanAvatarUrl={candidate.avatarUrl}
            name={candidate.name}
            secondary={candidate.secondary}
            trailing={trailing}
          />
        )}
      </li>
    );
  };

  const sections = (
    <>
      {agentCandidates.length > 0 ? (
        <section>
          <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.agents" })}</ChannelMemberSectionHeader>
          <ul>{agentCandidates.map(renderCandidate)}</ul>
        </section>
      ) : null}
      {humanCandidates.length > 0 ? (
        <section>
          <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.humans" })}</ChannelMemberSectionHeader>
          <ul>{humanCandidates.map(renderCandidate)}</ul>
        </section>
      ) : null}
    </>
  );
  return (
    <ChannelMemberListShell className={className} data-testid={dataTestId}>
      {radio ? (
        <RadioGroup
          value={value[0] ?? ""}
          onValueChange={choose}
          disabled={disabled}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
        >
          {props.noneLabel !== undefined ? (
            <label className={NONE_ROW_CLASS} data-testid={dataTestId ? `${dataTestId}-none` : undefined}>
              <span className="min-w-0 flex-1 truncate">{props.noneLabel}</span>
              <RadioGroupItem value={NONE} />
            </label>
          ) : null}
          {sections}
        </RadioGroup>
      ) : labelledBy ? (
        <div role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>{sections}</div>
      ) : sections}
    </ChannelMemberListShell>
  );
}
