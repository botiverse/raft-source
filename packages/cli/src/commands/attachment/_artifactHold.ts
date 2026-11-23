// `raft attachment upload` of an HTML or Markdown file is held once before any
// request, with the artifact push to make instead (#347; the
// reverse of a push with no page, #345). The shared op decides and words the
// hold (agentOps/attachments.ts holdAttachmentForArtifact); this file gives it
// what only the disk knows (the file's content hash, its first bytes, and
// whether its directory can be pushed as it is) and keeps the hold in the
// agent ledger beside the push holds, under its own key prefix. Only where
// Artifacts is known to be on (the daemon's RAFT_ENABLED_APPS names it):
// unknown or off, nothing is held, since the push it names would be refused.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  appEnabledPerEnv,
  ATTACHMENT_TITLE_SCAN_BYTES,
  artifactTitleFromFileName,
  attachmentPrefersArtifact,
  holdAttachmentForArtifact,
  type AttachmentArtifactHold,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { CommandContext } from "../../core/context";
import { heldOnceStore } from "../artifact/_heldOnceStore";

/** A pushed directory's record of a pulled artifact: with it, `push --target` is refused, so such a directory is never pushed as it is. */
const ARTIFACT_DIR_STATE = ".raft-artifact.json";

/**
 * Where the held file is pushed from: its own directory when it is the only
 * file there (hidden ones aside: push leaves them out), else a new directory
 * beside it named after the file (`plan` for plan.md; `plan-artifact` when
 * that name is taken) to copy it into.
 */
export function attachmentArtifactPushDir(filePath: string): { dir: string; copyFrom?: string } {
  const dir = dirname(filePath);
  const name = basename(filePath);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const shown = entries.filter((entry) => !entry.startsWith("."));
  if (shown.length === 1 && shown[0] === name && !entries.includes(ARTIFACT_DIR_STATE)) return { dir };
  const stem = artifactTitleFromFileName(name).replace(/[\\/]/g, "-") || "artifact";
  let own = join(dir, stem);
  for (let n = 1; existsSync(own); n += 1) own = join(dir, `${stem}-artifact${n === 1 ? "" : `-${n}`}`);
  return { dir: own, copyFrom: filePath };
}

/** The file's sha256 and its first bytes (where an HTML page's `<title>` is), read in chunks. */
function hashAndHead(filePath: string): { sha256: string; head: Uint8Array } {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  let head: Uint8Array | null = null;
  const fd = openSync(filePath, "r");
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      if (head === null) head = Uint8Array.from(chunk.subarray(0, Math.min(read, ATTACHMENT_TITLE_SCAN_BYTES)));
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), head: head ?? new Uint8Array() };
}

/**
 * The upload's hold: `held` (its failure) the first time an HTML or Markdown
 * file is uploaded; else the upload goes ahead and `release` forgets the hold
 * once it went through. Any other file is never held, nor any file where
 * Artifacts isn't known to be on.
 */
export async function attachmentArtifactHold(ctx: Pick<CommandContext, "env" | "now">, agentId: string, filePath: string, target: string): Promise<AttachmentArtifactHold> {
  const path = resolve(filePath);
  if (!attachmentPrefersArtifact(basename(path)) || appEnabledPerEnv(ctx.env ?? {}, "artifacts") !== true) return { release: async () => undefined };
  const { sha256, head } = hashAndHead(path);
  return holdAttachmentForArtifact({ filename: basename(path), target, sha256, head }, {
    store: heldOnceStore(agentId, "attachment_upload_page", ctx.env),
    path,
    push: attachmentArtifactPushDir(path),
    ...(ctx.now ? { now: ctx.now } : {}),
  }, "cli");
}
