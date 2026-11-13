// Glimpse layer 2, "what the client actually printed" (layer 1 is the
// Server's `server.agent_context.returned`). The raft CLI counts each passive
// AX block it writes for the model, per model context and kind, in the
// agent's ledger (`passive_render_counts`, schema owned by the CLI); when a
// turn ends the daemon takes and clears those rows and puts them on that
// turn's `daemon.runtime.turn` span (`passive_render_*`), next to its token
// counts. Counts and sizes only, never text.
//
// Kinds are a closed list both sides agree on; a kind the daemon does not
// know (a newer CLI) still adds to the totals.

export const PASSIVE_RENDER_COUNTS_TABLE = "passive_render_counts";

/**
 * The table, as the CLI creates it (on its first count). Additive to ledger
 * version 1: older CLIs never see it, older daemons never read it.
 */
export const PASSIVE_RENDER_COUNTS_DDL = `CREATE TABLE IF NOT EXISTS ${PASSIVE_RENDER_COUNTS_TABLE} (
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  renders INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (context_id, kind)
)`;

/** The CLI's count statement; parameters: context id, kind, code points, UTF-8 bytes. */
export const PASSIVE_RENDER_COUNTS_UPSERT = `INSERT INTO ${PASSIVE_RENDER_COUNTS_TABLE} (context_id, kind, renders, chars, bytes) VALUES (?, ?, 1, ?, ?)
  ON CONFLICT (context_id, kind) DO UPDATE SET
    renders = renders + 1, chars = chars + excluded.chars, bytes = bytes + excluded.bytes`;

export const PASSIVE_RENDER_KINDS = [
  /** A channel card on read, or in a send's reply after the card changed. */
  "channel_card",
  /** A DM peer card on read, or in a send's reply. */
  "peer_card",
  /** A send held only because its context never saw the card: exists only with passive AX. */
  "card_hold",
  /**
   * A freshness hold for unread messages (send, task claim/update/amend),
   * with any card it carries. The Server holds these with passive AX off too:
   * counted only while it is on, so not by itself a cost of passive AX.
   */
  "freshness_hold",
  /** Unseen messages attached to an applied task write (status update, amend, release) instead of a hold. */
  "freshness_attached",
  /** The latest messages shown after every send on a runtime that does not report compaction. */
  "send_attachment",
  /** Command guidance shown before a command runs (attached or held), not `--help`. */
  "command_guidance",
] as const;

export type PassiveRenderKind = (typeof PASSIVE_RENDER_KINDS)[number];

export function isPassiveRenderKind(value: string): value is PassiveRenderKind {
  return (PASSIVE_RENDER_KINDS as readonly string[]).includes(value);
}
