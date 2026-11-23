import { sameJsonData } from "../utils/sameJsonData";
import type { Message } from "./messageStore";

/**
 * A fetched page with the rows the list already shows kept as the objects it
 * shows them with.
 *
 * A page read over a list that is already on screen (a channel opened again:
 * its cached list first, then the page) parses every message into a new
 * object. A message row is memoized on its message, so each row rendered
 * again for a message that said the same thing (task #441). A fetched message
 * is replaced by the shown one only when every field of the two holds the
 * same data, so nothing that reads a message can tell the difference; an
 * edit, a reaction, a new attachment state or any other field keeps the
 * fetched object. Order and length are the fetched page's.
 */
export function reuseUnchangedMessages(shown: readonly Message[] | undefined, fetched: Message[]): Message[] {
  if (!shown || shown.length === 0 || fetched.length === 0) return fetched;
  const shownById = new Map<string, Message>();
  for (const message of shown) shownById.set(message.id, message);
  let reused = false;
  const next = fetched.map((message) => {
    const current = shownById.get(message.id);
    if (current === undefined || current === message || !sameJsonData(current, message)) return message;
    reused = true;
    return current;
  });
  return reused ? next : fetched;
}
