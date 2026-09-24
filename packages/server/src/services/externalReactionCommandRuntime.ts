import type { DatabaseTransaction } from "../db/index.js";

export type ExternalReactionAggregateTransition = Readonly<{
  tx: DatabaseTransaction;
  raftMessageId: string;
  canonicalEmoji: string;
  localDiscussionVersion: number;
  localAggregateCount: number;
  desiredPresent: boolean;
  now: Date;
}>;

type Handler = (input: ExternalReactionAggregateTransition) => Promise<unknown>;
let handler: Handler | null = null;

export function installExternalReactionCommandHandler(next: Handler): () => void {
  if (handler) throw new Error("External reaction command handler is already installed");
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

export async function enqueueExternalReactionAggregateTransition(
  input: ExternalReactionAggregateTransition,
): Promise<void> {
  if (handler) await handler(input);
}

export function __resetExternalReactionCommandHandlerForTests(): void {
  handler = null;
}
