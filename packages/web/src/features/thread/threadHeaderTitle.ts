import { notificationPlainText } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import { isRetractedMessage } from "../../components/message/delegatedMessage";
import type { Message } from "../../store/messageStore";
import type { ThreadParentGlimpse } from "./useThreadParent";

/**
 * What the thread head's title can say about the message the thread started from (raft-design
 * conversation.md, Threads; #proj-chat:#31 v3): once that message scrolls out of view, its sender and first line
 * take the title's place. Deleted or out of reach, the title stays Thread and only its accessible name says why.
 */
export type ThreadHeaderOriginal =
  | { state: "shown"; sender: string; text: string }
  | { state: "deleted" }
  | { state: "unavailable" };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The first line of a message as plain text (no Markdown; an @mention stays its words), or, with no text, what it
 * holds: "Image" when every file is an image, else "File" (raft-design conversation.md, Threads).
 */
export function threadOriginalFirstLine(message: Pick<Message, "content" | "attachments">, formatMessage: IntlShape["formatMessage"]): string {
  const line = notificationPlainText(message.content ?? "")
    .split("\n")
    .map(oneLine)
    .find((part) => part.length > 0);
  if (line) return line;
  const files = message.attachments ?? [];
  if (files.length === 0) return formatMessage({ id: "message.outline.noText" });
  const images = files.every((file) => file.mimeType?.startsWith("image/"));
  return formatMessage({ id: images ? "message.threadPanel.titleImage" : "message.threadPanel.titleFile" });
}

/**
 * The title's original: `unavailable` where the person can't read the message (its place is one they can't open),
 * `deleted` where its owner retracted it, else its sender and first line. A parent behind the plan's history window
 * is neither: it is named from what is known of it (`glimpse`), as usual. Null while nothing is known (the title
 * stays Thread).
 */
export function resolveThreadHeaderOriginal({
  parentMessage,
  glimpse = null,
  unavailable,
  senderName,
  formatMessage,
}: {
  parentMessage: Message | null;
  glimpse?: ThreadParentGlimpse | null;
  unavailable: boolean;
  /** The sender's name from the people and agents the panel knows, for the parent or the glimpse. */
  senderName: string | null;
  formatMessage: IntlShape["formatMessage"];
}): ThreadHeaderOriginal | null {
  if (unavailable) return { state: "unavailable" };
  const unknownSender = () => formatMessage({ id: "message.author.unknown" });
  if (parentMessage) {
    if (isRetractedMessage(parentMessage)) return { state: "deleted" };
    return {
      state: "shown",
      sender: senderName || parentMessage.senderDisplayName || parentMessage.senderName || unknownSender(),
      text: threadOriginalFirstLine(parentMessage, formatMessage),
    };
  }
  // Its first line (a followed thread's preview may hold several), as for a loaded parent.
  const text = glimpse?.preview ? glimpse.preview.split("\n").map(oneLine).find((part) => part.length > 0) ?? "" : "";
  // Nothing of its words known: the title stays Thread (the place name still opens the place at its paywall).
  if (!glimpse || !text) return null;
  return { state: "shown", sender: senderName || glimpse.senderName || unknownSender(), text };
}
