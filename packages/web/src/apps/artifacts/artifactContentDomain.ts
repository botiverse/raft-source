// Where an Artifact's frames load from: the build's content domain and an
// Artifact's own host on it. Apart from ArtifactFrame so that code which only
// needs the origin (artifactOpenIntent's preconnect) does not pull Porthole
// into the app shell.

import type { ArtifactId } from "@botiverse/raft-shared";

/** The label prefix the content Worker serves Artifact `pt_<uuid>` on: `w-<uuid>.<content domain>`. */
const LABEL_PREFIX = "w-";

/** Porthole's scope for an Artifact: its uuid, as the Worker derives it from `pt_<uuid>`. */
export function scopeOf(id: ArtifactId): string {
  return id.startsWith("pt_") ? id.slice(3) : id;
}

let loopbackContentOverride: boolean | null = null;
let contentDomainOverride: string | null | undefined;

/** Whether http on a `*.localhost` content domain (the local content Worker) may be framed: dev builds only. */
export function allowLoopbackContent(): boolean {
  return loopbackContentOverride ?? import.meta.env.DEV === true;
}

/** Tests only: act as a production (false) or dev (true) build; null restores the build's own. */
export function setLoopbackContentForTests(allow: boolean | null): void {
  loopbackContentOverride = allow;
}

/** Tests only: the content domain this build frames (null: none); undefined restores the build's own. */
export function setContentDomainForTests(domain: string | null | undefined): void {
  contentDomainOverride = domain;
}

/** A dev build with no VITE_ARTIFACTS_CONTENT_DOMAIN: scripts/fake-artifact-content.ts's domain. */
const DEV_CONTENT_DOMAIN = "content.localhost:8791";

/** The build's VITE_ARTIFACTS_CONTENT_DOMAIN; a dev build falls back to the local fake content server. */
function buildContentDomain(): string | undefined {
  return import.meta.env.VITE_ARTIFACTS_CONTENT_DOMAIN || (import.meta.env.DEV === true ? DEV_CONTENT_DOMAIN : undefined);
}

/**
 * The build's content domain as `host[:port]`, lower case, or null when it
 * is unset or not a bare host (a scheme, path, credentials or a single label).
 */
export function artifactsContentDomain(): string | null {
  const raw = contentDomainOverride !== undefined ? contentDomainOverride : buildContentDomain();
  const domain = raw?.trim().toLowerCase();
  if (!domain) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    return null;
  }
  if (parsed.host !== domain) return null;
  // At least a registrable domain (never a bare TLD such as `com`).
  if (parsed.hostname.split(".").length < 2) return null;
  return domain;
}

/** This Artifact's own label on the content domain: `w-<uuid>.<domain>`, lower case. */
export function contentHostOf(id: ArtifactId, domain: string): string {
  return `${LABEL_PREFIX}${scopeOf(id)}`.toLowerCase() + `.${domain}`;
}

/**
 * The origin this Artifact's frames load from, as frameContentSource accepts
 * it (https; http only for the local content Worker on a `*.localhost`
 * domain in a dev build), known from the id alone before any frame route
 * answers; null with no content domain, or an id that makes no host.
 */
export function artifactContentOrigin(id: ArtifactId): string | null {
  const domain = artifactsContentDomain();
  if (!domain) return null;
  const loopback = allowLoopbackContent() && domain.replace(/:\d+$/, "").endsWith(".localhost");
  const origin = `${loopback ? "http" : "https"}://${contentHostOf(id, domain)}`;
  try {
    return new URL(origin).origin === origin ? origin : null;
  } catch {
    return null;
  }
}
