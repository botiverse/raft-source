/**
 * `messages.seq` is an int8. A server path that leaks the raw driver value
 * (GET /messages/sync did) serializes it as a JSON string, and a string seq
 * breaks every numeric consumer: ThreadPanel's window merge drops rows whose
 * seq is not a number, `seq === cursor + 1` never matches, and `+ 1` on a
 * string concatenates. Coerce once at ingest so the store only holds numbers.
 */
export function coerceWireMessageSeq<T extends { seq?: unknown }>(message: T): T {
  const seq = message.seq;
  if (typeof seq !== "string") return message;
  const numeric = Number(seq);
  return { ...message, seq: Number.isFinite(numeric) ? numeric : undefined };
}

export function coerceWireMessageSeqs<T extends { seq?: unknown }>(messages: readonly T[]): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const coerced = coerceWireMessageSeq(message);
    if (coerced !== message) changed = true;
    return coerced;
  });
  return changed ? next : (messages as T[]);
}
