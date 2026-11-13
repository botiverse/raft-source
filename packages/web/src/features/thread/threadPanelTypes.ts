import type { MutableRefObject, ReactNode } from "react";
import type { SideSectionHead } from "../../components/task/sideSectionDrag";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import type { ReadOnlySenderProjection } from "../../components/message/MessageItem";

export interface ReadOnlyThreadData {
  threadChannelId: string;
  parentChannelId: string;
  parentMessage: Message;
  replies: Message[];
  senderByMessageId: ReadonlyMap<string, ReadOnlySenderProjection>;
  channels: Channel[];
  loading: boolean;
  error: string;
  hasOlder: boolean;
  loadOlder: () => void | Promise<void>;
}

export interface ThreadPanelProps {
  /** Before the head's title (a host's control: task v2's collapse chevron when the thread shares its column). */
  headerLeading?: ReactNode;
  /** The head as the handle that moves the thread among task v2's side columns (its props and its grip), where it can. */
  headerDrag?: SideSectionHead;
  /** The panel is the row's thread column (MainLayout's): its head takes the row's Expand, Focus Mode, where the plan shows it (#189 rule 5). */
  allowExpand?: boolean;
  presentation?: "side" | "modal" | "mobile-modal";
  /** See AuthenticatedThreadPanel: "inset" when the host already draws the left divider. */
  edge?: "attached" | "inset";
  onClose?: () => void;
  threadIdentity?: {
    /** Null for a sub-conversation without a parent message: a task's own
     *  conversation (task v2), identified by `parentTaskId` instead. */
    parentMessageId: string | null;
    parentChannelId: string;
    threadChannelId: string | null;
    focusedMessageId?: string | null;
    /** Names the jump to `focusedMessageId`, new on every jump (the store's
     *  `focusNonce`), so a second jump to the same reply restarts its located
     *  highlight. */
    focusNonce?: number;
    /** Task v2: the task whose conversation this is (no parent message). */
    parentTaskId?: string | null;
  };
  onFocusedMessageConsumed?: () => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  showComposer?: boolean;
  overlayComposer?: boolean;
  mobilePage?: boolean;
  composerAutoFocus?: boolean;
  hideHeader?: boolean;
  hideParentMessage?: boolean;
  parentSlot?: ReactNode;
  /** Replaces the "No replies yet" state of an empty conversation. */
  emptyState?: ReactNode;
  /** A host that draws its own header (the task dialog) gets the panel's
   *  "search in this conversation" command here, for its More menu. */
  searchCommandRef?: MutableRefObject<(() => void) | null>;
  /** A host that draws Back outside the panel's head (task v2's covering
   *  column, whose tabs head has it) gets the panel's Back here. */
  backCommandRef?: MutableRefObject<(() => void) | null>;
  /** Narrow public snapshot. Supplying it mounts no authenticated thread
   * store, socket, task, member, or message data source. */
  readOnlyData?: ReadOnlyThreadData;
}
