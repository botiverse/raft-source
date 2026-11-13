import { NewSticker } from "./ArtifactMessageCard";
import type { ArtifactNews } from "./artifactNews";

/**
 * The one pink sticker (option B): the message card's own (#12873's NewSticker),
 * so the home page and a message say what is new in the same words, by the same
 * rule ("Updated", "2 new comments", "Updated · 2 new comments"; a role="img"
 * named by the long forms), and the home page leads with who it is for
 * ("Mentions you · 3 new comments"). Nothing when nothing is new.
 */
export function ArtifactNewSticker({ news, twoLines = false }: { news: ArtifactNews; twoLines?: boolean }) {
  return <NewSticker mentioned={news.mentioned} newerVersion={news.newerVersion} newComments={news.newComments} twoLines={twoLines} />;
}
