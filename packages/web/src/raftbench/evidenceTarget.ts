/** Splits an evidence target: `#channel` cites a top-level message, `#channel:shortId` a reply in that message's thread. */
export function parseEvidenceTarget(target: string): { channelName: string; threadShortId: string | null } {
  const [channel, threadShortId] = target.replace(/^#/, "").split(":", 2);
  return { channelName: channel, threadShortId: threadShortId || null };
}
