// `--pair <id>` on `setup` / `attach` (docs/contracts/computer-pairing.md,
// loopback login design §11 B): the Add Computer window the command was
// copied from puts it there, so the approval can be shown in that window.
// It is only a convenience: a malformed id is dropped with one warning and
// the approval goes on with a code as usual, never failing over it. The id
// is never echoed, logged or traced.

export const PAIR_FLAG_DESC =
  "added automatically by the Add Computer window you copied this command from, so you can approve this machine there";

/** Loose: base64url-ish, 16–128 characters (the server's ids are 43). */
const PAIRING_ID = /^[A-Za-z0-9_-]{16,128}$/;

export const INVALID_PAIR_WARNING =
  "Ignoring --pair: it is not a valid pairing id. Continuing without it (approve this machine the usual way).";

/**
 * The pairing id to send, or undefined (no flag, or a malformed one: then
 * `warn` is called once). Surrounding whitespace from a paste is trimmed.
 */
export function resolvePairFlag(
  raw: string | undefined,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string | undefined {
  if (raw === undefined) return undefined;
  const id = raw.trim();
  if (PAIRING_ID.test(id)) return id;
  warn(INVALID_PAIR_WARNING);
  return undefined;
}
