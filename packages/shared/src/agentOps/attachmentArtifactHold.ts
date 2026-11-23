// An HTML or Markdown file uploaded as an attachment, held once before any
// request, with the artifact push to make instead (#347: the
// reverse of a push with no page, agentOps/artifacts.ts). The CLI runs it
// before its upload; uploadAttachment takes it as its `hold`
// (attachmentArtifactHold). A module of its own, so the SDK, which turns no
// such hold on, bundles none of it.

import { artifactFileType, artifactTitleFromFileName, artifactTitleFromHtml } from "../artifactFiles";
import { formatAttachmentPreferArtifactHold } from "../agentText/artifacts";
import { parseRaftRefTarget, taskRefConversationTarget } from "../raftRefs";
import { ARTIFACT_NOT_A_PAGE_HOLD_MS, type ArtifactPageHoldStore } from "./artifacts";
import type { AttachmentUploadHold } from "./attachments";
import type { RaftHintStyle } from "./hint";
import { failureOutcome, opError, type RaftFailure } from "./outcome";

/** An HTML or Markdown file (.html, .htm, .md, .markdown, in any case): pushed as an artifact rather than uploaded. */
export function attachmentPrefersArtifact(filename: string): boolean {
  const { kind } = artifactFileType(filename);
  return kind === "html" || kind === "markdown";
}

/**
 * Where `raft artifact push --target` puts an upload's target, and where the
 * link is posted then. The push takes `#channel`, `dm:@peer` (`~agent` /
 * `~human` too) and a thread of either by its 8-character short id (homed in
 * the thread's conversation, as the Server's resolveConversationTarget has
 * it); a task ref (`#channel:#7`, `dm:@peer:#7`) is no home, so the push goes
 * to the task's conversation and the link is posted in the task (`postIn`).
 * Null for any other target: no push to name, so no hold.
 */
export function artifactPushTargetFor(target: string): { target: string; postIn?: string } | null {
  const given = target.trim();
  const ref = parseRaftRefTarget(given);
  switch (ref?.kind) {
    case "channel":
    case "dm":
      return { target: given };
    case "channel-thread":
    case "dm-thread":
      return ref.threadShortId.length === 8 ? { target: given } : null;
    case "task": {
      const conversation = taskRefConversationTarget(given);
      return conversation === null ? null : { target: conversation, postIn: given };
    }
    default:
      return null;
  }
}

/** How an upload holds an HTML or Markdown file: without these, it never does. Pass them only where Artifacts is known to be on. */
export interface AttachmentArtifactHoldOptions {
  /** The push hold's store (the CLI's agent ledger); this hold's keys have their own prefix. */
  store: ArtifactPageHoldStore;
  /** The CLI's file, absolute: part of the key. A tool call has none (its filename stands in). */
  path?: string;
  /** The CLI's directory to push, absolute, and (`copyFrom`, the file's path) whether the file is to be copied into it first. */
  push?: { dir: string; copyFrom?: string };
  /** The clock (tests). */
  now?: () => number;
}

/** A held upload (`held`: its failure), or one to send and then `release` (forget its hold; nothing for a file never held). */
export type AttachmentArtifactHold = { held: RaftFailure; release?: undefined } | { held?: undefined; release: () => Promise<void> };

const NOT_HELD: AttachmentArtifactHold = { release: async () => undefined };

/**
 * Hold an upload of an HTML or Markdown file once: the first time, a
 * held-once failure (`heldOnce`) with the artifact push to make instead; the same
 * upload again (the same file, content and target) within
 * ARTIFACT_NOT_A_PAGE_HOLD_MS goes through. Its key is the file (`path`, else
 * its name), the target as given (trimmed) and the content's sha256, under its
 * own prefix in the push hold's store. A store that can't be read or written,
 * or a target no push can name (artifactPushTargetFor), never holds (the hold
 * is a nudge). `head`: the file's first bytes, where an
 * HTML page's `<title>` is looked for (with one, the push needs no --title).
 */
export async function holdAttachmentForArtifact(
  upload: { filename: string; target?: string; sha256: string; head?: Uint8Array },
  options: AttachmentArtifactHoldOptions,
  style: RaftHintStyle = "cli",
): Promise<AttachmentArtifactHold> {
  if (!attachmentPrefersArtifact(upload.filename)) return NOT_HELD;
  const target = upload.target?.trim() || undefined;
  const pushTo = target === undefined ? null : artifactPushTargetFor(target);
  if (target !== undefined && pushTo === null) return NOT_HELD;
  const keyed = JSON.stringify(["attachment-prefer-artifact/1", options.path ?? upload.filename, target ?? null, upload.sha256]);
  const key = `prefer-artifact/${await sha256Hex(new TextEncoder().encode(keyed))}`;
  const now = (options.now ?? Date.now)();
  const heldAt = await fromHoldStore(() => options.store.heldAt(key));
  const confirmed = typeof heldAt === "number" && heldAt <= now && now - heldAt <= ARTIFACT_NOT_A_PAGE_HOLD_MS;
  const release = async () => { await fromHoldStore(() => options.store.release(key)); };
  if (confirmed || !await fromHoldStore(async () => { await options.store.hold(key, now); return true; })) return { release };
  const pageTitle = artifactFileType(upload.filename).kind === "html" && upload.head
    ? artifactTitleFromHtml(new TextDecoder().decode(upload.head.subarray(0, ATTACHMENT_TITLE_SCAN_BYTES)))
    : null;
  const text = formatAttachmentPreferArtifactHold({
    file: upload.filename,
    ...(pushTo === null ? {} : pushTo),
    ...(pageTitle === null ? { title: artifactTitleFromFileName(upload.filename) } : {}),
    ...(options.push === undefined ? {} : { dir: options.push.dir, ...(options.push.copyFrom === undefined ? {} : { copyFrom: options.push.copyFrom }) }),
  }, style);
  return { held: failureOutcome(opError("CONFLICT", { message: text.message, nextAction: text.nextAction, heldOnce: true })) };
}

/** How much of an HTML file is read for its `<title>`: as much as a push reads of its entry page. */
export const ATTACHMENT_TITLE_SCAN_BYTES = 1024 * 1024;

/** A hold store's answer, or undefined when it failed: a store that can't keep the hold must not stop every such upload. */
async function fromHoldStore<T>(call: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hold as uploadAttachment takes it (its `hold`): the content hashed, its first bytes for an HTML file's `<title>`. */
export function attachmentArtifactHold(options: AttachmentArtifactHoldOptions, style: RaftHintStyle = "cli"): AttachmentUploadHold {
  return async ({ filename, target, bytes }) => attachmentPrefersArtifact(filename)
    ? holdAttachmentForArtifact({ filename, target, sha256: await sha256Hex(bytes), head: bytes }, options, style)
    : NOT_HELD;
}
