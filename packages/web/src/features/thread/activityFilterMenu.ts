import type { ComponentType } from "react";
import { AtSign, Bookmark, Inbox, MessageSquareDot, Pin } from "lucide-react";
import type { ActivityFilterChoice } from "../../store/activityFilterPreference";
import { ArtifactIcon } from "@botiverse/ricons";

/** The Filter menu: the read filters, then the scopes (Pinned, Saved, Artifacts) after a separator. */
export const ACTIVITY_FILTER_MENU: readonly { choice: ActivityFilterChoice; separated?: boolean }[] = [
  { choice: "all" },
  { choice: "unread" },
  { choice: "mentions" },
  { choice: "pinned", separated: true },
  { choice: "saved" },
  // Only Artifact rows (Artea, #proj-workspace:8b3bd9c3; Kirby's mockup): one kind of object, like the scopes before it.
  { choice: "artifacts" },
];

// Lucide's icons and raft-ui's ArtifactIcon (an object Lucide has none for) both take these.
type ActivityFilterIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export const ACTIVITY_FILTER_ICON: Record<ActivityFilterChoice, ActivityFilterIcon> = {
  all: Inbox,
  unread: MessageSquareDot,
  mentions: AtSign,
  pinned: Pin,
  saved: Bookmark,
  artifacts: ArtifactIcon,
};

export const ACTIVITY_FILTER_LABEL_ID = {
  all: "thread.filter.all",
  unread: "thread.filter.unread",
  mentions: "thread.filter.mentions",
  pinned: "thread.filter.pinned",
  saved: "thread.filter.saved",
  artifacts: "thread.filter.artifacts",
} as const satisfies Record<ActivityFilterChoice, string>;
