import { createContext } from "react";
import type { Message } from "../../store/messageStore";

/**
 * Forwards one message (task #35): the hover toolbar's and the context menu's
 * Forward entry. ChatPanel / ThreadPanel provide it around their timelines and
 * open their forward composer with just that message; null (the default, and
 * where forwarding isn't allowed) hides the entry.
 */
export const MessageForwardContext = createContext<((message: Message) => void) | null>(null);
