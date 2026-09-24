import { useEffect } from "react";

const APP_DOCUMENT_TITLE = "Raft";

interface ServerDocumentTitleIdentity {
  name: string;
  slug: string;
}

interface ServerRouteDocumentTitleContext {
  agentLabel?: string | null;
  machineLabel?: string | null;
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

export function serverRouteAgentId(pathname: string, serverSlug: string): string | null {
  return routeEntityId(pathname, serverSlug, "agent");
}

export function serverRouteMachineId(pathname: string, serverSlug: string): string | null {
  return routeEntityId(pathname, serverSlug, "computer") ?? routeEntityId(pathname, serverSlug, "machine");
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
  if (!hostShell) return `${serverLabel} | ${APP_DOCUMENT_TITLE}`;

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

export function genericAppDocumentTitle(): string {
  return APP_DOCUMENT_TITLE;
}

export function hostShellFallbackDocumentTitle(
  fallbacks: DocumentTitleFallbacks,
): string {
  return fallbacks.computers;
}

/** Owns the browser title for one mounted server resolver. */
export function useBrowserDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    return () => {
      document.title = genericAppDocumentTitle();
    };
  }, []);
}
