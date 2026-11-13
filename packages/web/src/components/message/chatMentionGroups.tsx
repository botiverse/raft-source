import type { IntlShape } from "react-intl";
import { ArrowLeftRight, UserX } from "lucide-react";

import type { MentionSuggestionGroup } from "../mention/useMentionPicker";
import type { MentionCandidateGroups } from "./mentionCandidates";

/**
 * Chat's @ list groups: members of this conversation (with the linked Slack
 * participants, tagged), then the rest of the server faded. The first group's heading shows only when another group does.
 */
export function chatMentionGroups(groups: MentionCandidateGroups, formatMessage: IntlShape["formatMessage"]): MentionSuggestionGroup[] {
  return [
    {
      key: "in-channel",
      label: groups.notInChannel.length > 0 || groups.externals.length > 0
        ? formatMessage({ id: "message.composer.inThisChannel" })
        : undefined,
      items: [
        ...groups.inChannel.map((candidate) => ({ candidate })),
        ...groups.externals.map((candidate) => ({
          candidate,
          // Slack-side participant — visually tag as external
          auxiliary: <ArrowLeftRight aria-hidden="true" size={10} strokeWidth={2.5} />,
        })),
      ],
    },
    {
      key: "not-in-channel",
      separated: true,
      label: formatMessage({ id: "message.composer.notInThisChannel" }),
      items: groups.notInChannel.map((candidate) => ({ candidate, muted: true, className: "opacity-60", auxiliary: <UserX size={12} /> })),
    },
  ];
}
