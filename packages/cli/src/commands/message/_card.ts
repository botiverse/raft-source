// Card messages (RFC 082) on the CLI: the `--card <file>` of `raft message
// send` and `raft message update-card`, checked here with the shared schema
// before any request, so an agent gets the element's path and the limit it
// breaks without a round trip; and the Server's card refusals, each with its
// next step.
//
// A card is a file, never stdin: stdin is the message body, which with a card
// is the card's fallback text.

import fs from "node:fs";

import type { MessageCard, MessageCardInput, MessageCardProblem } from "@botiverse/raft-shared";
import {
  formatMessageCardProblem,
  MESSAGE_CARD_ERROR_CODES,
  MESSAGE_CARD_LIMITS,
  messageCardFallbackProblem,
  parseMessageCard,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { CliError, cliError } from "../../core/errors";

/**
 * A card file larger than this is refused unread. A card is at most 8 KiB of
 * JSON as sent; the file may be indented, so it gets room for whitespace.
 */
export const CARD_FILE_MAX_BYTES = 64 * 1024;

export interface LoadedCard {
  /** The path as given (for the commands an error suggests). */
  file: string;
  /** The card as the sender wrote it: what is sent (the Server fills defaults in). */
  input: MessageCardInput;
  /** The card as stored (defaults filled in). */
  card: MessageCard;
}

function cardInvalid(problem: MessageCardProblem, file: string): CliError {
  return cliError("CARD_INVALID", `${formatMessageCardProblem(problem)} Nothing was sent.`, {
    details: { path: problem.path, limit: problem.limit, ...(problem.node === undefined ? {} : { node: problem.node }) },
    retryable: false,
    suggestedNextAction: `Fix ${problem.path} in ${file}, then run the same command again.`,
  });
}

/** Read and check `--card <file>`: the card, or the first rule it breaks (path and limit). Throws a CliError. */
export function loadCardFile(file: string): LoadedCard {
  const path = file.trim();
  if (!path || path === "-") {
    throw cliError("INVALID_ARG", "--card takes the path of a JSON file with the card. stdin is the message text, so a card cannot be read from it.", {
      suggestedNextAction: "Write the card to a file and pass its path: --card card.json",
    });
  }
  const unreadable = (cause: unknown, reason: string) => cliError("CARD_FILE_UNREADABLE", `Cannot read the card file ${path} (${reason}). Nothing was sent.`, {
    cause,
    retryable: false,
    suggestedNextAction: "Pass the path of a readable JSON file with the card: --card <file>",
  });
  let size: number;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw unreadable(undefined, "not a file");
    size = stat.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw unreadable(err, (err as NodeJS.ErrnoException).code ?? "unreadable");
  }
  if (size > CARD_FILE_MAX_BYTES) {
    throw cardInvalid({
      path: "card",
      limit: "size",
      message: `The card file is ${size} bytes; a card is at most ${MESSAGE_CARD_LIMITS.maxBytes} bytes (8 KiB) of JSON`,
    }, path);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path);
  } catch (err) {
    throw unreadable(err, (err as NodeJS.ErrnoException).code ?? "unreadable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw cardInvalid({
      path: "card",
      limit: "shape",
      message: `The card file is not JSON (${err instanceof Error ? err.message : String(err)})`,
    }, path);
  }
  const parsed = parseMessageCard(raw);
  if (!parsed.ok) throw cardInvalid(parsed.problem, path);
  // It parsed: it is a card a sender may write (messageCard.ts pins the two types together).
  return { file: path, input: raw as MessageCardInput, card: parsed.card };
}

/** No text on stdin and nothing on the card to derive one from: refused before any request. */
export function assertCardFallback(loaded: LoadedCard, content: string | undefined): void {
  const problem = messageCardFallbackProblem(loaded.card, content);
  if (problem) throw cardInvalid(problem, loaded.file);
}

/** `--mention` binds an @handle in the text; a card sent without text has a derived one, which mentions no one. */
export function cardMentionsWithoutTextError(): CliError {
  return cliError(
    "MESSAGE_CARD_MENTIONS_WITHOUT_CONTENT",
    "--mention needs the message text on stdin: with --card and no text, Raft derives the text from the card, and a derived text mentions no one. Nothing was sent.",
    {
      retryable: false,
      suggestedNextAction: "Write the text with the @mentions on stdin, or leave out --mention.",
    },
  );
}

/**
 * `--attachment-id` with `--card`: a card message carries no files (RFC 082
 * §4.1), in any conversation. `message` is the Server's sentence when it
 * refused (a saved draft from an older CLI, sent with --send-draft).
 */
export function cardWithAttachmentsError(
  message = "A card message carries no files: --card cannot be used with --attachment-id. Nothing was sent.",
): CliError {
  return cliError(
    "MESSAGE_CARD_WITH_ATTACHMENTS",
    message,
    {
      retryable: false,
      suggestedNextAction: "Send the card without --attachment-id, and send the files in a separate message.",
    },
  );
}

function bodyField(res: ApiResponse<unknown>, key: string): unknown {
  const body = res.errorBody;
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/** An argument of a command an error prints (a card file, a key), quoted for a shell when it needs it. */
export function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A Server refusal because of the card (RFC 082 §4.1/§4.2), with its next
 * step; null for any other answer. The Server's own sentence leads: it says
 * what is wrong and that nothing changed.
 */
export function messageCardRefusal(res: ApiResponse<unknown>, command: "send" | "update", file: string): CliError | null {
  const message = res.error ?? `HTTP ${res.status}`;
  switch (res.errorCode) {
    case MESSAGE_CARD_ERROR_CODES.invalid: {
      const path = bodyField(res, "path");
      const limit = bodyField(res, "limit");
      const node = bodyField(res, "node");
      return cliError("CARD_INVALID", message, {
        details: {
          ...(typeof path === "string" ? { path } : {}),
          ...(typeof limit === "string" ? { limit } : {}),
          ...(typeof node === "string" ? { node } : {}),
        },
        retryable: false,
        suggestedNextAction: `Fix ${typeof path === "string" ? `${path} in ` : ""}${file}, then run the same command again.`,
      });
    }
    case MESSAGE_CARD_ERROR_CODES.disabled:
      return cliError("MESSAGE_CARDS_DISABLED", message, {
        retryable: false,
        suggestedNextAction: command === "send"
          ? "Send the message as text: the same command without --card, with the text on stdin."
          : "Send a new message as text with raft message send.",
      });
    // Only an older Server answers it (a joint channel, before RFC 082 v1.8): a current one takes the card there.
    case MESSAGE_CARD_ERROR_CODES.unsupportedTarget:
      return cliError("MESSAGE_CARD_UNSUPPORTED_TARGET", message, {
        retryable: false,
        suggestedNextAction: "Send the message as text: the same command without --card, with the text on stdin.",
      });
    case MESSAGE_CARD_ERROR_CODES.mentionsWithoutContent:
      return cardMentionsWithoutTextError();
    case MESSAGE_CARD_ERROR_CODES.withAttachments:
      return cardWithAttachmentsError(message);
    default:
      return null;
  }
}
