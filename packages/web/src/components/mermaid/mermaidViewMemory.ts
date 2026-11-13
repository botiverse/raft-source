import type { MermaidView } from "./MermaidToolbar";

// The Diagram / Code view each Mermaid block of a message was left on, so a
// row that remounts (the virtual timeline mounts only the rows near the view)
// comes back as the reader left it. Keyed by message id and source; in memory,
// bounded, most recently set last. Only views other than the default are kept.
const MAX_REMEMBERED = 500;
const views = new Map<string, MermaidView>();

export function mermaidViewKey(messageId: string | null, code: string): string | null {
  return messageId ? `${messageId}\u0000${code}` : null;
}

export function recallMermaidView(key: string | null): MermaidView | undefined {
  return key ? views.get(key) : undefined;
}

export function rememberMermaidView(key: string | null, view: MermaidView, defaultView: MermaidView): void {
  if (!key) return;
  views.delete(key);
  if (view === defaultView) return;
  views.set(key, view);
  while (views.size > MAX_REMEMBERED) {
    const oldest = views.keys().next().value;
    if (oldest === undefined) break;
    views.delete(oldest);
  }
}

export function clearMermaidViewMemoryForTests(): void {
  views.clear();
}
