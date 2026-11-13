import type { MouseEvent, ReactElement } from "react";
import { useIntl } from "react-intl";
import { SmilePlus } from "lucide-react";
import { MessageReactionQuickButton } from "@botiverse/raft-ui";
import ReactionGlyph from "./ReactionGlyph";
import Tooltip from "../ui/Tooltip";
import { QUICK_REACTION_EMOJIS } from "./reactionConstants";

// One reaction bar everywhere (stdrc, 2026-11-05: the bar the hover toolbar's
// Add Reaction opens is the right size): 18px drawings in raft-ui's quick
// buttons, 2px apart, then the button for every other emoji. The message menu
// shows the same bar.
const QUICK_REACTION_GLYPH_SIZE = 18;
/** The one reaction bar's buttons: the seven reactions and the button for every other emoji. */
export function QuickReactionButtons({ itemRole, onReact, onMore }: {
  itemRole?: "menuitem";
  onReact: (event: MouseEvent<HTMLElement>) => void;
  onMore: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { formatMessage } = useIntl();
  const addLabel = formatMessage({ id: "message.messageItem.addReaction" });
  // In the message menu a button is named by `title` and `aria-label`, as in
  // raft-ui's context-menu composition: a Tooltip around a quick button
  // renders its trigger onto it and replaces its data-slot. In the bar it is
  // named by the app's Tooltip, like the hover toolbar's buttons.
  const named = (label: string, button: ReactElement) => (
    itemRole ? button : <Tooltip key={button.key ?? undefined} content={label}>{button}</Tooltip>
  );
  return (
    <>
      {QUICK_REACTION_EMOJIS.map((emoji) => {
        const label = formatMessage({ id: "message.messageItem.reactWith" }, { emoji });
        return named(label, (
          <MessageReactionQuickButton key={emoji} role={itemRole} data-reaction-emoji={emoji} onClick={onReact} title={itemRole ? label : undefined} aria-label={label}>
            <ReactionGlyph emoji={emoji} size={QUICK_REACTION_GLYPH_SIZE} className="block" />
          </MessageReactionQuickButton>
        ));
      })}
      {named(addLabel, (
        <MessageReactionQuickButton key="add" role={itemRole} onClick={onMore} title={itemRole ? addLabel : undefined} aria-label={addLabel} data-message-affordance="reaction-add-any">
          <SmilePlus size={18} aria-hidden />
        </MessageReactionQuickButton>
      ))}
    </>
  );
}
