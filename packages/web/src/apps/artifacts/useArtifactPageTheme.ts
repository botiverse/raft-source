import { useMemo, useSyncExternalStore } from "react";
import { cssVariableTheme } from "@botiverse/porthole/react";
import { ARTIFACT_PAGE_THEME_TOKENS } from "@botiverse/raft-shared/src/artifactPageTheme";

function subscribeRootTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The theme on <html> (serverTheme.ts): none is Raft Yellow. */
const rootTheme = (): string => document.documentElement.dataset.theme ?? "";

const readerFor = (_rootTheme: string) => cssVariableTheme(ARTIFACT_PAGE_THEME_TOKENS);

/**
 * What a Markdown page's frame reads Raft's colours with (Porthole's `theme`), or undefined for a
 * frame that follows nothing: only the names in artifactPageTheme, each a colour token, as <html>
 * resolves them now.
 *
 * Two things change them with the page open. The light/dark mode changes `scheme`: Porthole reads
 * the values again itself. The server's theme (`data-theme` on <html>) changes neither `scheme` nor
 * any prop, so it is watched here, and each gets a reader of its own: a new function is what makes
 * Porthole read again, and send what differs. Not `themeKey`: Porthole refreshes only for a key
 * other than the one the frame mounted with, so a theme switched away from and back would stay on
 * the other's colours.
 */
export function useArtifactPageTheme(follows: boolean) {
  const theme = useSyncExternalStore(subscribeRootTheme, rootTheme, () => "");
  return useMemo(() => (follows ? readerFor(theme) : undefined), [follows, theme]);
}
