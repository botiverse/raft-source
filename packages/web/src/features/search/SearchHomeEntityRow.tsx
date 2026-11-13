import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Monitor } from "lucide-react";
import {
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
} from "@botiverse/raft-ui";
import AgentActivityDot from "../../components/agent/AgentActivityDot";
import AppBadge from "../../components/agent/AppBadge";
import { useAppBotAgent } from "../../store/agentStore";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { appBotEntitySubtitle } from "./searchEntities";
import { formatEntitySubtitle } from "./searchLabels";
import type { SearchSenderMember } from "./searchResultTypes";

/** A "frequent" destination tile on the search home. */
export function SearchHomeEntityRow({
  result,
  agentAvatarUrl,
  humanMember,
  onActivate,
}: {
  result: SearchEntityRecord;
  agentAvatarUrl: string | null;
  humanMember: SearchSenderMember | undefined;
  onActivate: (result: SearchEntityRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onActivate(result), [onActivate, result]);
  // An App bot has no presence: the App badge follows its name instead.
  const appBot = useAppBotAgent(result.type === "agentDm" ? result.agentId : null);

  return (
    <SearchEntityResult
      type="button"
      data-testid={`search-common-${result.key}`}
      onClick={handleClick}
    >
      <SearchEntityResultLeading>
        {result.type === "channel" ? (
          <SearchEntityResultIcon>
            <ChannelIcon channelId={result.channelId} type={result.channelType ?? "channel"} />
          </SearchEntityResultIcon>
        ) : result.type === "computer" ? (
          <SearchEntityResultIcon>
            <Monitor size={14} />
          </SearchEntityResultIcon>
        ) : result.type === "agentDm" ? (
          <AvatarSlot
            context="compact-row"
            type="agent"
            agentAvatarUrl={agentAvatarUrl}
            badge={result.agentId && !appBot ? <AgentActivityDot agentId={result.agentId} /> : undefined}
          />
        ) : (
          <AvatarSlot
            context="compact-row"
            type="human"
            humanAvatarUrl={humanMember?.avatarUrl}
          />
        )}
      </SearchEntityResultLeading>
      <SearchEntityResultContent>
        <SearchEntityResultHeader>
          <SearchEntityResultTitle>{result.title}</SearchEntityResultTitle>
          {appBot ? <AppBadge className="shrink-0" appName={appBot.managedByApp?.name} botName={result.title} /> : null}
        </SearchEntityResultHeader>
        <SearchEntityResultDescription>
          {formatEntitySubtitle(appBotEntitySubtitle(result.subtitle, appBot), formatMessage)}
        </SearchEntityResultDescription>
      </SearchEntityResultContent>
    </SearchEntityResult>
  );
}
