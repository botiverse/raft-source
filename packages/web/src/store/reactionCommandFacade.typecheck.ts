import type {
  CommentRef,
  SetInteractionCommandDescription,
} from "@botiverse/raft-shared";
import type { executeMessageReactionCommand } from "./reactionCommandFacade";

type AssertFalse<Value extends false> = Value;
type CommentReactionCommand = Omit<SetInteractionCommandDescription, "target"> & {
  target: CommentRef;
};
type ExecuteMessageReactionCommandInput = Parameters<
  typeof executeMessageReactionCommand
>[0];

export type MessageReactionCommandRejectsCommentRef = AssertFalse<
  CommentReactionCommand extends ExecuteMessageReactionCommandInput ? true : false
>;
