import { useEffect, useRef } from "react";
import { create } from "zustand";
import { isHostShell } from "../embed";
import { isEmbeddedBrowser } from "./embeddedBrowser";
import type { Channel } from "../store/channelStore";

const APP_DOCUMENT_TITLE = "Raft";

interface ServerDocumentTitleIdentity {
  name: string;
  slug: string;
}

interface ServerRouteDocumentTitleContext {
  /** What the page shown in the server names itself (useServerPageDocumentLabel): ahead of every other segment. */
  pageLabel?: string | null;
  agentLabel?: string | null;
  machineLabel?: string | null;
  channelLabel?: string | null;
  threadChannelLabel?: string | null;
}

export type DocumentTitleFallbacks = {
  agent: string;
  computer: string;
  computers: string;
};

function titleSegment(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

function optionalTitleSegment(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function routeEntityId(pathname: string, serverSlug: string, entity: "agent" | "computer" | "machine"): string | null {
  const prefix = `/s/${encodeURIComponent(serverSlug)}/${entity}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encodedId = pathname.slice(prefix.length).split("/", 1)[0];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

function routeScopedId(pathname: string, serverSlug: string, scope: "channel" | "dm"): string | null {
  const prefix = `/s/${encodeURIComponent(serverSlug)}/${scope}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encodedId = pathname.slice(prefix.length).split("/", 1)[0];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

export function serverRouteAgentId(pathname: string, serverSlug: string): string | null {
  return routeEntityId(pathname, serverSlug, "agent");
}

export function serverRouteMachineId(pathname: string, serverSlug: string): string | null {
  return routeEntityId(pathname, serverSlug, "computer") ?? routeEntityId(pathname, serverSlug, "machine");
}

export function serverRouteChannelId(pathname: string, serverSlug: string): string | null {
  return routeScopedId(pathname, serverSlug, "channel");
}

export function serverRouteDmId(pathname: string, serverSlug: string): string | null {
  return routeScopedId(pathname, serverSlug, "dm");
}

export function getServerRouteDocumentTitle(
  pathname: string,
  server: ServerDocumentTitleIdentity,
  context: ServerRouteDocumentTitleContext = {},
  hostShell = false,
  fallbacks?: DocumentTitleFallbacks,
): string {
  const serverLabel = titleSegment(server.name || server.slug, server.slug);
  // `hostShell` comes only from the latched `embed=raft-settings-v1&shell=host`
  // contract. In that mode the native shell owns the header and consumes this
  // document title through its existing typed WebView navigation state.
  if (!hostShell) {
    const pageLabel = optionalTitleSegment(context.pageLabel);
    if (pageLabel) return `${pageLabel} | ${serverLabel} | ${APP_DOCUMENT_TITLE}`;

    const threadChannelLabel = optionalTitleSegment(context.threadChannelLabel);
    if (threadChannelLabel) return `${threadChannelLabel} - Thread | ${serverLabel} | ${APP_DOCUMENT_TITLE}`;

    const channelLabel = optionalTitleSegment(context.channelLabel);
    if (channelLabel) return `${channelLabel} | ${serverLabel} | ${APP_DOCUMENT_TITLE}`;

    return `${serverLabel} | ${APP_DOCUMENT_TITLE}`;
  }

  if (!fallbacks) {
    throw new Error("getServerRouteDocumentTitle requires localized fallbacks in hostShell mode");
  }

  const pathBase = `/s/${encodeURIComponent(server.slug)}`;
  const agentId = serverRouteAgentId(pathname, server.slug);
  if (agentId) {
    return titleSegment(context.agentLabel ?? "", fallbacks.agent);
  }

  const machineId = serverRouteMachineId(pathname, server.slug);
  if (machineId) {
    return titleSegment(context.machineLabel ?? "", fallbacks.computer);
  }

  if (pathname === `${pathBase}/computers` || pathname.startsWith(`${pathBase}/computers/`)) {
    return fallbacks.computers;
  }

  return fallbacks.computers;
}

/** A channel's part of the page title: `#name`, or `@peer` for a DM. */
export function documentTitleChannelLabel(channel: Channel | null | undefined): string | null {
  if (!channel) return null;
  if (channel.type === "dm") {
    const peerLabel = (channel.peerDisplayName || channel.peerName || channel.name).trim();
    return peerLabel ? `@${peerLabel}` : null;
  }
  const channelName = channel.name.trim();
  return channelName ? `#${channelName}` : null;
}

export function genericAppDocumentTitle(): string {
  return APP_DOCUMENT_TITLE;
}

export function hostShellFallbackDocumentTitle(
  fallbacks: DocumentTitleFallbacks,
): string {
  return fallbacks.computers;
}

// The unread prefix (notifications/badge.ts): "(3) #eng | Acme | Raft". Kept
// apart from the route title so either can change without the other.
let unreadPrefixCount = 0;
let baseDocumentTitle = APP_DOCUMENT_TITLE;

/** `(N) title` for N > 0; the title unchanged otherwise. */
export function documentTitleWithUnread(title: string, count: number): string {
  return count > 0 ? `(${count}) ${title}` : title;
}

function writeDocumentTitle(base: string): void {
  baseDocumentTitle = base;
  // The host shell's native header reads the title: no prefix there.
  document.title = isHostShell() ? base : documentTitleWithUnread(base, unreadPrefixCount);
}

/** The badge count shown in front of the title (0 removes it). */
export function setDocumentTitleUnreadCount(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (next === unreadPrefixCount) return;
  unreadPrefixCount = next;
  if (typeof document !== "undefined") writeDocumentTitle(baseDocumentTitle);
}

/**
 * Owns the browser title for one mounted server resolver. In an in-app browser
 * the title stays "Raft": WeChat's, QQ's, Feishu's and DingTalk's "send to a
 * friend" put the page title on the shared card, which would carry the
 * channel and server names out of the server. Raft's own app (host shell)
 * is a WebView too, but reads the title for its header and shares nothing.
 */
export function useBrowserDocumentTitle(title: string): void {
  useEffect(() => {
    writeDocumentTitle(isEmbeddedBrowser() && !isHostShell() ? APP_DOCUMENT_TITLE : title);
  }, [title]);

  useEffect(() => {
    return () => {
      writeDocumentTitle(genericAppDocumentTitle());
    };
  }, []);
}

/**
 * An Artifact's own page's title (`/artifacts/<id>`, `/v/<n>`, outside any
 * server's layout), ` | `-joined as every page's: `<title> | <server> | Raft`
 * for a member, who reads it in its server (as a channel's or the viewer's);
 * `<title> | Raft` with no server (a visitor, an outsider of a public one),
 * exactly what the page's HTML says for a public Artifact (the server's and
 * the Pages Worker's preview head), so that tab doesn't change when the app
 * mounts. "Raft" alone when there is no title.
 */
export function artifactPageDocumentTitle(title: string, serverName?: string | null): string {
  const normalized = title.trim();
  if (!normalized) return APP_DOCUMENT_TITLE;
  const server = optionalTitleSegment(serverName);
  return server ? `${normalized} | ${server} | ${APP_DOCUMENT_TITLE}` : `${normalized} | ${APP_DOCUMENT_TITLE}`;
}

/**
 * The browser title of an Artifact's own page: artifactPageDocumentTitle of
 * `title` (and the member's `server`), or "Raft" for `null` (a page that
 * names nothing of the Artifact: "can't open", a failure), and "Raft" again
 * once it goes. In an in-app browser (its share card takes the title,
 * useBrowserDocumentTitle) only a `shareable` Artifact's title is written,
 * without the server: it is public, so its title is what its link's preview
 * already says, but the server's name never is. In Raft's app (host shell)
 * nothing is written: its native title bar draws the title and version.
 */
export function useArtifactPageDocumentTitle(title: string | null, { server = null, shareable = false }: { server?: string | null; shareable?: boolean } = {}): void {
  const hostShell = isHostShell();
  const embedded = isEmbeddedBrowser();
  const value = title === null
    ? APP_DOCUMENT_TITLE
    : embedded
      ? (shareable ? artifactPageDocumentTitle(title) : APP_DOCUMENT_TITLE)
      : artifactPageDocumentTitle(title, server);
  useEffect(() => {
    if (hostShell) return;
    writeDocumentTitle(value);
  }, [hostShell, value]);

  useEffect(() => {
    if (hostShell) return;
    return () => {
      writeDocumentTitle(genericAppDocumentTitle());
    };
  }, [hostShell]);
}

/**
 * What the page shown in a server's layout names itself, ahead of the route's
 * own segments (getServerRouteDocumentTitle's `pageLabel`): one page at a
 * time, kept until that page sets another or goes.
 */
const usePageLabelStore = create<{ label: string | null; owner: object | null }>(() => ({ label: null, owner: null }));

/** Name the page shown in the server for its title (`label`, or null for none) while it is mounted (the Artifacts home). */
export function useServerPageDocumentLabel(label: string | null): void {
  const owner = useRef<object>({});
  useEffect(() => {
    usePageLabelStore.setState({ label, owner: owner.current });
  }, [label]);
  useEffect(() => {
    const mine = owner.current;
    return () => {
      if (usePageLabelStore.getState().owner === mine) usePageLabelStore.setState({ label: null, owner: null });
    };
  }, []);
}

/** The label the page shown in the server set (useServerPageDocumentLabel), or null. */
export function useServerPageDocumentLabelValue(): string | null {
  return usePageLabelStore((state) => state.label);
}
