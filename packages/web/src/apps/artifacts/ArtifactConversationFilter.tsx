import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Globe, Hash, Lock, Users } from "lucide-react";
import {
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxSeparator,
} from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import type { ArtifactDashboardConversation } from "@botiverse/raft-shared";

import { ArtifactActorAvatar } from "./ArtifactActorParts";
import { ArtifactFilterCombobox, FilterChoicesFailed, FilterChoicesLoading } from "./ArtifactFilterCombobox";
import { ARTIFACT_PLACE_HOMES, CHOSEN_BOLD } from "./artifactDashboardParts";
import type { ArtifactPlace, ArtifactPlaceHome } from "./artifactDashboardParts";
import { conversationLabel, conversationName } from "./artifactHomeWords";
import { useArtifactServerName } from "./artifactServerName";
import { artifactSource } from "./artifactSource";
import { useFilterChoices } from "./useFilterChoices";
import type { FilterChoicesSource } from "./useFilterChoices";

/**
 * Where an Artifact lives, as the home page filters it (#proj-workspace:#221,
 * xxchan, Kirby's draft): an Artifact belongs to a conversation and who can see
 * it follows. Instead of kinds of place, the conversations themselves. First,
 * under 谁能看, the two homes that are no conversation, in the product's words
 * for them (`artifacts.scope.public`, `artifacts.scope.server`: "Anyone with the
 * link", "Everyone in Northwind Labs", "Everyone in this server" with no name), which
 * narrow by `home`; then a divider and Channels & DMs: the conversations with
 * Artifacts the reader can see, most recently updated first
 * (`dashboardConversations`, the server searching them), channels with the
 * scope chip's icon (ArtifactScopeLabel: a joint is a #, as there) and DMs with
 * their peer's avatar, which narrow by `conversation`. The button says the value
 * with its mark, its name only; the filter's name is in its accessible name.
 *
 * The two homes are always offered, and a search keeps them only while their
 * name matches, here, as they aren't the server's rows. Typing filters what is
 * loaded at once, until the server's answer replaces it (useFilterChoices). A failed read says so
 * under them, and they still work. An older server without the route (404) is
 * that failure too: there is no list to stand in for it.
 */

const CONVERSATIONS: FilterChoicesSource<ArtifactDashboardConversation> = {
  ask: (q) => artifactSource().dashboardConversations({ q }).then(({ conversations }) => conversations),
  keyOf: (conversation) => conversation.id,
  // As the server's `q`: a channel is written with its #, which no name has.
  matches: ({ name, peerDisplayName }, words) => {
    const bare = words.replace(/^#/, "");
    return name.toLocaleLowerCase().includes(bare) || (peerDisplayName ?? "").toLocaleLowerCase().includes(bare);
  },
};

const homeValue = (home: ArtifactPlaceHome) => `home:${home}`;

export function ArtifactConversationFilter({ value, onChange, testId }: { value: ArtifactPlace | null; onChange: (value: ArtifactPlace | null) => void; testId: string }) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { rows, phase, answer, retry } = useFilterChoices(open, query, CONVERSATIONS);

  const homeLabel = useCallback((home: ArtifactPlaceHome) => (
    home === "public" ? formatMessage({ id: "artifacts.scope.public" }) : formatMessage({ id: "artifacts.scope.server" }, server)
  ), [formatMessage, server]);
  const words = query.trim().toLocaleLowerCase();
  const homes = useMemo(() => ARTIFACT_PLACE_HOMES.filter((home) => homeLabel(home).toLocaleLowerCase().includes(words)), [homeLabel, words]);
  const items = useMemo(() => [...homes.map(homeValue), ...rows.map((conversation) => conversation.id)], [homes, rows]);

  const labelOf = useCallback((choice: string) => {
    const home = ARTIFACT_PLACE_HOMES.find((candidate) => homeValue(candidate) === choice);
    if (home) return homeLabel(home);
    const conversation = rows.find((row) => row.id === choice) ?? (value?.kind === "conversation" ? value.conversation : null);
    return conversation ? conversationLabel(conversation) : "";
  }, [homeLabel, rows, value]);

  // Only what the list offered goes on. The whole conversation is kept: the button names it when the list has moved on.
  const change = useCallback((next: string | null) => {
    const home = ARTIFACT_PLACE_HOMES.find((candidate) => homeValue(candidate) === next);
    const conversation = rows.find((row) => row.id === next);
    onChange(home ? { kind: "home", home } : conversation ? { kind: "conversation", conversation } : null);
  }, [rows, onChange]);

  const chosen = value === null ? null : value.kind === "home" ? homeValue(value.home) : value.conversation.id;
  const valueLabel = chosen === null ? null : labelOf(chosen);
  const unavailable = phase === "failed" || phase === "missing";
  const footer = unavailable ? (
    <FilterChoicesFailed
      message={formatMessage({ id: "artifacts.dashboard.conversation.failed" })}
      retryLabel={formatMessage({ id: "artifacts.dashboard.retry" })}
      onRetry={retry}
      testId={`${testId}-failed`}
    />
  ) : phase === "pending" && rows.length === 0 ? (
    <FilterChoicesLoading label={formatMessage({ id: "common.loading" })} testId={`${testId}-loading`} />
  ) : phase === "ok" && homes.length === 0 && rows.length === 0 ? (
    <p className="px-3 py-2 text-callout text-foreground-muted">{formatMessage({ id: "artifacts.dashboard.conversation.noMatch" })}</p>
  ) : null;

  return (
    <ArtifactFilterCombobox
      testId={testId}
      icon={value === null ? <DirectMessageIcon aria-hidden width={14} height={14} />
        : value.kind === "home" ? <HomeMark home={value.home} />
          : <ConversationMark conversation={value.conversation} />}
      name={formatMessage({ id: "artifacts.dashboard.conversation.label" })}
      value={chosen}
      valueLabel={valueLabel}
      appliedLabel={valueLabel === null ? null : formatMessage({ id: "artifacts.dashboard.conversation.applied" }, { name: valueLabel })}
      clearLabel={formatMessage({ id: "artifacts.dashboard.conversation.clear" })}
      onValue={change}
      items={items}
      answer={answer}
      labelOf={labelOf}
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQuery={setQuery}
      searchLabel={formatMessage({ id: "artifacts.dashboard.conversation.searchLabel" })}
      searchPlaceholder={formatMessage({ id: "artifacts.dashboard.conversation.searchPlaceholder" })}
      footer={footer}
    >
      {homes.length > 0 ? (
        <ComboboxGroup>
          <ComboboxGroupLabel>{formatMessage({ id: "artifacts.scope.whoTitle" })}</ComboboxGroupLabel>
          {homes.map((home) => (
            <ComboboxItem key={home} value={homeValue(home)} className={CHOSEN_BOLD} data-testid={`${testId}-item`} data-home={home}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                  <HomeMark home={home} />
                </span>
                <span className="truncate">{homeLabel(home)}</span>
              </span>
              <ComboboxItemIndicator />
            </ComboboxItem>
          ))}
        </ComboboxGroup>
      ) : null}
      {homes.length > 0 && rows.length > 0 ? <ComboboxSeparator /> : null}
      {rows.length > 0 ? (
        <ComboboxGroup>
          <ComboboxGroupLabel>{formatMessage({ id: "artifacts.dashboard.conversation.group" })}</ComboboxGroupLabel>
          {rows.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} testId={testId} />)}
        </ComboboxGroup>
      ) : null}
    </ArtifactFilterCombobox>
  );
}

function HomeMark({ home }: { home: ArtifactPlaceHome }) {
  return home === "public" ? <Globe aria-hidden size={14} /> : <Users aria-hidden size={14} />;
}

/** A lock, a #, or a DM's peer: on its row and on the button. Decoration: the name says which. */
function ConversationMark({ conversation }: { conversation: ArtifactDashboardConversation }) {
  if (conversation.type === "private") return <Lock aria-hidden size={14} />;
  if (conversation.type !== "dm") return <Hash aria-hidden size={14} />;
  return conversation.peer ? <ArtifactActorAvatar actor={conversation.peer} context="picker-trigger" /> : <DirectMessageIcon aria-hidden width={14} height={14} />;
}

/** A DM with an agent is told by the agent's face (#250: no "agent" beside the name). */
function ConversationRow({ conversation, testId }: { conversation: ArtifactDashboardConversation; testId: string }) {
  return (
    <ComboboxItem value={conversation.id} className={CHOSEN_BOLD} data-testid={`${testId}-item`} data-conversation={conversation.id}>
      <span className="flex min-w-0 items-center gap-1.5">
        {/* The option is named by the name. */}
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <ConversationMark conversation={conversation} />
        </span>
        <span className="truncate">{conversationName(conversation)}</span>
      </span>
      <ComboboxItemIndicator />
    </ComboboxItem>
  );
}
