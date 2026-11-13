import type { ArtifactDashboardAllNews } from "@botiverse/raft-shared";

/**
 * What is new on an Artifact for the reader, for the home page's one pink
 * sticker (option B, xxchan's choice, #proj-workspace:#133; Kirby's
 * A4jpGi3nDcBGP36Rxp1gbJ): a comment that mentions them, a newer version, and
 * how many comments by others.
 *
 * It says the row's own `news` (ArtifactDashboardAllNews) as it is: nothing
 * capped by the card, and no `card.unseen`, which marks Artifacts the reader
 * opened but doesn't follow. `和我有关` keeps the rows whose `news` says
 * something, so a card has a sticker exactly when the toggle would keep it
 * (#proj-workspace:#210). An older Server sends no `news`: no sticker.
 */
export interface ArtifactNews {
  mentioned: boolean;
  newerVersion: boolean;
  newComments: number;
}

export function artifactNewsOf(news: ArtifactDashboardAllNews | undefined): ArtifactNews {
  return { mentioned: (news?.mentions ?? 0) > 0, newerVersion: (news?.versions ?? 0) > 0, newComments: news?.comments ?? 0 };
}

export const hasNews = (news: ArtifactNews) => news.mentioned || news.newerVersion || news.newComments > 0;
