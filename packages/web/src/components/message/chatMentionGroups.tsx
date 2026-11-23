import type { IntlShape } from "react-intl";
import { ArrowLeftRight, UserX } from "lucide-react";

import { COMPOSER_SUGGESTION_MAX_RESULTS } from "../../utils/composerSuggestionSearch";
import type { MentionSuggestionGroup } from "../mention/useMentionPicker";
import type { MentionCandidateGroups } from "./mentionCandidates";

const EXTERNAL_AUXILIARY_ICON = <ArrowLeftRight aria-hidden="true" size={10} strokeWidth={2.5} />;
const NOT_IN_CHANNEL_AUXILIARY_ICON = <UserX size={12} />;

/**
 * Chat's @ list groups: members of this conversation (with the linked Slack
 * participants, tagged), then the rest of the server faded, bounded to
 * `maxItems` so opening `@` on a large server never mounts hundreds of live
 * presence-subscribed rows at once. The first group's heading shows only when
 * another group does.
 */
export function chatMentionGroups(
  groups: MentionCandidateGroups,
  formatMessage: IntlShape["formatMessage"],
  maxItems = COMPOSER_SUGGESTION_MAX_RESULTS,
): MentionSuggestionGroup[] {
  let remaining = Math.max(0, maxItems);
  const shownInChannel = groups.inChannel.slice(0, remaining);
  remaining -= shownInChannel.length;
  const shownExternals = groups.externals.slice(0, remaining);
  remaining -= shownExternals.length;
  const shownNotInChannel = groups.notInChannel.slice(0, remaining);

  return [
    {
      key: "in-channel",
      label: shownNotInChannel.length > 0 || shownExternals.length > 0
        ? formatMessage({ id: "message.composer.inThisChannel" })
        : undefined,
      items: [
        ...shownInChannel.map((candidate) => ({ candidate })),
        ...shownExternals.map((candidate) => ({
          candidate,
          // Slack-side participant — visually tag as external
          auxiliary: EXTERNAL_AUXILIARY_ICON,
        })),
      ],
    },
    {
      key: "not-in-channel",
      separated: true,
      label: formatMessage({ id: "message.composer.notInThisChannel" }),
      items: shownNotInChannel.map((candidate) => ({
        candidate,
        muted: true,
        className: "opacity-60",
        auxiliary: NOT_IN_CHANNEL_AUXILIARY_ICON,
      })),
    },
  ];
}
