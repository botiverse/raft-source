import { sql, type SQL } from "drizzle-orm";

// `thread` and `task` (task v2 conversation) are follow-scoped: never muted.
export type ActivityMuteTargetKind = "channel" | "dm" | "thread" | "task";

export function isActivityPromotionSuppressedByMute(opts: {
  kind: ActivityMuteTargetKind;
  messageSeq: number;
  muteFromSeq: number | null | undefined;
  personalMention: boolean;
}): boolean {
  return opts.kind !== "thread"
    && opts.kind !== "task"
    && !opts.personalMention
    && opts.muteFromSeq != null
    && opts.messageSeq >= opts.muteFromSeq;
}

export function activityPromotionAllowedByMuteSql(opts: {
  kindIsThread: SQL;
  messageSeq: SQL;
  muteFromSeq: SQL;
  personalMentionExists: SQL;
}): SQL {
  return sql`(
    ${opts.kindIsThread}
    OR ${opts.muteFromSeq} IS NULL
    OR ${opts.messageSeq} < ${opts.muteFromSeq}
    OR ${opts.personalMentionExists}
  )`;
}
