/**
 * The startup-memory size contract (RFC 070 §6.1), stated once.
 *
 * Everything else derives from the single root parameter below:
 *
 *   injection cap (bytes) = budget tokens x approx bytes/token
 *   recommended MEMORY.md size = the injection cap ("fits fully into every
 *     fresh session" — past it the file's tail stops reaching wakes)
 *   CLI-guide target copy = the same cap, interpolated (every managed
 *     agent; the `constructed_wake_context` flag was retired on 2026-10-23)
 *
 * The Cleaner idle-hint threshold is NOT derived from this cap yet: its
 * default is a global config shared by every server and still 64 KiB. The
 * block is now on for every managed agent, so aligning it is an open
 * follow-up (Runtime maintainer).
 *
 * Change the root here and every surface moves together; nothing else in the
 * repo may restate these numbers.
 */

/** Root parameter: how much of a fresh session's first input the injected
 * MEMORY.md head may occupy. Judgment value from the RFC 070 cost math
 * (~10% of the ~40k-token fresh-start floor, half the constructed-panel
 * budget); per-agent RAFT_STARTUP_MEMORY_BLOCK_TOKENS can override the
 * runtime budget, which moves the actual cap but not this contract. */
export const STARTUP_MEMORY_BLOCK_BUDGET_TOKENS = 4_000;

/** Irreducible heuristic, not derivable: ~4 bytes/token holds for
 * English/markdown; CJK-heavy files run ~1.5-2 bytes/token and therefore hit
 * token budgets earlier than the byte figure suggests. The byte cap is what
 * the injector actually enforces. */
export const APPROX_PROMPT_BYTES_PER_TOKEN = 4;

/** = 16 KiB with the defaults above. */
export const RECOMMENDED_MEMORY_MD_BYTES =
  STARTUP_MEMORY_BLOCK_BUDGET_TOKENS * APPROX_PROMPT_BYTES_PER_TOKEN;
