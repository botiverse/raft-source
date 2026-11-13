// Forwarding a message: the Server refuses a forward to more distinct
// destinations than this, and the web's forward picker stops selecting there.

/** Most destination conversations one forward may target. */
export const MAX_FORWARD_DESTINATIONS = 10;

/** Most messages one forward may carry; the web's composer says so before sending. */
export const MAX_FORWARD_MESSAGES = 20;

/** The Server's `code` when a forward carries more than MAX_FORWARD_MESSAGES. */
export const FORWARD_TOO_MANY_MESSAGES_CODE = "too_many_messages";

/**
 * A forward's `action_metadata` as a client is served it. The Server builds it
 * (messageForwardService `buildForwardedBundleMetadata`) and stores it with
 * its attachments copied into the destination (`persistForwardBundle`); the
 * request digest and fingerprint it also stores are never served. The Server
 * checks at compile time that what it builds has exactly these keys.
 */
export interface ForwardedBundleMetadata {
  kind: "forwarded-bundle";
  version: number;
  /** The person who forwarded it. */
  forwardedBy: ForwardedBundleAuthorSnapshot;
  forwardedAt: string;
  /** The conversation it was forwarded to, as the request named it. */
  destinationTargetId: string;
  forwardedItems: ForwardedBundleItem[];
}

/**
 * One forwarded message, as it was when forwarded. The pointers to its source
 * (`sourceServerId` to `sourceTaskTitle`) are carried only for a public
 * source, and a reader who cannot see the source is served the item without
 * them, with a restricted `sourceTargetSnapshot` and `provenanceState`
 * `original_unavailable`.
 */
export interface ForwardedBundleItem {
  index: number;
  sourceIsThreadParent: boolean;
  sourceServerId?: string | null;
  sourceTargetId?: string | null;
  sourceThreadId?: string;
  parentChannelId?: string;
  sourceTaskId?: string;
  sourceTaskNumber?: number;
  sourceTaskTitle?: string;
  sourceMessageId?: string | null;
  sourceMessageSeq: number | null;
  sourceTargetSnapshot: ForwardedBundleTargetSnapshot;
  sourceAuthorSnapshot: ForwardedBundleAuthorSnapshot;
  sourceCreatedAt: string;
  contentSnapshot: string;
  attachmentSnapshots: ForwardedBundleAttachmentSnapshot[];
  attachmentPolicy: "projected" | "excluded";
  provenanceState: "available" | "original_unavailable";
}

export interface ForwardedBundleAuthorSnapshot {
  type: "user" | "agent" | "external_projection";
  id: string;
  name: string;
  /** Absent for an external (Slack) author. */
  uniqueName?: string;
}

export interface ForwardedBundleTargetSnapshot {
  /** Null unless the source is public. */
  id: string | null;
  type: string;
  /** Empty unless the source is public. */
  label: string;
  labelVisibility: "public" | "restricted";
}

/** A forwarded file: the destination's own copy (its attachment id), sharing the source's bytes. */
export interface ForwardedBundleAttachmentSnapshot {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/**
 * Every key a forward's `action_metadata` may carry to a client, at each
 * level, and whether the mobile App's canonical message V2 keeps it
 * (#proj-apps:#40, Lagoon 9376e822). App 1.21.0 and later keep the keys their
 * FORWARDED_* lists name and drop the rest from the V2 copy only; the App's
 * own forward card still reads the plain row, so it can use a `"v2-drops"`
 * key (`sourceIsThreadParent`, `attachmentPolicy`). App 1.16.0 to 1.20.x
 * instead refuse the whole forwarded message's V2 conversion when any
 * `"v2-drops"` key is present: the message still shows through the plain
 * display path, but the channel's local V2 window is marked discontinuous.
 * Every `"v2-drops"` key below had already shipped when these lists were
 * written, so those versions refuse every forward.
 *
 * Each list is exhaustive over its type, and the Server checks those types
 * against what it builds, so adding a key fails to compile until it is listed
 * here. That is the moment to ask the App owner whether its V2 keeps it,
 * drops it, or needs a release first: until App 1.21.0 is everyone's, a new
 * key on any level is one more key the older Apps refuse.
 */
export const FORWARDED_BUNDLE_METADATA_KEYS = {
  kind: "v2-keeps",
  version: "v2-keeps",
  forwardedItems: "v2-keeps",
  forwardedBy: "v2-drops",
  forwardedAt: "v2-drops",
  destinationTargetId: "v2-drops",
} as const satisfies Record<keyof ForwardedBundleMetadata, "v2-keeps" | "v2-drops">;

/** Each `forwardedItems` entry's keys (FORWARDED_BUNDLE_METADATA_KEYS says why). */
export const FORWARDED_BUNDLE_ITEM_KEYS = {
  index: "v2-keeps",
  sourceMessageId: "v2-keeps",
  sourceAuthorSnapshot: "v2-keeps",
  sourceCreatedAt: "v2-keeps",
  sourceTargetSnapshot: "v2-keeps",
  contentSnapshot: "v2-keeps",
  attachmentSnapshots: "v2-keeps",
  provenanceState: "v2-keeps",
  sourceIsThreadParent: "v2-drops",
  sourceMessageSeq: "v2-drops",
  attachmentPolicy: "v2-drops",
  sourceServerId: "v2-drops",
  sourceTargetId: "v2-drops",
  sourceThreadId: "v2-drops",
  parentChannelId: "v2-drops",
  sourceTaskId: "v2-drops",
  sourceTaskNumber: "v2-drops",
  sourceTaskTitle: "v2-drops",
} as const satisfies Record<keyof ForwardedBundleItem, "v2-keeps" | "v2-drops">;

/** An item's `sourceAuthorSnapshot` keys (FORWARDED_BUNDLE_METADATA_KEYS says why). */
export const FORWARDED_BUNDLE_AUTHOR_KEYS = {
  type: "v2-keeps",
  id: "v2-keeps",
  name: "v2-keeps",
  uniqueName: "v2-keeps",
} as const satisfies Record<keyof ForwardedBundleAuthorSnapshot, "v2-keeps" | "v2-drops">;

/** An item's `sourceTargetSnapshot` keys (FORWARDED_BUNDLE_METADATA_KEYS says why). */
export const FORWARDED_BUNDLE_TARGET_KEYS = {
  id: "v2-keeps",
  type: "v2-keeps",
  label: "v2-keeps",
  labelVisibility: "v2-keeps",
} as const satisfies Record<keyof ForwardedBundleTargetSnapshot, "v2-keeps" | "v2-drops">;

/** Each `attachmentSnapshots` entry's keys (FORWARDED_BUNDLE_METADATA_KEYS says why). */
export const FORWARDED_BUNDLE_ATTACHMENT_KEYS = {
  filename: "v2-keeps",
  mimeType: "v2-keeps",
  id: "v2-drops",
  sizeBytes: "v2-drops",
  width: "v2-drops",
  height: "v2-drops",
} as const satisfies Record<keyof ForwardedBundleAttachmentSnapshot, "v2-keeps" | "v2-drops">;
