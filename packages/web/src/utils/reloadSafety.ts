import { useMessageStore } from "../store/messageStore";
import { flushPendingDraftSnapshot, loadDrafts } from "../store/draftStorage";
import { failedSendMentionsByDraftKey, hasDraftPendingFiles } from "../features/composer/draftPendingFilesCache";
import { hasOpenLayer } from "../components/topbar/layerGuard";
import { hasWritesInFlight } from "./inFlightWrites";
import { hasReloadHolds, runBeforeReload } from "./reloadHolds";

// Work a mounted surface holds and what it saves before a reload live in
// reloadHolds (no store imports); re-exported for the reload's own callers.
export { holdReload, onBeforeReload } from "./reloadHolds";

/** Right before a reload: composer drafts written to the device now, and every surface's spot saved. */
export function prepareReload(): void {
  flushPendingDraftSnapshot();
  runBeforeReload();
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password"]);

// The text of the field being typed in, if it holds any.
function focusedFieldText(doc: Document): string {
  const field = doc.activeElement;
  if (!field) return "";
  if (field.tagName === "TEXTAREA") return (field as HTMLTextAreaElement).value.trim();
  if (field.tagName === "INPUT") {
    const input = field as HTMLInputElement;
    return TEXT_INPUT_TYPES.has(input.type) ? input.value.trim() : "";
  }
  return (field as HTMLElement).isContentEditable === true ? (field.textContent ?? "").trim() : "";
}

/**
 * Whether every composer draft (messageStore keeps only non-empty ones) is on
 * this device as it is now, read back from draftStorage after writing any
 * pending change: a draft the reloaded page will put back is not lost. None
 * kept (nobody signed in, storage full or off, another account's session)
 * counts as lost.
 */
function draftsKeptOnDevice(drafts: Record<string, string>, userId: string | null): boolean {
  if (Object.keys(drafts).length === 0) return true;
  flushPendingDraftSnapshot();
  const kept = loadDrafts(userId);
  return Object.entries(drafts).every(([key, text]) => kept[key] === text);
}

// Not the composers' own fields: their text is the draft (above), and the
// rest of a composer holds the page itself (MessageInput).
const COMPOSER = "[data-composer-frame-edge]";

/**
 * A text field changed and not focused, outside the composers. React keeps a
 * controlled field's default in step with its value, so this sees the
 * uncontrolled ones (value no longer their default); a controlled editor
 * holds the page itself (EnvVarsSection). Checkboxes, radios and selects are
 * left out: React never moves a controlled one's default, so every toggle
 * saved at once would read as changed for good. A search box is not work.
 */
function hasChangedField(doc: Document): boolean {
  for (const field of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    if (field.disabled || field.readOnly || field.closest(COMPOSER)) continue;
    if (field.tagName === "INPUT" && (!TEXT_INPUT_TYPES.has(field.type) || field.type === "search")) continue;
    if (field.value !== field.defaultValue) return true;
  }
  return false;
}

/** A video or a voice note playing (also one kept playing off screen: inlineAudioKeepAlive), or anything full screen. */
function isPlaying(doc: Document): boolean {
  if (doc.fullscreenElement) return true;
  return [...doc.querySelectorAll<HTMLMediaElement>("video, audio")].some((media) => !media.paused && !media.ended);
}

// A message sent and not yet confirmed by the server (an optimistic row).
function hasPendingSend(): boolean {
  for (const bucket of Object.values(useMessageStore.getState().channelMessages)) {
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const message = bucket[index]!;
      if (typeof message.seq !== "number" && typeof message.optimisticDisplaySeq === "number") return true;
    }
  }
  return false;
}

/**
 * Whether reloading this page now loses nothing the person has not sent or
 * is not in the middle of:
 * - work a mounted surface holds (holdReload), an attachment picked or
 *   uploading in a composer, mounted or not, mentions kept from a failed send;
 * - a write in flight (inFlightWrites) or a message not yet confirmed;
 * - a composer draft the device does not keep;
 * - a dialog, sheet, menu or popover open (layerGuard's open layers);
 * - focus in an embedded frame (an Artifact, a web preview, a PDF): what is
 *   done in there never reaches this page, so it counts as in use;
 * - a video or voice note playing, or anything full screen;
 * - text in the focused field unless it is a kept composer draft (an edit in
 *   place), or a field changed elsewhere (hasChangedField).
 */
export function canReloadWithoutLosingWork(doc: Document = document): boolean {
  if (hasReloadHolds() || hasDraftPendingFiles() || failedSendMentionsByDraftKey.size > 0) return false;
  if (hasWritesInFlight() || hasPendingSend()) return false;
  const { drafts, currentUserId } = useMessageStore.getState();
  if (!draftsKeptOnDevice(drafts, currentUserId)) return false;
  if (hasOpenLayer(doc) || doc.activeElement?.tagName === "IFRAME" || isPlaying(doc)) return false;
  const text = focusedFieldText(doc);
  if (text !== "" && !Object.values(drafts).some((draft) => draft.trim() === text)) return false;
  return !hasChangedField(doc);
}
