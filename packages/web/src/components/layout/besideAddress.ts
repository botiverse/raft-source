import { artifactOpenTarget, withArtifactOpenParams } from "../../apps/artifacts";
import type { ArtifactLinkTarget } from "../../apps/artifacts";
import { normalizeBeside } from "../../store/besideMemory";
import type { BesideState } from "../../store/besideMemory";

// What is open beside a conversation, as its page's address says it
// (docs/frontend/beside-memory.md): the address is where the thread
// (`?thread=<conversation>:<message>`, rightPanelUrlSync), the Artifact
// (`?artifact=<id>&version=<n>`, artifactOpenAddress) and the profile
// (`?profile=<type>:<id>`, `&agentTab=`) already live, so the memory is read
// from it and restored into it; the stores follow the address as ever.
//
// Not beside, so never read here: a task's dialog (`?task=`), the legacy task
// panel (`?legacyTask=`), an external author's profile (`?profile=external…`,
// which needs its message), and the Tasks and Files cards (one setting for
// the person already, channelSideCardStore).

/** A conversation's own page: `/s/<slug>/channel/<id>` or `/s/<slug>/dm/<id>`. */
export interface BesideConversation {
  serverSlug: string;
  conversationId: string;
}

export function besideConversationOf(pathname: string): BesideConversation | null {
  const match = /^\/s\/([^/]+)\/(?:channel|dm)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return { serverSlug: decodeURIComponent(match[1]!), conversationId: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

/** What `search` names beside `conversationId`. A thread of another conversation is not this one's. */
export function readBesideAddress(search: string, conversationId: string): BesideState {
  const params = new URLSearchParams(search);
  const thread = params.get("thread");
  const prefix = `${conversationId}:`;
  const artifact = artifactOpenTarget(params);
  return normalizeBeside({
    thread: thread?.startsWith(prefix) ? thread.slice(prefix.length) : undefined,
    artifact: artifact ? { id: params.get("artifact"), version: artifact.version } : undefined,
    profile: params.get("profile") ?? undefined,
    agentTab: params.get("agentTab") ?? undefined,
  });
}

/**
 * The address has the thread's place for something else than a thread to
 * restore: `?thread=` of any shape (this conversation's is named already;
 * another conversation's is a link the layout rejects whole), or `?msg=`, a
 * message of the conversation itself.
 */
export function isBesideThreadTaken(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("thread") || params.has("msg");
}

/** The Artifact a remembered entry names, as the viewer's address reads it; null if it no longer parses. */
export function besideArtifactTarget(artifact: NonNullable<BesideState["artifact"]>): ArtifactLinkTarget | null {
  const target = artifactOpenTarget(new URLSearchParams({ artifact: artifact.id }));
  return target ? { id: target.id, version: artifact.version } : null;
}

/** `search` with `add` opened too, written as opening each by hand writes it; what `search` already names is kept. */
export function withBesideAddress(search: string, conversationId: string, add: BesideState): string {
  let params = new URLSearchParams(search);
  if (add.thread !== undefined && !params.has("thread")) params.set("thread", `${conversationId}:${add.thread}`);
  if (add.artifact !== undefined && !params.has("artifact")) {
    const target = besideArtifactTarget(add.artifact);
    if (target) params = withArtifactOpenParams(params, target);
  }
  if (add.profile !== undefined && !params.has("profile")) {
    params.set("profile", add.profile);
    if (add.agentTab !== undefined) params.set("agentTab", add.agentTab);
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}
