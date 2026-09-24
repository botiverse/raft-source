// Pick the target server for a per-server CLI command (v4 §6):
//   - CLI accepts user-facing server slug, never server UUID
//   - exactly 1 attached server  → that one (omit the slug allowed)
//   - ≥2 attached servers + opts.server slug in the set → that one
//   - ≥2 attached + opts.server missing → fail-loud, list candidates
//     (NO implicit "current server" ambient state — locked design)
//   - 0 attached → NO_ATTACHMENT
//   - opts.server slug not in the attached set → NOT_ATTACHED
//
// Callers pass the slug from the command's positional `[serverSlug]`
// argument (no `--server` flag anywhere).
import { ComputerAttachClient } from "./apiClient.js";
import {
  formatServerSlugDisplay,
  listServerAttachments,
  normalizeServerSlug,
  readServerAttachment,
  writeServerAttachment,
  type ServerAttachment,
} from "./serverState.js";
import { resolveRaftHome } from "./paths.js";
import { fail } from "./output.js";

function attachmentLabel(a: ServerAttachment): string {
  return formatServerSlugDisplay(a.serverSlug);
}

async function refreshAttachmentSlug(home: string, attachment: ServerAttachment): Promise<ServerAttachment> {
  try {
    const client = new ComputerAttachClient(attachment.serverUrl, "");
    const result = await client.preflight(attachment.apiKey);
    if (!result.ok || !result.serverSlug || result.serverSlug === attachment.serverSlug) {
      return attachment;
    }
    const updated = { ...attachment, serverSlug: result.serverSlug };
    await writeServerAttachment(home, updated);
    return updated;
  } catch {
    return attachment;
  }
}

async function listAttachmentsWithFreshSlugs(home: string): Promise<ServerAttachment[]> {
  const attachments = await listServerAttachments(home);
  return await Promise.all(attachments.map((a) => refreshAttachmentSlug(home, a)));
}

export async function resolveTargetServerId(opts: { server?: string | null }): Promise<string> {
  const home = resolveRaftHome();
  let attachments = await listServerAttachments(home);
  if (attachments.length === 0) {
    fail("NO_ATTACHMENT", "No server attachments yet. Run `raft-computer attach /<serverSlug>` (e.g. `/myserver`) first.");
  }
  // Accept canonical `/<slug>` or shorthand `<slug>`; both normalize to
  // the bare form stored in `runner.state.json#serverSlug`.
  const requested = normalizeServerSlug(opts.server ?? "");
  if (requested) {
    let found = attachments.find((a) => a.serverSlug === requested);
    if (!found) {
      // Server slug can change while the serverId-keyed local attachment
      // remains valid. On a miss, refresh slug metadata from each
      // attachment's own Computer credential, then retry. UUID-shaped input
      // is still treated as a slug and will fail if no slug matches.
      attachments = await listAttachmentsWithFreshSlugs(home);
      found = attachments.find((a) => a.serverSlug === requested);
    }
    if (!found) {
      fail(
        "NOT_ATTACHED",
        `Server slug ${formatServerSlugDisplay(requested)} is not attached. Attached server slugs: ${attachments.map(attachmentLabel).join(", ")}.`,
      );
    }
    return found.serverId;
  }
  if (attachments.length === 1) return attachments[0].serverId;
  fail(
    "AMBIGUOUS_SERVER",
    `Multiple servers attached (${attachments.map(attachmentLabel).join(", ")}). Pass the server slug positionally (e.g. \`${attachmentLabel(attachments[0])}\`) to choose one.`,
  );
}

/** Resolve target server AND load its attachment in one go. */
export async function resolveTargetAttachment(opts: {
  server?: string | null;
}): Promise<ServerAttachment> {
  const serverId = await resolveTargetServerId(opts);
  const a = await readServerAttachment(resolveRaftHome(), serverId);
  if (!a) {
    const label = opts.server ?? serverId;
    fail("INVALID_ATTACHMENT", `Attachment for ${label} is missing/invalid. Re-run \`raft-computer attach ${label}\`.`);
  }
  return a;
}
