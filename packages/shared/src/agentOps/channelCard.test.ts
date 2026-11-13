import { describe, expect, it } from "vitest";

import { CHANNEL_CARD_DESCRIPTION_CHARS, channelCardRev, renderChannelCard, type ChannelCard } from "./passiveResources";

const general: ChannelCard = { id: "c-1", name: "general", type: "channel", description: "Announcements only." };

describe("channelCardRev", () => {
  it("is v1-prefixed and stable for the same card", () => {
    expect(channelCardRev(general)).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(channelCardRev({ ...general })).toBe(channelCardRev(general));
  });

  it("moves with each field the card shows, and only with those", () => {
    const base = channelCardRev(general);
    expect(channelCardRev({ ...general, name: "general-2" })).not.toBe(base);
    expect(channelCardRev({ ...general, type: "private" })).not.toBe(base);
    expect(channelCardRev({ ...general, archived: true })).not.toBe(base);
    expect(channelCardRev({ ...general, description: "Announcements and questions." })).not.toBe(base);
    // Not shown on the card: the id, and whitespace around the description.
    expect(channelCardRev({ ...general, id: "c-other" })).toBe(base);
    expect(channelCardRev({ ...general, description: "  Announcements\n\n only.\n" })).toBe(base);
    // Same visibility, same card.
    expect(channelCardRev({ ...general, type: null })).toBe(base);
  });

  it("does not let field boundaries collide", () => {
    expect(channelCardRev({ id: "a", name: "ab", description: "c" })).not.toBe(channelCardRev({ id: "a", name: "a", description: "bc" }));
  });
});

describe("renderChannelCard", () => {
  it("shows the channel, its visibility and description, then the equivalent command", () => {
    expect(renderChannelCard(general)).toEqual([
      "Channel #general (public): Announcements only.",
      "Equivalent: raft channel info \"#general\"",
    ]);
  });

  it("says when the agent saw an older version in this context", () => {
    expect(renderChannelCard(general, { changed: true })[0]).toBe("Channel #general (public), changed since you last saw it: Announcements only.");
  });

  it("marks archived, joint and private channels and a missing description", () => {
    expect(renderChannelCard({ id: "c", name: "old", type: "private", archived: true })).toEqual(["Channel #old (private, archived, read-only): no description."]);
    expect(renderChannelCard({ id: "c", name: "shared", type: "joint", description: "x" })[0]).toBe("Channel #shared (joint): x");
  });

  it("gives an archived channel its whole description and no pointer: no command shows it", () => {
    const long = "字".repeat(CHANNEL_CARD_DESCRIPTION_CHARS + 20);
    expect(renderChannelCard({ id: "c", name: "old", type: "channel", archived: true, description: long })).toEqual([`Channel #old (public, archived, read-only): ${long}`]);
  });

  it("collapses whitespace and caps the description by code point", () => {
    const [line] = renderChannelCard({ id: "c", name: "long", description: `a\n\nb ${"字".repeat(CHANNEL_CARD_DESCRIPTION_CHARS)}` });
    expect(line).toBe(`Channel #long (public): a b ${"字".repeat(CHANNEL_CARD_DESCRIPTION_CHARS - 4)}…⟨4 more chars⟩`);
  });
});
