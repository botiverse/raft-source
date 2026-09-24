/**
 * Single source of truth for the in-message reference-chip box.
 *
 * Every chip rendered inside message content — @self-mention (MentionLink),
 * thread / #channel / task / slock-permalink (MessageItem), resolved and
 * unresolved — composes this exact box, so they are provably one height and
 * sit at the inline-code background-box height (stdrc #proj-message task #28
 * msg=dee00ea3: "确保所有 chip 高度一致，且和 inline code 背景框高度一致").
 *
 * - `[font-size:0.875em] leading-[1.3em]` keeps chip text one step smaller than
 *   its surrounding message while still scaling with the message font-size
 *   preference. `py-0` makes the zero vertical-padding contract explicit;
 *   `px-1` keeps the existing horizontal breathing room. The slightly tighter
 *   line-height keeps wrapped bordered chips from touching without adding an
 *   external margin or changing the zero-padding contract.
 * - `whitespace-nowrap` keeps refs like `task #16` atomic in screenshot
 *   export. Without it, a shrink-to-fit inline-block at the end of a wrapped
 *   line can split `#16` into `#1` + `6`, and html-to-image may then paint
 *   the second digit into the following text line. Pair it with max-width +
 *   overflow clipping so long labels cannot paint outside their border in a
 *   narrow message column.
 * - NO `cursor` here on purpose: in-message refs are an explicit exception to
 *   the app's link-hand control contract (stdrc task #28 msg=ca65d96d).
 *   Every call site appends `cursor-default` explicitly (the live thread-ref
 *   appends `cursor-wait` while resolving). Explicit per-site cursor also
 *   covers real-href Slock permalinks and `MentionLink` self-mentions rather
 *   than depending on a global selector.
 *
 * Lives in its own module (not inlined in MessageItem) so MentionLink can
 * import the same constant — Huarong review #proj-message:ca65d96d found the
 * self-mention chip drifting on its own `leading-[21px]` box because the
 * constant was MessageItem-local. Shared module + contract test pins it.
 */
export const MSG_REF_CHIP =
  "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom border border-black px-1 py-0 [font-size:0.875em] font-bold leading-[1.3em] select-text";
