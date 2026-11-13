import type { RaftThemeId } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/** A theme's name in the picker, the sidebar and the switcher. */
export const RAFT_THEME_NAME_ID: Record<RaftThemeId, MessageId> = {
  raft: "settings.theme.name.raft",
  boring: "settings.theme.name.boring",
  bots: "settings.theme.name.bots",
  critters: "settings.theme.name.critters",
  space: "settings.theme.name.space",
  desk: "settings.theme.name.desk",
  food: "settings.theme.name.food",
  quest: "settings.theme.name.quest",
  weather: "settings.theme.name.weather",
  plants: "settings.theme.name.plants",
  spooky: "settings.theme.name.spooky",
};
